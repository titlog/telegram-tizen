/* 后台线程的连接作废之后能不能自己重连（tg.js 的 again / reconnect）。电视把应用挂到后台时主线程整个停住、发不出心跳，
 * 后台线程 60 秒收不到就把连接作废；这里让主线程忙等 70 秒来模拟，然后调 TG.me()，看日志里有没有「重连」那一行、
 * 之后的请求还能不能用。真连 Telegram（凭证读 ~/.telegram-tizen.conf），不用登录 —— 没登录 getMe 会报错，但那是重连之后的事。
 * 先开 test/serve.mjs（:8768）。打包要是新的（tools/deploy.sh 会打，或者照 deploy.sh 里那两行 esbuild 手动打）。
 *   node test/worker-expire.mjs */
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const conf = fs.readFileSync(os.homedir() + '/.telegram-tizen.conf', 'utf8');
const id = /TG_API_ID=["']?(\d+)/.exec(conf)[1], hash = /TG_API_HASH=["']?([0-9a-f]+)/.exec(conf)[1];

const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (/^tg:/.test(t)) console.log('  ' + t); });
page.on('pageerror', e => console.log('  pageerror ' + e.message));
await page.route('**/__expire.html', r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset=utf-8><body>
<script>var REPORT_TO = ""; var TG_API_ID = ${id}; var TG_API_HASH = "${hash}";</script>
<script src="/app/js/log.js"></script><script src="/app/js/tg.bundle.js"></script><script src="/app/js/web.js"></script><script src="/app/js/tg.js"></script>` }));
await page.goto('http://localhost:8768/__expire.html');
const t0 = Date.now();
console.log('连接 …');
console.log('  ' + await page.evaluate(() => TG.init().then(() => 'mtcute 在 ' + TG.mode())));
console.log('  连上 ' + (Date.now() - t0) + 'ms；主线程忙等 70 秒（不发心跳）…');
await page.evaluate(() => { const end = Date.now() + 70000; while (Date.now() < end) { /* 模拟应用挂在后台 */ } });
await page.waitForTimeout(500);       // 让积压的消息（connection_expired）先处理掉
const r = await page.evaluate(async () => {
  const out = [];
  try { await TG.primaryDc(); out.push('不经重连的请求：通（连接没被作废？）'); } catch (e) { out.push('不经重连的请求：' + e.message); }
  const t = performance.now();
  try { await TG.sources(5); out.push('sources：通'); } catch (e) { out.push('sources：' + e.message + '（重连之后的错误，没登录是正常的）'); }
  out.push('用时 ' + Math.round(performance.now() - t) + 'ms');
  try { out.push('之后 primaryDc：' + await TG.primaryDc()); } catch (e) { out.push('之后 primaryDc：' + e.message); }
  return out;
});
r.forEach(x => console.log('  ' + x));
await browser.close();
