/* mtcute 用到、而 required_version 那代引擎（Tizen 6.0 = Chromium 76）没有的 API。entry.js、worker.js 第一个 import 它，
 * 在 mtcute 的代码跑之前装好。语法由 esbuild 的 target 降级（build/bundle.sh），API 降不了，只能补在这里 ——
 * tools/syntax-verify.mjs 也查不出它们。2026-10-23 在打出来的包里一个个 grep 过（.toReversed、AggregateError 是库自己的，不算）。 */

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
