/* README 的截图：假的 Telegram 层（来源、视频都是编的，片子是 Blender 的开源电影），不碰任何真账号、真群。
 * 本机的 js/sites.local.js 换成空的，config.js 换成假凭证 —— 截图里不会出现本机写的站点规则。
 * 要先准备（都在 test/media/，不进仓库）：
 *   curl -o test/media/sintel_trailer-1080p.mp4 https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4
 *   ffmpeg -ss 33 -i test/media/sintel_trailer-1080p.mp4 -frames:v 1 -vf crop=1920:818:0:130,scale=640:-2 test/media/thumbs/sintel_33.jpg   # 裁掉上下黑边
 * 其余几部的封面是从 Wikimedia Commons 上的正片里取的一帧（下面 films 里的文件名和秒数），一次一帧、中间歇几秒 ——
 * 并发的范围请求它回 429：
 *   ffmpeg -ss 200 -i https://upload.wikimedia.org/wikipedia/commons/c/c0/Big_Buck_Bunny_4K.webm \
 *          -frames:v 1 -vf scale=640:-2,format=yuvj420p test/media/thumbs/bbb_200.jpg
 * 然后：RATE=0 LAT=0 node test/serve.mjs & node test/readme-shots.mjs   → docs/screenshots/*.jpg（1600×900，macOS 的 sips 转）
 * 片子都是 Blender Foundation / Blender Studio 的，CC BY（2.5–4.0，各片见 films）。 */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'docs/screenshots/';
/* UILANG=en：英文界面的那一套（docs/screenshots/en-*.jpg，README.en.md 用），片名、群名也换成英文 */
const EN = process.env.UILANG === 'en', PRE = EN ? 'en-' : '';
fs.mkdirSync(OUT, { recursive: true });
const sintel = ROOT + 'test/media/sintel_trailer-1080p.mp4';
if (!fs.existsSync(sintel)) { console.log('先下载 Sintel 预告片，见文件开头'); process.exit(1); }

/* 第一条是真能放的 Sintel 预告片；其余几部只有封面（片子文件不存在，截图里不点开）。都短于 40 分钟，不去找海报。
 * [标题, 时长秒, 封面（test/media/thumbs/ 下）, 能放的文件]；注释是作者、协议、封面取自 Commons 上的哪个文件： */
const day = 86400000;
const films = [
  ['Sintel 预告片', 52, 'sintel_33', 'sintel'],            // © Blender Foundation | durian.blender.org，CC BY 3.0；download.blender.org/durian/trailer
  ['Big Buck Bunny 大雄兔', 635, 'bbb_200'],                // © Blender Foundation | peach.blender.org，CC BY 3.0；c/c0/Big_Buck_Bunny_4K.webm
  ['Elephants Dream 大象之梦', 658, 'ed_120'],              // © Blender Foundation / Netherlands Media Art Institute，CC BY 2.5；2/28/Elephants_Dream_(2006)_1080p24.webm
  ['Tears of Steel 钢之泪', 734, 'tos_250'],                // © Blender Foundation | mango.blender.org，CC BY 3.0；c/cb/Tears_of_Steel_1080p.webm
  ['Spring 春天', 464, 'spring_70'],                        // © Blender Foundation（Andy Goralczyk），CC BY 4.0；a/a5/Spring_-_Blender_Open_Movie.webm
  ['Sprite Fright', 630, 'sprite_90'],                      // © Blender Studio，CC BY 4.0；7/76/Sprite_Fright_-_Blender_Open_Movie-full_movie.webm
  ['Charge', 263, 'charge_110'],                            // © Blender Studio，CC BY 4.0；7/7a/Charge_-_Blender_Open_Movie-full_movie.webm
  ['Coffee Run', 185, 'coffee_25'],                         // © Blender Foundation，CC BY 4.0；3/3f/Coffee_Run_-_Blender_Open_Movie-full_movie.webm
  ['Caminandes 3: Llamigos', 150, 'cami_55']];              // © Blender Institute（Pablo Vazquez），CC BY 3.0；a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm
for (const [, , thumb] of films) {
  if (!fs.existsSync(ROOT + 'test/media/thumbs/' + thumb + '.jpg')) { console.log('缺封面 test/media/thumbs/' + thumb + '.jpg，见文件开头'); process.exit(1); }
}
const enTitle = (t) => t === 'Sintel 预告片' ? 'Sintel (trailer)' : t.replace(/\s*[\u4e00-\u9fff].*$/, '');
const items = films.map(([title, duration, thumb, file], i) => ({
  key: 'k' + i, fileKey: 'f' + i, file: file || 'missing-' + i, thumb, title: EN ? enTitle(title) : title, duration,
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
    sources: async function () { var en = ${EN}; return [{ id: "a", title: en ? "Open movies" : "开源动画", kind: "channel" }, { id: "b", title: en ? "Forwarded by me" : "我转发的", kind: "group" },
      { id: "d", title: en ? "Documentaries" : "纪录片", kind: "channel" }, { id: "e", title: en ? "Travel" : "旅行视频", kind: "group" }, { id: "c", title: en ? "Empty group" : "空的群", kind: "group" }]; },
    videos: async function () { return { items: ITEMS, next: undefined, total: ITEMS.length }; },
    links: async function () { return []; },
    thumb: async function (it) {
      var b = await (await fetch("/test/media/thumbs/" + it.thumb + ".jpg")).arrayBuffer();
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
/* 应用自己会往外连的两处：诊断日志的接收端（地址从 diag.js 读）、自动更新查的 GitHub / jsDelivr —— 测试里一律拦掉，不往线上传东西 */
const OUTSIDE = [new URL(/var ENDPOINT = "([^"]+)"/.exec(fs.readFileSync(ROOT + 'app/js/diag.js', 'utf8'))[1]).host, 'raw.githubusercontent.com', 'cdn.jsdelivr.net'];
await page.route((u) => OUTSIDE.includes(u.host), (r) => r.abort());
await page.route('**/app/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'var REPORT_TO=""; var TG_API_ID=1; var TG_API_HASH="x";' }));
const sleep = (t) => new Promise(r => setTimeout(r, t));
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code); await sleep(150); } };
const shot = async (name) => {
  const png = os.tmpdir() + '/tg-shot-' + name + '.png';
  await page.screenshot({ path: png });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1600', png, '--out', OUT + PRE + name + '.jpg'], { stdio: 'ignore' });
  console.log('  截图 ' + name);
};

await page.goto('http://localhost:8768/app/index.html');
/* 「看到哪里」：Sintel 看过一半，卡片上有进度条，打开从那里接着放 */
await page.evaluate((l) => { try { localStorage.clear(); localStorage.setItem('tg.lang.v1', l); } catch (e) {} }, EN ? 'en' : 'zh');
await page.reload();
await sleep(1200);
await page.evaluate((t) => Store.setProgress('f0', 31, 52, t), items[0].title);
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
