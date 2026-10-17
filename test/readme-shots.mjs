/* README 的截图：假的 Telegram 层（来源、视频都是编的，片子是 Blender 基金会的开源动画），不碰任何真账号、真群。
 * 本机的 js/sites.local.js 换成空的，config.js 换成假凭证 —— 截图里不会出现本机写的站点规则。
 * 要先准备（都在 test/media/，不进仓库）：
 *   curl -o test/media/sintel_trailer-1080p.mp4 https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4
 *   ffmpeg -ss 33 -i test/media/sintel_trailer-1080p.mp4 -frames:v 1 -vf scale=640:-2 test/media/thumbs/sintel_33.jpg
 * 然后：RATE=0 LAT=0 node test/serve.mjs & node test/readme-shots.mjs   → docs/screenshots/*.jpg（1600×900，macOS 的 sips 转）
 * Sintel 预告片 © Blender Foundation | durian.blender.org，CC BY 3.0。 */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'docs/screenshots/';
fs.mkdirSync(OUT, { recursive: true });
const sintel = ROOT + 'test/media/sintel_trailer-1080p.mp4';
if (!fs.existsSync(sintel)) { console.log('先下载 Sintel 预告片，见文件开头'); process.exit(1); }

/* 第一条是真能放的 Sintel 预告片；其余几部只有标题（文件不存在 —— 封面取不到帧，显示片名卡片）。都短于 40 分钟，不去找海报。 */
const day = 86400000;
const films = [
  ['Sintel 预告片', 52, 'sintel'],
  ['Big Buck Bunny 大雄兔', 596], ['Elephants Dream 大象之梦', 653], ['Tears of Steel 钢之泪', 734],
  ['Spring 春天', 464], ['Cosmos Laundromat 宇宙洗衣店', 730], ['Agent 327: Operation Barbershop', 231],
  ['Coffee Run', 184], ['Caminandes 3: Llamigos', 150]];
const items = films.map(([title, duration, file], i) => ({
  key: 'k' + i, fileKey: 'f' + i, file: file || 'missing-' + i, title, duration,
  size: file ? fs.statSync(sintel).size : Math.round(duration * 1.6 * 1048576 / 10),
  date: Date.now() - (i * 2 + 1) * day, info: { year: '', rating: '', director: '' } }));

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
          if (!r.ok) { throw new Error("HTTP " + r.status); }
          var b = new Uint8Array(await r.arrayBuffer()); yield b; pos += b.length;
        }
      }
      return { start: start, iter: gen() };
    } };
  }
  return {
    init: async function () {}, mode: function () { return "stub"; }, me: async function () { return { id: 1 }; },
    login: async function () {}, logout: async function () {},
    videoCount: async function (src) { return src === "c" ? 0 : 9; },
    sources: async function () { return [{ id: "a", title: "开源动画", kind: "channel" }, { id: "b", title: "我转发的", kind: "group" },
      { id: "d", title: "纪录片", kind: "channel" }, { id: "e", title: "旅行视频", kind: "group" }, { id: "c", title: "空的群", kind: "group" }]; },
    videos: async function () { return { items: ITEMS, next: undefined, total: ITEMS.length }; },
    links: async function () { return []; },
    thumb: async function (it) {
      if (it.file !== "sintel") { return null; }
      var b = await (await fetch("/test/media/thumbs/sintel_33.jpg")).arrayBuffer();
      return { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), bytes: b };
    },
    source: function (it) { return httpSource("/test/media/" + (it.file === "sintel" ? "sintel_trailer-1080p" : it.file) + ".mp4", it.size); },
    describe: function (x) { return x; }
  };
})();`;

const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('  pageerror ' + e.message));
await page.route('**/app/js/tg.js', r => r.fulfill({ contentType: 'text/javascript', body: stub }));
await page.route('**/app/js/sites.local.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
await page.route('**/app/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'var REPORT_TO=""; var TG_API_ID=1; var TG_API_HASH="x";' }));
const sleep = (t) => new Promise(r => setTimeout(r, t));
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code); await sleep(150); } };
const shot = async (name) => {
  const png = os.tmpdir() + '/tg-shot-' + name + '.png';
  await page.screenshot({ path: png });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1600', png, '--out', OUT + name + '.jpg'], { stdio: 'ignore' });
  console.log('  截图 ' + name);
};

await page.goto('http://localhost:8768/app/index.html');
/* 「看到哪里」：Sintel 看过一半，卡片上有进度条，打开从那里接着放 */
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await sleep(1200);
await page.evaluate(() => Store.setProgress('f0', 31, 52, 'Sintel 预告片'));
await page.reload();
await sleep(2500);
await shot('01-home');
await key(37); await sleep(700);
await shot('02-sources');
await key(39); await sleep(500);
await key(13);
/* 出画面之后再截：等播放头真的在走 */
for (let i = 0; i < 40; i++) { await sleep(250); if (await page.evaluate(() => { const v = document.getElementById('v'); return v && v.currentTime > 30 && !v.paused; })) { break; } }
await sleep(600);
await shot('03-player');
await browser.close();
