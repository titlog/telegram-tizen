/* build/src/compat.js 的离线校验：给它一个 Chromium 76 那样的 AbortController（没有 reason、throwIfAborted、AbortSignal.any），
 * 看补上的三样行为对不对；再给一个 Chromium 69（Tizen 5.5）那样的全局（没有 globalThis、Object.fromEntries、queueMicrotask、
 * TextEncoder.encodeInto、Symbol.description）。node 自己全都有，所以在 vm 里换成假的、删掉。
 *
 *   node test/compat.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../build/src/compat.js", import.meta.url), "utf8");

function chromium76() {
  class AbortSignal extends EventTarget { constructor() { super(); this.aborted = false; } }
  class AbortController {
    constructor() { this.signal = new AbortSignal(); }
    abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal.dispatchEvent(new Event("abort")); }
  }
  const ctx = { AbortSignal, AbortController, DOMException, Event, EventTarget, Array, Object };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "compat.js" });
  return ctx;
}

const { AbortController: AC, AbortSignal: AS } = chromium76();

// reason：给了就是它，没给是 AbortError；abort 事件里就读得到
let c = new AC(), seen;
c.signal.addEventListener("abort", () => { seen = c.signal.reason; });
c.abort("why");
assert.equal(c.signal.reason, "why");
assert.equal(seen, "why");
c = new AC(); c.abort();
assert.equal(c.signal.reason.name, "AbortError");
c.abort("second");   // 已经 abort 过，reason 不变
assert.equal(c.signal.reason.name, "AbortError");
assert.equal(new AC().signal.reason, undefined);

// throwIfAborted：没 abort 不抛，abort 了抛 reason
c = new AC();
c.signal.throwIfAborted();
c.abort("stop");
assert.throws(() => c.signal.throwIfAborted(), (e) => e === "stop");

// AbortSignal.any：任何一个 abort 就 abort、带它的 reason，之后不再挂在别的信号上
const a = new AC(), b = new AC();
const any = AS.any([a.signal, b.signal]);
assert.equal(any.aborted, false);
b.abort("b went");
assert.equal(any.aborted, true);
assert.equal(any.reason, "b went");
let fired = 0;
any.addEventListener("abort", () => fired++);
a.abort("later");
assert.equal(fired, 0);
assert.equal(any.reason, "b went");
// 已经 abort 了的直接给回 abort 了的
const done = new AC(); done.abort("early");
const any2 = AS.any([new AC().signal, done.signal]);
assert.equal(any2.aborted, true);
assert.equal(any2.reason, "early");

// 已经有这些 API 的引擎上什么都不动
const native = { AbortSignal, AbortController, DOMException, Event, EventTarget, Array, Object };
const before = [AbortSignal.any, AbortSignal.prototype.throwIfAborted, AbortController.prototype.abort];
vm.createContext(native);
vm.runInContext(src, native);
assert.deepEqual([AbortSignal.any, AbortSignal.prototype.throwIfAborted, AbortController.prototype.abort], before);

/* ---------- Chromium 69：globalThis、Object.fromEntries、queueMicrotask、TextEncoder.encodeInto、Symbol.description ---------- */
const old = vm.createContext({ AbortSignal, AbortController, DOMException, Event, EventTarget, TextDecoder, setTimeout });
vm.runInContext(`
  this.self = this;
  delete Object.fromEntries;
  delete Symbol.prototype.description;
  class TextEncoder { encode(s) { return new Uint8Array(Buffer.from(s, "utf8")); } }
  this.TextEncoder = TextEncoder;
`.replace("Buffer.from(s, \"utf8\")", "__enc(s)"), Object.assign(old, { __enc: (s) => Buffer.from(s, "utf8") }));
vm.runInContext("delete globalThis.globalThis; delete this.queueMicrotask;", old);
assert.equal(vm.runInContext("typeof globalThis", old), "undefined");
vm.runInContext(src, old, { filename: "compat.js" });
assert.equal(vm.runInContext("globalThis === self", old), true);
assert.deepEqual(vm.runInContext("JSON.stringify(Object.fromEntries([['a', 1], ['b', 2]]))", old), '{"a":1,"b":2}');
assert.equal(vm.runInContext("Symbol('x y').description + '|' + Symbol().description", old), "x y|undefined");
// encodeInto：放得下全写，read 是 UTF-16 码元数；放不下只写完整的字符
let r = JSON.parse(vm.runInContext("var d = new Uint8Array(16); JSON.stringify([new TextEncoder().encodeInto('a中😀', d), Array.from(d.subarray(0, 8))])", old));
assert.deepEqual(r[0], { read: 4, written: 8 });
assert.deepEqual(r[1], Array.from(Buffer.from("a中😀")));
r = JSON.parse(vm.runInContext("var d = new Uint8Array(6); JSON.stringify(new TextEncoder().encodeInto('a中😀', d))", old));
assert.deepEqual(r, { read: 2, written: 4 });
// queueMicrotask：比 setTimeout 先、按顺序
const order = [];
old.__push = (x) => order.push(x);
vm.runInContext("setTimeout(() => __push('timeout')); queueMicrotask(() => __push(1)); queueMicrotask(() => __push(2));", old);
await new Promise((ok) => setTimeout(ok, 20));
assert.deepEqual(order, [1, 2, "timeout"]);

/* ---------- Chromium 63（Tizen 5.0）：build/legacy/prelude63.js 补的 AbortController、trimStart / trimEnd、DataView 读写 64 位（JSBI），
 * 再叠上 compat.js 的 reason / throwIfAborted / any —— 老电视那份包（tg.legacy.js）就是这个顺序 ---------- */
{
  const { createRequire } = await import("node:module");
  const req = createRequire(new URL("../build/package.json", import.meta.url));
  const jsbi = fs.readFileSync(req.resolve("jsbi/dist/jsbi-umd.js"), "utf8");
  const pre = fs.readFileSync(new URL("../build/legacy/prelude63.js", import.meta.url), "utf8");
  const c63 = vm.createContext({ DOMException, setTimeout, TextDecoder, Uint8Array, ArrayBuffer });
  vm.runInContext(`this.self = this; delete String.prototype.trimStart; delete String.prototype.trimEnd;
    delete DataView.prototype.getBigUint64; delete DataView.prototype.getBigInt64; delete DataView.prototype.setBigUint64; delete DataView.prototype.setBigInt64;`, c63);
  assert.equal(vm.runInContext("typeof AbortController", c63), "undefined");
  vm.runInContext(jsbi + "\n" + pre + "\n" + src, c63, { filename: "jsbi+prelude63+compat.js" });
  const r = JSON.parse(vm.runInContext(`(() => {
    const out = {}, c = new AbortController(), seen = [];
    c.signal.addEventListener("abort", () => seen.push("a"));
    c.signal.addEventListener("abort", () => seen.push("once"), { once: true });
    c.signal.onabort = () => seen.push("on");
    out.before = c.signal.aborted; c.abort("why"); c.abort("again");
    out.after = c.signal.aborted; out.reason = c.signal.reason; out.seen = seen.join(",");
    try { c.signal.throwIfAborted(); out.threw = false; } catch (e) { out.threw = e; }
    const a = new AbortController(), b = new AbortController(), any = AbortSignal.any([a.signal, b.signal]);
    b.abort("b"); out.any = any.aborted + "/" + any.reason;
    const d = new AbortController(); d.abort(); out.defReason = d.signal.reason.name;
    out.trim = "  x ".trimStart() + "|" + "  x ".trimEnd() + "|";
    const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, JSBI.BigInt("0x0102030405060708"));
    out.u64 = dv.getBigUint64(0).toString(16) + " " + Array.from(new Uint8Array(dv.buffer)).join(",");
    dv.setBigInt64(0, JSBI.BigInt(-2), true); out.i64 = dv.getBigInt64(0, true).toString();
    return JSON.stringify(out); })()`, c63));
  assert.deepEqual(r, { before: false, after: true, reason: "why", seen: "on,a,once", threw: "why", any: "true/b", defReason: "AbortError",
    trim: "x |  x|", u64: "102030405060708 1,2,3,4,5,6,7,8", i64: "-2" });
}

console.log("✓ compat.js：reason、throwIfAborted、AbortSignal.any 在 Chromium 76 那样的引擎上补对了；globalThis、fromEntries、queueMicrotask、" +
  "encodeInto、Symbol.description 在 Chromium 69 那样的引擎上补对了；prelude63.js 的 AbortController、trimStart / trimEnd、DataView 64 位在 Chromium 63 那样的引擎上补对了；新引擎上不动");
