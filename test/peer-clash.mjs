/* 会话库里存着的人和新来的撞了（tg.js 的 peerClash / clearPeers）。mtcute 的 peers 表 phone、username 是唯一索引：
 * 库里有另一个 id 的人用过同一个号码 / 用户名，新来的人存不进去，整个事务回滚，mtcute 只抛「IDB transaction was aborted」。
 * 11-26 一台 Tizen 10（issue #5 / #6）：账号 USER_DEACTIVATED 之后扫码登录，每次存自己都撞上，扫码、getMe 永远失败。
 *
 * 在 Chrome 里用 mtcute 自己的 IdbStorage 建一个真的会话库（authKeys、kv、一个旧的人），跑真的 app/js/tg.js；
 * 假客户端的 getMe / signInQr 真往这个库里存「新来的人」，撞不撞、清没清、会话丢没丢都是库说了算。
 *   node test/peer-clash.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');
const esbuild = createRequire(new URL('../build/package.json', import.meta.url))('esbuild');

const root = new URL('..', import.meta.url);
const idb = new URL('build/node_modules/@mtcute/web/idb/index.js', root).pathname;
const seed = esbuild.buildSync({
  stdin: { contents: `import { IdbStorage } from ${JSON.stringify(idb)}; window.IdbStorage = IdbStorage;`, resolveDir: new URL('build', root).pathname },
  bundle: true, format: 'iife', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const tg = fs.readFileSync(new URL('app/js/tg.js', root), 'utf8');

const page0 = `<!doctype html><meta charset=utf-8><body><script>
var logs = [];
var Log = { report: function (k, s) { logs.push(k + ": " + s); } };
var Accounts = { active: function () { return { storage: "tg-session" }; } };
var ApiKey = { get: function () { return { id: 1, hash: "x" }; } };
var fake = {};
var TGLib = { create: async function () { return { client: fake, mode: "worker" }; } };
</script><script>${seed.replace(/<\/script/g, '<\\/script')}</script><script>${tg.replace(/<\/script/g, '<\\/script')}</script>`;

const candidates = [
  process.env.CHROME,
  os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browser = await chromium.launch({ executablePath: candidates.find(p => fs.existsSync(p)) });
const page = await browser.newPage();
page.on('pageerror', e => console.log('  pageerror ' + e.message));
await page.route('https://tv.test/**', r => r.fulfill({ contentType: 'text/html', body: page0 }));
await page.goto('https://tv.test/');

const r = await page.evaluate(async () => {
  const OLD = { id: 111, accessHash: '1', isMin: false, phone: '5511999', usernames: ['oldname'], updated: 1, complete: null };
  const NEW = { id: 222, accessHash: '2', isMin: false, phone: '5511999', usernames: [], updated: 2, complete: null };
  const KEY = new Uint8Array([1, 2, 3, 4]);
  let st;
  /* 一个用过的会话库：DC 2 的授权、kv 里一项、一个旧的人（号码 5511999，用户名 oldname），一条消息引用 */
  async function reseed() {
    if (st) { st.driver.db.close(); }
    await new Promise(res => { const q = indexedDB.deleteDatabase('tg-session'); q.onsuccess = q.onerror = q.onblocked = () => res(); });
    st = new IdbStorage('tg-session');
    await st.driver.load();
    await st.authKeys.set(2, KEY);
    await st.kv.set('dc', new Uint8Array([2]));
    st.peers.store(OLD);
    await st.driver.save();
    await st.refMessages.store(111, -100, 5);
  }
  /* 新来的人存进库：mtcute 的 getMe / 登录成功之后就是这么写的（writeLater + save） */
  async function storeSelf() { st.peers.store(Object.assign({}, NEW)); await st.driver.save(); return { id: 222 }; }
  async function state() {
    return {
      key: Array.from((await st.authKeys.get(2)) || []),
      kv: Array.from((await st.kv.get('dc')) || []),
      old: !!(await st.peers.getById(111)), neu: !!(await st.peers.getById(222)),
      ref: await st.refMessages.getByPeer(111),
    };
  }
  const out = {};
  fake.connect = async () => {};
  await TG.init();

  // 0. 撞上时 mtcute 抛的就是电视上那句（不是 ConstraintError）
  await reseed();
  try { await storeSelf(); out.raw = 'ok'; } catch (e) { out.raw = e.message; }

  // 1. 启动时 getMe 撞上：清掉 peers 再问一次，问到了；会话没丢
  await reseed(); logs.length = 0;
  let calls = 0;
  fake.getMe = async () => { calls++; return storeSelf(); };
  const me = await TG.me();
  out.me = { me, calls, logs: logs.slice(), after: await state() };

  // 2. 扫码登录成功后存自己撞上：不重新出码，清掉、问一次自己是谁
  await reseed(); logs.length = 0; calls = 0;
  let scans = 0;
  fake.signInQr = async () => { scans++; return storeSelf(); };
  const who = await TG.login(() => {}, () => {}, () => Promise.resolve(''), () => {});
  out.login = { who, scans, calls, logs: logs.slice(), after: await state() };

  // 3. 别的错不碰缓存
  await reseed(); logs.length = 0; calls = 0;
  fake.getMe = async () => { calls++; throw new Error('Telegram API error 401: AUTH_KEY_UNREGISTERED'); };
  out.other = { me: await TG.me(), calls, logs: logs.slice(), after: await state() };

  // 4. 清了还是撞（不是缓存的事）：只清一次，不打转
  await reseed(); logs.length = 0; calls = 0;
  fake.getMe = async () => { calls++; throw new Error('IDB transaction was aborted'); };
  out.stuck = { me: await TG.me(), calls, logs: logs.slice() };
  return out;
});
await browser.close();

assert.equal(r.raw, 'IDB transaction was aborted', '撞上的那一刻 mtcute 抛的是什么');

const kept = { key: [1, 2, 3, 4], kv: [2] };
assert.deepEqual(r.me.me, { id: 222 }, '启动：getMe 清完再问应该问到');
assert.equal(r.me.calls, 2);
assert.ok(r.me.logs.some(l => /清掉 tg-session 的 peers 缓存/.test(l)), r.me.logs.join('\n'));
assert.deepEqual({ key: r.me.after.key, kv: r.me.after.kv }, kept, '启动：授权和 kv 不能丢');
assert.deepEqual([r.me.after.old, r.me.after.neu, r.me.after.ref], [false, true, null], '启动：旧的人和消息引用清掉、新来的人存上');

assert.deepEqual(r.login.who, { id: 222 }, '登录：清完问自己是谁');
assert.deepEqual([r.login.scans, r.login.calls], [1, 1], '登录：不重新出码，getMe 一次');
assert.deepEqual({ key: r.login.after.key, kv: r.login.after.kv }, kept, '登录：授权和 kv 不能丢');
assert.deepEqual([r.login.after.old, r.login.after.neu], [false, true]);

assert.equal(r.other.me, null);
assert.equal(r.other.calls, 1);
assert.ok(!r.other.logs.some(l => /peers/.test(l)), '别的错不该清缓存：' + r.other.logs.join('\n'));
assert.deepEqual([r.other.after.old, r.other.after.ref], [true, [-100, 5]], '别的错：缓存原样');

assert.equal(r.stuck.me, null);
assert.equal(r.stuck.calls, 2, '只清一次、只再问一次');

console.log('peer-clash: 撞上的那句、启动 getMe、扫码登录、别的错不碰、只清一次 —— 全部通过');
