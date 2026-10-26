/* 给没有 BigInt 的引擎（Tizen 5.0 = Chromium 63）打 mtcute 包：zsh build/bundle.sh 里在正常那份之后跑。
 *   node build/legacy/build-legacy.mjs <输出 tg.legacy.js>
 * 和正常那份（tg.bundle.js）同样的入口（src/entry.js + src/worker.js），只是：
 *   - 用到 BigInt 的模块换成 JSBI：jsbi-bigint.js 整个替换几个、patches.mjs 按行改握手和两步验证、剩下几个（用不到的）交给
 *     babel-plugin-transform-bigint 做语法转换（它碰到拿不准类型的 i++、typeof 会直接报错，那两处改成原样放着 —— 这几个文件里都是
 *     普通数字）；
 *   - esbuild 的 target 是 chrome63；
 *   - 前面拼上 JSBI（jsbi-umd.js）和 prelude63.js（AbortController、trimStart / trimEnd、DataView 读写 64 位数）。后台线程那份文本也一样。
 * 启动时哪份：boot.js 看 typeof BigInt。打出来的包对着 Chromium 63 查语法（tools/syntax-verify.mjs）。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PATCHES, REPLACE, TRANSFORM } from './patches.mjs';

const BUILD = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.log('用法：node build/legacy/build-legacy.mjs <输出 tg.legacy.js>'); process.exit(1); }
const req = createRequire(BUILD + '/package.json');
const esbuild = req('esbuild');
const babel = req('@babel/core');
/* babel-plugin-transform-bigint 碰到 i++、typeof 拿不准类型就抛错：在内存里把那两处改成「原样放着」再用 */
const pluginSrc = fs.readFileSync(req.resolve('babel-plugin-transform-bigint'), 'utf8');
const fixes = [["throw new RangeError('UpdateExpressions are not supported because of the complexity: ' + path);", 'return;'],
               ["throw new RangeError('not supported');", 'return;']];
let patched = pluginSrc;
for (const [a, b] of fixes) { if (patched.split(a).length !== 2) { throw new Error('babel-plugin-transform-bigint 变了，改不了：' + a); } patched = patched.replace(a, b); }
const pluginFile = path.join(BUILD, 'out', 'transform-bigint.cjs');
fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
fs.writeFileSync(pluginFile, patched);
const transformBigint = req(pluginFile);
const JSBI_UMD = fs.readFileSync(req.resolve('jsbi/dist/jsbi-umd.js'), 'utf8');
const PRELUDE = JSBI_UMD + '\n' + fs.readFileSync(path.join(BUILD, 'legacy', 'prelude63.js'), 'utf8') + '\n';
const SHIM = path.join(BUILD, 'legacy', 'jsbi-bigint.js');

const used = { patched: new Set(), replaced: new Set(), transformed: new Set() };
const legacyPlugin = { name: 'legacy-bigint', setup(b) {
  b.onLoad({ filter: /\.js$/ }, (args) => {
    const rel = path.relative(BUILD, args.path).split(path.sep).join('/');
    if (REPLACE.some((re) => re.test(args.path))) {
      used.replaced.add(rel);
      return { contents: `export * from ${JSON.stringify(SHIM)};`, loader: 'js', resolveDir: path.dirname(args.path) };
    }
    if (PATCHES[rel]) {
      let src = fs.readFileSync(args.path, 'utf8');
      for (const [from, to] of PATCHES[rel]) {
        const n = typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) || []).length;
        if (n !== 1) { throw new Error(`${rel}：这一处找到 ${n} 次（应该正好 1 次），mtcute 变了，重新对一遍 build/legacy/patches.mjs：${String(from).slice(0, 80)}`); }
        src = typeof from === 'string' ? src.replace(from, () => to) : src.replace(from, to);
      }
      if (/\b\d+n\b|[^.\w]BigInt\(/.test(src)) { throw new Error(`${rel} 改完还有原生 BigInt：${(src.match(/.{30}(\b\d+n\b|[^.\w]BigInt\().{30}/) || [''])[0]}`); }
      used.patched.add(rel);
      return { contents: src, loader: 'js', resolveDir: path.dirname(args.path) };
    }
    if (TRANSFORM.test(args.path)) {
      const r = babel.transformSync(fs.readFileSync(args.path, 'utf8'), { babelrc: false, configFile: false, filename: args.path, sourceType: 'module', plugins: [transformBigint] });
      used.transformed.add(rel);
      return { contents: r.code.replace(/^import JSBI from ["'][^"']+["'];?\s*$/m, ''), loader: 'js', resolveDir: path.dirname(args.path) };
    }
    return undefined;
  });
} };
const common = { bundle: true, format: 'iife', target: 'chrome63', loader: { '.wasm': 'binary', '.txt': 'text' }, minify: true, legalComments: 'none',
  logLevel: 'warning', plugins: [legacyPlugin], write: false, absWorkingDir: BUILD };
const w = await esbuild.build({ ...common, entryPoints: [path.join(BUILD, 'src', 'worker.js')] });
fs.writeFileSync(path.join(BUILD, 'out', 'worker.legacy.txt'), PRELUDE + w.outputFiles[0].text);
/* 主线程那份：同一个 entry.js，只是嵌的是老引擎的后台线程文本 */
const entryLegacy = path.join(BUILD, 'src', '_entry.legacy.js');
fs.writeFileSync(entryLegacy, fs.readFileSync(path.join(BUILD, 'src', 'entry.js'), 'utf8').replace("'../out/worker.bundle.txt'", "'../out/worker.legacy.txt'"));
try {
  const e = await esbuild.build({ ...common, entryPoints: [entryLegacy] });
  fs.writeFileSync(OUT, PRELUDE + e.outputFiles[0].text);
} finally { fs.unlinkSync(entryLegacy); }
/* 打出来的包里不该再有原生 BigInt（字面量、BigInt(…)、typeof … "bigint" 以外的） */
const body = fs.readFileSync(OUT, 'utf8').slice(PRELUDE.length);
const lits = body.match(/\b\d+n\b/g) || [];
const calls = (body.match(/[^.\w$]BigInt\(/g) || []).length;
console.log(`  老引擎的包 → ${path.basename(OUT)} ${(fs.statSync(OUT).size / 1048576).toFixed(2)}MB：整个换 ${used.replaced.size} 个、按行改 ${used.patched.size} 个、转换 ${used.transformed.size} 个；` +
  `剩下的原生 BigInt 字面量 ${lits.length} 个、BigInt( 调用 ${calls} 处（long 库里的 fromBigInt / toBigInt，没人调）`);
if (lits.length) { throw new Error('老引擎的包里还有 BigInt 字面量'); }
if (used.patched.size !== Object.keys(PATCHES).length) { throw new Error('patches.mjs 里有文件没打进包：' + Object.keys(PATCHES).filter((k) => !used.patched.has(k)).join(', ')); }
