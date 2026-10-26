/* FLAC 软件解码：音乐里的 .flac 文件。电视解不了 FLAC —— <audio> 直接放、装进 MP4、走 MSE（只有音频、配了视频）都一样，数据进得去、
 * 从来不解（2026-10-26 deploy.sh --music 实测，见 CLAUDE.md）。所以自己解成 16 位 PCM，拼成 WAV 交给 <audio>：WAV 做成 blob 在电视上
 * 放得了、跳得动。边下边解，在后台线程里（主线程只收解好的 PCM 块）。
 *
 * 按 FLAC 规范（RFC 9639）：帧头、CONSTANT / VERBATIM / FIXED / LPC 子帧、Rice / Rice2 余数（含 escape）、wasted bits、
 * 左 / 侧、侧 / 右、中 / 侧声道还原。16 位以上的右移成 16 位，以下的左移；采样率、声道数照原样。不校验 CRC、MD5。
 * test/check-flac.mjs 对着 ffmpeg 解出来的 PCM 逐字节比。
 *
 *   var d = Flac.decoder();  d.push(Uint8Array) → Int16Array（这次解出来的，交错）；d.end() → 剩下的；d.info → {rate, channels, bits, samples}
 *   Flac.wavHeader(info, PCM 字节数) → Uint8Array(44)
 *   var w = Flac.worker();   w.push(Uint8Array)；w.end() → Promise<Blob（audio/wav）>；w.stop()
 */
var Flac = (function () {
    "use strict";

    /* 解码器本体：后台线程里也要用（拿它的源码拼成线程的脚本），所以不能引用外面的任何东西 */
    function core() {
        var BS = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
        var SR = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000, 0, 0, 0, 0];
        var SS = [0, 8, 12, 0, 16, 20, 24, 32];
        var NEED = { need: true }, BAD = { bad: true };
        var POW2 = [];
        for (var p = 0; p < 64; p++) { POW2.push(Math.pow(2, p)); }

        function decoder() {
            var b = new Uint8Array(0), bitPos = 0, info = null, out = [], outLen = 0;

            function bits(n) {
                if (n === 0) { return 0; }
                var i = bitPos >>> 3, o = bitPos & 7;
                if (n <= 24) {
                    var w = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
                    bitPos += n;
                    return ((w << o) >>> 0) >>> (32 - n);
                }
                var hi = bits(n - 16);
                return hi * 65536 + bits(16);
            }
            function sbits(n) {
                if (n === 0) { return 0; }
                var v = bits(n);
                return v >= POW2[n - 1] ? v - POW2[n] : v;
            }
            function unary() {
                var n = 0;
                for (;;) {
                    var i = bitPos >>> 3;
                    if (i >= b.length) { throw NEED; }
                    var o = bitPos & 7, rest = (b[i] << o) & 0xff;
                    if (rest === 0) { n += 8 - o; bitPos += 8 - o; }
                    else { var lz = Math.clz32(rest) - 24; n += lz; bitPos += lz + 1; return n; }
                }
            }

            function header() {
                /* 前面可能有 ID3v2 标签（有的 FLAC 是这样存的） */
                var p0 = 0;
                if (b.length < 10) { throw NEED; }
                if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
                    p0 = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
                }
                if (b.length < p0 + 8) { throw NEED; }
                if (b[p0] !== 0x66 || b[p0 + 1] !== 0x4C || b[p0 + 2] !== 0x61 || b[p0 + 3] !== 0x43) { throw new Error("不是 FLAC（没有 fLaC 标记）"); }
                var q = p0 + 4, last = false, si = null;
                while (!last) {
                    if (b.length < q + 4) { throw NEED; }
                    last = !!(b[q] & 0x80);
                    var type = b[q] & 0x7f, len = (b[q + 1] << 16) | (b[q + 2] << 8) | b[q + 3];
                    if (b.length < q + 4 + len) { throw NEED; }
                    if (type === 0) { si = q + 4; }
                    q += 4 + len;
                }
                if (si === null) { throw new Error("FLAC 没有 STREAMINFO"); }
                bitPos = si * 8;
                bits(16); var maxBs = bits(16); bits(24); var maxFs = bits(24);
                var rate = bits(20), channels = bits(3) + 1, bps = bits(5) + 1, samples = bits(4) * POW2[32] + bits(32);
                info = { rate: rate, channels: channels, bits: bps, samples: samples, maxBlock: maxBs, maxFrame: maxFs };
                bitPos = q * 8;
            }

            function residual(s, bs, order) {
                var method = bits(2);
                if (method > 1) { throw BAD; }
                var pb = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31, po = bits(4), parts = 1 << po, i = order;
                for (var p = 0; p < parts; p++) {
                    var n = (bs >> po) - (p === 0 ? order : 0), k = bits(pb), j;
                    if (k === esc) {
                        var nb = bits(5);
                        for (j = 0; j < n; j++) { s[i++] = sbits(nb); }
                    } else {
                        var m = POW2[k];
                        for (j = 0; j < n; j++) {
                            var v = unary() * m + bits(k);
                            s[i++] = (v & 1) ? -(v + 1) / 2 : v / 2;
                        }
                    }
                }
            }

            function subframe(bs, bps) {
                if (bits(1)) { throw BAD; }
                var type = bits(6), wasted = 0, s = new Int32Array(bs), i, j;
                if (bits(1)) { wasted = unary() + 1; bps -= wasted; }
                if (type === 0) {
                    var c = sbits(bps);
                    for (i = 0; i < bs; i++) { s[i] = c; }
                } else if (type === 1) {
                    for (i = 0; i < bs; i++) { s[i] = sbits(bps); }
                } else if (type >= 8 && type <= 12) {
                    var fo = type - 8;
                    for (i = 0; i < fo; i++) { s[i] = sbits(bps); }
                    residual(s, bs, fo);
                    if (fo === 1) { for (i = 1; i < bs; i++) { s[i] += s[i - 1]; } }
                    else if (fo === 2) { for (i = 2; i < bs; i++) { s[i] += 2 * s[i - 1] - s[i - 2]; } }
                    else if (fo === 3) { for (i = 3; i < bs; i++) { s[i] += 3 * s[i - 1] - 3 * s[i - 2] + s[i - 3]; } }
                    else if (fo === 4) { for (i = 4; i < bs; i++) { s[i] += 4 * s[i - 1] - 6 * s[i - 2] + 4 * s[i - 3] - s[i - 4]; } }
                } else if (type >= 32) {
                    var order = (type & 31) + 1;
                    for (i = 0; i < order; i++) { s[i] = sbits(bps); }
                    var prec = bits(4) + 1;
                    if (prec === 16) { throw BAD; }
                    var shift = sbits(5), div = POW2[shift < 0 ? 0 : shift], coef = new Array(order);
                    for (i = 0; i < order; i++) { coef[i] = sbits(prec); }
                    residual(s, bs, order);
                    /* 系数乘样本最多 2^40，32 阶加起来不到 2^46：用浮点算（2^53 以内是准的），除以 2^shift 再向下取整 = 算术右移 */
                    for (i = order; i < bs; i++) {
                        var sum = 0;
                        for (j = 0; j < order; j++) { sum += coef[j] * s[i - 1 - j]; }
                        s[i] += Math.floor(sum / div);
                    }
                } else { throw BAD; }
                if (wasted) { var wm = POW2[wasted]; for (i = 0; i < bs; i++) { s[i] *= wm; } }
                return s;
            }

            /* 一帧：解出来的交错 16 位样本推进 out。字节不够抛 NEED（从帧头重来），帧头不对抛 BAD（往后找下一个帧头） */
            function frame() {
                var start = bitPos;
                if ((b.length - (start >>> 3)) < 16) { throw NEED; }
                if (bits(15) !== 0x7FFC) { bitPos = start; throw BAD; }
                bits(1);
                var bsCode = bits(4), srCode = bits(4), chCode = bits(4), ssCode = bits(3);
                bits(1);
                if (bsCode === 0 || srCode === 15 || chCode > 10 || ssCode === 3) { bitPos = start; throw BAD; }
                var x = bits(8), extra = x < 0x80 ? 0 : x >= 0xFE ? 6 : x >= 0xFC ? 5 : x >= 0xF8 ? 4 : x >= 0xF0 ? 3 : x >= 0xE0 ? 2 : x >= 0xC0 ? 1 : -1;
                if (extra < 0) { bitPos = start; throw BAD; }
                for (var e = 0; e < extra; e++) { bits(8); }
                var bs = bsCode === 6 ? bits(8) + 1 : bsCode === 7 ? bits(16) + 1 : BS[bsCode];
                if (srCode === 12) { bits(8); } else if (srCode === 13 || srCode === 14) { bits(16); }
                bits(8);    // 帧头的 CRC-8
                var bps = ssCode === 0 ? info.bits : SS[ssCode], nch = chCode < 8 ? chCode + 1 : 2, ch = [], c, i;
                if (bps > 30) { throw new Error("FLAC " + bps + " 位样本不支持"); }
                for (c = 0; c < nch; c++) {
                    var side = (chCode === 8 && c === 1) || (chCode === 9 && c === 0) || (chCode === 10 && c === 1);
                    ch.push(subframe(bs, bps + (side ? 1 : 0)));
                }
                bitPos = (bitPos + 7) & ~7;
                bits(16);   // 帧尾的 CRC-16
                if ((bitPos >>> 3) > b.length) { throw NEED; }
                if (chCode === 8) { for (i = 0; i < bs; i++) { ch[1][i] = ch[0][i] - ch[1][i]; } }
                else if (chCode === 9) { for (i = 0; i < bs; i++) { ch[0][i] += ch[1][i]; } }
                else if (chCode === 10) {
                    for (i = 0; i < bs; i++) {
                        var sd = ch[1][i], m = ch[0][i] * 2 + (sd & 1);
                        ch[0][i] = (m + sd) >> 1;
                        ch[1][i] = (m - sd) >> 1;
                    }
                }
                var o = new Int16Array(bs * nch), sh = bps - 16;
                for (c = 0; c < nch; c++) {
                    var a = ch[c], k = c;
                    if (sh > 0) { for (i = 0; i < bs; i++, k += nch) { o[k] = a[i] >> sh; } }
                    else if (sh < 0) { for (i = 0; i < bs; i++, k += nch) { o[k] = a[i] << -sh; } }
                    else { for (i = 0; i < bs; i++, k += nch) { o[k] = a[i]; } }
                }
                if (info.frameChannels === undefined) { info.frameChannels = nch; }
                out.push(o);
                outLen += o.length;
            }

            function run(final) {
                if (!info) {
                    try { header(); } catch (e) { if (e === NEED) { if (final) { throw new Error("FLAC 文件不完整"); } return; } throw e; }
                }
                /* 不知道一帧最多多长（STREAMINFO 没写）就攒够 1MB 再解；最后一块什么时候都解 */
                var room = (info.maxFrame || 1048576) + 16;
                for (;;) {
                    var at = bitPos;
                    if (!final && b.length - (at >>> 3) < room) { break; }
                    if ((at >>> 3) >= b.length) { break; }
                    try { frame(); }
                    catch (e) {
                        if (e === NEED) { bitPos = at; break; }
                        if (e !== BAD) { throw e; }
                        /* 不是帧头：往后找下一个 0xFFF8 / 0xFFF9 */
                        var q = (at >>> 3) + 1;
                        while (q + 1 < b.length && !(b[q] === 0xFF && (b[q + 1] & 0xFE) === 0xF8)) { q++; }
                        if (q + 1 >= b.length) { bitPos = q * 8; break; }
                        bitPos = q * 8;
                    }
                }
                /* 用掉的字节扔掉 */
                var used = bitPos >>> 3;
                if (used > 0) { b = b.subarray(used); bitPos -= used * 8; }
            }
            function take() {
                var r = new Int16Array(outLen), k = 0;
                for (var i = 0; i < out.length; i++) { r.set(out[i], k); k += out[i].length; }
                out = [];
                outLen = 0;
                return r;
            }
            return {
                push: function (u8) {
                    var nb = new Uint8Array(b.length + u8.length);
                    nb.set(b);
                    nb.set(u8, b.length);
                    b = nb;
                    run(false);
                    return take();
                },
                end: function () { run(true); return take(); },
                get info() { return info; }
            };
        }
        return { decoder: decoder };
    }

    var C = core();

    function wavHeader(info, bytes) {
        var ch = info.frameChannels || info.channels, h = new DataView(new ArrayBuffer(44));
        function str(o, s) { for (var i = 0; i < 4; i++) { h.setUint8(o + i, s.charCodeAt(i)); } }
        str(0, "RIFF"); h.setUint32(4, 36 + bytes, true); str(8, "WAVE");
        str(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
        h.setUint32(24, info.rate, true); h.setUint32(28, info.rate * ch * 2, true); h.setUint16(32, ch * 2, true); h.setUint16(34, 16, true);
        str(36, "data"); h.setUint32(40, bytes, true);
        return new Uint8Array(h.buffer);
    }

    /* 后台线程：脚本是 core 的源码拼上收发消息的几行，用 blob: 地址起（电视上页面是 file://，不能从文件起线程，mtcute 也是这样） */
    var workerUrl = null;
    function worker() {
        if (!workerUrl) {
            var src = "var C = (" + core.toString() + ")(), d = C.decoder();\n" +
                "onmessage = function (e) { var m = e.data, r;\n" +
                "  try { r = m.end ? d.end() : d.push(new Uint8Array(m.buf)); } catch (err) { postMessage({ error: String(err && err.message || err) }); return; }\n" +
                "  postMessage({ pcm: r.buffer, info: d.info, end: !!m.end }, [r.buffer]); };";
            workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }
        var w = new Worker(workerUrl), parts = [], bytes = 0, info = null, done = null, fail = null, err = null;
        w.onmessage = function (e) {
            var m = e.data;
            if (m.error) { err = new Error(m.error); w.terminate(); if (fail) { fail(err); } return; }
            if (m.pcm.byteLength) { parts.push(m.pcm); bytes += m.pcm.byteLength; }
            if (m.info) { info = m.info; }
            if (m.end) {
                w.terminate();
                if (!info) { if (fail) { fail(new Error("FLAC 没解出东西")); } return; }
                done(new Blob([wavHeader(info, bytes)].concat(parts), { type: "audio/wav" }));
            }
        };
        return {
            push: function (u8) { if (err) { throw err; } var c = u8.slice(); w.postMessage({ buf: c.buffer }, [c.buffer]); },
            end: function () {
                return new Promise(function (ok, no) { if (err) { no(err); return; } done = ok; fail = no; w.postMessage({ end: true }); });
            },
            stop: function () { w.terminate(); }
        };
    }

    return { decoder: C.decoder, wavHeader: wavHeader, worker: worker };
})();
