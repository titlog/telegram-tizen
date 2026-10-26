/* 界面双语的检查（i18n.js）：
 *   1. 代码里每个 T("…") / tx("…") 的键、index.html 里每个 data-i18n 元素，英文字典里都要有，{0} {1} 一样多；
 *   2. app.js 里往屏幕上写字的那几种地方（toast / innerHTML / textContent / spin / label / h:）不能直接写中文（要套 T）；
 *   3. 只在运行时拼出来的键（语种名、编码名、字幕文件的语言）也要在字典里。
 *   node test/i18n.mjs */
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = { navigator: { language: 'en-US' }, localStorage: { getItem: () => 'en', setItem() {} }, document: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/i18n.js', 'utf8') + ';this.I18n = I18n;', ctx);
const I18n = ctx.I18n, keys = new Set(I18n.keys());
let bad = 0;
const fail = (m) => { bad++; console.log('  ✗ ' + m); };
const holes = (s) => (s.match(/\{\d\}/g) || []).sort().join('');

/* 1. 代码里的键 */
const used = new Map();
for (const f of fs.readdirSync(ROOT + 'app/js').filter(f => f.endsWith('.js') && !/bundle|vendor|sites\.local|i18n/.test(f))) {
  const src = fs.readFileSync(ROOT + 'app/js/' + f, 'utf8');
  for (const m of src.matchAll(/\b(?:T|tx)\(\s*"((?:[^"\\]|\\.)*)"/g)) used.set(JSON.parse('"' + m[1] + '"'), f);
}
const html = fs.readFileSync(ROOT + 'app/index.html', 'utf8');
for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n\b[^>]*>([\s\S]*?)<\/\1>/g)) used.set(m[2].trim(), 'index.html');
/* 3. 运行时拼的 */
for (const k of ['中文', '国语', '粤语', '英语', '日语', '韩语', '法语', '德语', '西班牙语', '意大利语', '俄语', '泰语', '葡萄牙语', '越南语', '印地语', '荷兰语', '波兰语',
  '简体', '繁体', '英文', '中英', '杜比 AC-3', '杜比 E-AC-3', '连接', 'TG 视频']) used.set(k, '运行时');
for (const [k, f] of used) {
  if (!keys.has(k)) fail(`${f}：没有英文「${k}」`);
  else if (holes(k) !== holes(I18n.t(k))) fail(`${f}：占位符对不上「${k}」→「${I18n.t(k)}」`);
}
console.log(`用到 ${used.size} 个键，字典里 ${keys.size} 个`);
for (const k of keys) if (!used.has(k) && !/^[；、]$/.test(k) && k !== 'English' && k !== '中文界面') console.log(`  · 字典里没用到的：「${k}」`);

/* 2. app.js 里直接往屏幕上写中文 */
const app = fs.readFileSync(ROOT + 'app/js/app.js', 'utf8').split('\n');
app.forEach((l, i) => {
  const code = l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
  /* 换语言那一项故意用要换成的语言写（英文界面上写「中文界面」，看不懂英文的人也找得到） */
  if (/^\s*\*/.test(l) || /^\s*R\(/.test(code) || /__lang/.test(code)) return;
  if (!/(toast\(|innerHTML\s*=|textContent\s*=|spin\(|label:|\bh:|title:)/.test(code)) return;
  const raw = code.replace(/\b(?:T|tx)\(\s*"(?:[^"\\]|\\.)*"/g, '').replace(/R\(.*$/, '');
  if (/"[^"]*[一-鿿][^"]*"/.test(raw)) fail(`app.js:${i + 1} 直接写了中文：${code.trim().slice(0, 140)}`);
});

/* 日期 */
console.log('  日期：' + I18n.date(new Date(2025, 9, 18)) + ' / ' + I18n.date(new Date()));
console.log(bad ? `${bad} 处有问题` : '全部通过');
process.exit(bad ? 1 : 0);
