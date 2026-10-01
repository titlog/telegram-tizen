/* 在 Playwright 的 Chromium 里跑 test/player.html，每个文件一轮。先开 test/serve.mjs。
 *   node test/run.mjs media/a_h264_fast.mp4 [media/b.mp4?start=30 …] */
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');

const PORT = process.env.PORT || 8768;
const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
for (const arg of process.argv.slice(2)) {
  const [f, qs] = arg.split('?');
  console.log('== ' + arg);
  const page = await browser.newPage();
  await new Promise(async (resolve) => {
    const timer = setTimeout(() => { console.log('  超时'); resolve(); }, 120000);
    page.on('console', m => {
      const t = m.text();
      if (!t.startsWith('P: ')) return;
      console.log('  ' + t.slice(3));
      if (t.includes('DONE') || t.includes('open 失败')) { clearTimeout(timer); resolve(); }
    });
    page.on('pageerror', e => console.log('  pageerror ' + e.message));
    await page.goto(`http://localhost:${PORT}/test/player.html?f=${encodeURIComponent(f)}${qs ? '&' + qs : ''}`);
  });
  await page.close();
}
await browser.close();
