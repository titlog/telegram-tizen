/* 诊断日志（app/js/diag.js）的离线验证。deploy.sh、release.sh 卡着它。
 *
 * 照搬 douyin-tizen 的 tools/diag-verify.mjs（接收端那一半在 bilibili-tizen 测：三个应用共用一个接收端）。卡发布，因为这件事坏掉的
 * 两种样子都是静默的：群名、片名漏出去，看起来和正常上传一模一样；该传的时候没传，看起来就是一台没出过事的电视。
 * 所以测：什么被抹掉、什么时候传什么时候不传、log.js 是不是每一行都记进来了；再从源码里查每个进 R() / Log.report() /
 * Diag.incident() 的群名、片名、文件名、搜索词、地址、账号名和用户 ID 是不是都包在 Diag.priv() 里。
 *
 *   node tools/diag-verify.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const SRC = fs.readFileSync(here("../app/js/diag.js"), "utf8");
const LOG = fs.readFileSync(here("../app/js/log.js"), "utf8");
let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("✓ " + name); }
  catch (e) { failures++; console.log("✗ " + name + "\n    " + (e && e.message || e).split("\n").join("\n    ")); }
}

/* ---------------- 给 diag.js 一台电视 ---------------- */

function television({ ua = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36", storage = new Map(), reportTo = "", diagTo = "https://diag.test/v1/upload", selftest = "", start = Date.UTC(2026, 9, 21, 4), withLog = false } = {}) {
  let clock = start;
  const timers = new Map(); let nextTimer = 1;
  const sent = [], reported = [], collector = [];
  const responder = { fn: () => [200, JSON.stringify({ id: "abc23456" })] };
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [clock])); }
    static now() { return clock; }
  }
  class XHR {
    constructor() { this.readyState = 0; this.status = 0; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      if (/\/report$/.test(this.url)) { collector.push(JSON.parse(body).detail.msg); return; }
      sent.push(this);
      const [status, text] = responder.fn(this);
      this.status = status; this.responseText = text; this.readyState = 4;
      if (status === 0 && this.onerror) { this.onerror(); }
      if (this.onreadystatechange) { this.onreadystatechange(); }
    }
  }
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  const sandbox = {
    Date: FakeDate, Math, JSON, String, Number, Uint8Array, RegExp,
    localStorage, XMLHttpRequest: XHR,
    navigator: { userAgent: ua },
    window: { crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } },
              addEventListener() {} },
    document: { hidden: false, addEventListener() {} },
    console: { log() {} },
    Boot: { info: () => ({ packaged: "1.2.0", running: "1.3.0", note: "" }), scriptName: (s) => s },
    REPORT_TO: reportTo, DIAG_TO: diagTo, SELFTEST: selftest,
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock + (ms || 0) }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  /* null：比这两个都老的 config.js */
  if (diagTo === null) { delete sandbox.DIAG_TO; }
  if (selftest === null) { delete sandbox.SELFTEST; }
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "diag.js" });
  const Diag = sandbox.Diag;
  if (withLog) {
    vm.runInContext(LOG, sandbox, { filename: "log.js" });
    Diag.init({ report: sandbox.Log.report });
  } else {
    Diag.init({ report: (k, d) => { reported.push(k + ": " + d); Diag.record(k, d); } });
  }
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); clock = due[1].at; due[1].fn();
    }
    clock = until;
  }
  return { Diag, sent, reported, collector, storage, advance, responder, sandbox };
}

const lastBody = (tv) => JSON.parse(tv.sent[tv.sent.length - 1].body);

/* ---------------- 什么能传出去 ---------------- */

await t("包起来的群名、片名换成 …，大小、时长、编码留着", () => {
  const { Diag } = television();
  const line = "app: 播放「" + Diag.priv("末代皇帝 加长版") + "」2.6 GB 3:39:00（文件 " + Diag.priv("The.Last.Emperor.1987.mkv") + "）";
  assert.equal(Diag.scrub(line), "app: 播放「…」2.6 GB 3:39:00（文件 …）");
  assert.equal(Diag.plain(line), "app: 播放「末代皇帝 加长版」2.6 GB 3:39:00（文件 The.Last.Emperor.1987.mkv）");
  assert.equal(Diag.scrub("player: 到画面 1820ms（第一块 640ms，moov 到手 512ms，取了 3.1MB）"), "player: 到画面 1820ms（第一块 640ms，moov 到手 512ms，取了 3.1MB）");
});

await t("被截断、没收尾的包裹一直抹到行尾", () => {
  const { Diag } = television();
  const cut = ("app: 来源 " + Diag.priv("一个名字特别长的频道名字特别长的频道")).slice(0, 14);
  assert.equal(Diag.scrub(cut + " 后面的字"), "app: 来源 …");
});

await t("没包的也兜住：「」里的名字、地址、tg:// 链接、用户 ID、网站账号编号、32 位十六进制", () => {
  const { Diag } = television();
  const cases = [
    ["app: 来源「某个电影群🎬4K」805ms，40/1175 个视频", "app: 来源「…」805ms，40/1175 个视频"],
    ["app: 账号：1 个，当前 a1（库 tg-session，爸爸 id=5550001234），Telegram 答的是 id=5550001234 —— 对上了", null],
    ["app: 播放网页 https://videos.example/v/abc?x=1，从 1:00 接着放", "app: 播放网页 …，从 1:00 接着放"],
    ["app: 登录 x：成功，账号编号 7，收藏 30 个", "app: 登录 x：成功，账号编号 …，收藏 30 个"],
    ["app: 扫码 tg://login?token=AQIDBAUGBwgJCgsMDQ4PEA", "app: 扫码 …"],
    ["app: 凭证 0123456789abcdef0123456789ABCDEF", "app: 凭证 …"],
  ];
  for (const [line, want] of cases) {
    const got = Diag.scrub(line);
    if (want) assert.equal(got, want);
    assert.doesNotMatch(got, /某个电影群|5550001234|videos\.example|账号编号 7|AQIDBAU|0123456789abcdef/i, got);
  }
});

await t("观众的 IP 不出门：403 页、响应头、oi、别的点分四段；版本号留着", () => {
  const { Diag } = television();
  /* 编的地址（文档用的那几段）。 */
  const lines = [
    "app: 放不了 <p>Client_ip: 203.0.113.7</p> <p>Client_ip: 2001:db8::7</p> {\"x-debug-rmt-addr\":\"198.51.100.23\"}",
    "app: 连到 192.0.2.44:443，oi=3405803777",
  ];
  for (const l of lines) {
    const s = Diag.scrub(l);
    assert.doesNotMatch(s, /203\.0\.113\.7|2001:db8::7|198\.51\.100\.23|3405803777|192\.0\.2\.44/, s);
  }
  assert.match(Diag.scrub("engine: Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"), /Chrome\/120\.0\.0\.0/);
});

await t("上传的整份内容里没有任何包起来的东西（原因也过一遍）", () => {
  const tv = television();
  tv.Diag.record("app", "播放「" + tv.Diag.priv("秘密片名") + "」1.2 GB");
  tv.Diag.incident("读不到来源里的视频：" + tv.Diag.priv("某个私密群") + " id=5550001234");
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  assert.doesNotMatch(tv.sent[0].body, /秘密片名|某个私密群|5550001234||/);
  assert.match(tv.sent[0].body, /1\.2 GB/);
});

await t("log.js：每一行都进那一圈（抹过的），收集器收到的是原样、没有记号", () => {
  const tv = television({ reportTo: "http://10.0.0.2:8097", diagTo: "", withLog: true });
  tv.sandbox.Log.report("app", "播放「" + tv.Diag.priv("某部片子") + "」1.2 GB");
  const ring = tv.Diag._test.ring();
  assert.match(ring[ring.length - 1], /app: 播放「…」1\.2 GB$/);
  assert.equal(tv.collector[tv.collector.length - 1], "app: 播放「某部片子」1.2 GB");
});

await t("log.js：js 错误、没人接的 Promise 异常都算出事", () => {
  const tv = television({ withLog: true });
  tv.sandbox.window.onerror("Cannot read properties of undefined (reading 'title')", "app.js", 412);
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  assert.match(lastBody(tv).reason, /^js 错误：Cannot read properties.*@app\.js:412$/);
});

/* ---------------- 那一圈 ---------------- */

await t("关着：不记、不传；关掉时清空本地的；开关记在 tg.diag.off", () => {
  const tv = television();
  tv.Diag.record("播放", "第一行");
  tv.advance(20000);
  assert.ok(tv.storage.get("tg.diag.ring").includes("第一行"));
  tv.Diag.setEnabled(false);
  assert.equal(tv.storage.get("tg.diag.off"), "1");
  assert.equal(tv.storage.has("tg.diag.ring"), false);
  tv.Diag.record("播放", "关着时的一行");
  tv.Diag.incident("放不了：MEDIA_ERR_DECODE");
  tv.advance(60000);
  assert.equal(tv.sent.length, 0);
  assert.equal(tv.Diag._test.ring().length, 0);
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.Diag.status().enabled, false);
  tv.Diag.setEnabled(true);
  assert.equal(tv.storage.has("tg.diag.off"), false);
  assert.equal(tv.Diag.status().enabled, true);
});

await t("最多 600 行、16 万字，挤掉最老的", () => {
  const tv = television();
  for (let i = 0; i < 700; i++) tv.Diag.record("播放", "行 " + i);
  const ring = tv.Diag._test.ring();
  assert.equal(ring.length, 600);
  assert.match(ring[ring.length - 1], /行 699$/);
  for (let i = 0; i < 100; i++) tv.Diag.record("播放", "长".repeat(3000));
  const total = tv.Diag._test.ring().reduce((n, l) => n + l.length, 0);
  assert.ok(total <= 160000, "ring holds " + total + " chars");
  tv.Diag.record("播放", "x".repeat(9000));
  assert.ok(tv.Diag._test.ring().pop().length < 4100);
});

await t("重开应用：上次的日志还在，中间有一行分界；编号不变", () => {
  const storage = new Map();
  const a = television({ storage });
  a.Diag.record("播放", "上一次的最后一行");
  a.advance(20000);
  const b = television({ storage });
  const ring = b.Diag._test.ring();
  assert.ok(ring.some((l) => l.includes("上一次的最后一行")));
  assert.match(ring[ring.length - 1], /新的一次启动/);
  assert.equal(b.Diag.status().device, a.Diag.status().device);
  assert.match(a.Diag.status().device, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

/* ---------------- 什么时候传 ---------------- */

await t("出事后等 8 秒再传，期间的几件事合成一份；信封里是 telegram-tizen", () => {
  const tv = television();
  tv.Diag.incident("连不上 Telegram：连接 15 秒没回");
  tv.advance(3000);
  tv.Diag.record("tg", "后到的一行");
  tv.Diag.incident("读不到来源里的视频：CHANNEL_PRIVATE");
  assert.equal(tv.sent.length, 0);
  tv.advance(tv.Diag._test.SETTLE);
  assert.equal(tv.sent.length, 1);
  const b = lastBody(tv);
  assert.equal(b.reason, "连不上 Telegram：连接 15 秒没回 / 读不到来源里的视频：CHANNEL_PRIVATE");
  assert.ok(b.lines.some((l) => l.includes("后到的一行")));
  assert.equal(b.app, "telegram-tizen");
  assert.match(b.device, /^[A-Z2-9]{8}$/);
  assert.equal(b.version, "1.2.0");
  assert.equal(b.running, "1.3.0");
  assert.equal(b.manual, false);
  assert.match(b.ua, /Tizen 6\.0/);
  assert.equal(tv.sent[0].headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(tv.Diag.status().last.id, "abc23456");
  assert.ok(tv.reported.some((l) => /传了 \d+ 行，编号 abc23456，走 https/.test(l)));
});

await t("自动上传：三分钟一份、一天十二份；手动不受这个限制", () => {
  const tv = television();
  const { SETTLE, AUTO_GAP, AUTO_PER_DAY } = tv.Diag._test;
  tv.Diag.incident("一"); tv.advance(SETTLE);
  tv.Diag.incident("二"); tv.advance(SETTLE);
  assert.equal(tv.sent.length, 1, "second within three minutes is held back");
  assert.ok(tv.reported.some((l) => l.includes("没传（三分钟内")));
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, true, "manual is not held back by the automatic gap");
  assert.equal(lastBody(tv).manual, true);
  for (let i = 0; i < 20; i++) { tv.advance(AUTO_GAP); tv.Diag.incident("循环 " + i); tv.advance(SETTLE); }
  assert.equal(tv.sent.filter((x) => !JSON.parse(x.body).manual).length, AUTO_PER_DAY);
  assert.ok(tv.reported.some((l) => l.includes("今天已经自动传了")));
});

await t("手动连按：十秒内第二次被拒，状态里写着原因", () => {
  const tv = television();
  tv.Diag.upload(() => {});
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.equal(tv.sent.length, 1);
  assert.match(tv.Diag.status().last.why, /刚传过/);
});

await t("https 连不上时用 http 再试一次，日志写明走的哪条", () => {
  const tv = television();
  tv.responder.fn = (x) => (x.url.startsWith("https:") ? [0, ""] : [200, JSON.stringify({ id: "viahttp2" })]);
  tv.Diag.upload(() => {});
  assert.deepEqual(tv.sent.map((x) => x.url), ["https://diag.test/v1/upload", "http://diag.test/v1/upload"]);
  assert.equal(tv.Diag.status().last.id, "viahttp2");
  assert.ok(tv.reported.some((l) => l.includes("走 http（https")));
});

await t("服务器拒绝：写进状态，不当成功", () => {
  const tv = television();
  tv.responder.fn = () => [429, JSON.stringify({ error: "too many from this device" })];
  let r; tv.Diag.upload((x) => { r = x; });
  assert.equal(r.ok, false);
  assert.match(tv.Diag.status().last.why, /HTTP 429 too many/);
});

await t("从源码装的和发布包一样传（diag.js 自己的 https 地址）；DIAG_TO=off、自测构建不传；DIAG_TO 给了地址就传那里", () => {
  const ENDPOINT = /var ENDPOINT = "([^"]*)";/.exec(SRC)[1];
  assert.match(ENDPOINT, /^https:\/\//);
  const lan = "http://10.0.0.2:8097";
  const release = television({ reportTo: "", diagTo: "" });
  assert.equal(release.Diag._test.endpoint(), ENDPOINT);
  const source = television({ reportTo: lan, diagTo: "" });
  assert.equal(source.Diag._test.endpoint(), ENDPOINT);
  assert.equal(source.Diag.status().configured, true);
  /* 比 DIAG_TO、SELFTEST 都老的安装包，更新到这份 diag.js */
  const old = television({ reportTo: lan, diagTo: null, selftest: null });
  assert.equal(old.Diag._test.endpoint(), ENDPOINT);
  for (const quiet of [television({ reportTo: lan, diagTo: "off" }),
                       television({ reportTo: lan, diagTo: "", selftest: "loginexpiry" })]) {
    quiet.Diag.incident("放不了：MEDIA_ERR_DECODE"); quiet.advance(60000);
    assert.equal(quiet.sent.length, 0);
    assert.equal(quiet.Diag.status().configured, false);
  }
  const pointed = television({ reportTo: lan, diagTo: "http://10.0.0.2:8096/v1/upload", selftest: "diag" });
  assert.equal(pointed.Diag._test.endpoint(), "http://10.0.0.2:8096/v1/upload");
  const cfg = fs.readFileSync(here("../app/js/config.js"), "utf8");
  assert.match(cfg, /^var DIAG_TO = "";$/m, "config.js 里的 DIAG_TO 要是空串（deploy.sh 中途退出留下的？）");
});


await t("桌面浏览器不传（UA 里没有 Tizen）：发布构建、给了地址的也不传", () => {
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  for (const desk of [television({ ua: MAC, reportTo: "", diagTo: "" }),
                      television({ ua: MAC, reportTo: "http://10.0.0.2:8099/report", diagTo: "http://10.0.0.2:8097/v1/upload" })]) {
    desk.Diag.incident("放不了：MEDIA_ERR_DECODE"); desk.advance(60000);
    assert.equal(desk.sent.length, 0);
    assert.equal(desk.Diag.status().configured, false);
  }
});
await t("boot.js：diag.js 排在最前（log.js 一加载就要用它）", () => {
  const boot = fs.readFileSync(here("../app/js/boot.js"), "utf8");
  const list = [.../var SCRIPTS = \[([^\]]*)\]/.exec(boot)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(list[0], "diag.js", "SCRIPTS 是 " + list.join(", "));
});

/* ---------------- 源码：进 Log.report() / Diag.incident() 的作者名、文案、昵称都包起来 ---------------- */

await t("app/js：进日志和出事原因的群名、片名、文件名、搜索词、地址、账号名、用户 ID 都包在 Diag.priv 里", () => {
  const dir = here("../app/js/");
  const skip = new Set(["diag.js", "log.js", "selftest.js", "config.js", "boot.js", "tg.bundle.js", "sites.local.js", "i18n.js"]);
  const bad = [];
  let calls = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js") && !skip.has(x))) {
    const src = fs.readFileSync(dir + f, "utf8");
    /* app.js、web.js、player.js 的 R(s) 都是 Log.report(…, s)。 */
    const re = /(?:Log\.report|Diag\.incident|(?<![\w.])R)\(/g;
    let m;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length, depth = 1, q = null;
      while (i < src.length && depth) {
        const c = src[i];
        if (q) { if (c === "\\") i++; else if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      calls++;
      const call = src.slice(m.index, i);
      let rest = call, prev;
      do { prev = rest; rest = rest.replace(/Diag\.priv\((?:[^()]|\([^()]*(?:\([^()]*\)[^()]*)*\))*\)/g, "PRIV"); } while (rest !== prev);
      /* 字段，不是方法；e.name（错误名）、lane.name（读的是哪一路）不是人名，r.info（封面帧的编码、耗时）不是片名，ps.info（维基的条目）是。 */
      if (/\.(title|fileName|query|url|hostname|userId|displayName)\b(?!\()|\b(?:acct|a|cur|dup|f)\.name\b|\bps\.info\b|\br\.msg\b|\bme\.id\b|\bhost\(|字幕文件「" \+ name/.test(rest)) {
        bad.push(f + ":" + src.slice(0, m.index).split("\n").length + ": " + call.replace(/\s+/g, " ").slice(0, 140));
      }
    }
  }
  assert.ok(calls > 80, "只找到 " + calls + " 处调用 —— 匹配规则坏了？");
  assert.deepEqual(bad, [], "没包起来：\n" + bad.join("\n"));
});

if (failures) { console.log(`\n✗ ${failures} 项失败`); process.exit(1); }
console.log("\n✓ 诊断日志全部通过");
