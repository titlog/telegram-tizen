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

/* 只从搜索里出来的片子（不打乱上面那些步骤的位置）：双音轨 + 内嵌中文字幕的 MP4，两集短剧，MKV。
 * test/media/ui/ 里的生成方法：
 *   multi.mp4：ffmpeg -i ../a_h264_fast.mp4 -f lavfi -i "sine=frequency=330:duration=60:sample_rate=48000" -i zh.srt -map 0:v -map 0:a -map 1:a -map 2
 *     -c:v copy -c:a:0 copy -c:a:1 aac -b:a:1 96k -c:s mov_text -metadata:s:a:0 language=chi -metadata:s:a:0 handler_name=国语
 *     -metadata:s:a:1 language=eng -metadata:s:a:1 handler_name=导演评论 -metadata:s:s:0 language=chi -disposition:a:0 default -disposition:a:1 0 multi.mp4
 *   ep1/ep2.mp4：ffmpeg -ss 0/20 -i ../a_h264_fast.mp4 -t 12 -c copy epN.mp4；ext_gbk.srt = iconv -t gbk ext.srt
 * MKV 用 test/check-mkv.mjs 生成的（有就加上）。 */
const extra = [];
const addExtra = (path, o) => { if (!fs.existsSync(`${ROOT}test/media/${path}`)) return;
  extra.push({ key: 'x' + extra.length, fileKey: 'x' + extra.length, path, size: fs.statSync(`${ROOT}test/media/${path}`).size, date: Date.now() - (60 + extra.length) * 86400000,
    info: { year: '', rating: '', director: '' }, msg: { id: 100 + extra.length, chat: { id: 9 } }, ...o }); };
addExtra('ui/multi.mp4', { title: '双音轨 + 内嵌字幕', fileName: 'Double.Audio.2020.mp4', duration: 60 });
addExtra('ui/ep2.mp4', { title: '测试剧 第2集', fileName: 'ep2.mp4', duration: 12 });
addExtra('ui/ep1.mp4', { title: '测试剧 第1集', fileName: 'ep1.mp4', duration: 12 });
for (const f of fs.existsSync(`${ROOT}test/media/mkv`) ? fs.readdirSync(`${ROOT}test/media/mkv`).filter(f => /\.(mkv|webm)$/.test(f)).sort() : []) {
  addExtra('mkv/' + f, { title: 'MKV ' + f, fileName: f, duration: 0, asFile: true });
}
const subFiles = { 'Double.Audio.2020.mp4': [{ name: 'Double.Audio.2020.chs.srt', lang: '简体', size: 141, score: 4, doc: { path: '/test/media/ui/ext_gbk.srt' } }] };

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
  var EXTRA = ${JSON.stringify(extra)};
  EXTRA.forEach(function (it) { it.date = new Date(it.date); });
  var SUBS = ${JSON.stringify(subFiles)};
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
    /* 多账号：「我是谁」按当前账号的库答（tg-session-3 故意也是爸爸 —— 添加了一个已经在的账号）。扫码：stub.noscan 不在就 1.5 秒后自动「扫上」 */
    init: async function () {}, mode: function () { return "stub"; },
    me: async function () {
      var USERS = { "tg-session": { id: 101, displayName: "爸爸" }, "tg-session-2": { id: 202, displayName: "妈妈" }, "tg-session-3": { id: 101, displayName: "爸爸" } };
      var st = Accounts.active().storage, logged = JSON.parse(localStorage.getItem("stub.logged") || '["tg-session"]');
      return logged.indexOf(st) >= 0 ? USERS[st] : null;
    },
    login: function (onUrl) {
      onUrl("tg://login?token=STUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUB");
      if (localStorage.getItem("stub.noscan")) { return new Promise(function () {}); }
      return new Promise(function (resolve) { setTimeout(function () {
        var logged = JSON.parse(localStorage.getItem("stub.logged") || '["tg-session"]');
        logged.push(Accounts.active().storage); localStorage.setItem("stub.logged", JSON.stringify(logged)); resolve();
      }, 1500); });
    },
    logout: async function () {
      var st = Accounts.active().storage, logged = JSON.parse(localStorage.getItem("stub.logged") || '["tg-session"]');
      localStorage.setItem("stub.logged", JSON.stringify(logged.filter(function (x) { return x !== st; })));
    },
    videoCount: async function (src) { await new Promise(function (r) { setTimeout(r, 150); }); return src === 3 || src === 4 ? 0 : 5; },
    sources: async function () { return [{ id: "me", title: "Test", kind: "group" }, { id: 1, title: "视频分享群", kind: "group" }, { id: 4, title: "BotFather", kind: "user" },
      { id: 2, title: "一个名字特别长的频道名字特别长的频道", kind: "channel" }, { id: 3, title: "空的群", kind: "group" }]; },
    videos: async function (src) { await new Promise(function (r) { setTimeout(r, 300); });
      var list = src === 3 ? [] : src === 1 ? ITEMS.slice(0, 3) : ITEMS; return { items: list, next: undefined, total: list.length }; },
    links: async function (src) { return src === 3 || src === 1 ? [] : LINKS; },
    thumb: async function (it) { window.__thumbCall && window.__thumbCall(); if (it.file === "e_long_2h" || it.file === "c_hevc") { return null; }
      var b = await (await fetch("/test/media/thumbs/" + it.file + ".jpg")).arrayBuffer();
      return { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), bytes: b }; },
    source: function (it) { return httpSource("/test/media/" + (it.path || it.file + ".mp4"), it.size); },
    search: async function (q) { await new Promise(function (r) { setTimeout(r, 200); });
      var list = EXTRA.filter(function (it) { return it.title.indexOf(q) >= 0; }); return { items: list, next: undefined, total: list.length }; },
    subtitlesFor: async function (it) { return SUBS[it.fileName] || []; },
    download: async function (doc) { return new Uint8Array(await (await fetch(doc.path)).arrayBuffer()); },
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
/* 应用自己会往外连的两处：诊断日志的接收端（地址从 diag.js 读）、自动更新查的 GitHub / jsDelivr —— 测试里一律拦掉，不往线上传东西 */
const OUTSIDE = [new URL(/var ENDPOINT = "([^"]+)"/.exec(fs.readFileSync(ROOT + 'app/js/diag.js', 'utf8'))[1]).host, 'raw.githubusercontent.com', 'cdn.jsdelivr.net'];
await page.route((u) => OUTSIDE.includes(u.host), (r) => r.abort());
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
/* 一下 = keydown + keyup（遥控器也是这样；确认键在松开时才算短按，按住 650ms 是菜单） */
/* 按下去页面就重新加载了（切换账号）：松开那一下没有页面可发，不算错 */
const ev = (type, c) => page.evaluate(([t, c]) => document.dispatchEvent(new KeyboardEvent(t, { keyCode: c, bubbles: true })), [type, c])
  .catch(e => { if (!/context was destroyed|navigation/i.test(e.message)) throw e; });
const key = async (code, n = 1) => { for (let i = 0; i < n; i++) { await ev('keydown', code); await sleep(40); await ev('keyup', code); await sleep(80); } };
const hold = async (code, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await ev('keydown', code); await sleep(100); } await ev('keyup', code); await sleep(200); };
/* UILANG=en：英文界面（截图名前面加 en-）。不给就钉成中文 —— Playwright 的 Chromium 系统语言是 en-US，新装的会跟着变英文 */
const UILANG = process.env.UILANG || 'zh', L = (zh, en) => UILANG === 'en' ? en : zh;
const shot = async (name) => { await page.screenshot({ path: `${ROOT}logs/ui-${UILANG === 'en' ? 'en-' : ''}${name}.png` }); console.log('  截图 ' + name); };

const vt = () => page.evaluate(() => document.getElementById('v').currentTime);
const txt = (sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const search = async (q) => {
  await key(37, 4); await key(38, 15); await key(13); await sleep(400);
  await page.fill('#sx-q', q);
  await page.evaluate(() => document.getElementById('sx-q').dispatchEvent(new KeyboardEvent('keydown', { keyCode: 65376, bubbles: true })));
  await sleep(1200);
};
const menuRows = () => page.evaluate(() => [...document.querySelectorAll('#menu .mh, #menu .mi')].map(e =>
  (e.classList.contains('mh') ? '# ' : e.classList.contains('dis') ? '- ' : e.classList.contains('focus') ? '> ' : '  ') + e.textContent));
/* 菜单里把光标挪到 pred 认的那一行（↑↓ 会跳过标题和灰掉的行） */
const goto = async (pred) => {
  const sel = (await menuRows()).filter(x => !x.startsWith('# ') && !x.startsWith('- '));
  const cur = sel.findIndex(x => x.startsWith('> ')), want = sel.findIndex(pred);
  if (want < 0) { console.log('  ✗ 菜单里没有要找的那行'); return; }
  await key(want > cur ? 40 : 38, Math.abs(want - cur));
};
/* 一段时间里字幕出现过哪些（取样那一刻可能正好在两句之间） */
const subsSeen = async (ms) => { const seen = new Set(); const t0 = Date.now();
  while (Date.now() - t0 < ms) { for (const sel of ['#sub', '#subtop']) { const x = await txt(sel); if (x) seen.add(x); } await sleep(250); }
  return [...seen].join(' / ') || '（没有）'; };

await page.goto('http://localhost:8768/app/index.html');
await page.evaluate((l) => { try { localStorage.clear(); localStorage.setItem('tg.lang.v1', l); } catch (e) {} }, UILANG);
await page.reload();
await sleep(1500);
await shot('1-home');
/* ONLY=mkv：只跑最后 MKV 那一段 */
if (!process.env.ONLY) {
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
await key(37, 3); await key(38, 8); await key(40); await sleep(300);      // 最上面是「搜索」，下一个才是网页列表
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

/* ---------- 搜索 → 双音轨片子：菜单、换音轨、字幕（片子里的、群里的文件）、字幕时间 ---------- */
await search('双音轨');
await shot('19-search');
console.log('  搜索结果 ' + await page.evaluate(() => document.querySelectorAll('.card').length) + ' 张卡片：' + await txt('.card .title'));
await key(13); await sleep(3500);
await shot('20-multi');
await hold(13, 900); await sleep(300);
await shot('21-menu');
console.log('  菜单：\n    ' + (await menuRows()).join('\n    '));
const t1 = await vt();
await key(40); await key(13); await sleep(4000);
const t2 = await vt();
console.log(`  换音轨：${t1.toFixed(1)} → 重开后 ${t2.toFixed(1)}（应该接着 ${t1.toFixed(1)} 往后放）`);
await hold(13, 900); await sleep(300);
console.log('  换完再开菜单：\n    ' + (await menuRows()).join('\n    '));
/* 片子里的中文字幕：菜单里「字幕」下面第二行 */
await goto(r => r.includes(L('片子里', 'in the file'))); await key(13); await sleep(2500);      // zh.srt 第三条从 10 秒开始
console.log('  内嵌字幕 t=' + (await vt()).toFixed(1) + '：' + await txt('#sub'));
await shot('22-sub-emb');
await hold(13, 900); await sleep(300);
await goto(r => r.includes(L('群里的文件', 'file in the group'))); await key(13); await sleep(1500);
console.log('  外挂字幕（GBK）t=' + (await vt()).toFixed(1) + '：' + await txt('#sub'));
await shot('23-sub-file');
await hold(13, 900); await sleep(300);
await goto(r => r.trim().endsWith('→')); await key(39, 2); await sleep(300);
console.log('  字幕时间：' + (await menuRows()).filter(r => r.trim().endsWith('→')).join(''));
await shot('24-offset');
await key(10009); await sleep(300);
await key(13); await sleep(600);
await shot('25-paused-sub');
await key(10009); await sleep(800);

/* ---------- 下一集：搜「测试剧」，放第 1 集，跳到快结束，等倒计时 ---------- */
await search('测试剧');
console.log('  搜「测试剧」：' + await page.evaluate(() => [...document.querySelectorAll('.card .title')].map(e => e.textContent).join(' / ')));
await key(39); await key(13); await sleep(3000);
await key(39); await sleep(1200);      // +15 秒，落在结尾前 3 秒
await sleep(4500);
await shot('26-upnext');
console.log('  放完：' + await txt('#upnext'));
await sleep(9000);
console.log('  倒计时之后在放：' + await txt('#ov-title') + ' t=' + (await vt()).toFixed(1));
await shot('27-next');
await key(10009); await sleep(800);

}

/* ---------- 多账号（ONLY=acct 只跑这一段）：账号页 → 添加（扫码）→ 切回去 → 添加一个已经在的 → 扫码时按返回取消 → 退出一个 ---------- */
if (!process.env.ONLY || process.env.ONLY === 'acct') {
  const acctState = () => page.evaluate(() => ({ list: Accounts.list().map(a => a.id + ':' + (a.name || '?') + (a.id === Accounts.active().id ? '*' : '')).join(' '),
    progress: Object.keys(JSON.parse(localStorage.getItem(Accounts.scope('tg.progress.v1')) || '{}')).length, rail: document.querySelector('#rail-list').textContent.slice(-40) }));
  /* 来源栏最底下几项是「账号 · 设置 · 换语言」：按文字找，不按位置（加「设置」那天位置变了，这一步跑去开了设置页） */
  const toRail = async (re) => {
    await key(37, 4); await key(40, 30);
    for (let i = 0; i < 6 && !re.test(await txt('#rail-list .src.focus') || ''); i++) await key(38);
    await key(13); await sleep(400);
  };
  const toAcct = () => toRail(/^(账号|Account)/);
  const acctRows = () => page.evaluate(() => [...document.querySelectorAll('#acct .ai')].map(e => (e.classList.contains('focus') ? '> ' : '  ') + e.textContent));
  const acctGo = async (pred) => { const r = await acctRows(); const cur = r.findIndex(x => x.startsWith('> ')), want = r.findIndex(pred);
    await key(want > cur ? 40 : 38, Math.abs(want - cur)); await key(13); };
  /* 先在第一个账号（爸爸）下看一部，记一条进度 */
  await page.evaluate(() => Store.setProgress('acct-test', 100, 600, '爸爸看的'));
  console.log('  多账号 开始：', JSON.stringify(await acctState()));
  await toAcct();
  await shot('30-acct');
  console.log('  账号页：' + (await acctRows()).join(' | '));
  await acctGo(x => x.includes(L('添加账号', 'Add an account'))); await sleep(5500);
  console.log('  扫上之后：', JSON.stringify(await acctState()));
  await shot('32-second');
  await toAcct();
  console.log('  账号页：' + (await acctRows()).join(' | '));
  await acctGo(x => x.includes('爸爸')); await sleep(3500);
  console.log('  切回爸爸：', JSON.stringify(await acctState()), '提示：' + await txt('#toast'));
  /* 再添加一个，扫的是已经在的爸爸（stub 里 tg-session-3 答 101） */
  await toAcct(); await acctGo(x => x.includes(L('添加账号', 'Add an account'))); await sleep(6000);
  console.log('  添加了已经在的账号：', JSON.stringify(await acctState()), '提示：' + await txt('#toast'));
  /* 添加时扫码页按返回 = 取消 */
  await page.evaluate(() => localStorage.setItem('stub.noscan', '1'));
  await toAcct(); await acctGo(x => x.includes(L('添加账号', 'Add an account'))); await sleep(2000);
  await shot('31-add-login');
  console.log('  添加账号扫码页：' + await txt('#qrnote'));
  await key(10009); await sleep(3000);
  console.log('  扫码时按返回取消：', JSON.stringify(await acctState()));
  await page.evaluate(() => localStorage.removeItem('stub.noscan'));
  /* 切到妈妈、退出妈妈（按两下）→ 回到爸爸，妈妈的库排进待删、下次启动删掉 */
  await toAcct(); await acctGo(x => x.includes('妈妈')); await sleep(3500);
  await toAcct(); await acctGo(x => x.includes(L('退出', 'Sign out'))); await sleep(300); await key(13); await sleep(3500);
  console.log('  退出妈妈之后：', JSON.stringify(await acctState()), '妈妈的进度键还在吗：' +
    await page.evaluate(() => localStorage.getItem('tg.progress.v1@a2') !== null));

  /* 设置：诊断日志开关、上传（测试里接收端被拦掉 → 写「没传上」）、检查更新（GitHub 也被拦掉 → 「没查成」），返回键回主页 */
  const optsRows = () => page.evaluate(() => [...document.querySelectorAll('#opts .ai')].map(e => (e.classList.contains('focus') ? '> ' : '  ') + e.textContent));
  await toRail(/^(设置|Settings)$/);
  console.log('  设置页：' + (await optsRows()).join(' | ') + ' || ' + await txt('#opts-diag') + ' || ' + await txt('#opts-update'));
  await shot('33-opts');
  await key(13); await sleep(300);
  console.log('  关掉之后：' + (await optsRows())[0] + ' || ' + await txt('#opts-diag'));
  await key(13); await sleep(300);
  await key(40); await key(13); await sleep(2500);
  console.log('  按了上传：' + await txt('#opts-diag'));
  await key(40); await key(13); await sleep(2500);
  console.log('  按了检查更新：' + await txt('#opts-update'));
  await key(10009); await sleep(400);
  console.log('  返回之后：' + await page.evaluate(() => window.__app.screen()));
}

/* ---------- MKV（有生成好的测试片才跑） ---------- */
if ((!process.env.ONLY || process.env.ONLY === 'mkv') && extra.some(x => x.path.startsWith('mkv/'))) {
  await search('MKV');
  const n = await page.evaluate(() => document.querySelectorAll('.card').length);
  console.log('  MKV ' + n + ' 个：' + await page.evaluate(() => [...document.querySelectorAll('.card .title')].map(e => e.textContent).join(' / ')));
  /* 画布上 PGS 字幕的不透明像素有多少 */
  const pgsPixels = () => page.evaluate(() => { const c = document.getElementById('subpic'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4 * 7) if (d[i] > 0) n++; return n; });
  for (let i = 0; i < n; i++) {
    if (i) { if (i % 3) await key(39); else { await key(37, 2); await key(40); } }      // 先回第一列再往下（最后一排不满时往下会落到最后一个；第一列再按左键就开来源栏了）
    await key(13); await sleep(4000);
    const a = await vt(), title = await txt('#ov-title');
    let extraInfo = '';
    if (/m_multi/.test(title)) {
      await hold(13, 900); await sleep(300);
      console.log('  m_multi 的菜单：' + (await menuRows()).join(' | '));
      await goto(r => r.includes(L('英语', 'English')) && r.includes(L('片子里', 'in the file'))); await key(13);
      extraInfo = '，选英语 ASS 之后 8 秒里出现过的字幕：' + await subsSeen(8000);
    }
    if (/m_pgs/.test(title)) {
      let best = 0, at = 0; for (let k = 0; k < 16; k++) { const p = await pgsPixels(); if (p > best) { best = p; at = await vt(); if (best > 50) await shot('29-pgs'); } await sleep(250); }
      extraInfo = '，PGS 画布上最多 ' + best + ' 个采样点有字（t=' + at.toFixed(1) + '）';
    }
    await key(39); await sleep(2500);
    console.log(`  MKV #${i} ${title}：4 秒后 t=${a.toFixed(1)}，快进之后 t=${(await vt()).toFixed(1)}，错误：${await txt('#perr') || '无'}，字幕：${await txt('#sub') || '—'}${extraInfo}`);
    await shot('28-mkv-' + i);
    await key(10009); await sleep(800);
  }
}
await browser.close();
