/* Chromium 63（Tizen 5.0）缺的：AbortController / AbortSignal（66；63 连 EventTarget 构造器都没有，自己记监听）、trimStart / trimEnd（66） */
(function (G) {
  if (typeof G.AbortController === 'undefined') {
    var AbortSignal = function () { this.aborted = false; this.reason = undefined; this.onabort = null; this._l = []; };
    AbortSignal.prototype.addEventListener = function (t, f, o) { if (t === 'abort' && f) { this._l.push({ f: f, once: !!(o && o.once) }); } };
    AbortSignal.prototype.removeEventListener = function (t, f) { this._l = this._l.filter(function (x) { return x.f !== f; }); };
    AbortSignal.prototype.dispatchEvent = function (ev) {
      var self = this, l = this._l.slice();
      this._l = this._l.filter(function (x) { return !x.once; });
      if (typeof this.onabort === 'function') { try { this.onabort.call(this, ev); } catch (e) { setTimeout(function () { throw e; }); } }
      l.forEach(function (x) { try { typeof x.f === 'function' ? x.f.call(self, ev) : x.f.handleEvent(ev); } catch (e) { setTimeout(function () { throw e; }); } });
      return true;
    };
    var AbortController = function () { this.signal = new AbortSignal(); };
    AbortController.prototype.abort = function (reason) {
      var s = this.signal;
      if (s.aborted) { return; }
      s.aborted = true;
      /* compat.js 包了一层 abort：先把 reason 写好、再不带参数调这里 —— 已经有了就别盖掉（单元测试抓到的） */
      if (s.reason === undefined) { s.reason = reason !== undefined ? reason : new DOMException('This operation was aborted', 'AbortError'); }
      s.dispatchEvent({ type: 'abort', target: s });
    };
    G.AbortController = AbortController;
    G.AbortSignal = AbortSignal;
  }
  if (!String.prototype.trimStart) { String.prototype.trimStart = String.prototype.trimLeft; }
  if (!String.prototype.trimEnd) { String.prototype.trimEnd = String.prototype.trimRight; }
})(typeof self !== 'undefined' ? self : window);
/* DataView 读写 64 位整数（67）：转换过的代码里这些值都是 JSBI，交给 JSBI 自带的同名函数 */
(function () {
  if (typeof DataView === 'undefined' || DataView.prototype.getBigUint64 || typeof JSBI === 'undefined') { return; }
  DataView.prototype.getBigUint64 = function (o, le) { return JSBI.DataViewGetBigUint64(this, o, le); };
  DataView.prototype.getBigInt64 = function (o, le) { return JSBI.DataViewGetBigInt64(this, o, le); };
  DataView.prototype.setBigUint64 = function (o, v, le) { JSBI.DataViewSetBigUint64(this, o, v, le); };
  DataView.prototype.setBigInt64 = function (o, v, le) { JSBI.DataViewSetBigInt64(this, o, v, le); };
})();
