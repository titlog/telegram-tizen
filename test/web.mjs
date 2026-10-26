/* 网页链接那条路（app/js/web.js）在桌面上跑一遍：解析页面 → hls.js 放 → 跳转，打印 web.js 自己报的那些行。
 * 走真网络、真网站。页面从 file:// 开、关掉跨域检查 —— 和电视上 widget 的处境一样（电视上不受 CORS 约束）。
 *   node test/web.mjs <网页链接> [跳到第几秒=4800]
 *   站点规则：仓库里的 app/js/sites.js（archive.org）+ 本机的 app/js/sites.local.js（不进仓库）；链接本身是 .m3u8 / .mp4 的不用规则。
 *   node test/web.mjs https://archive.org/details/his_girl_friday 3000
 *   NOXHR=1 node test/web.mjs …   把对页面的 XHR 都回成 Cloudflare 的 403，走隐藏框那条路。桌面 Chrome 怎么开关都不让 file:// 页面读
 *                                 跨域框（电视上能读），所以这时测试页伪装成那个站自己的一个地址，框和它同源。 */
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const url = process.argv[2], seekTo = Number(process.argv[3] || 4800);
if (!url) { console.log('用法：node test/web.mjs <网页链接> [跳到第几秒]'); process.exit(1); }

const local = fs.existsSync(ROOT + 'app/js/sites.local.js') ? `<script src="file://${ROOT}app/js/sites.local.js"></script>` : '';
const dir = fs.mkdtempSync(os.tmpdir() + '/tgweb-');
fs.writeFileSync(dir + '/t.html', `<!doctype html><meta charset=utf-8><body><video id=v muted style="width:320px"></video>
<script>var Diag = { priv: function (s) { return s; } };</script>
<script src="file://${ROOT}app/js/vendor/hls.min.js"></script><script src="file://${ROOT}app/js/web.js"></script><script src="file://${ROOT}app/js/sites.js"></script>${local}
<script>
window.LINES = []; var t0 = performance.now();
function L(s) { LINES.push(Math.round(performance.now() - t0) + "ms " + s); }
var p = Web.player(document.getElementById("v"), function (s) { L("web: " + s); }, function (ph, m) { if (ph !== "playing") { L("state " + ph + (m ? " " + m : "")); } });
window.go = function (u) { return p.open({ url: u }, { startAt: 0 }).then(function () { L("open 完成"); }, function (e) { L("open 失败 " + e.message); }); };
window.meta = function (u) { return Web.meta(u).then(function (m) { L("meta 标题「" + m.title.slice(0, 20) + "…」图 " + (m.image ? "有" : "无")); }, function (e) { L("meta 失败 " + e.message); }); };
window.P = p;
</script>`);

/* --disable-web-security 要配独立的用户目录才完全生效（不然跨域框还是读不了），所以用 launchPersistentContext */
const ctx = await chromium.launchPersistentContext(dir + '/profile', {
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security', '--allow-file-access-from-files', '--disable-site-isolation-trials'],
  userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.0.0/9.0 TV Safari/537.36',
});
const page = await ctx.newPage();
page.on('pageerror', e => { if (e.message !== 'undefined') console.log('pageerror ' + e.message); });
if (process.env.NOXHR) {
  const host = new URL(url).host;
  await page.route(r => new URL(r).host === host, (route, req) => req.resourceType() === 'xhr'
    ? route.fulfill({ status: 403, contentType: 'text/html', body: '<title>Just a moment...</title>' }) : route.continue());
}
let pageUrl = 'file://' + dir + '/t.html';
if (process.env.NOXHR) {
  pageUrl = new URL('/__tg_test.html', url).href;
  await page.route(pageUrl, r => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(dir + '/t.html', 'utf8')
    .replace(/file:\/\/[^"]+\/(hls\.min|web|sites)\.js/g, (m, n) => '/__tg_' + n + '.js') }));
  for (const [n, f] of [['hls.min', 'app/js/vendor/hls.min.js'], ['web', 'app/js/web.js'], ['sites', 'app/js/sites.js']])
    await page.route(new URL('/__tg_' + n + '.js', url).href, r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(ROOT + f, 'utf8') }));
}
await page.goto(pageUrl);
await page.evaluate(u => meta(u), url);
await page.evaluate(u => go(u), url);
await page.waitForFunction(() => document.getElementById('v').currentTime > 3, null, { timeout: 30000 }).catch(() => console.log('出画面后 30 秒没走到第 3 秒'));
await page.evaluate(t => { LINES.push('--- 跳到 ' + t + ' 秒'); P.seek(t); }, seekTo);
await page.waitForFunction(t => document.getElementById('v').currentTime > t + 1, seekTo, { timeout: 30000 }).catch(() => console.log('跳转 30 秒没接着放'));
await page.evaluate(() => { LINES.push('--- 关掉再开（续播 600 秒）'); P.close(); });
await page.evaluate(u => P.open({ url: u }, { startAt: 600 }).then(() => LINES.push('续播 open 完成 t=' + document.getElementById('v').currentTime.toFixed(1))), url);
console.log((await page.evaluate(() => LINES)).join('\n'));
await ctx.close();
fs.rmSync(dir, { recursive: true });
