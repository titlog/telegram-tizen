/* 渐进式 MP4 → MSE 用的分段 MP4（fMP4），自己写的，替掉 mp4box.js。
 *
 * 为什么不用 mp4box：它给每个样本建一个 JS 对象。《末代皇帝》219 分钟 ~93 万个样本，在电视上解析 moov 4 秒、
 * 第一次 seek 9.5 秒、之后每 append 512KB 还要 200–300ms 生成分段，全在主线程（2026-10-01 探测实测）。
 * 这里样本表存 TypedArray，找关键帧二分，分段自己拼 moof+mdat。
 *
 * 用法：
 *   var top = Mp4.scanTop(bytes, base)          顶层盒子（ftyp/moov/mdat…），只要盒子头在 bytes 里就列出来
 *   var movie = Mp4.parseMoov(moovBytes)       { timescale, duration(秒), tracks: [...] }
 *   Mp4.initSegment(track, id)                  这条轨的 init 段（ftyp+moov，stsd 原样拷过来）；id 不给就用 track.id
 *   Mp4.fragment(track, list, seq, copyBytes, id)  一串样本拼成 moof+mdat；copyBytes(dst, dstOff, fileOff, size) 往 dst 里拷样本数据
 *   Mp4.fragmentFrames(id, frames, seq)         不靠样本表、直接给帧（mkv.js 拆出来的）：frames = [{dts, cto, dur, key, data}]
 *   Mp4.afterLeading(track, k)                  跳到关键帧 k 时要跳过的前导帧之后的第一帧
 *   Mp4.sampleAt(track, sec) / Mp4.keyAtOrBefore(track, i) / Mp4.keyNear(track, sec, dir) / Mp4.pts(track, i)
 */
var Mp4 = (function () {
    "use strict";
    /* 显示给用户的话（i18n.js）；node 里的离线测试没有 I18n，原样用中文 */
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    /* ---------- 读 ---------- */

    function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
    function u32(b, o) { return ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]); }
    function i32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
    function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
    function i64(b, o) { return i32(b, o) * 4294967296 + u32(b, o + 4); }
    function type4(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }

    /* 盒子头：{type, start, size, hdr}；size = 0 表示「到文件尾」（返回 Infinity），头不完整返回 null。 */
    function header(b, o, base) {
        if (o + 8 > b.length) { return null; }
        var size = u32(b, o), t = type4(b, o + 4), hdr = 8;
        if (size === 1) {
            if (o + 16 > b.length) { return null; }
            size = u64(b, o + 8);
            hdr = 16;
        } else if (size === 0) {
            size = Infinity;
        }
        return { type: t, start: base + o, size: size, hdr: hdr };
    }

    /* 顶层盒子扫描：从 bytes 开头（文件偏移 base）一个接一个读头，读到头不完整为止。 */
    function scanTop(b, base) {
        var out = [], o = 0;
        while (o < b.length) {
            var h = header(b, o, base);
            if (!h) { break; }
            out.push(h);
            if (h.size === Infinity || h.size < 8) { break; }
            o += h.size;
        }
        return out;
    }

    /* 在 [s, e) 里找子盒子 */
    function children(b, s, e) {
        var out = [], o = s;
        while (o + 8 <= e) {
            var h = header(b, o, 0);
            if (!h || h.size < 8) { break; }
            var end = h.size === Infinity ? e : o + h.size;
            out.push({ type: h.type, s: o, p: o + h.hdr, e: Math.min(end, e) });
            o = end;
        }
        return out;
    }
    function child(b, box, t) {
        var c = children(b, box.p, box.e);
        for (var i = 0; i < c.length; i++) { if (c[i].type === t) { return c[i]; } }
        return null;
    }
    function path(b, box, types) {
        for (var i = 0; i < types.length && box; i++) { box = child(b, box, types[i]); }
        return box;
    }

    /* ---------- codec 字符串 ---------- */

    function hex2(n) { return (n < 16 ? "0" : "") + n.toString(16); }

    function avcCodec(b, entry, t, tr) {
        var c = child(b, { p: entry.p + 78, e: entry.e }, "avcC");
        if (!c) { return t; }
        tr.levelFix = fixAvcLevel(b.subarray(c.p, c.e), tr.width, tr.height);      // 原地改，后面切出来的 stsd 就是改过的
        entry.config = b.slice(c.p, c.e);           // WebCodecs 解单帧要的 description
        return avcString(t, entry.config);
    }

    /* H.264 写的级别比画面小：2026-10-25 一台 Tizen 6.0 放一部 576x1280 60fps 的竖屏片，文件里写的是 Level 1.3（那一级一帧最多
     * 396 个宏块，这片一帧 2880 个），出画面之前就 Player error code=3。桌面 Chrome 软解不看级别，三星的硬件解码器多半按级别分配资源。
     * 帧大小超出写的级别时，把 avcC 和里面 SPS 的 level_idc 改成够用的一级（按 60fps 算；写高了解码器无所谓）。原地改 c（avcC 正文），
     * 返回 {from, to, mbs}；没改返回 null。[level_idc, 一帧最多宏块, 每秒最多宏块]，H.264 附录 A 表 A-1 */
    var AVC_LEVELS = [[10, 99, 1485], [11, 396, 3000], [12, 396, 6000], [13, 396, 11880], [20, 396, 11880], [21, 792, 19800], [22, 1620, 20250],
        [30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [41, 8192, 245760], [42, 8704, 522240],
        [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600]];
    function fixAvcLevel(c, w, h) {
        if (!c || c.length < 12 || !w || !h) { return null; }
        var mbs = Math.ceil(w / 16) * Math.ceil(h / 16), have = c[3], cur = null;
        AVC_LEVELS.forEach(function (l) { if (l[0] === have) { cur = l; } });
        if (!cur || mbs <= cur[1]) { return null; }        // 不认识的级别不动
        var want = AVC_LEVELS.filter(function (l) { return l[1] >= mbs && l[2] >= mbs * 60; })[0] || AVC_LEVELS[AVC_LEVELS.length - 1];
        c[3] = want[0];
        /* 第一个 SPS：avcC 第 6 字节起是 2 字节长度 + NAL（头 0x67、profile_idc、约束位、level_idc） */
        if ((c[5] & 0x1f) && (c[8] & 0x1f) === 7) { c[11] = want[0]; }
        return { from: have / 10, to: want[0] / 10, mbs: mbs };
    }
    /* avcC 的正文（AVCDecoderConfigurationRecord）→ codecs 字符串。mkv.js 也用（MKV 的 CodecPrivate 就是它） */
    function avcString(t, c) { return t + "." + hex2(c[1]) + hex2(c[2]) + hex2(c[3]); }

    function hevcCodec(b, entry, t) {
        var c = child(b, { p: entry.p + 78, e: entry.e }, "hvcC");
        if (!c) { return t; }
        entry.config = b.slice(c.p, c.e);
        return hevcString(t, entry.config);
    }
    /* hvcC 的正文 → codecs 字符串，ISO/IEC 14496-15 附录 E */
    function hevcString(t, b) {
        var x = b[1];
        var space = x >> 6, tier = (x >> 5) & 1, prof = x & 31;
        var compat = u32(b, 2), rev = 0;
        for (var i = 0; i < 32; i++) { rev = (rev << 1) | ((compat >>> i) & 1); }
        var s = t + "." + ["", "A", "B", "C"][space] + prof + "." + (rev >>> 0).toString(16) + "." + (tier ? "H" : "L") + b[12];
        var cons = [];
        for (var k = 0; k < 6; k++) { cons.push(b[6 + k]); }
        while (cons.length && !cons[cons.length - 1]) { cons.pop(); }
        for (var j = 0; j < cons.length; j++) { s += "." + cons[j].toString(16).toUpperCase(); }
        return s;
    }

    /* esds 里的描述符：tag(1) + 变长长度 */
    function desc(b, o) {
        var tag = b[o++], len = 0, k = 0, x;
        do { x = b[o++]; len = (len << 7) | (x & 127); k++; } while ((x & 128) && k < 4);
        return { tag: tag, p: o, e: o + len };
    }
    function mp4aCodec(b, entry, child0) {
        var e = child(b, { p: child0, e: entry.e }, "esds");
        if (!e) { return "mp4a.40.2"; }
        var d = desc(b, e.p + 4);                       // ES_Descriptor
        if (d.tag !== 3) { return "mp4a.40.2"; }
        var o = d.p + 2, fl = b[o++];
        if (fl & 128) { o += 2; }
        if (fl & 64) { o += 1 + b[o]; }
        if (fl & 32) { o += 2; }
        var dc = desc(b, o);                            // DecoderConfigDescriptor
        if (dc.tag !== 4) { return "mp4a.40.2"; }
        var oti = b[dc.p];
        if (oti !== 0x40) { return "mp4a." + hex2(oti); }
        var ds = desc(b, dc.p + 13);                    // DecoderSpecificInfo
        if (ds.tag !== 5) { return "mp4a.40.2"; }
        var aot = b[ds.p] >> 3;
        if (aot === 31) { aot = 32 + (((b[ds.p] & 7) << 3) | (b[ds.p + 1] >> 5)); }
        return "mp4a.40." + aot;
    }

    function describeEntry(b, stsd, tr) {
        var entry = children(b, stsd.p + 8, stsd.e)[0];
        if (!entry) { throw new Error("stsd 是空的"); }
        var t = entry.type;
        tr.format = t;
        if (tr.kind === "video") {
            tr.width = u16(b, entry.p + 24);
            tr.height = u16(b, entry.p + 26);
            if (t === "avc1" || t === "avc3") { tr.codec = avcCodec(b, entry, t, tr); }
            else if (t === "hvc1" || t === "hev1") { tr.codec = hevcCodec(b, entry, t); }
            else if (t === "av01") { tr.codec = "av01.0.08M.08"; }
            else { tr.codec = t; tr.unsupported = tx("视频格式 {0} 放不了", t); }
            tr.config = entry.config || null;
            tr.mime = "video/mp4; codecs=\"" + tr.codec + "\"";
        } else if (tr.kind === "audio") {
            var ver = u16(b, entry.p + 8);             // QuickTime 声音条目有 v1 / v2，多 16 / 36 字节
            tr.channels = u16(b, entry.p + 16);
            tr.rate = u32(b, entry.p + 24) >>> 16;
            var c0 = entry.p + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
            if (t === "mp4a") { tr.codec = mp4aCodec(b, entry, c0); }
            else if (t === "ac-3" || t === "ec-3") { tr.codec = t; }
            else if (t === "Opus") { tr.codec = "opus"; }
            else if (t === "fLaC") { tr.codec = "flac"; }
            else if (t === "alac") { tr.codec = t; tr.unsupported = tx("Apple 无损（ALAC）音频电视解不了"); }
            else { tr.codec = t; tr.unsupported = tx("音频格式 {0} 放不了", t); }
            tr.mime = "audio/mp4; codecs=\"" + tr.codec + "\"";
        } else {
            /* 字幕轨：tx3g（ffmpeg 的 mov_text）、QuickTime 的 text（样本格式一样：2 字节长度 + 文字）、wvtt（ISO 14496-30）。
             * 不进 SourceBuffer，样本交给 subs.js */
            tr.codec = t === "text" ? "tx3g" : t;
            if (t !== "tx3g" && t !== "text" && t !== "wvtt") { tr.unsupported = tx("字幕格式 {0} 放不了", t); }
        }
        tr.stsd = b.slice(stsd.s, stsd.e);
    }

    /* ---------- 样本表 ---------- */

    function sampleTable(b, stbl, tr) {
        var stsz = child(b, stbl, "stsz"), stz2 = child(b, stbl, "stz2");
        var n, size, i, o;
        if (stsz) {
            var fixed = u32(b, stsz.p + 4);
            n = u32(b, stsz.p + 8);
            size = new Uint32Array(n);
            if (fixed) { size.fill(fixed); }
            else { for (i = 0, o = stsz.p + 12; i < n; i++, o += 4) { size[i] = u32(b, o); } }
        } else if (stz2) {
            var fs = b[stz2.p + 7];
            n = u32(b, stz2.p + 8);
            size = new Uint32Array(n);
            for (i = 0, o = stz2.p + 12; i < n; i++) {
                if (fs === 16) { size[i] = u16(b, o); o += 2; }
                else if (fs === 8) { size[i] = b[o]; o += 1; }
                else { size[i] = (i & 1) ? b[o++] & 15 : b[o] >> 4; }
            }
        } else { throw new Error("没有 stsz"); }

        /* 偏移：stsc（每个 chunk 几个样本）× stco/co64（chunk 在文件里的位置） */
        var stco = child(b, stbl, "stco"), co64 = child(b, stbl, "co64"), stsc = child(b, stbl, "stsc");
        var nChunks = u32(b, (stco || co64).p + 4), chunkOff = (stco || co64).p + 8;
        var nsc = u32(b, stsc.p + 4);
        var offset = new Float64Array(n);
        var k = 0;
        for (var e = 0; e < nsc; e++) {
            var first = u32(b, stsc.p + 8 + e * 12) - 1;
            var per = u32(b, stsc.p + 12 + e * 12);
            var last = e + 1 < nsc ? u32(b, stsc.p + 8 + (e + 1) * 12) - 1 : nChunks;
            for (var c = first; c < last && k < n; c++) {
                var off = stco ? u32(b, chunkOff + c * 4) : u64(b, chunkOff + c * 8);
                for (var s = 0; s < per && k < n; s++) { offset[k] = off; off += size[k]; k++; }
            }
        }
        if (k !== n) { throw new Error("stsc/stco 只覆盖了 " + k + "/" + n + " 个样本"); }

        /* 解码时间：stts */
        var stts = child(b, stbl, "stts"), dts = new Float64Array(n), t = 0, lastDelta = 0;
        var nts = u32(b, stts.p + 4);
        k = 0;
        for (e = 0, o = stts.p + 8; e < nts; e++, o += 8) {
            var cnt = u32(b, o);
            lastDelta = u32(b, o + 4);
            for (i = 0; i < cnt && k < n; i++) { dts[k++] = t; t += lastDelta; }
        }
        for (; k < n; k++) { dts[k] = t; t += lastDelta; }

        /* 合成时间偏移：ctts（v1 是有符号的；v0 按有符号读也一样，实际值都小于 2^31） */
        var ctts = child(b, stbl, "ctts"), cto = null;
        if (ctts) {
            cto = new Int32Array(n);
            var ncs = u32(b, ctts.p + 4);
            k = 0;
            for (e = 0, o = ctts.p + 8; e < ncs; e++, o += 8) {
                var cc = u32(b, o), v = i32(b, o + 4);
                for (i = 0; i < cc && k < n; i++) { cto[k++] = v; }
            }
        }

        /* 关键帧：stss（没有 = 全是关键帧，音频就是这样） */
        var stss = child(b, stbl, "stss"), keys = null;
        if (stss) {
            var nk = u32(b, stss.p + 4);
            keys = new Uint32Array(nk);
            for (i = 0, o = stss.p + 8; i < nk; i++, o += 4) { keys[i] = u32(b, o) - 1; }
        }

        tr.n = n;
        tr.size = size;
        tr.offset = offset;
        tr.dts = dts;
        tr.cto = cto;
        tr.keys = keys;
        tr.end = t;                                     // 最后一个样本的结束（解码时间）
        tr.lastDelta = lastDelta;
    }

    /* edit list：第一段非空编辑的 media_time 就是「首帧往前挪多少」（B 帧的视频常见，等于首帧的 ctts）。
     * 前面的空编辑是整体延后，单位是电影时间刻度。 */
    function editShift(b, trak, movieTs, ts) {
        var elst = path(b, trak, ["edts", "elst"]);
        if (!elst) { return 0; }
        var v = b[elst.p], n = u32(b, elst.p + 4), o = elst.p + 8, delay = 0;
        for (var i = 0; i < n; i++) {
            var dur = v ? u64(b, o) : u32(b, o);
            var mt = v ? i64(b, o + 8) : i32(b, o + 4);
            o += v ? 20 : 12;
            if (mt === -1) { delay += dur; continue; }
            return mt - Math.round(delay * ts / movieTs);
        }
        return 0;
    }

    /* mdhd 里的语言：三个 5 位字母（ISO 639-2/T），「und」= 没写 */
    function mdhdLang(b, mdhd) {
        var x = u16(b, mdhd.p + (b[mdhd.p] ? 32 : 20));
        var s = String.fromCharCode(((x >> 10) & 31) + 0x60, ((x >> 5) & 31) + 0x60, (x & 31) + 0x60);
        return /^[a-z]{3}$/.test(s) && s !== "und" ? s : "";
    }
    /* 轨道名：udta/name（ffmpeg 把 title 写在这）→ hdlr 的名字。「SoundHandler」「Core Media Audio」这类编码器默认值不算 */
    function trackName(b, trak, hdlr) {
        var s = "", nm = path(b, trak, ["udta", "name"]);
        if (nm) { s = utf8(b.subarray(nm.p, nm.e)); }
        else if (hdlr && hdlr.e > hdlr.p + 24) {
            var n = b.subarray(hdlr.p + 24, hdlr.e);
            if (n.length && n[0] === n.length - 1) { n = n.subarray(1); }       // QuickTime 的 hdlr 名字是 Pascal 字符串
            s = utf8(n);
        }
        s = s.replace(/\0[\s\S]*$/, "").trim();
        return /handler|media|^(video|audio|sound|subtitle|text)$|^gpac|^l-smash|^bento|^apple/i.test(s) ? "" : s;
    }
    function utf8(a) { try { return new TextDecoder("utf-8").decode(a); } catch (e) { return ""; } }

    function parseMoov(b) {
        var moov = { p: 8, e: b.length };
        var top = header(b, 0, 0);
        if (!top || top.type !== "moov") { throw new Error("不是 moov"); }
        moov.p = top.hdr;
        var mvhd = child(b, moov, "mvhd");
        var mv = b[mvhd.p];
        var movieTs = u32(b, mvhd.p + (mv ? 20 : 12));
        var movieDur = mv ? u64(b, mvhd.p + 24) : u32(b, mvhd.p + 16);
        if (child(b, moov, "mvex")) { throw new Error("已经是分段 MP4（fragmented），还不支持"); }

        var tracks = [], perKind = {};
        children(b, moov.p, moov.e).forEach(function (trak) {
            if (trak.type !== "trak") { return; }
            var hdlr = path(b, trak, ["mdia", "hdlr"]);
            var h = hdlr ? type4(b, hdlr.p + 8) : "";
            var kind = h === "vide" ? "video" : h === "soun" ? "audio" : h === "sbtl" || h === "text" || h === "subt" ? "sub" : "";
            if (!kind) { return; }
            var tkhd = child(b, trak, "tkhd");
            var mdhd = path(b, trak, ["mdia", "mdhd"]);
            var stbl = path(b, trak, ["mdia", "minf", "stbl"]);
            var tr = {
                kind: kind,
                index: perKind[kind] = (perKind[kind] === undefined ? 0 : perKind[kind] + 1),     // 同类轨里的第几条（ffprobe 的 a:1 之类）
                id: u32(b, tkhd.p + (b[tkhd.p] ? 20 : 12)),
                enabled: !!(b[tkhd.p + 3] & 1),          // tkhd 的 track_enabled：多音轨的 MP4 里默认那条是开着的
                timescale: u32(b, mdhd.p + (b[mdhd.p] ? 20 : 12)),
                lang: mdhdLang(b, mdhd),
                name: trackName(b, trak, hdlr)
            };
            describeEntry(b, child(b, stbl, "stsd"), tr);
            sampleTable(b, stbl, tr);
            /* 音频的 edit list 多是编码器预滚（1024/2112 个样本，20–50ms），表达它要负的显示时间，不值得；只认视频的。 */
            tr.shift = tr.kind === "video" ? editShift(b, trak, movieTs, tr.timescale) : 0;
            tr.duration = (tr.end - tr.shift) / tr.timescale;
            tracks.push(tr);
        });
        return { timescale: movieTs, duration: movieDur / movieTs, tracks: tracks };
    }

    /* ---------- 查找 ---------- */

    function pts(tr, i) { return (tr.dts[i] + (tr.cto ? tr.cto[i] : 0) - tr.shift) / tr.timescale; }

    /* 解码时间 ≤ sec 的最后一个样本（dts 单调，二分） */
    function sampleAt(tr, sec) {
        var t = sec * tr.timescale + tr.shift, lo = 0, hi = tr.n - 1;
        if (t <= tr.dts[0]) { return 0; }
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (tr.dts[mid] <= t) { lo = mid; } else { hi = mid - 1; }
        }
        return lo;
    }

    /* keys 里 ≤ i 的最后一个关键帧在 keys 里的下标 */
    function keyIndex(tr, i) {
        var k = tr.keys, lo = 0, hi = k.length - 1;
        if (i <= k[0]) { return 0; }
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (k[mid] <= i) { lo = mid; } else { hi = mid - 1; }
        }
        return lo;
    }
    function keyAtOrBefore(tr, i) { return tr.keys ? tr.keys[keyIndex(tr, i)] : i; }

    /* 离 sec 最近的关键帧。dir > 0 / < 0（快进 / 快退）时保证真的往那个方向动了半秒以上 ——
     * 关键帧间隔可能比一次快进的步长还大，只取最近的会原地不动。 */
    function keyNear(tr, sec, dir, fromSec) {
        if (!tr.keys) { return sampleAt(tr, sec); }
        var ks = tr.keys, ki = keyIndex(tr, sampleAt(tr, sec));
        if (ki + 1 < ks.length && Math.abs(pts(tr, ks[ki + 1]) - sec) < Math.abs(pts(tr, ks[ki]) - sec)) { ki++; }
        if (dir > 0) { while (ki + 1 < ks.length && pts(tr, ks[ki]) <= fromSec + 0.5) { ki++; } }
        if (dir < 0) { while (ki > 0 && pts(tr, ks[ki]) >= fromSec - 0.5) { ki--; } }
        return ks[ki];
    }

    /* ---------- 写 ---------- */

    function W(n) { this.b = new Uint8Array(n); this.o = 0; }
    W.prototype.u8 = function (v) { this.b[this.o++] = v; };
    W.prototype.u16 = function (v) { this.b[this.o++] = v >> 8; this.b[this.o++] = v; };
    W.prototype.u32 = function (v) {
        var b = this.b, o = this.o;
        b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v;
        this.o = o + 4;
    };
    W.prototype.u64 = function (v) { this.u32(Math.floor(v / 4294967296)); this.u32(v % 4294967296); };
    W.prototype.str = function (s) { for (var i = 0; i < s.length; i++) { this.b[this.o++] = s.charCodeAt(i); } };
    W.prototype.bytes = function (a) { this.b.set(a, this.o); this.o += a.length; };
    W.prototype.zeros = function (n) { this.o += n; };

    /* box("type", 正文片段…) —— 片段是 Uint8Array */
    function box(t) {
        var parts = Array.prototype.slice.call(arguments, 1), len = 8;
        parts.forEach(function (p) { len += p.length; });
        var w = new W(len);
        w.u32(len); w.str(t);
        parts.forEach(function (p) { w.bytes(p); });
        return w.b;
    }
    function full(t, ver, flags, body) {
        var w = new W(4 + body.length);
        w.u32(((ver & 255) << 24) | flags);
        w.bytes(body);
        return box(t, w.b);
    }
    function raw(fill, n) { var w = new W(n); fill(w); return w.b; }

    var MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

    function initSegment(tr, id) {
        var video = tr.kind === "video";
        id = id || tr.id;
        var ftyp = box("ftyp", raw(function (w) { w.str("isom"); w.u32(0x200); w.str("isomiso6mp41"); }, 20));
        var mvhd = full("mvhd", 0, 0, raw(function (w) {
            w.u32(0); w.u32(0); w.u32(tr.timescale); w.u32(0);
            w.u32(0x00010000); w.u16(0x0100); w.zeros(10);
            MATRIX.forEach(function (m) { w.u32(m); });
            w.zeros(24); w.u32(id + 1);
        }, 96));
        var tkhd = full("tkhd", 0, 3, raw(function (w) {
            w.u32(0); w.u32(0); w.u32(id); w.u32(0); w.u32(0); w.zeros(8);
            w.u16(0); w.u16(0); w.u16(video ? 0 : 0x0100); w.u16(0);
            MATRIX.forEach(function (m) { w.u32(m); });
            w.u32((tr.width || 0) * 65536); w.u32((tr.height || 0) * 65536);
        }, 80));
        var mdhd = full("mdhd", 0, 0, raw(function (w) { w.u32(0); w.u32(0); w.u32(tr.timescale); w.u32(0); w.u16(0x55c4); w.u16(0); }, 20));
        var hdlr = full("hdlr", 0, 0, raw(function (w) {
            w.u32(0); w.str(video ? "vide" : "soun"); w.zeros(12); w.str(video ? "Video" : "Audio"); w.u8(0);
        }, 26));
        var xmhd = video ? full("vmhd", 0, 1, new Uint8Array(8)) : full("smhd", 0, 0, new Uint8Array(4));
        var dinf = box("dinf", full("dref", 0, 0, concat([raw(function (w) { w.u32(1); }, 4), full("url ", 0, 1, new Uint8Array(0))])));
        var stbl = box("stbl", tr.stsd,
            full("stts", 0, 0, new Uint8Array(4)), full("stsc", 0, 0, new Uint8Array(4)),
            full("stsz", 0, 0, new Uint8Array(8)), full("stco", 0, 0, new Uint8Array(4)));
        var trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", xmhd, dinf, stbl)));
        var mvex = box("mvex", full("trex", 0, 0, raw(function (w) { w.u32(id); w.u32(1); w.u32(0); w.u32(0); w.u32(0); }, 20)));
        return concat([ftyp, box("moov", mvhd, trak, mvex)]);
    }

    function concat(list) {
        var len = 0;
        list.forEach(function (a) { len += a.length; });
        var out = new Uint8Array(len), o = 0;
        list.forEach(function (a) { out.set(a, o); o += a.length; });
        return out;
    }

    /* 一串样本（解码顺序的下标，递增，可以跳着取）→ moof+mdat。tfdt v1（64 位解码时间）、trun v1（有符号合成偏移：
     * 视频的 edit list 偏移从这里减掉，首帧显示时间落在 0，和音频对齐）。
     * 每个样本的时长 = 到下一个「要放的」样本的解码时间差：跳过的样本（跳转后的前导帧）由前一个样本把时长撑过去 ——
     * 解码时间断开超过两帧，MSE 当成不连续，之后的帧全丢到下一个关键帧为止。 */
    function fragment(tr, list, seq, copyBytes, id) {
        var n = list.length, data = 0, i, j;
        for (j = 0; j < n; j++) { data += tr.size[list[j]]; }
        var moofSize = 8 + 16 + 8 + 16 + 20 + 20 + 16 * n;
        var w = new W(moofSize + 8 + data);
        w.u32(moofSize); w.str("moof");
        w.u32(16); w.str("mfhd"); w.u32(0); w.u32(seq);
        w.u32(moofSize - 24); w.str("traf");
        w.u32(16); w.str("tfhd"); w.u32(0x020000); w.u32(id || tr.id);
        w.u32(20); w.str("tfdt"); w.u32(0x01000000); w.u64(tr.dts[list[0]]);
        w.u32(20 + 16 * n); w.str("trun"); w.u32(0x01000F01); w.u32(n); w.u32(moofSize + 8);
        var keys = tr.keys, ki = keys ? keyIndex(tr, list[0]) : 0;
        for (j = 0; j < n; j++) {
            i = list[j];
            var nx = j + 1 < n ? list[j + 1] : i + 1;
            var dur = nx < tr.n ? tr.dts[nx] - tr.dts[i] : tr.lastDelta;
            var sync = !keys;
            if (keys) {
                while (ki < keys.length && keys[ki] < i) { ki++; }
                sync = ki < keys.length && keys[ki] === i;
            }
            w.u32(dur);
            w.u32(tr.size[i]);
            w.u32(sync ? 0x02000000 : 0x01010000);
            w.u32((tr.cto ? tr.cto[i] : 0) - tr.shift);
        }
        w.u32(8 + data); w.str("mdat");
        for (j = 0; j < n; j++) { i = list[j]; copyBytes(w.b, w.o, tr.offset[i], tr.size[i]); w.o += tr.size[i]; }
        return w.b;
    }

    /* 直接给帧拼 moof+mdat（MKV 那条路：没有样本表，帧是拆块拆出来的）。frames 按解码顺序，每个
     * {dts, cto, dur, key, data}：dts / dur 是这条轨的时间刻度（init 段里的 timescale），cto 可以是负的（trun v1）。 */
    function fragmentFrames(id, frames, seq) {
        var n = frames.length, data = 0, j;
        for (j = 0; j < n; j++) { data += frames[j].data.length; }
        var moofSize = 8 + 16 + 8 + 16 + 20 + 20 + 16 * n;
        var w = new W(moofSize + 8 + data);
        w.u32(moofSize); w.str("moof");
        w.u32(16); w.str("mfhd"); w.u32(0); w.u32(seq);
        w.u32(moofSize - 24); w.str("traf");
        w.u32(16); w.str("tfhd"); w.u32(0x020000); w.u32(id);
        w.u32(20); w.str("tfdt"); w.u32(0x01000000); w.u64(frames[0].dts);
        w.u32(20 + 16 * n); w.str("trun"); w.u32(0x01000F01); w.u32(n); w.u32(moofSize + 8);
        for (j = 0; j < n; j++) {
            var f = frames[j];
            w.u32(f.dur);
            w.u32(f.data.length);
            w.u32(f.key ? 0x02000000 : 0x01010000);
            w.u32(f.cto || 0);
        }
        w.u32(8 + data); w.str("mdat");
        for (j = 0; j < n; j++) { w.bytes(frames[j].data); }
        return w.b;
    }

    /* 关键帧 k 后面、解码顺序在它之后、显示却在它之前的帧（open GOP 的前导帧，HEVC 的 RASL）：它们参考上一个 GOP，
     * 跳转过来时那个 GOP 不在解码器里，解出来是错的，Chrome 的硬件解码直接报 PIPELINE_ERROR_DECODE（桌面实测 x265 默认
     * open-gop）。返回第一个不是前导帧的样本下标；closed GOP 就是 k + 1。 */
    function afterLeading(tr, k) {
        if (!tr.cto) { return k + 1; }
        var kp = tr.dts[k] + tr.cto[k], f = k + 1;
        while (f < tr.n && f - k < 64 && tr.dts[f] + tr.cto[f] < kp) { f++; }
        return f;
    }

    return {
        scanTop: scanTop, parseMoov: parseMoov, initSegment: initSegment, fragment: fragment, fragmentFrames: fragmentFrames, afterLeading: afterLeading,
        sampleAt: sampleAt, keyAtOrBefore: keyAtOrBefore, keyNear: keyNear, pts: pts,
        /* 给 mkv.js 拼 stsd 用的：写盒子的小工具、codecs 字符串 */
        W: W, box: box, full: full, raw: raw, concat: concat, hex2: hex2, avcString: avcString, hevcString: hevcString, fixAvcLevel: fixAvcLevel
    };
})();
