/* 桌面上看界面：把 js/tg.js 换成假的 Telegram 层（来源、视频用 test/media 里的文件，HTTP Range 取），
 * 按 STEPS 派发按键、截图到 logs/ui-*.png。先开 test/serve.mjs（:8768）。
 *   node test/ui-emu.mjs */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
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

/* 群里发的网页链接（web.js）：一条直接是 .m3u8 的，指向 test/media/hls（AES-128 加密的 HLS，生成方法：
 * cd test/media/hls && openssl rand 16 > k.key && printf 'k.key\\nk.key\\n%s\\n' $(openssl rand -hex 16) > k.info &&
 * ffmpeg -i ../a_h264_fast.mp4 -c copy -bsf:v h264_mp4toannexb -hls_time 4 -hls_playlist_type vod -hls_key_info_file k.info -hls_segment_filename 'a%03d.ts' a.m3u8） */
const webUrl = 'http://localhost:8768/test/media/hls/a.m3u8';
const favUrl = 'https://videos.example/my/favourites/';
const links = [{ kind: 'weblist', url: favUrl, title: '示例站 收藏', date: Date.now() - 50 * 86400000 }, { kind: 'web', key: 'w0', fileKey: 'web:' + webUrl, url: webUrl, site: 'localhost', doc: null, title: '网页链接：HLS 加密测试片',
  size: 0, duration: 0, date: Date.now() - 40 * 86400000, info: { year: '', rating: '', director: '' } }];

const stub = `
var TG = (function () {
  var ITEMS = ${JSON.stringify(items)};
  ITEMS.forEach(function (it) { it.date = new Date(it.date); });
  var LINKS = ${JSON.stringify(links)};
  LINKS.forEach(function (it) { it.date = new Date(it.date); });
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
    links: async function (src) { return src === 3 || src === 1 ? [] : LINKS; },
    thumb: async function (it) { window.__thumbCall && window.__thumbCall(); if (it.file === "e_long_2h" || it.file === "c_hevc") { return null; }
      var b = await (await fetch("/test/media/thumbs/" + it.file + ".jpg")).arrayBuffer();
      return { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), bytes: b }; },
    source: function (it) { return httpSource("/test/media/" + it.file + ".mp4", it.size); },
    describe: function (x) { return x; }
  };
})();`;

const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'],   // 电视上 widget 不受 CORS 约束，假站点的请求跨域
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', m => { const t = m.text(); if (/^(app|player|web|onerror|csp):/.test(t)) console.log('  ' + t); });
let thumbCalls = 0;
await page.exposeFunction('__thumbCall', () => { thumbCalls++; });
page.on('pageerror', e => console.log('  pageerror ' + e.message));
await page.route('**/app/js/tg.js', r => r.fulfill({ contentType: 'text/javascript', body: stub }));
/* 假的网站 videos.example，和它的站点规则（换掉本机的 js/sites.local.js，测试不依赖本机写了哪些站）：
 * /login 收 test / pw、回账号编号 7；要登录的 /my/favourites/ 登录后改读公开的 /members/7/favourites/，两页（24 + 6）；
 * 片子页 /v/… 里写着本地 HLS 的地址。页面在 localhost，XHR 带 cookie 跨域，所以回 CORS 头（电视上 widget 不受 CORS 约束，用不着） */
const siteRule = `Web.register({
  name: "示例站", host: /(^|\\.)videos\\.example$/i, path: /^\\/v\\/[^/]+/,
  fromHtml: function (h) { var m = /data-hls="([^"]+)"/.exec(h); return m && m[1]; },
  list: function (u) { return /^\\/(my|members)\\//.test(u.pathname); },
  listTitle: function (u) { return /^\\/my\\//.test(u.pathname) ? "示例站 我的收藏" : ""; },
  needLogin: function (u) { return /^\\/my\\//.test(u.pathname); },
  publicUrl: function (u, a) { return u.origin + "/members/" + a.userId + u.pathname.replace(/^\\/my/, "") + u.search; },
  isLoginPage: function (url) { return /\\/login\\b/.test(url); },
  parseList: function (html, base, page, H) {
    var d = new DOMParser().parseFromString(html, "text/html"), items = [];
    d.querySelectorAll("a.item").forEach(function (a) {
      items.push({ url: new URL(a.getAttribute("href"), base).href, title: a.textContent.trim(),
        image: new URL(a.getAttribute("data-img"), base).href, duration: H.durSec(a.getAttribute("data-dur")) });
    });
    var n = d.querySelector("a.next");
    return { items: items, next: n ? { page: page + 1, url: new URL(n.getAttribute("href"), base).href } : null, total: 30 };
  },
  login: async function (user, pass, H) {
    var r = await H.postRetry("https://videos.example/login", "user=" + encodeURIComponent(user) + "&pass=" + encodeURIComponent(pass), 10000);
    var j = JSON.parse(r.text);
    return j.ok ? { ok: true, msg: "成功", userId: j.id, name: user, favs: 30 } : { ok: false, msg: j.error };
  }
});`;
await page.route('**/app/js/sites.local.js', r => r.fulfill({ contentType: 'text/javascript', body: siteRule }));
let siteIn = false;
const ORIGIN = 'http://localhost:8768';
const cors = { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' };
const item = (i) => `<a class="item" href="https://videos.example/v/fake-${i}/" data-img="${ORIGIN}/test/media/thumbs/a_h264_fast.jpg" data-dur="1:00">收藏里的第 ${i + 1} 个</a>`;
await page.route('https://videos.example/**', async (route, req) => {
  const u = new URL(req.url());
  if (req.method() === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-requested-with' } });
  }
  const html = (body) => route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body });
  if (u.pathname === '/login' && req.method() === 'POST') {
    const f = new URLSearchParams(req.postData());
    siteIn = f.get('user') === 'test' && f.get('pass') === 'pw';
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors,
      body: JSON.stringify(siteIn ? { ok: true, id: '7' } : { ok: false, error: '账号或密码错误' }) });
  }
  /* 「我的收藏」登录一次拿到账号编号（7）之后，读的是公开的 /members/7/favourites/ */
  if (u.pathname === '/members/7/favourites/') {
    if (u.searchParams.get('page') === '2') { return html(Array.from({ length: 6 }, (_, i) => item(24 + i)).join('')); }
    return html('<title>我的收藏</title>' + Array.from({ length: 24 }, (_, i) => item(i)).join('') + '<a class="next" href="?page=2">下一页</a>');
  }
  if (u.pathname.startsWith('/v/')) { return html(`<div data-hls="${ORIGIN}/test/media/hls/a.m3u8"></div>`); }
  return html('<title>示例站</title>首页');
});
await page.route('**/app/js/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'var REPORT_TO=""; var TG_API_ID=1; var TG_API_HASH="x";' }));
const sleep = (t) => new Promise(r => setTimeout(r, t));
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await page.evaluate(c => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: c, bubbles: true })), code); await sleep(120); } };
const shot = async (name) => { await page.screenshot({ path: `${ROOT}logs/ui-${name}.png` }); console.log('  截图 ' + name); };

await page.goto('http://localhost:8768/app/index.html');
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await sleep(1500);
await shot('1-home');
/* 网格只在露不全时才滚：一路往下再一路往上，每一步记焦点在第几排、网格滚了多少（看得见的几排之间移动应该不滚） */
{
  const pos = async () => page.evaluate(() => { const f = document.querySelector('.card.focus');
    return Math.round(parseInt(f.style.top) / 470) + '排/' + (document.getElementById('grid').style.transform.match(/-?\d+/) || ['0'])[0]; });
  const trail = [await pos()];
  for (let i = 0; i < 3; i++) { await key(40); trail.push('↓' + await pos()); }
  for (let i = 0; i < 3; i++) { await key(38); trail.push('↑' + await pos()); }
  console.log('  滚动：' + trail.join(' '));
}
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
/* 网页链接那张卡片排在最后（日期最早）：一路往下，按确认放，跳一下，返回 */
await key(40, 6); await sleep(300);
await shot('11-web-card');
await key(13); await sleep(2500);
await shot('12-web-player');
console.log('  网页链接 t=' + await page.evaluate(() => document.getElementById('v').currentTime.toFixed(1)));
await key(39, 2); await sleep(2500);
console.log('  跳 +20 秒之后 t=' + await page.evaluate(() => document.getElementById('v').currentTime.toFixed(1)));
await key(10009); await sleep(800);
await shot('13-web-back');
/* 网页列表当来源：来源栏最上面是「示例站 收藏」→ 要登录 → 先输错再输对 → 列表 → 往下翻第二页 → 放一个 */
await key(37, 3); await key(38, 8); await sleep(300);
await shot('14-rail-web');
await key(13); await sleep(1200);
await shot('15-login');
const typeIn = async (id, text) => { await page.fill('#' + id, text);
  await page.evaluate(id => document.getElementById(id).dispatchEvent(new KeyboardEvent('keydown', { keyCode: 65376, bubbles: true })), id); await sleep(300); };
await typeIn('wl-user', 'test'); await typeIn('wl-pass', 'bad'); await sleep(800);
await shot('16-login-fail');
console.log('  输错之后：' + await page.evaluate(() => document.getElementById('wl-msg').textContent));
await typeIn('wl-pass', 'pw'); await sleep(2000);
await shot('17-weblist');
await key(40, 9); await sleep(1500);
console.log('  翻到底：' + await page.evaluate(() => document.querySelectorAll('.card').length) + ' 张卡片');
await shot('18-weblist-more');
await key(13); await sleep(2500);
console.log('  列表里的片子 t=' + await page.evaluate(() => document.getElementById('v').currentTime.toFixed(1)));
await key(10009); await sleep(800);
await browser.close();
