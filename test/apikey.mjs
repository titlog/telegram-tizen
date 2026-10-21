/* API ID / Hash 从哪来、填写页（app/js/apikey.js、app.js 的 #api）在桌面上走一遍。
 *
 * 换掉 js/tg.js：假的 Telegram 层只认一组 hash（GOOD），别的在扫码那一步回 400 API_ID_INVALID —— 和真的 mtcute 一样
 * （2026-10-21 量过：连接、getMe 都不验，扫码才验）。config.js 每一段换一种：包里没带（deploy.sh --noapi）、带的那组被拒（被 Telegram
 * 停用了）、带的那组能用。字是真的用键盘敲进输入框的。截图到 logs/api-*.png。
 *   node test/apikey.mjs            （UILANG=en 看英文界面）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 8772, APP = `http://localhost:${PORT}/`;
const GOOD = '0123456789abcdef0123456789abcdef', BAD = 'ffffffffffffffffffffffffffffffff';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  const f = path.join(ROOT, 'app', p === '/' ? 'index.html' : p);
  if (!f.startsWith(path.join(ROOT, 'app')) || !fs.existsSync(f)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
}).listen(PORT);

const stub = `
var TG = (function () {
  var GOOD = "${GOOD}";
  return {
    init: async function () {}, mode: function () { return "stub"; },
    me: async function () { return localStorage.getItem("stub.logged") ? { id: 101, displayName: "测试" } : null; },
    login: function (onUrl) {
      var api = ApiKey.get();
      localStorage.setItem("stub.tried", (localStorage.getItem("stub.tried") || "") + api.from + ":" + api.id + ";");
      if (api.hash !== GOOD) { var e = new Error("Telegram API error 400: API_ID_INVALID"); e.text = "API_ID_INVALID"; e.code = 400; return Promise.reject(e); }
      onUrl("tg://login?token=STUB");
      return new Promise(function (resolve) { setTimeout(function () { localStorage.setItem("stub.logged", "1"); resolve(); }, 800); });
    },
    logout: async function () {}, videoCount: async function () { return 0; }, sources: async function () { return []; },
    videos: async function () { return { items: [], next: undefined, total: 0 }; }, links: async function () { return []; },
    search: async function () { return { items: [], total: 0 }; }, subtitlesFor: async function () { return []; }, describe: function (x) { return x; }
  };
})();`;
const bundle = fs.existsSync(ROOT + 'app/js/tg.bundle.js') ? null : 'window.TGLib = { qrSvg: function () { return "<svg></svg>"; } };';

let failed = 0;
const ok = (c, w) => { if (c) console.log('  ✓ ' + w); else { failed++; console.log('  ✗ ' + w); } };
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: process.env.UILANG === 'en' ? ['--lang=en-US'] : ['--lang=zh-CN'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: process.env.UILANG === 'en' ? 'en-US' : 'zh-CN' });
const errors = [], logs = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { const t = m.text(); if (/^app:/.test(t)) logs.push(t); });
/* 应用自己会往外连的两处：诊断日志的接收端（地址从 diag.js 读）、自动更新查的 GitHub / jsDelivr —— 测试里一律拦掉，不往线上传东西 */
const OUTSIDE = [new URL(/var ENDPOINT = "([^"]+)"/.exec(fs.readFileSync(ROOT + 'app/js/diag.js', 'utf8'))[1]).host, 'raw.githubusercontent.com', 'cdn.jsdelivr.net'];
await page.route((u) => OUTSIDE.includes(u.host), (r) => r.abort());
let cfg = '';
await page.route('**/js/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: cfg }));
await page.route('**/js/tg.js', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
await page.route('**/js/sites.local.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
if (bundle) await page.route('**/js/tg.bundle.js', (r) => r.fulfill({ contentType: 'text/javascript', body: bundle }));

const st = () => page.evaluate(() => ({
  form: document.getElementById('api').classList.contains('on'), home: !document.getElementById('home').classList.contains('hide'),
  panel: document.getElementById('panel').classList.contains('on'), focus: document.activeElement && document.activeElement.id,
  msg: document.getElementById('api-msg').textContent, id: document.getElementById('api-id').value, hash: document.getElementById('api-hash').value,
  api: ApiKey.get(), stored: localStorage.getItem('tg.api.v1'), tried: localStorage.getItem('stub.tried') || '', logged: !!localStorage.getItem('stub.logged'),
  qr: !!document.querySelector('#api-qr svg'), toast: document.getElementById('toast').textContent,
}));
/* 交了之后应用会重新加载页面（location.reload），碰上了就等一下再读 */
const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await fn(); } catch (e) { if (!/context was destroyed|navigation/.test(e.message)) throw e; }
  if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(150); } };
const fresh = async (config) => {
  cfg = 'var REPORT_TO = ""; ' + config;
  await page.goto(APP, { waitUntil: 'load' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('tg.lang.v1', /^en/.test(navigator.language) ? 'en' : 'zh'); });
  await page.reload({ waitUntil: 'load' });
  await sleep(600);
};
const press = async (key) => { await page.keyboard.press(key); await sleep(150); };
const typeInto = async (id, text) => { await page.focus('#' + id); await page.fill('#' + id, ''); await page.keyboard.type(text); };
const remote = (code) => page.evaluate((c) => {   // 遥控器上的键（返回 10009、屏幕键盘的「完成」65376），派发到当前焦点
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'keyCode', { get: () => c });
  (document.activeElement || document).dispatchEvent(e);
}, code);

console.log('包里没带（deploy.sh --noapi），也没填过');
await fresh('var TG_API_ID = 0; var TG_API_HASH = "";');
let s = await st();
ok(s.form && !s.home && s.focus === 'api-id' && s.qr, '一打开就是填写页，焦点在 api_id，右边有去 my.telegram.org 的码：' + JSON.stringify({ form: s.form, focus: s.focus, qr: s.qr }));
await page.screenshot({ path: ROOT + 'logs/api-1-empty.png' });
await press('Enter');
ok((await st()).msg.length > 0 && (await st()).focus === 'api-id', '什么都没填按确认：提示「先填」，焦点不动：' + (await st()).msg);
await typeInto('api-id', '12a45');
await press('Enter');
s = await st();
ok(s.focus === 'api-hash', 'api_id 填了按「完成」去下一栏');
await press('Enter');
s = await st();
ok(/12a45/.test(s.msg) && s.focus === 'api-id', 'api_id 不是数字：说清楚填的是什么，回到 api_id：' + s.msg);
await typeInto('api-id', ' 1234567 ');
await typeInto('api-hash', 'abc');
await remote(65376);
s = await st();
ok(/3/.test(s.msg) && s.focus === 'api-hash' && !s.stored, 'hash 只有 3 位（屏幕键盘的「完成」也算交）：' + s.msg);
await typeInto('api-hash', 'zz' + BAD.slice(2));
await press('Enter');
ok(/[a-f]/.test((await st()).msg) && !(await st()).stored, 'hash 里有 0–9、a–f 以外的字：' + (await st()).msg);
await typeInto('api-hash', BAD);
await press('Enter');
s = await until(async () => { const x = await st(); return x.form && /API_ID_INVALID/.test(x.msg) ? x : null; }, 5000);
ok(s && s.id === '1234567' && s.hash === BAD && s.focus === 'api-hash' && /tv:1234567/.test(s.tried),
  '格式对、Telegram 不认：扫码那一步被拒，带着刚填的回到填写页，焦点在 hash：' + JSON.stringify(s && { msg: s.msg, id: s.id, tried: s.tried, focus: s.focus }));
await page.screenshot({ path: ROOT + 'logs/api-2-rejected.png' });
await typeInto('api-hash', ' ' + GOOD.toUpperCase().slice(0, 16) + ' ' + GOOD.toUpperCase().slice(16));
await press('Enter');
s = await until(async () => { const x = await st(); return x.logged && x.home ? x : null; }, 8000);
ok(s && JSON.parse(s.stored).hash === GOOD && s.api.from === 'tv', '改对了（大写、中间带空格也认）：重新来过、扫码、进主页：' + JSON.stringify(s && { stored: s.stored, from: s.api.from }));
await page.reload({ waitUntil: 'load' }); await sleep(1200);
s = await st();
ok(!s.form && s.home && !s.panel, '再打开：不再问，直接进主页');

console.log('包里带的那组被 Telegram 拒了（停用了）');
await fresh('var TG_API_ID = 7654321; var TG_API_HASH = "' + BAD + '";');
s = await until(async () => { const x = await st(); return x.form ? x : null; }, 5000);
ok(s && /build:7654321/.test(s.tried) && s.id === '' && s.hash === '' && s.msg && !/^Telegram 不认这组/.test(s.msg),
  '一打开先用包里的去扫码，被拒 → 空着的填写页，说的是「安装包带的不再接受」：' + JSON.stringify(s && { tried: s.tried, msg: s.msg }));
await page.screenshot({ path: ROOT + 'logs/api-3-build-rejected.png' });
await remote(10009);
ok((await st()).focus !== 'api-id' && (await st()).form, '输入框里按返回：只收起键盘，不走');
await remote(10009);
ok((await st()).toast.length > 0 && (await st()).form, '再按返回：提示再按一次退出：' + (await st()).toast);
await remote(40);
ok((await st()).focus === 'api-hash', '键盘收起来时：下键到 api_hash');
await remote(10009);
await remote(38);
ok((await st()).focus === 'api-id', '上键回到 api_id');
await page.keyboard.type('2222222');
await remote(40);
ok((await st()).focus === 'api-id', '输入框里的方向键留给屏幕键盘，不换栏');
await remote(65376);
ok((await st()).focus === 'api-hash', '按「完成」去 api_hash');
await page.keyboard.type(GOOD);
await remote(10009);
await remote(13);
s = await until(async () => { const x = await st(); return x.logged && x.home ? x : null; }, 8000);
ok(s && s.api.from === 'tv' && s.api.id === 2222222, '不在输入框里按确认也交；之后用填的那组，不再用包里的：' + JSON.stringify(s && s.api && { from: s.api.from, id: s.api.id }));

/* release.sh 的打乱法（apikey.js 的 unpack 解它；release.sh 自己还会用 apikey.js 解一遍它 python 打出来的那串） */
const pack = (id, hash) => { const salt = crypto.randomBytes(8), d = Buffer.from(id + ':' + hash), o = Buffer.alloc(d.length);
  for (let i = 0; i < d.length; i++) o[i] = d[i] ^ ((salt[i % 8] * 31 + i * 17 + 0x5a) & 0xff); return Buffer.concat([salt, o]).toString('base64'); };
console.log('发布包：带的那组打乱过（TG_API_PACKED），能用');
await fresh('var TG_API_ID = 0; var TG_API_HASH = ""; var TG_API_PACKED = "' + pack(7654321, GOOD) + '";');
s = await until(async () => { const x = await st(); return x.logged && x.home ? x : null; }, 8000);
ok(s && /build:7654321/.test(s.tried) && !s.form && !s.stored, '解开了，直接扫码、进主页，不出填写页：' + JSON.stringify(s && { tried: s.tried }));
await fresh('var TG_API_ID = 0; var TG_API_HASH = ""; var TG_API_PACKED = "' + pack(7654321, GOOD).slice(0, -6) + 'AAAAAA";');
ok((await st()).form, '那一串坏了：当作没带，出填写页');

console.log('包里带的那组能用（从源码装的平时都是这样）');
await fresh('var TG_API_ID = 7654321; var TG_API_HASH = "' + GOOD + '";');
s = await until(async () => { const x = await st(); return x.logged && x.home ? x : null; }, 8000);
ok(s && !s.stored && /build:7654321/.test(s.tried) && !s.form, '不出填写页，直接扫码、进主页：' + JSON.stringify(s && { tried: s.tried, stored: s.stored }));
ok(logs.some((l) => /API ID 是安装包里带的/.test(l)) && logs.some((l) => /API ID 是电视上填的/.test(l)), '日志里写着这次用的是哪一组');
ok(!logs.some((l) => l.includes(GOOD) || l.includes(BAD)), '日志里没有 hash');
ok(!errors.length, '没有页面错误' + (errors.length ? '：' + errors.join(' / ') : ''));

await browser.close(); server.close();
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
