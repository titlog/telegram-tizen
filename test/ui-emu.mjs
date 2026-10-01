/* 桌面上看界面：把 js/tg.js 换成假的 Telegram 层（来源、视频用 test/media 里的文件，HTTP Range 取），
 * 按 STEPS 派发按键、截图到 logs/ui-*.png。先开 test/serve.mjs（:8768）。
 *   node test/ui-emu.mjs */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const media = ['a_h264_fast', 'c_hevc', 'e_long_2h', 'd_ac3', 'b_h264_moovend'];
const titles = ['末代皇帝 The Last Emperor (1987) 加长版', '测试片 HEVC open GOP', '黑鹰坠落 国语 高清',
  'AC-3 音轨（桌面没声音）', 'moov 在文件尾'];
const items = [];
for (let i = 0; i < 11; i++) {
  const f = media[i % media.length];
  const size = fs.statSync(`${ROOT}test/media/${f}.mp4`).size;
  items.push({ key: 'k' + i, fileKey: 'f' + i, file: f, title: titles[i % titles.length] + (i >= media.length ? ' #' + i : ''),
    size, duration: f === 'e_long_2h' ? 7200 : f === 'a_h264_fast' || f === 'b_h264_moovend' ? 60 : 30, date: Date.now() - i * 86400000 * 3,
    info: f === 'e_long_2h' ? { year: '2001', rating: '8.7', director: '雷德利·斯科特' } : { year: '', rating: '', director: '' } });
}

const stub = `
var TG = (function () {
  var ITEMS = ${JSON.stringify(items)};
  ITEMS.forEach(function (it) { it.date = new Date(it.date); });
  function httpSource(url, size) {
    var CH = Player.CH;
    return { size: size, stream: function (offset, signal, throttle) {
      var start = Math.floor(offset / CH) * CH;
      async function* gen() {
        for (var pos = start; pos < size;) {
          await throttle();
          var r = await fetch(url, { headers: { Range: "bytes=" + pos + "-" + (Math.min(size, pos + CH) - 1) }, signal: signal });
          var b = new Uint8Array(await r.arrayBuffer()); yield b; pos += b.length;
        }
      }
      return { start: start, iter: gen() };
    } };
  }
  return {
    init: async function () {}, mode: function () { return "stub"; }, me: async function () { return { id: 1 }; },
    login: async function () {}, logout: async function () {},
    videoCount: async function (src) { await new Promise(function (r) { setTimeout(r, 150); }); return src === 3 || src === 4 ? 0 : 5; },
    sources: async function () { return [{ id: "me", title: "Test", kind: "group" }, { id: 1, title: "视频分享群", kind: "group" }, { id: 4, title: "BotFather", kind: "user" },
      { id: 2, title: "一个名字特别长的频道名字特别长的频道", kind: "channel" }, { id: 3, title: "空的群", kind: "group" }]; },
    videos: async function (src) { await new Promise(function (r) { setTimeout(r, 300); });
      var list = src === 3 ? [] : src === 1 ? ITEMS.slice(0, 3) : ITEMS; return { items: list, next: undefined, total: list.length }; },
    thumb: async function (it) { window.__thumbCall && window.__thumbCall(); if (it.file === "e_long_2h" || it.file === "c_hevc") { return null; }
      var b = await (await fetch("/test/media/thumbs/" + it.file + ".jpg")).arrayBuffer();
      return { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), bytes: b }; },
    source: function (it) { return httpSource("/test/media/" + it.file + ".mp4", it.size); },
    describe: function (x) { return x; }
  };
})();`;

const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', m => { const t = m.text(); if (/^(app|player|onerror|csp):/.test(t)) console.log('  ' + t); });
let thumbCalls = 0;
await page.exposeFunction('__thumbCall', () => { thumbCalls++; });
page.on('pageerror', e => console.log('  pageerror ' + e.message));
await page.route('**/app/js/tg.js', r => r.fulfill({ contentType: 'text/javascript', body: stub }));
await page.route('**/app/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'var REPORT_TO=""; var TG_API_ID=1; var TG_API_HASH="x";' }));
const sleep = (t) => new Promise(r => setTimeout(r, t));
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code); await sleep(120); } };
const shot = async (name) => { await page.screenshot({ path: `${ROOT}logs/ui-${name}.png` }); console.log('  截图 ' + name); };

await page.goto('http://localhost:8768/app/index.html');
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await sleep(1500);
await shot('1-home');
await key(39, 2); await key(40, 1); await sleep(300);
await shot('2-focus');
await key(37, 4); await sleep(300);
await shot('3-rail');
await key(40, 3); await key(13); await sleep(800);
await shot('4-empty');
await key(37); await key(38, 3); await key(13); await sleep(800);
await key(13); await sleep(3000);
await shot('5-player');
await key(39, 3); await sleep(200);
await shot('6-seekhint');
await sleep(2500);
await key(13); await sleep(500);
await shot('7-paused');
await key(10009); await sleep(800);
await shot('8-back-home');
/* 按住右键 3.5 秒（电视的按键重复大约每 100ms 一下）：第三个是两小时那条 */
await key(39, 2); await key(13); await sleep(3000);
for (let i = 0; i < 35; i++) { await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 39, bubbles: true }))); await sleep(100); }
await shot('9-hold');
await sleep(1500);
console.log('  松手后 t=' + await page.evaluate(() => document.getElementById('v').currentTime.toFixed(0)));
console.log('  TG.thumb 调用 ' + thumbCalls + ' 次');
/* 重新打开一次（同一个浏览器资料夹，IndexedDB 还在）：封面应该全从缓存来，一次 TG.thumb、截图、维基都不该有 */
thumbCalls = 0;
console.log('  —— 重新打开');
await page.reload();
await sleep(4000);
console.log('  重开后 TG.thumb 调用 ' + thumbCalls + ' 次');
await page.screenshot({ path: `${ROOT}logs/ui-10-reopen.png` });
await browser.close();
