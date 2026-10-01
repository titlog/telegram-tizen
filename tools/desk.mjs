/* 桌面冒烟测试：Playwright 的 Chromium 打开 app/（http://localhost），config.js 换成带凭证的版本，
 * 看能不能连上 Telegram、出二维码。登录要人扫码，桌面上只测到出码为止。
 *   python3 -m http.server 8767 -d app/ & node tools/desk.mjs */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const conf = Object.fromEntries(fs.readFileSync(os.homedir() + '/.telegram-tizen.conf', 'utf8')
  .split('\n').filter(l => /^TG_/.test(l)).map(l => l.split('=')));
const browser = await chromium.launch({ executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', m => { if (/^(tg|onerror|csp):/.test(m.text())) console.log(m.text()); });
page.on('pageerror', e => console.log('pageerror', e.message));
await page.route('**/js/config.js', r => r.fulfill({ contentType: 'text/javascript',
  body: `var REPORT_TO = ""; var TG_API_ID = ${conf.TG_API_ID}; var TG_API_HASH = "${conf.TG_API_HASH}";` }));
await page.goto('http://localhost:8767/index.html');
await page.waitForFunction(() => document.querySelector('#qr svg'), null, { timeout: 30000 }).catch(e => console.log('没等到二维码', e.message));
await page.screenshot({ path: 'logs/desk.png' });
await browser.close();
