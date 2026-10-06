/* 网页列表（app/js/web.js 的 Web.list）在桌面上跑一遍：真网站，取第一页、再翻两页，打印每页几个、下一页地址、第一条的标题。
 * 要登录的列表没登录时应该报 needLogin。站点规则读本机的 app/js/sites.local.js（不进仓库）。
 *   node test/weblist.mjs <列表链接> [<列表链接> …] */
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const ROOT = new URL('..', import.meta.url).pathname;
const urls = process.argv.slice(2);
if (!urls.length) { console.log('用法：node test/weblist.mjs <列表链接> …'); process.exit(1); }

const dir = fs.mkdtempSync(os.tmpdir() + '/tgweblist-');
const local = fs.existsSync(ROOT + 'app/js/sites.local.js') ? `<script src="file://${ROOT}app/js/sites.local.js"></script>` : '';
if (!local) { console.log('没有 app/js/sites.local.js：一条站点规则都没有，列表链接都不认识（格式见 app/js/web.js 开头）'); }
fs.writeFileSync(dir + '/t.html', `<!doctype html><meta charset=utf-8><body><script src="file://${ROOT}app/js/web.js"></script>${local}`);
const ctx = await chromium.launchPersistentContext(dir + '/profile', {
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--disable-web-security', '--allow-file-access-from-files'],
  userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.0.0/9.0 TV Safari/537.36',
});
const page = await ctx.newPage();
page.on('pageerror', e => { if (e.message !== 'undefined') console.log('pageerror ' + e.message); });
await page.goto('file://' + dir + '/t.html');
for (const u of urls) {
  const out = await page.evaluate(async u => {
    const lines = ['=== ' + u + '  可列：' + Web.listable(u) + '  标题：' + Web.listTitle(u, '')];
    let cur;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await Web.list(u, cur);
        const f = r.items[0] || {};
        lines.push(`第 ${i + 1} 页 ${r.items.length} 个，${Math.round(r.ms)}ms（${r.how}）共 ${r.total || '?'}；第一条 ${(f.title || '').split(' ')[0]} ${f.duration}s 图 ${f.image ? new URL(f.image).host : '无'}；下一页 ${r.next ? r.next.url.replace(/^https?:\/\/[^/]+/, '') : '没有'}`);
        if (!r.next) { break; }
        cur = r.next;
      } catch (e) { lines.push('出错 ' + e.message + (e.needLogin ? '（needLogin）' : '')); break; }
    }
    return lines.join('\n');
  }, u);
  console.log(out);
}
await ctx.close();
fs.rmSync(dir, { recursive: true });
