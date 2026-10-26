/* README 的截图：假的 Telegram 层（来源、群里的消息都是编的），不碰任何真账号、真群、真网站。片子都能合法转发：
 * Blender Foundation / Blender Studio 的开源电影（CC BY）、archive.org 上公有领域 / CC0 的老电影。
 * 本机的 js/sites.local.js 换成空的，config.js 换成假凭证 —— 截图里不会出现本机写的站点规则；archive.org 那条是仓库里的 sites.js。
 * 要先准备（都在 test/media/，不进仓库）：
 *   curl -o test/media/sintel_trailer-1080p.mp4 https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4
 *   ffmpeg -ss 33 -i test/media/sintel_trailer-1080p.mp4 -frames:v 1 -vf crop=1920:818:0:130,scale=640:-2 test/media/thumbs/sintel_33.jpg   # 裁掉上下黑边
 * Blender 其余几部的封面是从 Wikimedia Commons 上的正片里取的一帧（下面 films 里的文件名和秒数），一次一帧、中间歇几秒 ——
 * 并发的范围请求它回 429：
 *   ffmpeg -ss 200 -i https://upload.wikimedia.org/wikipedia/commons/c/c0/Big_Buck_Bunny_4K.webm \
 *          -frames:v 1 -vf scale=640:-2,format=yuvj420p test/media/thumbs/bbb_200.jpg
 * archive.org 那几部同样取一帧（links 里的地址 + 秒数，片子文件见各条注释）：
 *   ffmpeg -ss 1150 -i https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_720p.mp4 \
 *          -frames:v 1 -vf scale=640:-2,format=yuvj420p test/media/thumbs/ia_sita_1150.jpg
 * Sintel 正片：官方的 MKV（H.264 1080p + AC-3 5.1 + 10 条内嵌字幕）截一分钟。音频转成 AAC —— 桌面 Chrome 的 MSE 不认 AC-3（电视认）。
 * 视频原样拷贝时从 104 秒前面那个关键帧（98.958 秒）开始，音频要从同一处单独转，不然开头 5 秒没有声音、音视频缓冲的交集
 * 从 5 秒起，播放头停在 0 走不动（第一次就这么截的）：
 *   S=https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv; cd test/media/readme
 *   ffmpeg -ss 104 -i $S -t 62 -map 0:v -map 0:s -c copy v.mkv && ffmpeg -ss 98.958 -i $S -t 67.2 -map 0:a:0 -c:a aac -ac 2 -b:a 192k a.mka
 *   ffmpeg -i v.mkv -i a.mka -map 0:v -map 1:a -map 0:s -c copy -metadata:s:a:0 title= -metadata:s:a:0 language=eng sintel_part.mkv
 * 中文是官方另外给的外挂字幕（GBK），按截出来那段的起点（98.958 秒 = 内嵌英文字幕和它前两句的差）挪过时间、还是 GBK：
 *   https://download.blender.org/durian/subs/sintel_chs.srt → 每条减 98.958 秒 → test/media/readme/Sintel.2010.1080p.chs.srt
 * 网页链接那张：Sita Sings the Blues 的 1080p 原片截 45 秒，重新编码；archive.org 的接口和下载都在这里拦下来答（见 IA）。
 * 不能 -c copy：从中间截出来的视频带 3.3 秒的预滚（编辑列表盖住）、音频从 -1 秒起，播放引擎不出画面（见 CLAUDE.md）：
 *   ffmpeg -ss 1688 -i https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_1080p.mp4 -t 45 -map 0:v:0 -map 0:a:0 \
 *          -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k -movflags +faststart test/media/readme/sita_1080p_part.mp4
 * 音乐那张：Kimiko Ishizaka 弹的 The Open Goldberg Variations（2012，CC0），archive.org 上的前两首原样下下来（放第一首、预先下第二首）；
 * 专辑图是 Haussmann 1748 年画的巴赫像（公有领域，Wikimedia Commons），裁成方的：
 *   B='https://archive.org/download/OpenGoldbergVariations/Kimiko%20Ishizaka%20-%20J.S.%20Bach-%20-Open-%20Goldberg%20Variations%2C%20BWV%20988%20%28Piano%29%20-%20'
 *   curl -Lo test/media/readme/ogv_01.mp3 "${B}01%20Aria.mp3"; curl -Lo test/media/readme/ogv_02.mp3 "${B}02%20Variatio%201%20a%201%20Clav..mp3"
 *   ffmpeg -i https://upload.wikimedia.org/wikipedia/commons/6/6a/Johann_Sebastian_Bach.jpg \
 *          -vf crop=1180:1180:98:30,scale=640:640,format=yuvj420p -q:v 3 test/media/thumbs/bach_1748.jpg
 * 然后：RATE=0 LAT=0 node test/serve.mjs & node test/readme-shots.mjs   → docs/screenshots/*.jpg（1600×900，macOS 的 sips 转） */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'docs/screenshots/';
/* UILANG=en：英文界面的那一套（docs/screenshots/en-*.jpg，README.md 用 —— GitHub 默认展示的是英文版；中文版 README.zh.md 用不带 en- 的），片名、群名也换成英文 */
const EN = process.env.UILANG === 'en', PRE = EN ? 'en-' : '';
fs.mkdirSync(OUT, { recursive: true });
const SINTEL = 'readme/sintel_part.mkv', SITA = 'readme/sita_1080p_part.mp4', CHS = 'readme/Sintel.2010.1080p.chs.srt';
for (const f of [SINTEL, SITA, CHS, 'readme/ogv_01.mp3', 'readme/ogv_02.mp3']) {
  if (!fs.existsSync(ROOT + 'test/media/' + f)) { console.log('缺 test/media/' + f + '，见文件开头'); process.exit(1); }
}

/* 群里发的视频和文件。第一条是真能放的 Sintel 正片（卡片上写正片的大小、时长，放的是截的那一分钟）；其余只有封面（截图里不点开）。
 * [标题, 时长秒, 封面（test/media/thumbs/ 下）, 第几天前发的]；注释是作者、协议、封面取自 Commons 上的哪个文件： */
const day = 86400000;
const films = [
  ['Sintel 辛特尔', 888, 'sintel_33', 1],                    // © Blender Foundation | durian.blender.org，CC BY 3.0；download.blender.org/durian/movies
  ['Big Buck Bunny 大雄兔', 635, 'bbb_200', 3],               // © Blender Foundation | peach.blender.org，CC BY 3.0；c/c0/Big_Buck_Bunny_4K.webm
  ['Tears of Steel 钢之泪', 734, 'tos_250', 5],               // © Blender Foundation | mango.blender.org，CC BY 3.0；c/cb/Tears_of_Steel_1080p.webm
  ['Spring 春天', 464, 'spring_70', 6],                       // © Blender Foundation（Andy Goralczyk），CC BY 4.0；a/a5/Spring_-_Blender_Open_Movie.webm
  ['Sprite Fright', 630, 'sprite_90', 8],                     // © Blender Studio，CC BY 4.0；7/76/Sprite_Fright_-_Blender_Open_Movie-full_movie.webm
  ['Charge', 263, 'charge_110', 9],                           // © Blender Studio，CC BY 4.0；7/7a/Charge_-_Blender_Open_Movie-full_movie.webm
  ['Elephants Dream 大象之梦', 658, 'ed_120', 10],            // © Blender Foundation / Netherlands Media Art Institute，CC BY 2.5；2/28/Elephants_Dream_(2006)_1080p24.webm
  ['Coffee Run', 185, 'coffee_25', 11],                       // © Blender Foundation，CC BY 4.0；3/3f/Coffee_Run_-_Blender_Open_Movie-full_movie.webm
  ['Caminandes 3: Llamigos', 150, 'cami_55', 12]];            // © Blender Institute（Pablo Vazquez），CC BY 3.0；a/ab/Caminandes_3_-_Llamigos_-_Blender_Animated_Short.webm
/* 群里发的 archive.org 片子页链接（仓库里的 sites.js 认得）：[标题, archive.org 编号, 封面, 第几天前发的] */
const pages = [
  ['Sita Sings the Blues 希塔唱蓝调', 'Sita_Sings_the_Blues', 'ia_sita_1150', 2],  // Nina Paley 2008，CC0；Sita_Sings_the_Blues_720p.mp4 第 1150 秒
  ['The General 将军号（1926）', 'TheGeneral1926', 'ia_general_3300', 4],            // Buster Keaton 1926，公有领域；The_General_1926_720p.mp4 第 3300 秒
  ['His Girl Friday 女友礼拜五（1940）', 'his_girl_friday', 'ia_hgf_400', 7]];      // Howard Hawks 1940，公有领域（版权没续期）；his_girl_friday.mp4 第 400 秒
/* 「钢琴」频道里的歌：The Open Goldberg Variations 的前六首（歌名、时长、大小照 archive.org 上的 MP3），前两首真能放 */
const tracks = [['Aria', 299.5, 5849600], ['Variatio 1 a 1 Clav.', 115.5, 2637824], ['Variatio 2 a 1 Clav.', 123, 2537472],
  ['Variatio 3 a 1 Clav. Canone all Unisuono', 116, 2524160], ['Variatio 4 a 1 Clav.', 68, 1562624], ['Variatio 5 a 1 ovvero 2 Clav.', 94, 2113024]];
for (const t of [...films, ...pages].map(x => x[2]).concat('bach_1748')) {
  if (!fs.existsSync(ROOT + 'test/media/thumbs/' + t + '.jpg')) { console.log('缺封面 test/media/thumbs/' + t + '.jpg，见文件开头'); process.exit(1); }
}
const enTitle = (t) => t.replace(/\s*[一-鿿].*?(（(\d{4})）)?$/, (m, p, y) => y ? ' (' + y + ')' : '');
const info = { year: '', rating: '', director: '' };
const GROUP = EN ? 'Forwarded by me' : '我转发的', PIANO = EN ? 'Piano' : '钢琴曲';
/* msg（会话 + 消息编号）和 chatTitle 是给播放记录的：记下的是这两样，打开时按它们找回来（byRefs），卡片上写来自哪个群 */
const items = films.map(([title, duration, thumb, ago], i) => ({
  key: 'k' + i, fileKey: 'f' + i, thumb, title: EN ? enTitle(title) : title, duration, date: Date.now() - ago * day, info,
  msg: { id: 100 + i, chat: { id: 'a' } }, chatTitle: GROUP,
  ...(i === 0 ? { file: SINTEL, fileName: 'Sintel.2010.1080p.mkv', asFile: true, size: 1180090590, bytes: fs.statSync(ROOT + 'test/media/' + SINTEL).size }
              : { file: 'missing-' + i, size: Math.round(duration * 1.6 * 1048576 / 10) }) }));
const music = tracks.map(([title, duration, size], i) => ({
  kind: 'music', key: 'm' + i, fileKey: 'm' + i, thumb: 'bach_1748', title, performer: 'Kimiko Ishizaka', ext: 'mp3', mime: 'audio/mpeg',
  size, duration, fileName: `Kimiko Ishizaka - Goldberg Variations - ${String(i + 1).padStart(2, '0')} ${title}.mp3`, date: Date.now() - (2 * day + i * 60000), info,
  msg: { id: 200 + i, chat: { id: 'm' } }, chatTitle: PIANO, file: i < 2 ? `readme/ogv_0${i + 1}.mp3` : 'missing-m' + i }));
const links = pages.map(([title, id, thumb, ago], i) => {
  const url = 'https://archive.org/details/' + id;
  return { kind: 'web', key: 'w' + i, fileKey: 'web:' + url, url, site: 'archive.org', doc: {}, thumb, title: EN ? enTitle(title) : title,
    fileName: '', caption: '', size: 0, duration: 0, width: 0, height: 0, mime: '', date: Date.now() - ago * day, hasCover: false, info };
});
const subFiles = { 'Sintel.2010.1080p.mkv': [{ name: 'Sintel.2010.1080p.chs.srt', lang: '简体', size: fs.statSync(ROOT + 'test/media/' + CHS).size, score: 4, doc: { path: '/test/media/' + CHS } }] };

const stub = `
var TG = (function () {
  var ITEMS = ${JSON.stringify(items)}, LINKS = ${JSON.stringify(links)}, MUSIC = ${JSON.stringify(music)}, SUBS = ${JSON.stringify(subFiles)};
  ITEMS.concat(LINKS, MUSIC).forEach(function (it) { it.date = new Date(it.date); });
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
    sources: async function () { var en = ${EN}; return [{ id: "a", title: ${JSON.stringify(GROUP)}, kind: "group" }, { id: "b", title: en ? "Open movies" : "开源动画", kind: "channel" },
      { id: "d", title: en ? "Classic films" : "老电影", kind: "channel" }, { id: "m", title: ${JSON.stringify(PIANO)}, kind: "channel" },
      { id: "e", title: en ? "Documentaries" : "纪录片", kind: "channel" }, { id: "c", title: en ? "Empty group" : "空的群", kind: "group" }]; },
    /* 给副本：放过之后应用会把截的那一分钟的长度写回卡片（当文件发的视频本来没有时长），播放记录里就成了 1:07 */
    videos: async function (src) { var list = (src === "m" ? MUSIC : ITEMS).map(function (x) { return Object.assign({}, x); }); return { items: list, next: undefined, total: list.length }; },
    links: async function (src) { return src === "m" ? [] : LINKS; },
    /* 播放记录：按「会话 + 消息编号」找回（真的 tg.js 是 getMessages），网页链接按地址 */
    byRefs: async function (refs) {
      var all = ITEMS.concat(MUSIC), items = [];
      refs.forEach(function (h) {
        var it = h.kind === "web" ? LINKS.filter(function (x) { return x.url === h.url; })[0]
                                  : all.filter(function (x) { return x.msg.chat.id === h.chat && x.msg.id === h.msg; })[0];
        if (it) { items.push(Object.assign({}, it, { playedAt: h.at })); }
      });
      return { items: items, missing: refs.length - items.length };
    },
    thumb: async function (it) {
      var b = await (await fetch("/test/media/thumbs/" + it.thumb + ".jpg")).arrayBuffer();
      return { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), bytes: b };
    },
    source: function (it) { return httpSource("/test/media/" + it.file, it.bytes || it.size); },
    subtitlesFor: async function (it) { return SUBS[it.fileName] || []; },
    download: async function (doc) { return new Uint8Array(await (await fetch(doc.path)).arrayBuffer()); },
    describe: function (x) { return x; }
  };
})();`;

const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  /* 网页链接里的 MP4 由播放引擎 fetch（跨域、带 Range）；电视上 widget 不受 CORS 约束，这里关掉跨域检查 */
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => console.log('  pageerror ' + e.message));
if (process.env.DEBUG) page.on('console', m => { if (/^(app|player|web|onerror):/.test(m.text())) console.log('  ' + m.text()); });     // DEBUG=1：应用自己写的日志
await page.route('**/app/js/tg.js', r => r.fulfill({ contentType: 'text/javascript', body: stub }));
await page.route('**/app/js/sites.local.js', r => r.fulfill({ contentType: 'text/javascript', body: '' }));
/* 应用自己会往外连的两处：诊断日志的接收端（地址从 diag.js 读）、自动更新查的 GitHub / jsDelivr —— 测试里一律拦掉，不往线上传东西 */
const OUTSIDE = [new URL(/var ENDPOINT = "([^"]+)"/.exec(fs.readFileSync(ROOT + 'app/js/diag.js', 'utf8'))[1]).host, 'raw.githubusercontent.com', 'cdn.jsdelivr.net'];
await page.route((u) => OUTSIDE.includes(u.host), (r) => r.abort());
/* archive.org（IA）：接口答一份照真接口抄的文件表（sites.js 从里面挑 1080p 那份），下载转到本地截的那段；别的请求一律拦掉 */
const IA = { metadata: { identifier: 'Sita_Sings_the_Blues', mediatype: 'movies' }, files: [
  { name: 'Sita_Sings_the_Blues_1080p.mp4', source: 'original', format: 'h.264 MPEG4', size: '4428753160', length: '4891.24', width: '1920', height: '1080' },
  { name: 'Sita_Sings_the_Blues_720p.mp4', source: 'original', format: 'h.264 MPEG4', size: '2594195433', length: '4891.24', width: '1280', height: '720' },
  { name: 'Sita_Sings_the_Blues.mp4', source: 'derivative', format: 'h.264', size: '507536373', length: '4891.24', width: '638', height: '360' },
  { name: 'SSTB_1080_FINAL_2009_02.mov', source: 'original', format: 'QuickTime', size: '16289618317', length: '4909.99', width: '1920', height: '1080' }] };
await page.route((u) => u.host.endsWith('archive.org'), (r) => {
  const u = new URL(r.request().url());
  if (u.pathname === '/metadata/Sita_Sings_the_Blues') {
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(IA),
      headers: { 'Access-Control-Allow-Origin': 'http://localhost:8768', 'Access-Control-Allow-Credentials': 'true' } });
  }
  if (u.pathname === '/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_1080p.mp4') {
    return r.fulfill({ status: 302, headers: { Location: 'http://localhost:8768/test/media/' + SITA } });
  }
  return r.abort();
});
await page.route('**/app/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'var REPORT_TO=""; var TG_API_ID=1; var TG_API_HASH="x";' }));
const sleep = (t) => new Promise(r => setTimeout(r, t));
/* 一下 = keydown + keyup（确认键松开时才算短按，按住 650ms 是菜单，见 test/ui-emu.mjs） */
const ev = (type, code) => page.evaluate(([t, c]) => document.dispatchEvent(new KeyboardEvent(t, { keyCode: c, bubbles: true })), [type, code]);
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await ev('keydown', code); await sleep(40); await ev('keyup', code); await sleep(150); } };
const hold = async (code, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await ev('keydown', code); await sleep(100); } await ev('keyup', code); await sleep(300); };
const vt = () => page.evaluate(() => document.getElementById('v').currentTime);
const subText = () => page.evaluate(() => (document.getElementById('sub').textContent || '').trim());
const waitFor = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(200); } return false; };
const shot = async (name) => {
  const png = os.tmpdir() + '/tg-shot-' + name + '.png';
  await page.screenshot({ path: png });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '1600', png, '--out', OUT + PRE + name + '.jpg'], { stdio: 'ignore' });
  console.log('  截图 ' + name);
};

await page.goto('http://localhost:8768/app/index.html');
/* 「看到哪里」：钢之泪看过一半，卡片上有进度条 */
await page.evaluate((l) => { try { localStorage.clear(); localStorage.setItem('tg.lang.v1', l); } catch (e) {} }, EN ? 'en' : 'zh');
await page.reload();
await sleep(1200);
await page.evaluate((t) => Store.setProgress('f2', 410, 734, t), items[2].title);
/* 播放记录里早几天放过的（之后真放的 Sintel、Sita、Aria 排在它们前面）：钢之泪（看到一半）、将军号、大雄兔 */
await page.evaluate(([tos, gen, bbb, gurl]) => {
  Store.setProgress('web:' + gurl, 1830, 4500, gen);
  Store.addHistory({ k: 'f1', kind: 'video', chat: 'a', msg: 101, title: bbb, at: Date.now() - 6 * 86400000 });
  Store.addHistory({ k: 'web:' + gurl, kind: 'web', url: gurl, site: 'archive.org', image: '', title: gen, at: Date.now() - 4 * 86400000 });
  Store.addHistory({ k: 'f2', kind: 'video', chat: 'a', msg: 102, title: tos, at: Date.now() - 3 * 86400000 });
}, [items[2].title, links[1].title, items[1].title, links[1].url]);
await page.reload();
await sleep(3000);
await shot('01-home');
/* 焦点开机停在看过的钢之泪（第二排中间）：左一下到第一列，再左一下才滑出来源栏 */
await key(37, 2); await sleep(700);
await shot('02-sources');
await key(39); await sleep(500);

/* Sintel（第一排第一个）：MKV、内嵌 10 条字幕 + 群里的中文字幕文件。中文界面自动开中文（对白是英语）；英文界面对白就是界面语言，
 * 不自动开 —— 在菜单里选英语 */
await key(38); await sleep(300);
await key(13);
if (!await waitFor(async () => (await vt()) > 3, 15000)) console.log('  ✗ Sintel 15 秒没放起来');
await hold(13, 900);
const rows = await page.evaluate(() => [...document.querySelectorAll('#menu .mi')].map(e => e.textContent));
console.log('  菜单：' + rows.join(' | '));
await shot('04-menu');
if (EN) {
  const want = rows.findIndex(r => /^English/.test(r.replace(/^✓/, ''))), cur = await page.evaluate(() => [...document.querySelectorAll('#menu .mi')].findIndex(e => e.classList.contains('focus')));
  await key(want > cur ? 40 : 38, Math.abs(want - cur)); await key(13);
} else {
  await key(10009);
}
/* 第二句（12.8–16.8 秒）在屏幕上时截 */
if (!await waitFor(async () => (await vt()) > 13.6 && (await subText()) !== '', 25000)) console.log('  ✗ 13.6 秒后没有字幕：t=' + (await vt()).toFixed(1));
console.log('  字幕：' + await subText());
await shot('03-player');
await key(10009); await sleep(1200);

/* 网页链接：第二张卡片是 archive.org 的 Sita Sings the Blues（sites.js 问接口 → 1080p 原片） */
await key(39); await sleep(300);
await key(13);
if (!await waitFor(async () => (await vt()) > 9, 25000)) console.log('  ✗ Sita 25 秒没放到第 9 秒');
console.log('  网页链接：' + await page.evaluate(() => { const v = document.getElementById('v'); return v.videoWidth + 'x' + v.videoHeight + ' t=' + v.currentTime.toFixed(1); }));
/* 暂停一下，片名和进度条露出来（不然截出来就是一张电影画面，看不出是这个应用在放） */
await key(13); await sleep(800);
await shot('05-web');
await key(10009); await sleep(1200);

/* 音乐：来源栏里的「钢琴曲」频道 → 第一首 Aria。放到几秒、专辑图和底图都出来了再截 */
const txt = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const railTo = async (re) => {
  await key(37, 3); await sleep(500);
  for (let i = 0; i < 12 && !re.test(await txt('#rail-list .src.focus') || ''); i++) await key(40);
  for (let i = 0; i < 12 && !re.test(await txt('#rail-list .src.focus') || ''); i++) await key(38);
  if (!re.test(await txt('#rail-list .src.focus') || '')) console.log('  ✗ 来源栏里没找到 ' + re);
  await key(13); await sleep(2000);
};
await railTo(/Piano|钢琴曲/);
await key(13);
const at = () => page.evaluate(() => document.getElementById('au').currentTime);
if (!await waitFor(async () => (await at()) > 6, 20000)) console.log('  ✗ Aria 20 秒没放到第 6 秒');
console.log('  音乐：' + await txt('#mu-title') + ' / ' + await txt('#mu-artist') + ' / ' + await txt('#mu-from') + ' / ' + await txt('#mu-next'));
await shot('06-music');
await key(10009); await sleep(1000);

/* 播放记录：最近放的在前（Aria 还在放），带着来自哪个群、看到哪里 */
await railTo(/^(History|播放记录)$/);
await sleep(1500);
console.log('  播放记录：' + await page.evaluate(() => [...document.querySelectorAll('.card')].map(c => c.querySelector('.title').textContent + '〔' + c.querySelector('.meta').textContent + '〕').join(' / ')));
await shot('07-history');
await browser.close();
