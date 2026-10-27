/* MKV / WebM → MSE 用的分段 MP4。和 mp4.js 一个思路：自己解析，不用库。
 *
 * 和 MP4 最大的不同：MKV 没有样本表。头部（EBML 头 + Segment 里的 Info / Tracks / Cues）只告诉我们有哪些轨、关键帧大概在
 * 哪个 Cluster；每一帧在哪、多大，要顺着 Cluster 一块块拆出来。所以分两半：
 *   readHead —— 读头部和 Cues（Cues 多半在文件尾，ffmpeg、mkvmerge 默认都是），结果能缓存；
 *   demuxer  —— 从某个 Cluster 开始顺序拆块，吐出按解码顺序、带解码时间的帧，直接交给 Mp4.fragmentFrames。
 * 另一个不同：MKV 只记显示时间（pts）。fMP4 要解码时间（dts），见 demuxer 里的「排序窗口」。
 *
 *   Mkv.sniff(u8)                               前 4 字节是不是 EBML 魔数
 *   Mkv.readHead(read, fileSize) → info         read(off, len) → Promise<Uint8Array>；info 能结构化克隆（存 IndexedDB）
 *   Mkv.cueAt(info, sec) / Mkv.cueNear(info, sec, dir, fromSec) / Mkv.guessOffset(info, sec, fileSize)
 *   var d = Mkv.demuxer(info, {video, audio, subs})
 *   d.reset(offset, startSec, resync)  d.feed(win) → {video, audio, subs, audioStsd}  d.flush()  d.pos  d.done  d.openGop
 *   Mkv.keyframeAt(read, info, sec) → {pts, data, track}   封面截帧
 */
var Mkv = (function () {
    "use strict";
    /* 显示给用户的话（i18n.js）；node 里的离线测试没有 I18n，原样用中文 */
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    var CH = 512 * 1024;
    var EBML = 0x1A45DFA3, SEGMENT = 0x18538067, SEEKHEAD = 0x114D9B74, INFO = 0x1549A966, TRACKS = 0x1654AE6B,
        CUES = 0x1C53BB6B, CLUSTER = 0x1F43B675, CHAPTERS = 0x1043A770, TAGS = 0x1254C367, ATTACH = 0x1941A469;
    var TIMESTAMP = 0xE7, SIMPLEBLOCK = 0xA3, BLOCKGROUP = 0xA0, BLOCK = 0xA1, BLOCKDUR = 0x9B, REFBLOCK = 0xFB;
    /* 大小未知的 Cluster（直播录下来的）靠「碰到下一个顶层元素」才知道结束 */
    var TOP = {};
    [EBML, SEGMENT, SEEKHEAD, INFO, TRACKS, CUES, CLUSTER, CHAPTERS, TAGS, ATTACH].forEach(function (id) { TOP[id] = true; });
    /* 算解码时间的排序窗口：压几帧再定。x264 默认（3 个 B 帧、金字塔）重排深度 2，x265 默认 3–4；从 4 起，真碰到更深的
     * （来了一帧显示时间比已经定下的解码时间还早）就加 2，最多 16。一开始是固定 16：高码率片子跳转后第一段要多等十几帧
     * （4K 一帧几百 KB），桌面测试里跳转 1.4 秒，改了之后见 CLAUDE.md。 */
    var R0 = 4, RMAX = 16;

    /* ---------- EBML 读 ---------- */

    /* 变长整数的字节数：第一个字节里最高的 1 在第几位 */
    function vlen(x) { for (var n = 1; n <= 8; n++) { if (x & (0x100 >> n)) { return n; } } return 0; }

    /* 元素头：ID（带长度标记位，1–4 字节）+ 大小（去掉标记位，1–8 字节；值位全 1 = 大小未知）。
     * 字节不够返回 null；不像元素头（第一个字节是 0、ID 超过 4 字节）返回 {bad: true}。 */
    function header(b, o, end) {
        if (o >= end) { return null; }
        var il = vlen(b[o]);
        if (!il || il > 4) { return { bad: true }; }
        if (o + il >= end) { return null; }
        var id = 0, i;
        for (i = 0; i < il; i++) { id = id * 256 + b[o + i]; }
        var p = o + il, sl = vlen(b[p]);
        if (!sl) { return { bad: true }; }
        if (p + sl > end) { return null; }
        var mask = 0xFF >> sl, v = b[p] & mask, ones = v === mask;
        for (i = 1; i < sl; i++) { v = v * 256 + b[p + i]; ones = ones && b[p + i] === 0xFF; }
        return { id: id, size: ones ? Infinity : v, hdr: il + sl, unknown: ones };
    }
    function uint(b, s, e) { var v = 0; for (var i = s; i < e; i++) { v = v * 256 + b[i]; } return v; }
    function float(b, s, e) {
        var dv = new DataView(b.buffer, b.byteOffset + s, e - s);
        return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : 0;
    }
    function str(b, s, e) {
        var t;
        try { t = new TextDecoder("utf-8").decode(b.subarray(s, e)); } catch (x) { t = ""; }
        return t.replace(/\0[\s\S]*$/, "");
    }
    /* [s, e) 里的子元素：fn(id, 正文起点, 正文终点) */
    function each(b, s, e, fn) {
        var o = s;
        while (o < e) {
            var h = header(b, o, e);
            if (!h || h.bad) { return; }
            var ds = o + h.hdr, de = h.unknown ? e : Math.min(e, ds + h.size);
            fn(h.id, ds, de);
            o = de;
        }
    }

    /* 按位读 / 写（AC-3、E-AC-3、VP9 的帧头；dac3 / dec3） */
    function Bits(b, bit) { this.b = b; this.p = bit || 0; }
    Bits.prototype.u = function (n) {
        var v = 0;
        for (var i = 0; i < n; i++) {
            var byte = this.b[this.p >> 3];
            v = v * 2 + (byte === undefined ? 0 : (byte >> (7 - (this.p & 7))) & 1);
            this.p++;
        }
        return v;
    };
    function BitW(n) { this.b = new Uint8Array(n); this.p = 0; }
    BitW.prototype.u = function (n, v) {
        for (var i = n - 1; i >= 0; i--) {
            if (Math.floor(v / Math.pow(2, i)) & 1) { this.b[this.p >> 3] |= 0x80 >> (this.p & 7); }
            this.p++;
        }
    };

    /* ---------- 读头部用的稀疏缓存：每次缺数据就读一整段 512KB 对齐的区间（Telegram 一块就是 512KB） ---------- */

    function Cache(read, size) { this.read = read; this.size = size; this.parts = []; this.calls = 0; }
    Cache.prototype.get = async function (off, len) {
        len = Math.max(0, Math.min(len, this.size - off));
        for (var i = 0; i < this.parts.length; i++) {
            var p = this.parts[i];
            if (off >= p.s && off + len <= p.s + p.b.length) { return p.b.subarray(off - p.s, off - p.s + len); }
        }
        var s = Math.floor(off / CH) * CH, e = Math.min(this.size, Math.ceil((off + len) / CH) * CH);
        var b = await this.read(s, e - s);
        this.calls++;
        this.parts.push({ s: s, b: b });
        return b.subarray(Math.min(b.length, off - s), Math.min(b.length, off - s + len));
    };
    /* 某个绝对位置上的一个元素：{id, ds（正文起点）, size, body} */
    Cache.prototype.element = async function (pos, withBody) {
        var hb = await this.get(pos, 12), h = header(hb, 0, hb.length);
        if (!h || h.bad) { return null; }
        var el = { id: h.id, pos: pos, ds: pos + h.hdr, size: h.size, unknown: h.unknown };
        if (withBody && !h.unknown) { el.body = await this.get(el.ds, h.size); }
        return el;
    };

    /* ---------- 头部 ---------- */

    function sniff(b) { return !!b && b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3; }

    async function readHead(read, fileSize) {
        var c = new Cache(read, fileSize);
        var b = await c.get(0, Math.min(fileSize, CH));
        var h = header(b, 0, b.length);
        if (!h || h.id !== EBML) { throw new Error(tx("不是 MKV（没有 EBML 头）")); }
        var docType = "matroska";
        each(b, h.hdr, h.hdr + h.size, function (id, s, e) { if (id === 0x4282) { docType = str(b, s, e); } });
        var o = h.hdr + h.size, sh = header(b, o, b.length);
        if (!sh || sh.id !== SEGMENT) { throw new Error(tx("MKV 里没有 Segment")); }
        var info = {
            docType: docType, segStart: o + sh.hdr, segEnd: 0, firstCluster: -1, timescale: 1000, tsNs: 1000000, duration: 0,
            tracks: [], cues: null
        };
        info.segEnd = sh.unknown ? fileSize : Math.min(fileSize, info.segStart + sh.size);
        var seeks = {}, done = {}, rawDur = -1, rawTracks = null, rawCues = null;

        function onElement(el) {
            if (el.id === SEEKHEAD) {
                each(el.body, 0, el.body.length, function (id, s, e) {
                    if (id !== 0x4DBB) { return; }
                    var sid = 0, spos = -1;
                    each(el.body, s, e, function (cid, cs, ce) {
                        if (cid === 0x53AB) { sid = uint(el.body, cs, ce); } else if (cid === 0x53AC) { spos = uint(el.body, cs, ce); }
                    });
                    if (sid && spos >= 0 && seeks[sid] === undefined) { seeks[sid] = info.segStart + spos; }
                });
                done[SEEKHEAD + ":" + el.pos] = true;
            } else if (el.id === INFO) {
                each(el.body, 0, el.body.length, function (id, s, e) {
                    if (id === 0x2AD7B1) { info.tsNs = uint(el.body, s, e) || 1000000; } else if (id === 0x4489) { rawDur = float(el.body, s, e); }
                });
                done[INFO] = true;
            } else if (el.id === TRACKS) { rawTracks = el.body; done[TRACKS] = true; }
            else if (el.id === CUES) { rawCues = el.body; done[CUES] = true; }
        }

        /* 顺着 Segment 的顶层元素往下走到第一个 Cluster：要的（SeekHead、Info、Tracks、Cues）读正文，别的（Attachments 里的字体
         * 可能几十 MB、Tags、Void）只读头、按大小跳过 */
        var pos = info.segStart, guard = 0;
        while (pos < info.segEnd && guard++ < 1000) {
            var el = await c.element(pos, false);
            if (!el) { break; }
            if (el.id === CLUSTER) { info.firstCluster = pos; break; }
            if (el.unknown) { break; }
            if (el.id === SEEKHEAD || el.id === INFO || el.id === TRACKS || el.id === CUES) {
                el.body = await c.get(el.ds, el.size);
                onElement(el);
            }
            pos = el.ds + el.size;
        }
        /* 头部没走到的（Cues 在文件尾；mkvmerge 有时把第二个 SeekHead 也放到尾部）：按 SeekHead 给的位置去读 */
        for (var round = 0; round < 3; round++) {
            var more = false;
            for (var k in seeks) {
                var id = +k, at = seeks[k];
                if (id === SEEKHEAD ? done[SEEKHEAD + ":" + at] : !(id === INFO || id === TRACKS || id === CUES) || done[id]) { continue; }
                if (at >= fileSize) { continue; }
                var e2 = await c.element(at, true);
                if (e2 && e2.id === id && e2.body) { onElement(e2); more = true; } else { done[id === SEEKHEAD ? SEEKHEAD + ":" + at : id] = true; }
            }
            if (!more) { break; }
        }
        if (info.firstCluster < 0 && seeks[CLUSTER] !== undefined) { info.firstCluster = seeks[CLUSTER]; }
        if (!rawTracks) { throw new Error(tx("MKV 里没有 Tracks")); }
        if (info.firstCluster < 0) { throw new Error(tx("MKV 里找不到 Cluster")); }

        info.timescale = Math.round(1e9 / info.tsNs);
        info.duration = rawDur > 0 ? rawDur * info.tsNs / 1e9 : 0;
        info.tracks = parseTracks(rawTracks, info);
        if (rawCues) { info.cues = parseCues(rawCues, info); }
        if (!info.duration && info.cues && info.cues.t.length) { info.duration = info.cues.t[info.cues.t.length - 1]; }
        scanFirstFrames(c, info);
        info.reads = c.calls;
        return info;
    }

    function parseTracks(b, info) {
        var out = [];
        each(b, 0, b.length, function (id, s, e) {
            if (id !== 0xAE) { return; }
            var t = {
                num: 0, kind: "", type: 0, codecId: "", codec: "", mime: "", unsupported: "", lang: "", name: "", isDefault: true, isForced: false,
                enabled: true, width: 0, height: 0, channels: 0, rate: 0, bitDepth: 0, config: null, stsd: null, needFirstFrame: false,
                codecPrivate: null, comp: null, defaultDur: 0, codecDelay: 0, timescale: info.timescale
            };
            var language = "", bcp47 = "", outRate = 0, enc = false;
            each(b, s, e, function (cid, cs, ce) {
                switch (cid) {
                    case 0xD7: t.num = uint(b, cs, ce); break;
                    case 0x83: t.type = uint(b, cs, ce); break;
                    case 0xB9: t.enabled = !!uint(b, cs, ce); break;
                    case 0x88: t.isDefault = !!uint(b, cs, ce); break;
                    case 0x55AA: t.isForced = !!uint(b, cs, ce); break;
                    case 0x23E383: t.defaultDur = uint(b, cs, ce) / 1e9; break;
                    case 0x56AA: t.codecDelay = uint(b, cs, ce) / 1e9; break;
                    case 0x536E: t.name = str(b, cs, ce); break;
                    case 0x22B59C: language = str(b, cs, ce); break;
                    case 0x22B59D: bcp47 = str(b, cs, ce); break;
                    case 0x86: t.codecId = str(b, cs, ce); break;
                    case 0x63A2: t.codecPrivate = b.slice(cs, ce); break;
                    case 0xE0:
                        each(b, cs, ce, function (vid, vs, ve) {
                            if (vid === 0xB0) { t.width = uint(b, vs, ve); } else if (vid === 0xBA) { t.height = uint(b, vs, ve); }
                        });
                        break;
                    case 0xE1:
                        each(b, cs, ce, function (aid, as, ae) {
                            if (aid === 0xB5) { t.rate = float(b, as, ae); } else if (aid === 0x78B5) { outRate = float(b, as, ae); }
                            else if (aid === 0x9F) { t.channels = uint(b, as, ae); } else if (aid === 0x6264) { t.bitDepth = uint(b, as, ae); }
                        });
                        break;
                    case 0x6D80:
                        /* ContentEncodings：Type 0 = 压缩（ContentCompAlgo 默认 0 = zlib，3 = header stripping），1 = 加密 */
                        each(b, cs, ce, function (eid, es, ee) {
                            if (eid !== 0x6240) { return; }
                            var type = 0, algo = 0, settings = null, has = false;
                            each(b, es, ee, function (x, xs, xe) {
                                if (x === 0x5033) { type = uint(b, xs, xe); }
                                else if (x === 0x5034) {
                                    has = true;
                                    each(b, xs, xe, function (y, ys, ye) {
                                        if (y === 0x4254) { algo = uint(b, ys, ye); } else if (y === 0x4255) { settings = b.slice(ys, ye); }
                                    });
                                } else if (x === 0x5035) { type = 1; }
                            });
                            /* 空的 ContentEncoding（mkvmerge v102 的 analyze_header_removal 没找到公共头时就这么写）= 没压缩 */
                            if (type === 1) { enc = true; } else if (has) { t.comp = { algo: algo, settings: settings || new Uint8Array(0) }; }
                        });
                        break;
                }
            });
            t.lang = bcp47 || language || "eng";       // 规范：没写 Language 就是 eng
            t.kind = t.type === 1 ? "video" : t.type === 2 ? "audio" : t.type === 17 ? "sub" : "";
            t.rate = t.kind === "audio" ? Math.round(t.rate || 8000) : 0;      // 规范的默认：8000Hz、1 声道（mkvmerge 单声道就不写）
            if (t.kind === "audio" && !t.channels) { t.channels = 1; }
            t.outRate = Math.round(outRate || 0);
            if (!t.kind) { return; }
            describe(t);
            if (enc) { t.unsupported = tx("加密的轨道放不了"); }
            else if (t.comp && t.comp.algo !== 3 && t.kind !== "sub") { t.unsupported = t.kind === "video" ? tx("压缩过的视频轨放不了") : tx("压缩过的音频轨放不了"); }
            out.push(t);
        });
        return out;
    }

    function parseCues(b, info) {
        var vnum = 0, list = [];
        info.tracks.forEach(function (t) { if (t.kind === "video" && !vnum) { vnum = t.num; } });
        each(b, 0, b.length, function (id, s, e) {
            if (id !== 0xBB) { return; }
            var time = -1, best = null;
            each(b, s, e, function (cid, cs, ce) {
                if (cid === 0xB3) { time = uint(b, cs, ce); }
                else if (cid === 0xB7) {
                    var p = { track: 0, pos: -1, rel: -1 };
                    each(b, cs, ce, function (x, xs, xe) {
                        if (x === 0xF7) { p.track = uint(b, xs, xe); } else if (x === 0xF1) { p.pos = uint(b, xs, xe); }
                        else if (x === 0xF0) { p.rel = uint(b, xs, xe); }
                    });
                    if (p.pos >= 0 && (!best || (p.track === vnum && best.track !== vnum))) { best = p; }
                }
            });
            if (time >= 0 && best) { list.push({ t: time, track: best.track, pos: best.pos, rel: best.rel }); }
        });
        /* 只用视频轨的 cue（mkvmerge 也给字幕轨写 cue）；一个视频 cue 都没有的（纯音频）就全用 */
        var v = list.filter(function (x) { return x.track === vnum; });
        if (v.length) { list = v; }
        list.sort(function (x, y) { return x.t - y.t || x.pos - y.pos; });
        var t = [], pos = [], rel = [];
        list.forEach(function (x) {
            if (t.length && t[t.length - 1] === x.t * info.tsNs / 1e9) { return; }
            t.push(x.t * info.tsNs / 1e9); pos.push(info.segStart + x.pos); rel.push(x.rel);
        });
        if (!t.length) { return null; }
        return { t: new Float64Array(t), pos: new Float64Array(pos), rel: new Float64Array(rel) };
    }

    /* ---------- 编码 → MP4 sample entry ---------- */

    function stsdOf(entry) { return Mp4.full("stsd", 0, 0, Mp4.concat([Mp4.raw(function (w) { w.u32(1); }, 4), entry])); }
    function visual(type, t, cfg) {
        var body = Mp4.raw(function (w) {
            w.zeros(6); w.u16(1); w.zeros(16); w.u16(t.width); w.u16(t.height);
            w.u32(0x00480000); w.u32(0x00480000); w.u32(0); w.u16(1); w.zeros(32); w.u16(0x18); w.u16(0xFFFF);
        }, 78);
        return stsdOf(Mp4.box(type, body, cfg));
    }
    function audio(type, t, cfg, sampleSize) {
        var body = Mp4.raw(function (w) {
            w.zeros(6); w.u16(1); w.zeros(8); w.u16(t.channels || 2); w.u16(sampleSize || 16); w.u16(0); w.u16(0);
            w.u32(t.rate <= 65535 ? t.rate * 65536 : 0);
        }, 28);
        return stsdOf(Mp4.box(type, body, cfg));
    }
    /* esds 里的描述符：tag + 长度（小于 128 一个字节，否则 4 字节变长） */
    function descr(tag, body) {
        var n = body.length, head = n < 128 ? [tag, n] : [tag, 0x80 | (n >> 21) & 127, 0x80 | (n >> 14) & 127, 0x80 | (n >> 7) & 127, n & 127];
        return Mp4.concat([new Uint8Array(head), body]);
    }
    function esds(oti, dsi) {
        var dcd = Mp4.concat([new Uint8Array([oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), dsi ? descr(5, dsi) : new Uint8Array(0)]);
        return Mp4.full("esds", 0, 0, descr(3, Mp4.concat([new Uint8Array([0, 0, 0]), descr(4, dcd), descr(6, new Uint8Array([2]))])));
    }

    var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    function rateIndex(r) { var i = AAC_RATES.indexOf(r); return i >= 0 ? i : 3; }
    function pad2(n) { return (n < 10 ? "0" : "") + n; }

    function describe(t) {
        var id = t.codecId, cp = t.codecPrivate;
        if (t.kind === "video") {
            if (id === "V_MPEG4/ISO/AVC" && cp && cp.length > 6) {
                t.profileFix = Mp4.fixAvcProfile(cp);                       // profile 写成 0 这种的照 SPS 改（见 mp4.js）
                t.levelFix = Mp4.fixAvcLevel(cp, t.width, t.height);       // 级别写小了改够（见 mp4.js），原地改 CodecPrivate
                t.config = cp; t.codec = Mp4.avcString("avc1", cp);
                t.stsd = visual("avc1", t, Mp4.box("avcC", cp));
            } else if (id === "V_MPEGH/ISO/HEVC" && cp && cp.length > 22) {
                /* hvcC 里带了参数集就是 hvc1，没带（参数集在码流里）就得写 hev1 */
                var ty = cp[22] ? "hvc1" : "hev1";
                t.config = cp; t.codec = Mp4.hevcString(ty, cp);
                t.stsd = visual(ty, t, Mp4.box("hvcC", cp));
            } else if (id === "V_AV1") {
                var c1 = cp && cp.length >= 4 ? cp : new Uint8Array([0x81, 0x08, 0x0C, 0]);
                var bd = (c1[2] >> 5) & 1 ? 12 : (c1[2] >> 6) & 1 ? 10 : 8;
                t.config = c1;
                t.codec = "av01." + (c1[1] >> 5) + "." + pad2(c1[1] & 31) + (c1[2] >> 7 ? "H" : "M") + "." + pad2(bd);
                t.stsd = visual("av01", t, Mp4.box("av1C", c1));
            } else if (id === "V_VP9") {
                var vp = { profile: 0, level: 0, bitDepth: 8, chroma: 1, range: 0 };
                /* VP9 的 CodecPrivate（可选）：一串 ID(1) 长度(1) 值，1 = profile、2 = level、3 = 位深、4 = 色度抽样 */
                for (var i = 0; cp && i + 2 < cp.length; i += 2 + cp[i + 1]) {
                    var v = cp[i + 2];
                    if (cp[i] === 1) { vp.profile = v; } else if (cp[i] === 2) { vp.level = v; } else if (cp[i] === 3) { vp.bitDepth = v; }
                    else if (cp[i] === 4) { vp.chroma = v; }
                }
                t.vp9 = vp;
                vp9Entry(t);
                if (!cp) { t.needFirstFrame = true; }      // 有第一帧就拿帧头里的 profile / 位深改写（scanFirstFrames / demuxer）
            } else {
                t.unsupported = tx("视频格式 {0} 放不了", id.replace(/^V_/, "") || tx("未知"));
            }
            t.mime = t.codec ? "video/mp4; codecs=\"" + t.codec + "\"" : "";
        } else if (t.kind === "audio") {
            if (id === "A_AAC" && cp && cp.length >= 2) { aacEntry(t, cp); }
            else if (/^A_AAC\//.test(id)) {
                /* 老的 CodecID 不带 CodecPrivate，按名字拼 AudioSpecificConfig；SBR（HE-AAC）用显式信令：aot 5 + 输出采样率 */
                var aot = /MAIN/.test(id) ? 1 : /SSR/.test(id) ? 3 : /LTP/.test(id) ? 4 : 2, w = new BitW(5);
                if (/SBR/.test(id)) {
                    w.u(5, 5); w.u(4, rateIndex(t.rate)); w.u(4, t.channels || 2); w.u(4, rateIndex(t.outRate || t.rate * 2)); w.u(5, 2); w.u(3, 0);
                    aacEntry(t, w.b.slice(0, 4));
                } else {
                    w.u(5, aot); w.u(4, rateIndex(t.rate)); w.u(4, t.channels || 2); w.u(3, 0);
                    aacEntry(t, w.b.slice(0, 2));
                }
            }
            else if (id === "A_AC3" || id === "A_EAC3") { t.codec = id === "A_AC3" ? "ac-3" : "ec-3"; t.needFirstFrame = true; }
            else if (id === "A_OPUS" && cp && cp.length >= 19) { opusEntry(t, cp); }
            else if (id === "A_FLAC" && cp && cp.length >= 42) { flacEntry(t, cp); }
            else if (id === "A_MPEG/L3") { t.codec = "mp4a.6B"; t.stsd = audio("mp4a", t, esds(0x6B, null)); }
            else if (id === "A_MS/ACM" && cp && cp.length >= 18) {
                /* 从 AVI 转来的：WAVEFORMATEX，0x55 = MP3，0x2000 = AC-3 */
                var tag = cp[0] | (cp[1] << 8);
                if (tag === 0x55) { t.codec = "mp4a.6B"; t.stsd = audio("mp4a", t, esds(0x6B, null)); }
                else if (tag === 0x2000) { t.codec = "ac-3"; t.needFirstFrame = true; t.codecId = "A_AC3"; }
                else { t.unsupported = tx("音频格式 {0} 放不了", "ACM 0x" + tag.toString(16)); }
            }
            else if (/^A_DTS/.test(id)) { t.unsupported = tx("DTS 音轨电视放不了"); }
            else if (id === "A_ALAC") { t.unsupported = tx("Apple 无损（ALAC）音频电视解不了"); }
            else if (id === "A_TRUEHD" || id === "A_MLP") { t.unsupported = tx("TrueHD 音轨电视放不了"); }
            else if (id === "A_VORBIS") { t.unsupported = tx("Vorbis 音轨放不了"); }
            else if (/^A_PCM/.test(id)) { t.unsupported = tx("PCM 音轨放不了"); }
            else { t.unsupported = tx("音频格式 {0} 放不了", id.replace(/^A_/, "") || tx("未知")); }
            t.mime = t.codec ? "audio/mp4; codecs=\"" + t.codec + "\"" : "";
        } else {
            if (!/^S_TEXT\/(UTF8|ASS|SSA|WEBVTT)$/.test(id) && id !== "S_HDMV/PGS") {
                t.unsupported = id === "S_VOBSUB" ? tx("DVD 图形字幕（VobSub）放不了") : tx("字幕格式 {0} 放不了", id.replace(/^S_/, ""));
            }
        }
    }

    function aacEntry(t, asc) {
        var aot = asc[0] >> 3;
        if (aot === 31) { aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5)); }
        t.codec = "mp4a.40." + aot;
        t.codecPrivate = asc;
        t.stsd = audio("mp4a", t, esds(0x40, asc));
    }
    /* OpusHead（小端，RFC 7845）→ dOps（大端，Opus in ISOBMFF） */
    function opusEntry(t, h) {
        var ch = h[9], pre = h[10] | (h[11] << 8), rate = (h[12] | (h[13] << 8) | (h[14] << 16)) + h[15] * 16777216, gain = h[16] | (h[17] << 8), fam = h[18];
        var tail = fam && h.length >= 21 + ch ? h.slice(19, 21 + ch) : new Uint8Array(0);
        var dops = Mp4.box("dOps", Mp4.raw(function (w) { w.u8(0); w.u8(ch); w.u16(pre); w.u32(rate); w.u16(gain); w.u8(fam); w.bytes(tail); }, 11 + tail.length));
        t.channels = ch;
        t.codec = "opus";
        t.stsd = audio("Opus", Object.assign({}, t, { rate: 48000 }), dops);
    }
    /* CodecPrivate = 「fLaC」+ 元数据块；dfLa 只放 STREAMINFO（标成最后一块，PICTURE 之类不要） */
    function flacEntry(t, cp) {
        if (cp[0] !== 0x66 || cp[1] !== 0x4C || cp[2] !== 0x61 || cp[3] !== 0x43 || (cp[4] & 127) !== 0) { t.unsupported = tx("FLAC 头不对"); return; }
        var si = cp.slice(8, 42), br = new Bits(si, 80);
        t.rate = br.u(20); t.channels = br.u(3) + 1; t.bitDepth = br.u(5) + 1;
        var dfla = Mp4.full("dfLa", 0, 0, Mp4.concat([new Uint8Array([0x80, 0, 0, 34]), si]));
        t.codec = "flac";
        t.stsd = audio("fLaC", t, dfla, t.bitDepth);
    }

    function vp9Entry(t) {
        var vp = t.vp9, lv = vp.level;
        if (!lv) { var px = t.width * t.height; lv = px <= 1280 * 720 ? 31 : px <= 1920 * 1088 ? 40 : px <= 4096 * 2176 ? 51 : 61; }
        var vpcc = Mp4.full("vpcC", 1, 0, Mp4.raw(function (w) {
            w.u8(vp.profile); w.u8(lv); w.u8((vp.bitDepth << 4) | (vp.chroma << 1) | (vp.range & 1)); w.u8(2); w.u8(2); w.u8(2); w.u16(0);
        }, 8));
        t.codec = "vp09." + pad2(vp.profile) + "." + pad2(lv) + "." + pad2(vp.bitDepth);
        t.stsd = visual("vp09", t, vpcc);
        t.config = null;
    }
    /* VP9 关键帧的未压缩帧头（VP9 Bitstream §6.2）：profile、位深、色度抽样 */
    function vp9Header(f) {
        var br = new Bits(f, 0);
        if (br.u(2) !== 2) { return null; }
        var lo = br.u(1), hi = br.u(1), profile = hi * 2 + lo;
        if (profile === 3) { br.u(1); }
        if (br.u(1)) { return null; }                   // show_existing_frame
        if (br.u(1) !== 0) { return null; }             // 不是关键帧
        br.u(2);                                        // show_frame, error_resilient_mode
        if (br.u(24) !== 0x498342) { return null; }
        var bd = 8, chroma = 1, range = 0;
        if (profile >= 2) { bd = br.u(1) ? 12 : 10; }
        var cs = br.u(3);
        if (cs !== 7) {
            range = br.u(1);
            if (profile === 1 || profile === 3) { var sx = br.u(1), sy = br.u(1); chroma = sx && sy ? 1 : sx ? 2 : 3; }
        } else { range = 1; chroma = 3; }
        return { profile: profile, bitDepth: bd, chroma: chroma, range: range };
    }

    /* AC-3 同步帧头（A/52 §5.3）→ dac3 */
    var AC3_CH = [2, 1, 2, 3, 3, 4, 4, 5];
    function ac3Stsd(t, f) {
        if (f.length < 8 || f[0] !== 0x0B || f[1] !== 0x77) { return null; }
        var fscod = f[4] >> 6, frmsizecod = f[4] & 63, bsid = f[5] >> 3, bsmod = f[5] & 7;
        if (bsid > 10) { return eac3Stsd(t, f); }
        var br = new Bits(f, 48), acmod = br.u(3);
        if ((acmod & 1) && acmod !== 1) { br.u(2); }
        if (acmod & 4) { br.u(2); }
        if (acmod === 2) { br.u(2); }
        var lfe = br.u(1), w = new BitW(3);
        w.u(2, fscod); w.u(5, bsid); w.u(3, bsmod); w.u(3, acmod); w.u(1, lfe); w.u(5, frmsizecod >> 1); w.u(5, 0);
        var tt = Object.assign({}, t, { channels: AC3_CH[acmod] + lfe, rate: [48000, 44100, 32000][fscod] || t.rate });
        return audio("ac-3", tt, Mp4.box("dac3", w.b));
    }
    /* E-AC-3（A/52 附录 E）：一块里可能有好几个同步帧（独立子流 + 7.1 的依赖子流）→ dec3 */
    function eac3Stsd(t, f) {
        var subs = [], o = 0, bits = 0, fs0 = 48000;
        while (o + 6 <= f.length && f[o] === 0x0B && f[o + 1] === 0x77) {
            var br = new Bits(f, (o + 2) * 8);
            var strmtyp = br.u(2); br.u(3);
            var frmsiz = br.u(11), fscod = br.u(2), nb, fs;
            if (fscod === 3) { fs = [24000, 22050, 16000][br.u(2)]; nb = 6; } else { fs = [48000, 44100, 32000][fscod]; nb = [1, 2, 3, 6][br.u(2)]; }
            var acmod = br.u(3), lfe = br.u(1), bsid = br.u(5), size = (frmsiz + 1) * 2;
            if (!subs.length) { fs0 = fs; }
            bits += size * 8 * fs / (nb * 256);
            if (strmtyp !== 1) { subs.push({ fscod: fscod === 3 ? 0 : fscod, bsid: bsid, acmod: acmod, lfe: lfe, dep: 0, loc: 0 }); }
            else if (subs.length) {
                br.u(5); if (br.u(1)) { br.u(8); }
                if (acmod === 0) { br.u(5); if (br.u(1)) { br.u(8); } }
                var last = subs[subs.length - 1];
                last.dep++;
                if (br.u(1)) { last.loc |= (br.u(16) >> 5) & 0x1FF; }      // chanmap 的位 → chan_loc（ffmpeg movenc 的做法）
            }
            if (size < 6) { break; }
            o += size;
        }
        if (!subs.length) { return null; }
        var nbits = 16, i;
        for (i = 0; i < subs.length; i++) { nbits += 23 + (subs[i].dep ? 9 : 1); }
        var w = new BitW(Math.ceil(nbits / 8));
        w.u(13, Math.min(8191, Math.round(bits / 1000))); w.u(3, subs.length - 1);
        subs.forEach(function (s) {
            w.u(2, s.fscod); w.u(5, s.bsid); w.u(1, 0); w.u(1, 0); w.u(3, 0); w.u(3, s.acmod); w.u(1, s.lfe); w.u(3, 0); w.u(4, s.dep);
            if (s.dep) { w.u(9, s.loc); } else { w.u(1, 0); }
        });
        var s0 = subs[0], tt = Object.assign({}, t, { channels: AC3_CH[s0.acmod] + s0.lfe, rate: fs0 });
        return audio("ec-3", tt, Mp4.box("dec3", w.b));
    }

    /* 要第一帧才写得出 stsd 的轨（AC-3 / E-AC-3、没有 CodecPrivate 的 VP9）：读头部时已经缓存的 512KB 里多半就有第一个 Cluster，
     * 在那里面找它们的第一帧。找不到就留给 demuxer（audioStsd）。 */
    function scanFirstFrames(c, info) {
        var need = {}, n = 0;
        info.tracks.forEach(function (t) { if (t.needFirstFrame && !t.unsupported) { need[t.num] = t; n++; } });
        if (!n) { return; }
        var part = null;
        c.parts.forEach(function (p) { if (info.firstCluster >= p.s && info.firstCluster < p.s + p.b.length) { part = p; } });
        if (!part) { return; }
        var b = part.b, o = info.firstCluster - part.s, end = b.length, cend = end;
        while (n && o < end) {
            var h = header(b, o, end);
            if (!h || h.bad) { return; }
            var ds = o + h.hdr;
            if (h.id === CLUSTER) { cend = h.unknown ? end : Math.min(end, ds + h.size); o = ds; continue; }
            if (h.unknown || ds + h.size > end) { return; }
            if (o >= cend && !TOP[h.id]) { return; }
            var blk = h.id === SIMPLEBLOCK ? b.subarray(ds, ds + h.size) : h.id === BLOCKGROUP ? groupBlock(b, ds, ds + h.size) : null;
            if (blk) {
                var tn = blk[0] & 0x7F;
                if (vlen(blk[0]) === 1 && need[tn]) {
                    var fr = blockFrames(blk);
                    if (fr.length) {
                        firstFrame(need[tn], strip(need[tn], blk.subarray(fr[0], fr[1])));
                        delete need[tn]; n--;
                    }
                }
            }
            o = ds + h.size;
        }
    }
    function groupBlock(b, s, e) { var r = null; each(b, s, e, function (id, cs, ce) { if (id === BLOCK && !r) { r = b.subarray(cs, ce); } }); return r; }
    function strip(t, f) {
        if (!t.comp || t.comp.algo !== 3 || !t.comp.settings.length) { return f; }
        return Mp4.concat([t.comp.settings, f]);
    }
    /* 拿第一帧补上 stsd。t 会被改（readHead 时是 info 里的轨，demuxer 里是它自己那份） */
    function firstFrame(t, f) {
        if (t.codecId === "A_AC3" || t.codecId === "A_EAC3") {
            var s = ac3Stsd(t, f);
            if (s) { t.stsd = s; t.needFirstFrame = false; }
            return !!s;
        }
        if (t.codecId === "V_VP9") {
            var h = vp9Header(f);
            if (h) { t.vp9 = Object.assign({}, t.vp9, h); vp9Entry(t); t.mime = "video/mp4; codecs=\"" + t.codec + "\""; }
            t.needFirstFrame = false;
            return false;
        }
        return false;
    }

    /* 块（SimpleBlock / Block 的正文）里各帧的 [起, 止, 起, 止…]。lacing：0 不分、1 Xiph、2 固定大小、3 EBML（Matroska §10.3） */
    function blockFrames(b) {
        var tl = vlen(b[0]), p = tl + 3, flags = b[tl + 2], lacing = (flags >> 1) & 3;
        if (!lacing) { return p <= b.length ? [p, b.length] : []; }
        var count = b[p++] + 1, sizes = [], i, s;
        if (lacing === 1) {
            for (i = 0; i < count - 1; i++) {
                s = 0;
                var x;
                do { x = b[p++]; s += x; } while (x === 255 && p < b.length);
                sizes.push(s);
            }
        } else if (lacing === 3) {
            var l = vlen(b[p]), v = b[p] & (0xFF >> l);
            for (i = 1; i < l; i++) { v = v * 256 + b[p + i]; }
            p += l;
            sizes.push(v);
            for (i = 1; i < count - 1; i++) {
                l = vlen(b[p]);
                var u = b[p] & (0xFF >> l);
                for (var k = 1; k < l; k++) { u = u * 256 + b[p + k]; }
                p += l;
                v += u - (Math.pow(2, 7 * l - 1) - 1);      // 有符号：减掉偏置
                sizes.push(v);
            }
        } else {
            var each_ = Math.floor((b.length - p) / count);
            for (i = 0; i < count - 1; i++) { sizes.push(each_); }
        }
        var out = [], o = p, sum = 0;
        for (i = 0; i < sizes.length; i++) { sum += sizes[i]; }
        if (sum > b.length - p || sizes.some(function (z) { return z < 0; })) { return []; }
        for (i = 0; i < sizes.length; i++) { out.push(o, o + sizes[i]); o += sizes[i]; }
        out.push(o, b.length);
        return out;
    }

    /* ---------- 查找 ---------- */

    function cueIndex(c, sec) {
        var lo = 0, hi = c.t.length - 1;
        if (sec < c.t[0]) { return 0; }
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (c.t[mid] <= sec + 1e-6) { lo = mid; } else { hi = mid - 1; }
        }
        return lo;
    }
    function cue(c, i) { return { t: c.t[i], pos: c.pos[i], rel: c.rel[i], i: i }; }
    function cueAt(info, sec) { var c = info.cues; return c && c.t.length ? cue(c, cueIndex(c, sec)) : null; }
    function cueNear(info, sec, dir, fromSec) {
        var c = info.cues;
        if (!c || !c.t.length) { return null; }
        var n = c.t.length, ki = cueIndex(c, sec);
        if (ki + 1 < n && Math.abs(c.t[ki + 1] - sec) < Math.abs(c.t[ki] - sec)) { ki++; }
        if (dir > 0) { while (ki + 1 < n && c.t[ki] <= fromSec + 0.5) { ki++; } }
        if (dir < 0) { while (ki > 0 && c.t[ki] >= fromSec - 0.5) { ki--; } }
        return cue(c, ki);
    }
    function guessOffset(info, sec, fileSize) {
        var a = info.firstCluster, b = Math.min(info.segEnd, fileSize || info.segEnd);
        if (!info.duration || b <= a) { return a; }
        return Math.floor(a + (b - a) * Math.max(0, Math.min(1, sec / info.duration)));
    }

    /* ---------- 流式拆块 ---------- */

    /* pts 的最小堆（算解码时间用） */
    function Heap() { this.a = []; }
    Heap.prototype.push = function (v) {
        var a = this.a, i = a.length;
        a.push(v);
        while (i > 0) { var p = (i - 1) >> 1; if (a[p] <= v) { break; } a[i] = a[p]; i = p; }
        a[i] = v;
    };
    Heap.prototype.pop = function () {
        var a = this.a, top = a[0], last = a.pop(), n = a.length, i = 0;
        if (n) {
            while (true) {
                var l = 2 * i + 1, r = l + 1, m = i;
                var mv = last;
                if (l < n && a[l] < mv) { m = l; mv = a[l]; }
                if (r < n && a[r] < mv) { m = r; }
                if (m === i) { break; }
                a[i] = a[m]; i = m;
            }
            a[i] = last;
        }
        return top;
    };

    function demuxer(info, want) {
        var ts = info.timescale, f = info.tsNs * ts / 1e9, ident = Math.abs(f - 1) < 1e-9;
        function tk(x) { return ident ? x : Math.round(x * f); }
        var d = { pos: info.firstCluster, done: false, openGop: false, leadDropped: 0, resyncs: 0, lacing: [0, 0, 0, 0], reorder: R0 };
        var T = {}, subsWanted = want.subs || [];
        info.tracks.forEach(function (t) {
            var kind = t.num === want.video ? "video" : t.num === want.audio ? "audio" : subsWanted.indexOf(t.num) >= 0 ? "sub" : "";
            if (!kind) { return; }
            T[t.num] = { kind: kind, t: Object.assign({}, t), dd: t.defaultDur * ts };
        });
        var hb = new Uint8Array(32);
        var inCluster = false, clusterEnd = 0, clusterTs = 0, syncing = false, startTicks = 0;
        var V, A, out;

        d.reset = function (offset, startSec, resync) {
            d.pos = offset;
            d.done = false;
            inCluster = false; clusterTs = 0;
            syncing = !!resync;
            startTicks = Math.round((startSec || 0) * ts);
            V = { pending: [], heap: new Heap(), held: null, lastDts: -1, lastDur: 0, needKey: true, dropLead: false, keyPts: 0 };
            A = { held: null, lastDur: 0, laced: null, waiting: want.video && T[want.video] ? [] : null, minPts: startTicks - 0.1 * ts };
        };
        d.reset(info.firstCluster, 0, false);

        /* ---- 视频：排序窗口算解码时间 ---- */
        function onVideo(pts, key, data) {
            if (V.needKey) {
                if (!key) { return; }
                V.needKey = false; V.dropLead = true; V.keyPts = pts;
                releaseAudio(pts - 0.1 * ts);
            } else if (key) {
                V.dropLead = false; V.keyPts = pts;
            } else if (pts < V.keyPts) {
                /* 显示在关键帧之前、解码在它之后：open GOP 的前导帧。刚跳过来时参考的上一个 GOP 不在解码器里，丢掉 */
                d.openGop = true;
                if (V.dropLead) { d.leadDropped++; return; }
            }
            if (pts < V.lastDts && d.reorder < RMAX) { d.reorder = Math.min(RMAX, d.reorder + 2); }
            V.pending.push({ pts: pts, dts: 0, cto: 0, dur: 0, key: key, data: data });
            V.heap.push(pts);
            while (V.pending.length > d.reorder) { assignVideo(V.pending.shift()); }
        }
        /* 解码顺序上第 i 帧的 dts = 还没被用掉的 pts 里最小的（压 R 帧再定，B 帧重排在窗口里）。严格递增、不为负。 */
        function assignVideo(fr) {
            var dts = V.heap.pop();
            if (dts <= V.lastDts) { dts = V.lastDts + 1; d.clamped = (d.clamped || 0) + 1; }
            if (dts < 0) { dts = 0; }
            fr.dts = dts; fr.cto = fr.pts - dts;
            if (V.held) { V.held.dur = dts - V.held.dts; V.lastDur = V.held.dur; out.video.push(V.held); }
            V.held = fr; V.lastDts = dts;
        }

        /* ---- 音频 ---- */
        function releaseAudio(minPts) {
            A.minPts = minPts;
            var w = A.waiting;
            A.waiting = null;
            if (w) { for (var i = 0; i < w.length; i++) { admitAudio(w[i].pts, w[i].data); } }
        }
        function onAudio(pts, data) {
            if (A.waiting) {
                A.waiting.push({ pts: pts, data: data });
                /* 视频关键帧迟迟不来（攒了 10 秒），按跳转目标判 */
                if (pts - A.waiting[0].pts > 10 * ts) { releaseAudio(startTicks - 0.1 * ts); }
                return;
            }
            admitAudio(pts, data);
        }
        function admitAudio(pts, data) {
            if (pts < A.minPts || pts < 0) { return; }
            if (A.held) {
                var dur = pts - A.held.dts;
                if (dur <= 0) { return; }
                A.held.dur = dur; A.lastDur = dur;
                out.audio.push(A.held);
            }
            A.held = { dts: pts, cto: 0, dur: 0, key: true, data: data };
        }
        /* 没有 DefaultDuration 的 lacing 块：等下一块的时间再把块里的帧均分 */
        function flushLaced(nextTs) {
            var L = A.laced;
            if (!L) { return; }
            A.laced = null;
            var n = L.frames.length, step = nextTs !== null && nextTs > L.ts ? (nextTs - L.ts) / n : (A.lastDur || 1);
            for (var i = 0; i < n; i++) { onAudio(L.ts + Math.round(i * step), L.frames[i]); }
        }

        function onBlock(st, b, simple, durTicks, hasRef) {
            var tl = vlen(b[0]), rel = (b[tl] << 8) | b[tl + 1];
            if (rel & 0x8000) { rel -= 0x10000; }
            var flags = b[tl + 2], key = simple ? !!(flags & 0x80) : !hasRef;
            d.lacing[(flags >> 1) & 3]++;
            var pts = tk(clusterTs + rel), fr = blockFrames(b);
            if (!fr.length) { return; }
            var frames = [];
            for (var i = 0; i < fr.length; i += 2) { frames.push(strip(st.t, b.subarray(fr[i], fr[i + 1]))); }
            if (st.kind === "video") {
                if (st.t.needFirstFrame) { firstFrame(st.t, frames[0]); }
                for (i = 0; i < frames.length; i++) { onVideo(pts + Math.round(i * st.dd), key, frames[i]); }
            } else if (st.kind === "audio") {
                if (!st.t.stsd && st.t.needFirstFrame && firstFrame(st.t, frames[0])) { out.audioStsd = st.t.stsd; }
                if (A.laced) { flushLaced(pts); }
                if (frames.length === 1) { onAudio(pts, frames[0]); }
                else if (st.dd) { for (i = 0; i < frames.length; i++) { onAudio(pts + Math.round(i * st.dd), frames[i]); } }
                else { A.laced = { ts: pts, frames: frames }; }
            } else {
                var z = !!(st.t.comp && st.t.comp.algo === 0);
                for (i = 0; i < frames.length; i++) {
                    out.subs.push({ num: st.t.num, pts: pts / ts, dur: durTicks > 0 ? tk(durTicks) / ts : 0, data: frames[i], zlib: z });
                }
            }
        }

        /* 往后找下一个像样的 Cluster：ID + 合法大小 + 第一个子元素是 Timestamp（前面可以有 CRC-32） */
        function resyncStep(win) {
            var s = Math.max(d.pos, win.startOff), e = win.endOff;
            if (e - s < 32) { return false; }
            var len = Math.min(e - s, 1048576), b = win.read(s, len);
            for (var i = 0; i + 4 <= len; i++) {
                if (b[i] !== 0x1F || b[i + 1] !== 0x43 || b[i + 2] !== 0xB6 || b[i + 3] !== 0x75) { continue; }
                if (i + 32 > len) { d.pos = s + i; return len === e - s ? false : true; }
                var h = header(b, i, len);
                if (!h || h.bad || (!h.unknown && s + i + h.hdr + h.size > info.segEnd + 16)) { continue; }
                var c = header(b, i + h.hdr, len);
                if (c && !c.bad && c.id === 0xBF) { c = header(b, i + h.hdr + c.hdr + c.size, len); }
                if (!c || c.bad || c.id !== TIMESTAMP || c.size < 1 || c.size > 8) { continue; }
                d.pos = s + i; syncing = false; inCluster = false; d.resyncs++;
                return true;
            }
            d.pos = s + len - 3;
            return len < e - s;
        }

        /* 一个元素：返回 false = 字节不够，等下次 */
        function step(win) {
            if (syncing) { return resyncStep(win); }
            if (d.pos < win.startOff) { return false; }
            var n = Math.min(hb.length, win.endOff - d.pos);
            if (n < 2) { return false; }
            win.copy(hb, 0, d.pos, n);
            var h = header(hb, 0, n);
            if (!h) { return false; }
            if (h.bad) { syncing = true; return true; }
            var ds = d.pos + h.hdr;
            if (inCluster && (clusterEnd !== Infinity ? d.pos >= clusterEnd : TOP[h.id])) { inCluster = false; }
            if (!inCluster) {
                if (h.id === CLUSTER) { inCluster = true; clusterEnd = h.unknown ? Infinity : ds + h.size; clusterTs = 0; d.pos = ds; return true; }
                if (h.id === EBML || h.id === SEGMENT || h.unknown) { d.done = true; return false; }     // 串起来的第二个 Segment 不管
                d.pos = ds + h.size;                    // Cues、Tags、Void…：只跳过，不用等它的字节
                return true;
            }
            if (h.unknown) { syncing = true; return true; }
            var end = ds + h.size;
            if (h.id === TIMESTAMP) {
                if (!win.has(ds, h.size)) { return false; }
                clusterTs = h.hdr + h.size <= n ? uint(hb, h.hdr, h.hdr + h.size) : uint(win.read(ds, h.size), 0, h.size);
            } else if (h.id === SIMPLEBLOCK || h.id === BLOCKGROUP) {
                /* 先只看轨道号：不要的轨不等它的字节，直接跳 */
                var peek = Math.min(h.size, 24);
                if (!win.has(ds, peek)) { return false; }
                var pb = win.read(ds, peek), tn = -1;
                if (h.id === SIMPLEBLOCK) { tn = pb[0] & 0x7F; if (vlen(pb[0]) !== 1) { tn = -1; } }
                else {
                    var c = header(pb, 0, peek);
                    if (c && !c.bad && c.id === BLOCK && c.hdr < peek && vlen(pb[c.hdr]) === 1) { tn = pb[c.hdr] & 0x7F; }
                }
                if (tn > 0 && !T[tn]) { d.pos = end; return true; }
                if (!win.has(ds, h.size)) { return false; }
                var body = win.read(ds, h.size);
                if (h.id === SIMPLEBLOCK) {
                    if (T[body[0] & 0x7F] && vlen(body[0]) === 1) { onBlock(T[body[0] & 0x7F], body, true, 0, false); }
                } else {
                    var blk = null, dur = 0, ref = false;
                    each(body, 0, body.length, function (id, cs, ce) {
                        if (id === BLOCK) { blk = body.subarray(cs, ce); } else if (id === BLOCKDUR) { dur = uint(body, cs, ce); }
                        else if (id === REFBLOCK) { ref = true; }
                    });
                    if (blk && vlen(blk[0]) === 1 && T[blk[0] & 0x7F]) { onBlock(T[blk[0] & 0x7F], blk, false, dur, ref); }
                }
            }
            d.pos = end;
            return true;
        }

        d.feed = function (win) {
            out = { video: [], audio: [], subs: [] };
            var guard = 0;
            while (!d.done && guard++ < 1000000) {
                if (d.pos >= info.segEnd) { d.done = true; break; }
                if (!step(win)) { break; }
            }
            return out;
        };
        /* 文件读完了：压着的帧全吐出来 */
        d.flush = function () {
            out = { video: [], audio: [], subs: [] };
            if (A.laced) { flushLaced(null); }
            while (V.pending.length) { assignVideo(V.pending.shift()); }
            var vt = want.video && T[want.video];
            if (V.held) { V.held.dur = V.lastDur || Math.round(vt ? vt.dd : 0) || 1; out.video.push(V.held); V.held = null; }
            if (A.waiting) { releaseAudio(startTicks - 0.1 * ts); }
            var at = want.audio && T[want.audio];
            if (A.held) { A.held.dur = A.lastDur || Math.round(at ? at.dd : 0) || 1; out.audio.push(A.held); A.held = null; }
            d.done = true;
            return out;
        };
        return d;
    }

    /* ---------- 封面：某个时间点附近的视频关键帧 ---------- */

    async function keyframeAt(read, info, sec) {
        var vt = null;
        info.tracks.forEach(function (t) { if (t.kind === "video" && !vt) { vt = t; } });
        if (!vt) { throw new Error("没有视频轨"); }
        var c = new Cache(read, info.segEnd), cu = cueAt(info, sec), cpos = cu ? cu.pos : info.firstCluster;
        var cl = await c.element(cpos, false);
        if (!cl || cl.id !== CLUSTER) { throw new Error("cue 指的位置不是 Cluster"); }
        var cend = cl.unknown ? info.segEnd : cl.ds + cl.size, limit = Math.min(cend, cpos + 8 * 1048576);
        var clusterTs = 0, o = cl.ds;
        var hd = await c.get(o, 32);
        each(hd, 0, hd.length, function (id, s, e) { if (id === TIMESTAMP && e <= hd.length) { clusterTs = uint(hd, s, e); } });
        async function tryAt(pos) {
            var el = await c.element(pos, false);
            if (!el || el.unknown) { return null; }
            if (el.id === TIMESTAMP) { var tb = await c.get(el.ds, el.size); clusterTs = uint(tb, 0, tb.length); return { next: el.ds + el.size }; }
            if (el.id !== SIMPLEBLOCK && el.id !== BLOCKGROUP) { return { next: el.ds + el.size }; }
            var body = await c.get(el.ds, el.size), blk = body, ref = false;
            if (el.id === BLOCKGROUP) {
                blk = null;
                each(body, 0, body.length, function (id, s, e) { if (id === BLOCK) { blk = body.subarray(s, e); } else if (id === REFBLOCK) { ref = true; } });
            }
            if (blk && vlen(blk[0]) === 1 && (blk[0] & 0x7F) === vt.num) {
                var tl = 1, rel = (blk[tl] << 8) | blk[tl + 1];
                if (rel & 0x8000) { rel -= 0x10000; }
                var key = el.id === SIMPLEBLOCK ? !!(blk[tl + 2] & 0x80) : !ref, fr = blockFrames(blk);
                if (key && fr.length) {
                    return { hit: { pts: (clusterTs + rel) * info.tsNs / 1e9, data: strip(vt, blk.slice(fr[0], fr[1])), track: vt } };
                }
            }
            return { next: el.ds + el.size };
        }
        /* CueRelativePosition：块在 Cluster 正文里的位置，直接去读那一块 */
        if (cu && cu.rel >= 0) {
            var r = await tryAt(cl.ds + cu.rel);
            if (r && r.hit) { return r.hit; }
        }
        while (o < limit) {
            var x = await tryAt(o);
            if (!x) { break; }
            if (x.hit) { return x.hit; }
            o = x.next;
        }
        throw new Error("8MB 里没找到视频关键帧");
    }

    return {
        sniff: sniff, readHead: readHead, cueAt: cueAt, cueNear: cueNear, guessOffset: guessOffset, demuxer: demuxer, keyframeAt: keyframeAt
    };
})();
