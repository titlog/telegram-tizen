/* 包里的脚本在 config.xml 的 required_version 那代电视上解析得了吗。deploy.sh、release.sh 卡着它。
 *
 * 2026-10-22：1.1.2 的 tg.bundle.js 打包目标是 chrome120，应用却让 Tizen 6.0（Chromium 76）装。两台这样的电视每次启动都是
 * 「Uncaught SyntaxError: Unexpected token ( @tg.bundle.js:1」—— @fuman/utils（mtcute 的依赖）里的私有方法 `#realloc()`，
 * Chromium 84 才认 —— 接着「TGLib is not defined」，整个应用打不开。`node --check` 看不出来：开发机的 node 什么都认。
 *
 * 所以：每个文件用 acorn 解析（最新的语法都认），再把用到的写法对着「从哪个 Chromium 起认」的表查，比 required_version 那代引擎新
 * 的就失败，说是哪种写法、第一次出现在哪。后台线程那份（build/out/worker.bundle.txt）在 tg.bundle.js 里只是一个字符串，单独查。
 * 只管语法；缺的 API（AbortSignal.any 之类）在 build/src/compat.js 补，这里查不出来。
 *
 *   node tools/syntax-verify.mjs            app/js 下的 .js（含 vendor/）+ build/out/worker.bundle.txt
 *   node tools/syntax-verify.mjs <文件…>     只查这些（release.sh 查它暂存目录里那份）
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const acorn = createRequire(path.join(ROOT, "build/package.json"))("acorn");

/* Tizen 版本 → 那代电视的 Chromium（三星的规格表；6.0 的 76 在那两台的 UA 里核对过）。 */
const TIZEN_CHROMIUM = { "3.0": 47, "4.0": 56, "5.0": 63, "5.5": 69, "6.0": 76, "6.5": 85, "7.0": 94, "8.0": 108, "9.0": 120 };
const required = /required_version="([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, "app/config.xml"), "utf8"))?.[1];
const ENGINE = TIZEN_CHROMIUM[required];
if (!ENGINE) { console.log(`✗ config.xml 的 required_version="${required}" 不在表里，不知道该按哪代 Chromium 查`); process.exit(1); }

/* 写法 → 从哪个 Chromium 起认。按 V8 / Chrome 的发布说明；比 3.0（47）更老的写法不列。 */
const RULES = [
  ["class", 49, (n) => n.type === "ClassDeclaration" || n.type === "ClassExpression"],
  ["let / const", 49, (n) => n.type === "VariableDeclaration" && n.kind !== "var"],
  ["解构", 49, (n) => n.type === "ObjectPattern" || n.type === "ArrayPattern"],
  ["参数默认值", 49, (n) => n.type === "AssignmentPattern"],
  ["**", 52, (n) => (n.type === "BinaryExpression" && n.operator === "**") || (n.type === "AssignmentExpression" && n.operator === "**=")],
  ["async 函数", 55, (n) => /Function/.test(n.type) && n.async && !n.generator],
  ["对象展开 / 剩余", 60, (n, p) => (n.type === "SpreadElement" && p?.type === "ObjectExpression") || (n.type === "RestElement" && p?.type === "ObjectPattern")],
  ["async 生成器 / for await", 63, (n) => (/Function/.test(n.type) && n.async && n.generator) || (n.type === "ForOfStatement" && n.await)],
  ["import()", 63, (n) => n.type === "ImportExpression"],
  ["import.meta", 64, (n) => n.type === "MetaProperty" && n.meta.name === "import"],
  ["catch 不带参数", 66, (n) => n.type === "CatchClause" && !n.param],
  ["BigInt 字面量", 67, (n) => n.type === "Literal" && n.bigint !== undefined],
  ["类字段", 72, (n) => n.type === "PropertyDefinition" && n.key.type !== "PrivateIdentifier"],
  ["私有字段 #x", 74, (n) => n.type === "PropertyDefinition" && n.key.type === "PrivateIdentifier"],
  ["数字分隔符 1_000", 75, (n) => n.type === "Literal" && typeof n.raw === "string" && /^[0-9.]/.test(n.raw) && n.raw.includes("_")],
  ["?.", 80, (n) => n.type === "ChainExpression"],
  ["??", 80, (n) => n.type === "LogicalExpression" && n.operator === "??"],
  ["私有方法 #m()", 84, (n) => n.type === "MethodDefinition" && n.key.type === "PrivateIdentifier"],
  ["??= ||= &&=", 85, (n) => n.type === "AssignmentExpression" && /^(\?\?|\|\||&&)=$/.test(n.operator)],
  ["#x in obj", 91, (n) => n.type === "BinaryExpression" && n.left.type === "PrivateIdentifier"],
  ["类的 static 块", 94, (n) => n.type === "StaticBlock"],
  ["正则 s 标志", 62, (n) => n.regex && n.regex.flags.includes("s")],
  ["正则后行断言 (?<= (?<!", 62, (n) => n.regex && /\(\?<[=!]/.test(n.regex.pattern)],
  ["正则命名分组 (?<名>", 64, (n) => n.regex && /\(\?<[^=!]/.test(n.regex.pattern)],
  ["正则 \\p{…}", 64, (n) => n.regex && n.regex.flags.includes("u") && /\\[pP]\{/.test(n.regex.pattern)],
  ["正则 d 标志", 90, (n) => n.regex && n.regex.flags.includes("d")],
  ["正则 v 标志", 112, (n) => n.regex && n.regex.flags.includes("v")],
];

function walk(node, parent, visit) {
  visit(node, parent);
  for (const key in node) {
    if (key === "loc") continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === "string") walk(c, node, visit); } }
    else if (v && typeof v.type === "string") { walk(v, node, visit); }
  }
}

/* mtcute 正常那份（tg.bundle.js 和它的后台线程文本）只在有 BigInt 的引擎上加载（boot.js；BigInt 是 Chromium 67 起），按 Tizen 5.5
 * （Chromium 69）打、按它查；没有 BigInt 的（Tizen 5.0）加载 tg.legacy.js，和别的脚本一样按 required_version 那代查（2026-10-26） */
const MODERN = /(^|[\/\\])(tg\.bundle\.js|worker\.bundle\.txt)$/;
const engineFor = (file) => (MODERN.test(file) ? Math.max(ENGINE, TIZEN_CHROMIUM["5.5"]) : ENGINE);

function check(file) {
  const src = fs.readFileSync(file, "utf8"), ENGINE = engineFor(file);
  const name = path.relative(ROOT, file) || file;
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true, locations: true }); }
  catch (e) { return [`${name}: 解析不了（${e.message}）`]; }
  const found = new Map();
  walk(ast, null, (n, p) => {
    for (const [what, since, test] of RULES) {
      if (since <= ENGINE || !test(n, p)) continue;
      const f = found.get(what) || { since, count: 0, at: n };
      f.count++;
      found.set(what, f);
    }
  });
  return [...found].map(([what, f]) => {
    const { line, column } = f.at.loc.start;
    const around = src.split("\n")[line - 1].slice(Math.max(0, column - 30), column + 50).replace(/\s+/g, " ");
    return `${name}: ${what}（Chromium ${f.since} 起）${f.count} 处，第一处 ${line}:${column + 1}  …${around}…`;
  });
}

let files = process.argv.slice(2);
if (!files.length) {
  const js = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? js(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : []);
  files = [...js(path.join(ROOT, "app/js")), path.join(ROOT, "build/out/worker.bundle.txt"), path.join(ROOT, "build/out/worker.legacy.txt")];
}
const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length) { console.log("✗ 没有这些文件（先打包）：" + missing.join("、")); process.exit(1); }
const problems = files.flatMap(check);
if (problems.length) {
  console.log(`✗ 比 Tizen ${required}（Chromium ${ENGINE}）新的写法 —— 这些电视上整个脚本解析不了：`);
  for (const p of problems) console.log("    " + p);
  process.exit(1);
}
const modern = files.filter((f) => MODERN.test(f) && engineFor(f) !== ENGINE).length;
console.log(`✓ ${files.length} 个脚本在 Tizen ${required}（Chromium ${ENGINE}）上解析得了` + (modern ? `（其中 ${modern} 个是有 BigInt 的引擎才加载的 mtcute 正常那份，按 Chromium ${TIZEN_CHROMIUM["5.5"]} 查）` : ""));
