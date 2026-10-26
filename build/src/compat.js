/* mtcute 用到、而 required_version 那代引擎（Tizen 5.5 = Chromium 69；10-23 时是 6.0 = 76）没有的 API。entry.js、worker.js 第一个
 * import 它，在 mtcute 的代码跑之前装好。语法由 esbuild 的 target 降级（build/bundle.sh），API 降不了，只能补在这里 ——
 * tools/syntax-verify.mjs 也查不出它们。2026-10-23 在打出来的包里一个个 grep 过（.toReversed、AggregateError 是库自己的，不算）；
 * 10-26 为 Tizen 5.5 又过了一遍 69–76 之间的（下面前五样）。 */

/* globalThis（Chromium 71）：mtcute 拿它找全局对象。后台线程里是 self，主线程是 window */
if (typeof globalThis === 'undefined') {
  (typeof self !== 'undefined' ? self : window).globalThis = typeof self !== 'undefined' ? self : window;
}

/* Object.fromEntries（Chromium 73）：2026-10-25 那台 Tizen 5.5 降了语法之后卡在这（「Object.fromEntries is not a function」） */
if (typeof Object.fromEntries !== 'function') {
  Object.fromEntries = function fromEntries(entries) {
    const o = {};
    for (const kv of entries) { o[kv[0]] = kv[1]; }
    return o;
  };
}

/* queueMicrotask（Chromium 71）：回调抛的错照常冒到全局（setTimeout 里再抛），不吞掉 */
if (typeof queueMicrotask !== 'function') {
  globalThis.queueMicrotask = function queueMicrotask(fn) {
    Promise.resolve().then(fn).catch((e) => setTimeout(() => { throw e; }));
  };
}

/* TextEncoder.prototype.encodeInto（Chromium 74）：mtcute 写 TL 字符串时先按字节数开好缓冲再编码进去 */
if (typeof TextEncoder !== 'undefined' && typeof TextEncoder.prototype.encodeInto !== 'function') {
  TextEncoder.prototype.encodeInto = function encodeInto(str, dest) {
    const b = this.encode(str);
    if (b.length <= dest.length) { dest.set(b); return { read: str.length, written: b.length }; }
    /* 放不下：只写完整的字符（UTF-8 的续字节 10xxxxxx 不能当结尾），read 按写进去的字符算 UTF-16 码元 */
    let n = dest.length;
    while (n > 0 && (b[n] & 0xc0) === 0x80) { n--; }
    dest.set(b.subarray(0, n));
    return { read: new TextDecoder().decode(b.subarray(0, n)).length, written: n };
  };
}

/* Symbol.prototype.description（Chromium 70）。从 toString 里取：Symbol() 和 Symbol('') 分不出来，都当没有（undefined） */
if (typeof Symbol === 'function' && !('description' in Symbol.prototype)) {
  Object.defineProperty(Symbol.prototype, 'description', {
    configurable: true,
    get() { const m = /^Symbol\(([\s\S]*)\)$/.exec(Symbol.prototype.toString.call(this)); return m && m[1] ? m[1] : undefined; }
  });
}

/* AbortSignal.reason（Chromium 98）：mtcute / @fuman 被取消时 `throw signal.reason`、`reject(signal.reason)`，没有它就是抛
 * undefined，接住的地方再读 .message 就又炸一次。abort 之前给这个信号写上 reason（abort() 同步派发事件，监听里读得到）。 */
if (typeof AbortController !== 'undefined' && !('reason' in AbortSignal.prototype)) {
  const abort = AbortController.prototype.abort;
  AbortController.prototype.abort = function (reason) {
    if (!this.signal.aborted) {
      const r = reason !== undefined ? reason : new DOMException('This operation was aborted', 'AbortError');
      try { Object.defineProperty(this.signal, 'reason', { value: r, configurable: true }); } catch (e) {}
    }
    return abort.call(this);
  };
}

/* AbortSignal.prototype.throwIfAborted（Chromium 100）：@fuman/net 连 WebSocket 之前、mtcute 限流等待的每一圈、扫码登录换 DC
 * 都调它。没有它连不上 Telegram，而且不报错、一直等：10-23 桌面 Chromium 76.0.3809 跑后台线程，不补 getMe 20 秒没回，补上 1.5 秒
 * 回 AUTH_KEY_UNREGISTERED（还没登录，就是连上了）。Tizen 6.5–7.0（Chromium 85–94）解析得了 1.1.2 的包，卡的就是这里。 */
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
  AbortSignal.prototype.throwIfAborted = function throwIfAborted() {
    if (!this.aborted) return;
    throw this.reason !== undefined ? this.reason : new DOMException('This operation was aborted', 'AbortError');
  };
}

/* AbortSignal.any（Chromium 116）：@mtcute/core 的 combineAbortSignals，请求自己带了 abort 信号（看视频时的下载就带）
 * 又碰上 FLOOD_WAIT / 内部错误要重试时才调。任何一个 abort 了，合起来的就 abort（带它的 reason）；之后摘掉挂在各个信号上的监听。 */
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function any(signals) {
    const ctrl = new AbortController();
    const list = Array.from(signals);
    for (const s of list) {
      if (s.aborted) { ctrl.abort(s.reason); return ctrl.signal; }
    }
    const hooks = list.map((s) => {
      const onAbort = () => {
        for (const h of hooks) { h.s.removeEventListener('abort', h.onAbort); }
        ctrl.abort(s.reason);
      };
      s.addEventListener('abort', onAbort);
      return { s, onAbort };
    });
    return ctrl.signal;
  };
}
