/* build/src/compat.js 的离线校验：给它一个 Chromium 76 那样的 AbortController（没有 reason、throwIfAborted、AbortSignal.any），
 * 看补上的三样行为对不对。node 自己全都有，所以在 vm 里换成假的。
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

console.log("✓ compat.js：reason、throwIfAborted、AbortSignal.any 在 Chromium 76 那样的引擎上补对了，新引擎上不动");
