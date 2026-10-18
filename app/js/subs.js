/* 字幕：外挂文件的解码和解析、片子里带的字幕轨（MP4 的 tx3g / wvtt，MKV 的文字和 PGS 图形字幕）、画到屏幕上。
 *
 *   Subs.isSubFile(name) / Subs.decode(bytes) → 文字 / Subs.parse(text, name) → [{s, e, text, top}]
 *   var tr = Subs.track(codec, codecPrivate)   tr.add(pts, dur, data, opts) / tr.addEvents(list) / tr.count() / tr.kind（"text" | "image"）
 *   var r = Subs.renderer(subEl, topEl, canvasEl)   r.set(tr | null) / r.offset(sec) / r.tick(t) / r.clear()
 *
 * 电视主线程上跑：tick 每 100ms 一次，二分找；显示的内容没变就不碰 DOM。PGS 只存原始字节，轮到显示才解，解过的那张留着。 */
var Subs = (function () {
    "use strict";

    var OPEN_MAX = 6;          // 不知道时长的文字字幕最多显示几秒（到下一条开始为止）
    var LONG = 30;             // 超过这么长的事件单独放一边（标牌、整段的注释），二分往回扫只扫 LONG 秒
    var PGS_MAX = 15;          // PGS 后面还没有显示集（还没下到）也没有时长时，最多留几秒

    function isSubFile(name) { return /\.(srt|ass|ssa|vtt)$/i.test(name || ""); }

    /* ---------- 文件编码 ---------- */

    /* 简体、繁体各一小组高频字（只取两边写法不同的和共用的最常见那些）。GBK 的字节按 Big5 解出来（或者反过来）是一堆生僻字，
     * 很少撞上这些 */
    var COMMON = {};
    ("的一是不了在人有我他她你们中大上来到说就也要会好这那么什没看个为国时对发后过还里样现当开实从经" +
     "這們來說會對發後過還裡樣現當開實從經麼沒個為國時") .split("").forEach(function (c) { COMMON[c] = 1; });
    function score(s) {
        var n = 0, bad = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (COMMON[c]) { n++; } else if (c === "\uFFFD") { bad++; }
        }
        return n - bad * 4;
    }
    function td(enc, b, fatal) { return new TextDecoder(enc, fatal ? { fatal: true } : undefined).decode(b); }

    function decode(b) {
        if (!(b instanceof Uint8Array)) { b = new Uint8Array(b); }
        if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) { return td("utf-8", b.subarray(3)); }
        if (b[0] === 0xFF && b[1] === 0xFE) { return td("utf-16le", b.subarray(2)); }
        if (b[0] === 0xFE && b[1] === 0xFF) { return td("utf-16be", b.subarray(2)); }
        /* 没 BOM 的 UTF-16：字幕里时间码、数字、换行全是 ASCII，高字节是 0 —— 奇数位（LE）或偶数位（BE）上一大片 0 */
        var n = Math.min(b.length, 4096) & ~1, z0 = 0, z1 = 0;
        for (var i = 0; i < n; i += 2) { if (!b[i]) { z0++; } if (!b[i + 1]) { z1++; } }
        if (n >= 16 && z1 > n / 2 * 0.3 && z0 < n / 2 * 0.05) { return td("utf-16le", b); }
        if (n >= 16 && z0 > n / 2 * 0.3 && z1 < n / 2 * 0.05) { return td("utf-16be", b); }
        try { return td("utf-8", b, true); } catch (e) {}
        var gb = td("gb18030", b), big = td("big5", b);
        return score(big) > score(gb) ? big : gb;
    }

    /* ---------- 解析外挂文件 ---------- */

    /* 「01:02:03,456」「02:03.4」「1:02:03.45」→ 秒。逗号点号都认，小数位按小数算（,5 = 0.5 秒） */
    function clock(s) {
        var m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d+))?\s*$/.exec(s);
        if (!m) { return NaN; }
        return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +("0." + m[4]) : 0);
    }

    var ENT = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
    function lines(s) {
        return s.split("\n").map(function (l) { return l.replace(/[ \t\u3000]+/g, " ").trim(); }).filter(Boolean).join("\n");
    }

    /* SRT / MKV 的 S_TEXT/UTF8 / WebVTT 的正文：HTML 样的标签去掉；有的 SRT 里夹着 ASS 的 {\an8} —— 认它当「放上面」 */
    function cleanHtml(s, vtt) {
        var top = /\{\\an[789]\}/.test(s);
        s = s.replace(/\r/g, "").replace(/\{\\[^}]*\}/g, "");
        if (vtt) { s = s.replace(/<rt>[\s\S]*?<\/rt>/g, "").replace(/<\d[^>]*>/g, ""); }
        s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "").replace(/&(lt|gt|amp|quot|#39|apos|nbsp);/g, function (m) { return ENT[m]; });
        return { text: lines(s), top: top };
    }

    function parseSrt(text) {
        var out = [], ls = text.split("\n"), cur = null;
        var TIME = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;
        function end() {
            if (cur) {
                var c = cleanHtml(cur.buf.join("\n"));
                if (c.text) { out.push({ s: cur.s, e: cur.e > cur.s ? cur.e : cur.s + 3, text: c.text, top: c.top }); }
            }
            cur = null;
        }
        for (var i = 0; i < ls.length; i++) {
            var m = TIME.exec(ls[i]);
            if (m && !isNaN(clock(m[1])) && !isNaN(clock(m[2]))) {
                end();
                cur = { s: clock(m[1]), e: clock(m[2]), buf: [] };
                continue;
            }
            if (!cur) { continue; }
            /* 空行结束一条；不少文件漏了空行，「序号行 + 下一行是时间」也算结束 */
            if (!ls[i].trim()) { end(); continue; }
            if (/^\s*\d+\s*$/.test(ls[i]) && i + 1 < ls.length && TIME.test(ls[i + 1])) { end(); continue; }
            cur.buf.push(ls[i]);
        }
        end();
        return out;
    }

    function parseVtt(text) {
        var out = [], blocks = text.split(/\n[ \t]*\n/);
        blocks.forEach(function (b) {
            var ls = b.split("\n");
            var k = ls.findIndex(function (l) { return /-->/.test(l); });
            if (k < 0) { return; }
            var m = /^\s*([\d:.]+)\s*-->\s*([\d:.]+)(.*)$/.exec(ls[k]);
            if (!m) { return; }
            var s = clock(m[1]), e = clock(m[2]);
            if (isNaN(s) || isNaN(e)) { return; }
            var c = cleanHtml(ls.slice(k + 1).join("\n"), true);
            if (c.text) { out.push({ s: s, e: e > s ? e : s + 3, text: c.text, top: c.top || vttTop(m[3]) }); }
        });
        return out;
    }
    /* cue 设置里的 line:0 / line:10% 是从上往下数；负数是从下往上 */
    function vttTop(set) {
        var m = /(?:^|\s)line:(-?\d+(?:\.\d+)?)(%?)/.exec(set || "");
        if (!m) { return false; }
        var v = +m[1];
        return m[2] ? v < 50 : v >= 0 && v < 6;
    }

    /* ASS / SSA 的头：样式名 → 是否放上面，PlayResY（\pos 的纵坐标按它算上半屏还是下半屏）。
     * [V4+ Styles] 的 Alignment 是小键盘（7–9 在上），[V4 Styles]（SSA）是老写法（5–7 在上，9–11 在中间） */
    function assHeader(text) {
        var h = { styles: {}, resY: 0, ssa: false }, sec = "", fmt = null;
        text.split("\n").forEach(function (l) {
            l = l.trim();
            var sm = /^\[(.+)\]$/.exec(l);
            if (sm) { sec = sm[1].toLowerCase(); fmt = null; if (sec === "v4 styles") { h.ssa = true; } return; }
            if (sec === "script info") {
                var r = /^PlayResY\s*:\s*(\d+)/i.exec(l);
                if (r) { h.resY = +r[1]; }
                if (/^ScriptType\s*:\s*v4\.00\s*$/i.test(l)) { h.ssa = true; }
            } else if (/styles$/.test(sec)) {
                var f = /^Format\s*:(.*)$/i.exec(l);
                if (f) { fmt = f[1].split(",").map(function (x) { return x.trim().toLowerCase(); }); return; }
                var st = /^Style\s*:(.*)$/i.exec(l);
                if (st) {
                    var v = st[1].split(","), names = fmt || ["name", "fontname", "fontsize", "primarycolour", "secondarycolour", "outlinecolour", "backcolour",
                        "bold", "italic", "underline", "strikeout", "scalex", "scaley", "spacing", "angle", "borderstyle", "outline", "shadow", "alignment"];
                    var name = (v[names.indexOf("name")] || "").trim(), al = +(v[names.indexOf("alignment")] || 2);
                    var top = sec === "v4 styles" || h.ssa ? al >= 5 && al <= 7 : al >= 7 && al <= 9;
                    h.styles[name] = top;
                    h.styles[name.toLowerCase()] = top;
                }
            }
        });
        if (!h.resY) { h.resY = 288; }
        return h;
    }
    function styleTop(h, name) {
        name = (name || "").trim().replace(/^\*/, "");
        if (h.styles[name] !== undefined) { return h.styles[name]; }
        return !!h.styles[name.toLowerCase()];
    }

    /* 一条 ASS 事件的正文：{} 里的覆盖标签去掉（\an \a \pos \move 拿来定位置），绘图模式（\p1 之后、\p0 之前）的内容丢掉，
     * \N \n → 换行，\h → 空格。只剩绘图 / 空白的返回 null */
    function cleanAss(t, h, top) {
        var out = "", drawing = false, re = /\{([^}]*)\}/g, last = 0, m;
        function tags(s) {
            var x;
            if ((x = /\\an([1-9])/.exec(s))) { top = +x[1] >= 7; }
            else if ((x = /\\a(\d+)/.exec(s))) { var a = +x[1]; top = a >= 5 && a <= 7; }
            if ((x = /\\(?:pos|move)\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(s))) { top = +x[1] < h.resY / 2; }
            var ps = s.match(/\\p(\d+)/g);
            if (ps) { drawing = +ps[ps.length - 1].slice(2) > 0; }
        }
        while ((m = re.exec(t))) {
            if (!drawing) { out += t.slice(last, m.index); }
            tags(m[1]);
            last = re.lastIndex;
        }
        if (!drawing) { out += t.slice(last); }
        out = lines(out.replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
        return out ? { text: out, top: top } : null;
    }

    function parseAss(text) {
        var h = assHeader(text), out = [], sec = "", fmt = null, ord = 0;
        text.split("\n").forEach(function (l) {
            var t = l.trim(), sm = /^\[(.+)\]$/.exec(t);
            if (sm) { sec = sm[1].toLowerCase(); fmt = null; return; }
            if (sec !== "events") { return; }
            var f = /^Format\s*:(.*)$/i.exec(t);
            if (f) { fmt = f[1].split(",").map(function (x) { return x.trim().toLowerCase(); }); return; }
            var d = /^Dialogue\s*:(.*)$/i.exec(l.replace(/^\s+/, ""));
            if (!d) { return; }
            var names = fmt || (h.ssa ? ["marked", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
                                      : ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]);
            var parts = splitN(d[1], names.length);
            var s = clock(parts[names.indexOf("start")] || ""), e = clock(parts[names.indexOf("end")] || "");
            if (isNaN(s) || isNaN(e)) { return; }
            var c = cleanAss(parts[names.indexOf("text")] || "", h, styleTop(h, parts[names.indexOf("style")]));
            if (c) { out.push({ s: s, e: e > s ? e : s + 3, text: c.text, top: c.top, ord: ord++ }); }
        });
        return out;
    }
    /* 按逗号切成 n 段，最后一段（正文）里的逗号不切 */
    function splitN(s, n) {
        var out = [], p = 0;
        for (var i = 0; i < n - 1; i++) {
            var k = s.indexOf(",", p);
            if (k < 0) { break; }
            out.push(s.slice(p, k));
            p = k + 1;
        }
        out.push(s.slice(p));
        return out;
    }

    function parse(text, name) {
        text = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
        var list;
        if (/^\s*WEBVTT/.test(text)) { list = parseVtt(text); }
        else if (/^\s*\[Script Info\]/im.test(text) || /^\s*\[V4\+? Styles\]/im.test(text) || /^\s*Dialogue\s*:/im.test(text)) { list = parseAss(text); }
        else if (/\d:\d{1,2}[,.]\d+\s*-->/.test(text)) { list = parseSrt(text); }
        else if (/\.vtt$/i.test(name || "")) { list = parseVtt(text); }
        else { list = []; }
        list.forEach(function (e, i) { if (e.ord === undefined) { e.ord = i; } e.top = !!e.top; });
        return list.sort(function (a, b) { return a.s - b.s || a.ord - b.ord; });
    }

    /* ---------- 片子里带的字幕：样本 / 块 → 文字 ---------- */

    function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
    function u32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
    function utf8(b) { return new TextDecoder("utf-8").decode(b); }

    /* tx3g：2 字节长度 + 文字（3GPP 规定以 FE FF 开头的是 UTF-16BE），后面的 styl/hlit 之类盒子不管 */
    function tx3g(d) {
        if (d.length < 2) { return null; }
        var n = Math.min(u16(d, 0), d.length - 2);
        if (!n) { return null; }
        var b = d.subarray(2, 2 + n);
        var s = b[0] === 0xFE && b[1] === 0xFF ? new TextDecoder("utf-16be").decode(b.subarray(2)) : utf8(b);
        return { text: lines(s.replace(/\r\n?/g, "\n")), top: false };
    }

    /* wvtt（ISO 14496-30）：一个样本是几个盒子，每个 vttc 是一条 cue（payl 正文、sttg 设置）；vtte 是「这段时间没字幕」。
     * 同一时刻的几条 cue 位置可能不同，各成一条 */
    function wvtt(d) {
        var out = [];
        for (var o = 0; o + 8 <= d.length;) {
            var size = u32(d, o), type = String.fromCharCode(d[o + 4], d[o + 5], d[o + 6], d[o + 7]);
            if (size < 8 || o + size > d.length) { break; }
            if (type === "vttc") {
                var text = "", top = false;
                for (var p = o + 8; p + 8 <= o + size;) {
                    var cs = u32(d, p), ct = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
                    if (cs < 8 || p + cs > o + size) { break; }
                    if (ct === "payl") { text = utf8(d.subarray(p + 8, p + cs)); }
                    else if (ct === "sttg") { top = vttTop(utf8(d.subarray(p + 8, p + cs))); }
                    p += cs;
                }
                var c = cleanHtml(text, true);
                if (c.text) { c.top = c.top || top; out.push(c); }
            }
            o += size;
        }
        return out;
    }

    /* MKV 的 S_TEXT/ASS、S_TEXT/SSA 块：「ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text」 */
    function mkvAss(d, h) {
        var f = splitN(utf8(d), 9);
        if (f.length < 9) { return null; }
        var c = cleanAss(f[8], h, styleTop(h, f[2]));
        if (c) { c.ord = +f[0] || 0; }
        return c;
    }

    /* ---------- 一条字幕轨 ---------- */

    function Track(codec, cp) {
        this.codec = codec;
        this.kind = codec === "S_HDMV/PGS" ? "image" : "text";
        this.ev = [];          // 按开始时间排；文字：{s, e, text, top, ord}，e < 0 = 不知道多长；图形：{s, dur, d, st, n, vw, vh}
        this.long = [];
        this.seen = {};
        this.seq = 0;
        this.gen = 0;          // 内容变了加一，renderer 据此知道要重算
        this.head = /^S_TEXT\/(ASS|SSA)$/.test(codec) ? assHeader(cp ? utf8(cp instanceof Uint8Array ? cp : new Uint8Array(cp)).replace(/\r\n?/g, "\n") : "") : null;
    }

    /* 二分：第一个 s > t 的下标 */
    function upper(ev, t) {
        var lo = 0, hi = ev.length;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (ev[mid].s <= t) { lo = mid + 1; } else { hi = mid; } }
        return lo;
    }
    /* 按开始时间插进去；顺序来的（正常播放）直接接在后面，跳回前面才真的要挪 */
    function insert(ev, x) {
        var n = ev.length;
        if (!n || ev[n - 1].s < x.s || (ev[n - 1].s === x.s && ev[n - 1].ord <= x.ord)) { ev.push(x); return; }
        var i = upper(ev, x.s);
        while (i > 0 && ev[i - 1].s === x.s && ev[i - 1].ord > x.ord) { i--; }
        ev.splice(i, 0, x);
    }

    Track.prototype.count = function () { return this.ev.length + this.long.length; };

    Track.prototype.put = function (s, e, c) {
        var key = Math.round(s * 1000) + "|" + c.text + "|" + (c.top ? 1 : 0);
        if (this.seen[key]) { return; }
        this.seen[key] = 1;
        var x = { s: s, e: e, text: c.text, top: !!c.top, ord: c.ord !== undefined ? c.ord : this.seq++ };
        if (e > 0 && e - s > LONG) { this.long.push(x); } else { insert(this.ev, x); }
        this.gen++;
    };

    Track.prototype.add = function (pts, dur, data, opts) {
        var self = this;
        if (!(data instanceof Uint8Array)) { data = new Uint8Array(data); }
        if (opts && opts.zlib) {
            return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()
                .then(function (b) { self.add(pts, dur, new Uint8Array(b)); });
        }
        if (this.kind === "image") { this.addPgs(pts, dur, data); return; }
        var c;
        if (this.codec === "tx3g") { c = tx3g(data); }
        else if (this.codec === "wvtt") { c = wvtt(data); }
        else if (this.head) { c = mkvAss(data, this.head); }
        else { c = cleanHtml(utf8(data).replace(/\r\n?/g, "\n"), this.codec === "S_TEXT/WEBVTT"); }
        var list = Array.isArray(c) ? c : c ? [c] : [];
        for (var i = 0; i < list.length; i++) { if (list[i].text) { this.put(pts, dur > 0 ? pts + dur : -1, list[i]); } }
    };

    Track.prototype.addEvents = function (list) {
        for (var i = 0; i < list.length; i++) { this.put(list[i].s, list[i].e, list[i]); }
    };

    /* 不知道多长的事件：到下一条（开始时间更晚的）为止，最多 OPEN_MAX 秒 */
    Track.prototype.end = function (i) {
        var x = this.ev[i];
        if (x.e > 0) { return x.e; }
        for (var j = i + 1; j < this.ev.length; j++) { if (this.ev[j].s > x.s) { return Math.min(this.ev[j].s, x.s + OPEN_MAX); } }
        return x.s + OPEN_MAX;
    };

    /* t 时刻要显示的文字事件，按 ord 排 */
    Track.prototype.at = function (t) {
        var ev = this.ev, act = [];
        for (var i = upper(ev, t) - 1; i >= 0 && ev[i].s > t - LONG; i--) { if (this.end(i) > t) { act.push(ev[i]); } }
        for (var k = 0; k < this.long.length; k++) { var x = this.long[k]; if (x.s <= t && x.e > t) { act.push(x); } }
        return act.sort(function (a, b) { return a.ord - b.ord; });
    };

    /* ---------- PGS ---------- */

    /* 显示集只存原始字节，加的时候只看一眼 PCS：composition state、几个对象、画面尺寸 */
    Track.prototype.addPgs = function (pts, dur, d) {
        var key = Math.round(pts * 1000);
        if (this.seen[key]) { return; }
        var x = { s: pts, dur: dur > 0 ? dur : 0, d: d.slice(), st: 0, n: 0, vw: 1920, vh: 1080, ord: key };
        for (var o = 0; o + 3 <= d.length;) {
            var type = d[o], size = u16(d, o + 1), p = o + 3;
            if (p + size > d.length) { break; }
            if (type === 0x16 && size >= 11) { x.vw = u16(d, p); x.vh = u16(d, p + 2); x.st = d[p + 7]; x.n = d[p + 10]; x.pcs = true; break; }
            o = p + size;
        }
        if (!x.pcs) { return; }
        this.seen[key] = 1;
        insert(this.ev, x);
        this.gen++;
    };

    /* t 时刻该显示的显示集下标；-1 = 空 */
    Track.prototype.pgsAt = function (t) {
        var ev = this.ev, i = upper(ev, t) - 1;
        if (i < 0) { return -1; }
        var x = ev[i];
        if (!x.n) { return -1; }
        if (x.dur > 0 && t >= x.s + x.dur) { return -1; }
        if (i === ev.length - 1 && !(x.dur > 0) && t >= x.s + PGS_MAX) { return -1; }
        return i;
    };

    /* 调色板：YCbCr（限定范围）→ RGBA，按小端打进 Uint32（字节序 R G B A）。高清（高 > 576）用 BT.709，标清 BT.601 —— 和 ffmpeg 的 pgssubdec 一样 */
    function palColor(y, cr, cb, a, hd) {
        var Y = (y - 16) * 255 / 219, u = cb - 128, v = cr - 128, k = 255 / 224, r, g, b;
        if (hd) { r = Y + 1.5747 * k * v; g = Y - 0.1873 * k * u - 0.4682 * k * v; b = Y + 1.8556 * k * u; }
        else { r = Y + 1.402 * k * v; g = Y - 0.34414 * k * u - 0.71414 * k * v; b = Y + 1.772 * k * u; }
        r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
        return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }

    /* 第 i 个显示集要画的东西：从它往前最近的 epoch start / acquisition point（state ≠ 0，调色板和对象都从那开始算）重放到 i，
     * 攒出调色板和对象，拿 i 的 PCS 摆。返回 {vw, vh, objs: [{w, h, x, y, crop, rle, pal}]} */
    Track.prototype.pgsState = function (i) {
        var ev = this.ev, j = i;
        while (j > 0 && !(ev[j].st & 0xC0) && i - j < 200) { j--; }
        var pals = {}, objs = {}, pcs = null;
        for (var k = j; k <= i; k++) {
            var d = ev[k].d;
            for (var o = 0; o + 3 <= d.length;) {
                var type = d[o], size = u16(d, o + 1), p = o + 3, e = p + size;
                if (e > d.length) { break; }
                if (type === 0x16 && size >= 11) {
                    var c = { vw: u16(d, p), vh: u16(d, p + 2), st: d[p + 7], palId: d[p + 9], objs: [] };
                    if (c.st & 0xC0) { pals = {}; objs = {}; }
                    var n = d[p + 10], q = p + 11;
                    for (var m = 0; m < n && q + 8 <= e; m++) {
                        var ob = { id: u16(d, q), x: u16(d, q + 4), y: u16(d, q + 6), crop: null };
                        if (d[q + 3] & 0x80) { ob.crop = { x: u16(d, q + 8), y: u16(d, q + 10), w: u16(d, q + 12), h: u16(d, q + 14) }; q += 16; }
                        else { q += 8; }
                        c.objs.push(ob);
                    }
                    pcs = c;
                } else if (type === 0x14 && size >= 2) {
                    var id = d[p], pal = pals[id] || (pals[id] = { raw: [] });
                    for (var q2 = p + 2; q2 + 5 <= e; q2 += 5) { pal.raw[d[q2]] = [d[q2 + 1], d[q2 + 2], d[q2 + 3], d[q2 + 4]]; }
                    pal.lut = null;
                } else if (type === 0x15 && size >= 4) {
                    var oid = u16(d, p), fl = d[p + 3];
                    if (fl & 0x80) {
                        if (size < 11) { o = e; continue; }
                        var len = (d[p + 4] << 16) | (d[p + 5] << 8) | d[p + 6];
                        objs[oid] = { w: u16(d, p + 7), h: u16(d, p + 9), len: Math.max(0, len - 4), parts: [d.subarray(p + 11, e)] };
                    } else if (objs[oid]) {
                        objs[oid].parts.push(d.subarray(p + 4, e));
                    }
                }
                o = e;
            }
        }
        if (!pcs) { return null; }
        var hd = pcs.vh > 576, pal0 = pals[pcs.palId];
        if (pal0 && !pal0.lut) {
            pal0.lut = new Uint32Array(256);
            pal0.raw.forEach(function (v, idx) { if (v) { pal0.lut[idx] = palColor(v[0], v[1], v[2], v[3], hd); } });
        }
        var out = { vw: pcs.vw, vh: pcs.vh, objs: [] };
        pcs.objs.forEach(function (ob) {
            var o = objs[ob.id];
            if (!o || !o.w || !o.h) { return; }
            out.objs.push({ w: o.w, h: o.h, x: ob.x, y: ob.y, crop: ob.crop, parts: o.parts, pal: pal0 ? pal0.lut : new Uint32Array(256) });
        });
        return out;
    };

    /* RLE（HDMV PG）：非 0 字节 = 一个这种颜色的点；00 00 = 行尾；00 0L / 00 4L LL = L 个 0 号色；00 8L CC / 00 CL LL CC = L 个 CC 色 */
    function rle(parts, w, h, pal, px) {
        /* 大对象跨好几个 ODS，切口可能在转义序列中间 —— 先拼成一块 */
        var b = parts[0];
        if (parts.length > 1) {
            var len0 = 0, o = 0;
            parts.forEach(function (p) { len0 += p.length; });
            b = new Uint8Array(len0);
            parts.forEach(function (p) { b.set(p, o); o += p.length; });
        }
        var n = b.length, i = 0, x = 0, y = 0, row = 0;
        while (i < n && y < h) {
            var c = b[i];
            if (c) { if (x < w) { px[row + x] = pal[c]; } x++; i++; continue; }
            if (i + 1 >= n) { break; }
            var f = b[i + 1];
            if (!f) { x = 0; y++; row = y * w; i += 2; continue; }
            var len = f & 0x3F, need = 2 + (f & 0x40 ? 1 : 0) + (f & 0x80 ? 1 : 0);
            if (i + need > n) { break; }
            if (f & 0x40) { len = (len << 8) | b[i + 2]; }
            var color = f & 0x80 ? pal[b[i + need - 1]] : pal[0];
            var end = Math.min(x + len, w);
            for (var k = x; k < end; k++) { px[row + k] = color; }
            x += len;
            i += need;
        }
    }

    /* ---------- 画 ---------- */

    function renderer(subEl, topEl, canvasEl) {
        var cur = null, off = 0, lastText = null, lastImg = -1, lastGen = -1, dirty = false;
        var g = canvasEl ? canvasEl.getContext("2d") : null, scratch = null;

        function setText(bottom, top) {
            var key = bottom + "\u0001" + top;
            if (key === lastText) { return; }
            lastText = key;
            if (subEl) { subEl.textContent = bottom; }
            if (topEl) { topEl.textContent = top; }
        }
        function clearPic() {
            if (g && dirty) { g.clearRect(0, 0, canvasEl.width, canvasEl.height); dirty = false; }
            lastImg = -1;
        }
        function drawPgs(i) {
            clearPic();
            var st = cur.pgsState(i);
            lastImg = i;
            if (!st || !g) { return; }
            var sx = canvasEl.width / (st.vw || 1920), sy = canvasEl.height / (st.vh || 1080);
            var doc = canvasEl.ownerDocument;
            st.objs.forEach(function (o) {
                if (!scratch) { scratch = doc.createElement("canvas"); }
                scratch.width = o.w; scratch.height = o.h;
                var sg = scratch.getContext("2d"), img = sg.createImageData(o.w, o.h);
                rle(o.parts, o.w, o.h, o.pal, new Uint32Array(img.data.buffer));
                sg.putImageData(img, 0, 0);
                var c = o.crop || { x: 0, y: 0, w: o.w, h: o.h };
                var cw = Math.min(c.w, o.w - c.x), ch = Math.min(c.h, o.h - c.y);
                if (cw <= 0 || ch <= 0) { return; }
                g.drawImage(scratch, c.x, c.y, cw, ch, o.x * sx, o.y * sy, cw * sx, ch * sy);
                dirty = true;
            });
        }

        var api = {};
        api.set = function (tr) { cur = tr || null; api.clear(); };
        api.offset = function (sec) { off = +sec || 0; lastText = null; lastImg = -1; lastGen = -1; };
        api.clear = function () { setText("", ""); clearPic(); lastText = null; lastGen = -1; };
        api.tick = function (t) {
            if (!cur) { return; }
            t -= off;
            if (cur.kind === "image") {
                var i = cur.pgsAt(t);
                if (i === lastImg && cur.gen === lastGen) { return; }
                lastGen = cur.gen;
                if (i < 0) { clearPic(); } else if (i !== lastImg || dirty === false) { drawPgs(i); }
                return;
            }
            var act = cur.at(t), bottom = [], top = [], seen = {};
            for (var k = 0; k < act.length; k++) {
                var x = act[k], kk = (x.top ? "t" : "b") + x.text;
                if (seen[kk]) { continue; }
                seen[kk] = 1;
                (x.top ? top : bottom).push(x.text);
            }
            setText(bottom.join("\n"), top.join("\n"));
        };
        return api;
    }

    return {
        isSubFile: isSubFile, decode: decode, parse: parse, renderer: renderer,
        track: function (codec, codecPrivate) { return new Track(codec, codecPrivate); }
    };
})();
