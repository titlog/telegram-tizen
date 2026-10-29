/* 播放引擎：一个 <video> + 每部片一个 MediaSource，音视频各一个 SourceBuffer。
 *
 * 数据源只要会一件事：stream(offset, signal, throttle) → {start, iter}，从 start（≤ offset，按 512KB 对齐）起
 * 按顺序吐 Uint8Array。Telegram（tg.js）和 HTTP Range（桌面测试台）各一个实现。
 *
 * MP4：从头读 → 找到 moov（在尾部就跳过去读）→ Mp4.parseMoov → 按样本在文件里的位置顺序读，读到哪条轨的样本
 * 就拼成 ~1 秒的 moof+mdat 塞进它的 SourceBuffer。跳转 = 换个偏移重新读（目标已经在缓冲里就只改 currentTime）。
 * MKV（mkv.js，开头 4 个字节认出来）：没有样本表，Mkv.readHead 读头和 Cues，之后按 Cluster 顺序拆块，拆出来的帧
 * 攒够 ~1 秒拼一段（Mp4.fragmentFrames）。跳转靠 Cues。一路读（MKV 里同一时刻的音视频本来就挨着放）。
 *
 * 「路」（lane）：一路 = 一个从某个偏移顺序往下读的下载 + 它自己的字节窗口。普通文件一路（音视频一起读）。
 * 音视频在文件里隔得远的 MP4（《黑鹰坠落》4K：10 分钟处视频在 381MB、音频在 51MB，越往后隔得越远）拆成两路，
 * 各读各的位置 —— 一路的话从 6:35 续播要先读过 176MB、60 秒才出画面（2026-10-01 电视实测），播放中音频也越跑越前。
 *
 * 多音轨：打开时选一条（opts.audio 给的 → 文件标的默认那条 → 第一条放得了的），换音轨 = 在当前位置重开（app.js），
 * 不在原来的 MediaSource 上换 —— 换编码要 SourceBuffer.changeType，三星电视的 MSE 是自己的实现，没验证过，重开最稳。
 * 片子里带的字幕不进 SourceBuffer：MP4 的字幕样本在读音视频时顺带从窗口里拿出来，MKV 的字幕块 demuxer 交出来，
 * 都交给 opts.onSub（app.js → subs.js）。
 *
 *   var p = Player.create(videoEl, report, onState)
 *   p.open(source, {startAt, exact, moov, onMoov, audio, onTracks, onSub})   → Promise（出画面时 resolve）
 *       exact：停在 startAt 本身（换音轨重开用；默认落在它之前的关键帧上）
 *       onSub(key, pts, dur, data, extra)：片子里的一个字幕样本（秒；extra.zlib = MKV 的压缩块）
 *   p.tracks()                  {fmt, audio: [{key, lang, name, codec, channels, ok, why, current}], subs: [{key, lang, name, codec, codecPrivate, isDefault, isForced}]}
 *   p.seek(sec, dir)            dir = +1 / -1：快进快退（落在那个方向的关键帧上）；0：落在 sec 之前的关键帧
 *   p.toggle() / p.close() / p.time() / p.duration()
 */
var Player = (function () {
    "use strict";

    var CH = 512 * 1024;
    var AHEAD = 60;            // 生产到播放头前面多少秒就停下载
    var BEHIND = 15;           // 播放头后面留多少秒（电视的 SourceBuffer 小，留多了挤掉前面的）
    var SEG = 1;               // 每段多少秒
    var WIN_WARN = 48 * 1048576;
    var SPLIT = 16 * 1048576;  // 同一时刻的音视频在文件里隔得比这远，就分两路读
    var VID = 1, AID = 2;      // init 段和分段里写的轨道编号（不用文件里的）：哪条音轨都写成 2

    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }
    function sleep(t) { return new Promise(function (r) { setTimeout(r, t); }); }
    function errStr(e) { return (e && (e.message || e.text || e.name)) || String(e); }
    /* 显示给用户的话（i18n.js）；node 里的离线测试没有 I18n，原样用中文 */
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    /* 下载来的字节：按文件偏移排好的一串块。每次换读的位置就清空。 */
    function Win() { this.chunks = []; this.startOff = 0; this.endOff = 0; this.total = 0; }
    Win.prototype.reset = function (at) { this.chunks = []; this.startOff = this.endOff = at; this.total = 0; };
    Win.prototype.add = function (bytes) {
        this.chunks.push({ s: this.endOff, b: bytes });
        this.endOff += bytes.length;
        this.total += bytes.length;
    };
    Win.prototype.has = function (off, size) { return off >= this.startOff && off + size <= this.endOff; };
    Win.prototype.copy = function (dst, o, off, size) {
        var cs = this.chunks;
        for (var i = 0; i < cs.length && size > 0; i++) {
            var c = cs[i], ce = c.s + c.b.length;
            if (ce <= off) { continue; }
            var from = off - c.s, n = Math.min(size, ce - off);
            dst.set(c.b.subarray(from, from + n), o);
            o += n; off += n; size -= n;
        }
    };
    Win.prototype.read = function (off, size) { var d = new Uint8Array(size); this.copy(d, 0, off, size); return d; };
    Win.prototype.release = function (upTo) {
        var cs = this.chunks;
        while (cs.length && cs[0].s + cs[0].b.length <= upTo) {
            this.total -= cs[0].b.length;
            this.startOff = cs[0].s + cs[0].b.length;
            cs.shift();
        }
    };

    /* 一次性读 [off, off+len)（MKV 的头和 Cues、MP4 里挤在一起的字幕样本）。throttle 卡住只发需要的那几块请求（同 cover.js）。 */
    async function readRange(source, off, len) {
        var size = Math.min(len, source.size - off);
        if (size <= 0) { return new Uint8Array(0); }
        var ac = new AbortController(), n = 0, need = 0;
        var st = source.stream(off, ac.signal, function () { return n++ < need ? Promise.resolve() : new Promise(function () {}); });
        need = Math.ceil((off + size - st.start) / CH);
        var out = new Uint8Array(size), pos = st.start;
        try {
            for await (var c of st.iter) {
                var s = Math.max(off, pos), e = Math.min(off + size, pos + c.length);
                if (e > s) { out.set(c.subarray(s - pos, e - pos), s - off); }
                pos += c.length;
                if (pos >= off + size) { break; }
            }
        } finally { ac.abort(); }
        if (pos < off + size) { throw new Error(tx("没读够（{0}/{1}）", pos, off + size)); }
        return out;
    }

    /* 选音轨：要的那条（换音轨时 app 给的）→ 文件标的默认那条 → 第一条放得了的 */
    function pickAudio(list, want) {
        var ok = list.filter(function (a) { return a.ok; });
        return ok.filter(function (a) { return a.key === want; })[0] || ok.filter(function (a) { return a.isDefault; })[0] || ok[0] || null;
    }

    function create(video, report, onState) {
        var R = function (s) { report && report(s); };
        var S = null;          // 当前这部片的会话
        var api = {};

        var lastPhase = "";
        /* known：出错的原因是知道的（电视的限制），屏幕上说清楚就好，不当出事上传 */
        function state(phase, msg, known) {
            if (phase === lastPhase && !msg) { return; }
            lastPhase = phase;
            if (onState) { try { onState(phase, msg, known); } catch (e) {} }
        }

        /* 高过 1088 的 H.264：Tizen 5.5 / 6.0 的硬件解码器解不了（2026-10-27 诊断日志：四台电视高于 1088 的十四次全是出画面前 code=3，
         * 不高于的十次全成；Tizen 9 放得了；抖音那边同一台 Tizen 6.5 的竖屏 H.264 也是这样，H.265 的竖屏直播却放得了）。
         * 这台电视放成过一部这么高的（出画面后走了 2 秒），code=3 就不是这个原因。见 docs/播放引擎.md */
        var TALL_KEY = "tg.h264tall";
        function tallVideo(sess) {
            var v = null;
            sess.tracks.forEach(function (T) { if (T.tr.kind === "video") { v = T.tr; } });
            return v && /^avc/.test(v.codec || "") && v.height > 1088 ? v : null;
        }
        function tallOk() { try { return localStorage.getItem(TALL_KEY) === "1"; } catch (e) { return false; } }

        /* 音轨放不放得了。FLAC：电视的 MSE 说认（isTypeSupported 是 true），数据也进得去，可从来不解 —— readyState 停在 1，
         * 只有音频、配了视频都一样（2026-10-26 deploy.sh --music 实测；AAC 同样的放法没事）。MKV 里 FLAC 音轨的片子以前会一直卡在
         * 「正在打开」：当它放不了，有别的音轨换别的，没有就无声放、提示一下。桌面 Chrome 解得了，照常放 */
        function audioOk(t) {
            if (t.codec === "flac" && /Tizen/.test(navigator.userAgent)) { t.tvNo = tx("FLAC 音轨电视解不了"); return false; }
            return MediaSource.isTypeSupported(t.mime);
        }

        /* ---------- SourceBuffer 队列 ---------- */

        function pumpSb(T) {
            /* 换了片子、重开过的旧会话：它的 T.wait / T.retry 计时器还会来，SourceBuffer 已经从 MediaSource 上摘了（2026-10-26 一台
             * 印度电视的日志：「SourceBuffer … removed from the parent media source」） */
            if (!S || S.tracks.indexOf(T) < 0) { return; }
            /* "ended" 也照样 append：取完整部片 endOfStream 之后往回跳，appendBuffer 会自己把它改回 open */
            if (!T.sb || T.sb.updating || !T.q.length || !S || S.ms.readyState === "closed") { return; }
            var op = T.q[0];
            /* 拼好的段先攒在内存里，离播放头 T.ahead 秒以内才进 SourceBuffer。电视的 SourceBuffer 很小（音频 ~8MB），
             * 而有的文件音视频在文件里隔得很远：《黑鹰坠落》4K 里同一时刻的音频比视频早好几分钟的位置，读到视频之前
             * 音频已经攒了 6 分钟、把音频缓冲撑满（2026-10-01）。 */
            if (op.buf && op.t !== undefined && op.t > refTime() + T.ahead) {
                if (!T.wait) { T.wait = setTimeout(function () { T.wait = 0; pumpSb(T); }, 1000); }
                return;
            }
            try {
                if (op.remove) { T.sb.remove(op.remove[0], op.remove[1]); T.removing = op; }
                else { T.cur = op.init ? "init 段" : "t=" + (op.t !== undefined ? op.t.toFixed(1) : "?") + " 那段"; T.sb.appendBuffer(op.buf); T.full = false; if (op.t !== undefined) { T.lastT = op.t; } }
                T.q.shift();
                if (op.buf) { T.qBytes -= op.buf.length; }
            } catch (e) {
                if (e.name === "QuotaExceededError") {
                    /* 电视的 SourceBuffer 比桌面小得多（4K HEVC 开播 8 秒音频就满了，2026-10-01）。记下当时前面有多少字节，
                     * 这条轨以后最多攒它的 60%（gate 按这个停下载）；每段满只报一次，每秒最多重试一次。
                     * 第一版每次失败都再排一个 500ms 的重试、开播时播放头后面没东西可删，一秒刷一百多行。 */
                    if (!T.full) {
                        T.full = true;
                        var span = (T.lastT || refTime()) - refTime();
                        T.ahead = Math.max(15, Math.min(T.ahead, Math.floor(span * 0.7)));
                        R("缓冲满了（" + T.tr.kind + "）t=" + video.currentTime.toFixed(1) + "，已进 SourceBuffer 的到 " + span.toFixed(0) +
                          " 秒之后，各轨缓冲 " + api.debug() + "，这条轨以后只提前 " + T.ahead + " 秒放进去");
                    }
                    evict(10);
                    if (!T.retry) { T.retry = setTimeout(function () { T.retry = 0; pumpSb(T); }, 1000); }
                } else {
                    T.q.shift();
                    if (video.error) { fatal(); return; }
                    R("SourceBuffer " + T.tr.kind + " 出错 " + e.name + " " + e.message);
                }
            }
        }

        /* 媒体元素出错（解码失败等）之后什么都 append 不进去了：报一次，停下这部片。 */
        function fatal() {
            if (!S || S.dead) { return; }
            S.dead = true;
            var e = video.error;
            var msg = tx("播放器出错") + " code=" + (e ? e.code : "?") + " " + (e && e.message ? e.message : "") + " @" + video.currentTime.toFixed(2);
            R(msg);
            S.lanes.forEach(stopLane);
            S.tracks.forEach(function (T) { T.q.length = 0; });
            var tall = e && e.code === 3 && !S.firstFrameMs && !tallOk() ? tallVideo(S) : null;
            if (tall) {
                R("高 " + tall.height + " 的 H.264（" + tall.codec + "），这台电视没放成过这么高的：当成解码器的限制，不当出事");
                state("error", tx("这台电视解不了高度超过 1080 的 H.264 视频（这部是 {0}）", tall.width + "x" + tall.height), true);
                return;
            }
            state("error", msg);
        }

        function evict(behind) {
            var t = video.currentTime - behind;
            S && S.tracks.forEach(function (T) {
                var b = T.sb && T.sb.buffered;
                if (b && b.length && b.start(0) < t - 1 && !(T.q[0] && T.q[0].remove)) { T.q.unshift({ remove: [0, t] }); pumpSb(T); }
            });
        }

        /* 拿来比的「现在」：往后跳的时候清旧缓冲那几十毫秒 currentTime 还在原处，用跳转目标 */
        function refTime() { return S && S.seekAt ? Math.max(video.currentTime, S.seekAt.to) : video.currentTime; }

        /* ---------- 生产：窗口里有哪些样本就拼哪些 ---------- */

        /* 生产到哪了：取最慢的那条轨（默认看全部轨，给了 lane 就只看这一路的） */
        function frontier(lane) {
            var f = S.duration;
            if (S.fmt === "mkv") {
                if (S.dmxDone) { return f; }
                S.tracks.forEach(function (T) { f = Math.min(f, T.front); });
                return f;
            }
            (lane ? lane.tracks : S.tracks).forEach(function (T) { if (T.next < T.tr.n) { f = Math.min(f, Mp4.pts(T.tr, T.next)); } });
            return f;
        }

        var prodMax = 0, prodSum = 0;
        function produce(lane) {
            var t0 = performance.now();
            if (S.fmt === "mkv") { produceMkv(S, lane); } else { produceInner(lane); }
            var d = performance.now() - t0;
            prodSum += d;
            if (d > prodMax) { prodMax = d; }
        }
        api.takeStats = function () { var r = { prodMax: prodMax, prodSum: prodSum }; prodMax = prodSum = 0; return r; };

        function produceInner(lane) {
            var win = lane.win;
            lane.tracks.forEach(function (T) {
                var tr = T.tr, span = SEG * tr.timescale;
                while (T.next < tr.n) {
                    var a = T.next, e = a, list = [];
                    if (T.lead) {
                        /* 刚跳到关键帧 a：先丢掉它的前导帧。要等到前导帧后面那一帧也到了再拼 —— 关键帧的时长要撑到它 */
                        var f = Mp4.afterLeading(tr, a);
                        if (!win.has(tr.offset[a], tr.size[a]) || (f < tr.n && !win.has(tr.offset[f], tr.size[f]))) { break; }
                        if (f > a + 1) { S.leadSkipped = (S.leadSkipped || 0) + (f - a - 1); }
                        list.push(a);
                        e = f;
                        T.lead = false;
                    }
                    while (e < tr.n && win.has(tr.offset[e], tr.size[e]) && tr.dts[e] - tr.dts[a] < span) { list.push(e); e++; }
                    if (!list.length) { break; }
                    var frag = Mp4.fragment(tr, list, T.seq++, function (d, o, off, n) { win.copy(d, o, off, n); }, T.id);
                    T.q.push({ buf: frag, t: Mp4.pts(tr, list[0]) });
                    T.qBytes += frag.length;
                    T.next = e;
                    pumpSb(T);
                }
            });
            var need = Math.min(Infinity, subsFromWin(S, win));
            lane.tracks.forEach(function (T) { if (T.next < T.tr.n) { need = Math.min(need, T.tr.offset[T.next]); } });
            win.release(need === Infinity ? win.endOff : need);
            if (win.total > WIN_WARN && !S.warnedWin) {
                S.warnedWin = true;
                R("窗口里攒了 " + mb(win.total) + "（" + lane.name + "）：音视频在文件里隔得很远（交错差）");
            }
            if (S.tracks.every(function (T) { return T.next >= T.tr.n; })) { finish(); }
        }

        /* MP4 的字幕样本：窗口里有哪个就拿哪个（按文件位置排好的下标二分）。不参与「窗口留到哪」—— 字幕样本可能根本不在
         * 音视频读过的地方（有的工具把整条字幕轨写在文件头或文件尾），留着它会把整个窗口攒住。只有一个样本读了一半时，
         * 返回它的位置让窗口留到那里。 */
        function subsFromWin(sess, win) {
            var hold = Infinity;
            (sess.subT || []).forEach(function (st) {
                var tr = st.tr, ord = st.order, lo = 0, hi = ord.length;
                while (lo < hi) { var mid = (lo + hi) >> 1; if (tr.offset[ord[mid]] < win.startOff) { lo = mid + 1; } else { hi = mid; } }
                for (var j = lo; j < ord.length && tr.offset[ord[j]] < win.endOff; j++) {
                    var i = ord[j];
                    if (st.got[i]) { continue; }
                    if (!win.has(tr.offset[i], tr.size[i])) { hold = Math.min(hold, tr.offset[i]); break; }
                    st.got[i] = 1;
                    emitSub(sess, st, i, win.read(tr.offset[i], tr.size[i]));
                }
            });
            return hold;
        }
        function emitSub(sess, st, i, data) {
            var tr = st.tr, d = i + 1 < tr.n ? tr.dts[i + 1] - tr.dts[i] : tr.lastDelta;
            if (sess.opts.onSub) { try { sess.opts.onSub(st.key, tr.dts[i] / tr.timescale, d / tr.timescale, data, {}); } catch (e) {} }
        }

        function finish() {
            if (S.done) { return; }
            var wait = function () {
                if (!S || S.done) { return; }
                var busy = S.tracks.some(function (T) { return T.q.length || (T.sb && T.sb.updating); });
                if (busy) { setTimeout(wait, 300); return; }
                S.done = true;
                try { if (S.ms.readyState === "open") { S.ms.endOfStream(); } } catch (e) {}
                R("整部片取完了");
            };
            wait();
        }

        /* ---------- MKV：拆块 → 攒够一秒拼一段 ---------- */

        function produceMkv(sess, lane) {
            var out = sess.dmx.feed(lane.win);
            takeMkv(sess, out);
            lane.win.release(sess.dmx.pos);
            if (sess.dmx.done) { endMkv(sess, lane); }
        }
        /* 读到文件尾（或者 Segment 完了）：把 demuxer 压着的最后几帧要出来，剩下的不够一秒也拼 */
        function endMkv(sess, lane) {
            if (sess.dmxDone || S !== sess) { return; }
            takeMkv(sess, sess.dmx.flush());
            sess.dmxDone = true;
            stopLane(lane);             // 后面只剩 Cues / Tags
            finish();
        }
        function takeMkv(sess, out) {
            var V = sess.tracks[0], A = sess.tracks[1];
            if (out.audioStsd && A && !A.inited) {
                /* AC-3 / E-AC-3：dac3 / dec3 要第一帧的同步帧头才写得出，init 段这时才 append */
                A.tr.stsd = out.audioStsd;
                A.q.push({ buf: Mp4.initSegment(A.tr, AID), init: true });
                A.inited = true;
            }
            if (out.video && out.video.length) {
                if (sess.needStart) {
                    /* 没有 Cues、按码率猜的位置：真的从哪开始，要等第一个关键帧拆出来才知道 */
                    var f0 = out.video[0], t0 = (f0.dts + (f0.cto || 0)) / V.tr.timescale;
                    sess.needStart = false;
                    if (sess.seekAt) { sess.seekAt.to = t0; }
                    sess.startTo = t0;
                    if (sess.cleared) { video.currentTime = t0; }      // 旧缓冲还没清完的话，清完那一下会挪过去
                }
                if (sess.alignV === undefined) { sess.alignV = (out.video[0].dts + (out.video[0].cto || 0)) / V.tr.timescale; }
                Array.prototype.push.apply(V.pend, out.video);
                cutFrames(V);
            }
            if (A && out.audio && out.audio.length) {
                if (sess.alignA === undefined) { sess.alignA = out.audio[0].dts / A.tr.timescale; }
                Array.prototype.push.apply(A.pend, out.audio);
            }
            alignStart(sess);
            if (A && A.inited) { cutFrames(A); }
            if (out.subs && out.subs.length && sess.opts.onSub) {
                out.subs.forEach(function (s) { try { sess.opts.onSub("s:" + s.num, s.pts, s.dur, s.data, { zlib: !!s.zlib }); } catch (e) {} });
            }
        }
        /* 从 Cue 跳进来，第一帧音频可能比视频关键帧晚：mkvmerge 把跨过关键帧的那帧音频放在上一个 Cluster 里，这边拆出来的第一帧音频
         * 晚 0.006–0.12 秒。播放头放在关键帧上就落在音视频之间的空档里（buffered 是两条轨的交集）—— 三星的 MSE 不会自己跨过去：
         * 2026-10-26 一台印度电视续播 mkvmerge 封装的 MKV 六次都是 90 秒没画面，播放中跳转也每次先卡 1–2.5 秒等「跳过空档」。
         * 两条轨的第一帧都拿到了，起点挪到晚的那个。 */
        function alignStart(sess) {
            if (!sess.alignPending || sess.alignV === undefined || (sess.tracks[1] && sess.alignA === undefined)) { return; }
            sess.alignPending = false;
            var t = Math.max(sess.alignV, sess.alignA || 0);
            if (sess.startTo === undefined || t <= sess.startTo + 0.001) { return; }
            R("音频比视频晚 " + Math.round((t - sess.startTo) * 1000) + "ms 开始，起点挪到 " + t.toFixed(3));
            sess.startTo = t;
            if (sess.seekAt) { sess.seekAt.to = t; }
            if (sess.cleared) { video.currentTime = t; }       // 旧缓冲还没清完的话，清完那一下会挪过去
        }
        /* 和 MP4 那条路一样：窗口里拆出多少就拼多少（每段最多 1 秒），不等凑满一秒 —— 等的话跳转后第一段要多下一秒的字节，
         * 桌面测试里跳转 1.4–2.0 秒 → 见 CLAUDE.md */
        function cutFrames(T) {
            var ts = T.tr.timescale, span = SEG * ts;
            while (T.pend.length) {
                var e = 0, acc = 0;
                while (e < T.pend.length && acc < span) { acc += T.pend[e].dur; e++; }
                var list = T.pend.splice(0, e), f = list[0], l = list[list.length - 1];
                var frag = Mp4.fragmentFrames(T.id, list, T.seq++);
                T.q.push({ buf: frag, t: (f.dts + (f.cto || 0)) / ts });
                T.qBytes += frag.length;
                T.front = (l.dts + l.dur) / ts;
                pumpSb(T);
            }
        }

        /* ---------- 下载 ---------- */

        /* mtcute 的下载线程不管背压，每块请求之前 await 这个（HTTP 源也一样）。 */
        function gate(sess, lane, g) {
            return (async function () {
                while (S === sess && lane.gen === g && sess.moovDone &&
                       (frontier(lane) - video.currentTime > AHEAD || lane.win.total > 32 * 1048576 ||
                        sess.tracks.reduce(function (n, T) { return n + T.qBytes; }, 0) > 96 * 1048576)) {
                    await sleep(300);
                }
            })();
        }

        function newLane(name, tracks) { return { name: name, tracks: tracks, win: new Win(), gen: 0, ac: null }; }
        function stopLane(lane) { lane.gen++; if (lane.ac) { lane.ac.abort(); } }

        /* 这一路从 offset 开始读。onChunk 返回 false 就停（跳去别处）；读到文件尾调 lane.onEnd。出错自动重试。
         * keep：窗口里已有的字节留着（从窗口末尾接着读） */
        function startStream(lane, offset, onChunk, keep) {
            var sess = S, g = ++lane.gen;
            if (lane.ac) { lane.ac.abort(); }
            var ac = lane.ac = new AbortController();
            (async function () {
                var tries = 0;
                while (S === sess && lane.gen === g) {
                    var st = sess.source.stream(offset, ac.signal, function () { return gate(sess, lane, g); });
                    /* 重试时从窗口末尾接着读，窗口里还没用掉的字节留着（对得上才留：起点按 512KB 对齐） */
                    if ((!tries && !keep) || st.start !== lane.win.endOff) { lane.win.reset(st.start); }
                    var t0 = performance.now(), first = true;
                    try {
                        for await (var c of st.iter) {
                            if (S !== sess || lane.gen !== g) { return; }
                            if (first) { first = false; sess.firstChunkMs = sess.firstChunkMs || Math.round(performance.now() - t0); tries = 0; }
                            sess.bytes += c.length;
                            sess.lastByteAt = performance.now();
                            lane.win.add(c);
                            if (onChunk() === false) { return; }
                        }
                        if (S === sess && lane.gen === g && lane.onEnd) { lane.onEnd(); }
                        return;
                    } catch (e) {
                        if (ac.signal.aborted || S !== sess || lane.gen !== g) { return; }
                        tries++;
                        R("下载出错（" + lane.name + "，第 " + tries + " 次）" + errStr(e) + "，" + Math.min(10, tries * 2) + " 秒后从 " + mb(lane.win.endOff) + " 接着取");
                        offset = lane.win.endOff;
                        await sleep(Math.min(10, tries * 2) * 1000);
                    }
                }
            })();
        }

        /* ---------- 找 moov ---------- */

        function findMoov(sess) {
            var main = sess.lanes[0];
            return new Promise(function (resolve, reject) {
                var pos = 0;
                function step() {
                    var win = main.win;
                    /* 开头是 EBML 魔数：MKV / WebM，交给 mkv.js（这一块已经在窗口里了，Mkv.readHead 先从这读） */
                    if (pos === 0 && win.has(0, 4) && typeof Mkv !== "undefined" && Mkv.sniff(win.read(0, 4))) {
                        main.onChunk = function () { return false; };
                        resolve({ mkvSniffed: true });
                        return false;
                    }
                    while (true) {
                        if (!win.has(pos, 8)) { return true; }
                        var hb = win.read(pos, Math.min(16, win.endOff - pos));
                        var h = Mp4.scanTop(hb, pos)[0] || null;
                        if (!h) { return true; }
                        if (h.type === "moov") {
                            if (!win.has(pos, h.size)) { return true; }
                            var atHead = !sess.sawMdat;
                            /* moov 在开头：这条流接着读下去就是 mdat —— 先只攒着，setup 换成 produce 之后再处理 */
                            main.onChunk = function () { return true; };
                            resolve({ start: pos, bytes: win.read(pos, h.size), atHead: atHead });
                            return atHead;
                        }
                        if (h.type === "mdat" || h.size === Infinity) {
                            if (h.size === Infinity) { reject(new Error(tx("mdat 一直到文件尾，没有 moov"))); return false; }
                            sess.sawMdat = true;
                            pos = h.start + h.size;
                            R("moov 不在开头，跳到 " + mb(pos) + " 去读");
                            startStream(main, pos, step);
                            return false;
                        }
                        if (h.type === "moof") { reject(new Error(tx("已经是分段 MP4（fragmented），还不支持"))); return false; }
                        /* 开头就不像盒子（AVI 的 RIFF、TS 的 0x47…）：别顺着乱七八糟的「大小」一路跳到文件尾 */
                        if (pos === 0 && (h.size < 8 || h.size > sess.source.size || !/^[\x20-\x7e]{4}$/.test(h.type))) {
                            reject(new Error(tx("不认识的文件格式（不是 MP4 也不是 MKV）")));
                            return false;
                        }
                        pos = h.start + h.size;
                        if (pos >= sess.source.size) { reject(new Error(tx("读到文件尾也没找到 moov"))); return false; }
                    }
                }
                main.onChunk = step;
                startStream(main, 0, function () { return main.onChunk(); });
            });
        }

        /* MKV 的头：先从主路已经读到的那块里取，取不到再单独读 */
        function headReader(sess) {
            return function (off, len) {
                var w = sess.lanes[0].win, n = Math.max(0, Math.min(len, sess.source.size - off));
                if (w.has(off, n)) { return Promise.resolve(w.read(off, n)); }
                return readRange(sess.source, off, len);
            };
        }

        /* ---------- 打开 ---------- */

        api.open = function (source, opts) {
            opts = opts || {};
            api.close();
            var sess = S = {
                source: source, opts: opts, lanes: [newLane("主", [])], repos: 0, tracks: [], bytes: 0, t0: performance.now(),
                ms: new MediaSource(), lastByteAt: performance.now(), duration: 0
            };
            state("loading");
            return new Promise(function (resolve, reject) {
                sess.ms.addEventListener("sourceopen", function () {
                    /* 缓存里有这部片的 moov（opts.moov = {start, bytes}）/ MKV 的头（{mkv}）就不用再下 —— 长片的 moov 有好几 MB，
                     * 电视上要 2.5–4 秒（2026-10-01 实测）。新取到的交给 opts.onMoov 存起来。 */
                    var cm = opts.moov, got = cm && cm.mkv ? Promise.resolve({ mkv: cm.mkv, cached: true }) :
                        cm ? Promise.resolve({ start: cm.start, bytes: cm.bytes, atHead: false, cached: true }) : findMoov(sess);
                    got.then(async function (m) {
                        if (S !== sess) { return; }
                        var tm = performance.now();
                        if (m.mkv || m.mkvSniffed) {
                            var info = m.mkv || await Mkv.readHead(headReader(sess), source.size);
                            if (S !== sess) { return; }
                            stopLane(sess.lanes[0]);
                            sess.moovMs = Math.round(performance.now() - sess.t0);
                            if (!m.cached && opts.onMoov) { try { opts.onMoov({ mkv: info }); } catch (e) {} }
                            setupMkv(sess, info, Math.round(performance.now() - tm), !!m.cached, opts);
                        } else {
                            sess.movie = Mp4.parseMoov(m.bytes);
                            var parseMs = Math.round(performance.now() - tm);
                            sess.moovMs = Math.round(tm - sess.t0);
                            if (!m.cached && opts.onMoov) { try { opts.onMoov({ start: m.start, bytes: m.bytes }); } catch (e) {} }
                            setup(sess, m, parseMs, opts);
                        }
                        if (opts.onTracks) { try { opts.onTracks(api.tracks()); } catch (e) {} }
                        watchFirstFrame(sess, resolve, reject);
                    }).catch(function (e) {
                        if (S !== sess) { return; }
                        R("打不开：" + errStr(e));
                        state("error", errStr(e));
                        reject(e);
                    });
                }, { once: true });
                sess.url = URL.createObjectURL(sess.ms);
                video.onerror = function () { if (S === sess) { fatal(); reject(new Error(tx("播放器出错"))); } };
                video.src = sess.url;
            });
        };

        /* 一条要进 SourceBuffer 的轨 */
        function addTrack(sess, tr, id) {
            var T = { tr: tr, id: id, sb: sess.ms.addSourceBuffer(tr.mime), q: [], qBytes: 0, ahead: 90, next: 0, seq: 1, pend: [], front: 0, inited: true };
            T.sb.addEventListener("updateend", function () {
                var r = T.removing;
                T.removing = null;
                if (!r) { T.nOk = (T.nOk || 0) + 1; }
                if (r && r.done) { r.done(); }
                pumpSb(T);
            });
            /* 进的是 init 段还是第几段、stsd 里有什么：APPEND_FAILED 只说「解析失败」，这两样分得开是文件头的事还是数据的事 */
            T.sb.addEventListener("error", function () { R("SourceBuffer error " + tr.mime + "（正在进 " + (T.cur || "?") + "，之前进成 " + (T.nOk || 0) + " 次；" + (tr.stsdNote || "") + "）"); });
            sess.tracks.push(T);
            return T;
        }

        function setup(sess, m, parseMs, opts) {
            var mv = sess.movie, v = null, notes = [], startAt = opts.startAt || 0;
            sess.fmt = "mp4";
            sess.duration = mv.duration;
            mv.tracks.forEach(function (tr) {
                var ok = !tr.unsupported && MediaSource.isTypeSupported(tr.mime);
                if (tr.kind === "video" && !v) { if (ok) { v = tr; } else { notes.push(tr.unsupported ? tx(tr.unsupported) : tx("视频 {0} 放不了", tr.codec)); } }
            });
            if (!v) { throw new Error(notes.join(tx("；")) || tx("没有视频轨")); }
            /* 音轨：tkhd 里 enabled 的那条是默认（多音轨的 MP4 只开一条） */
            sess.audios = mv.tracks.filter(function (tr) { return tr.kind === "audio"; }).map(function (tr) {
                var ok = !tr.unsupported && audioOk(tr);
                return { key: "a:" + tr.id, tr: tr, lang: tr.lang, name: tr.name, codec: tr.codec, channels: tr.channels, ok: ok,
                         why: ok ? "" : tr.unsupported ? tx(tr.unsupported) : tr.tvNo || tx("{0} 电视放不了", tr.codec), isDefault: tr.enabled };
            });
            var pick = pickAudio(sess.audios, opts.audio), a = pick ? pick.tr : null;
            sess.audioKey = pick ? pick.key : "";
            if (!a && sess.audios.length) { notes.push(tx("没有能放的音轨（{0}），没声音", sess.audios.map(function (x) { return x.why; }).join(tx("、")))); }
            addTrack(sess, v, VID);
            if (a) { addTrack(sess, a, AID); }
            /* 片子里的字幕轨（tx3g / wvtt） */
            sess.subT = mv.tracks.filter(function (tr) { return tr.kind === "sub" && !tr.unsupported && tr.n; }).map(function (tr) {
                var order = new Uint32Array(tr.n);
                for (var i = 0; i < tr.n; i++) { order[i] = i; }
                order.sort(function (x, y) { return tr.offset[x] - tr.offset[y]; });
                return { key: "s:" + tr.id, tr: tr, got: new Uint8Array(tr.n), order: order };
            });
            sess.ms.duration = mv.duration;
            sess.tracks.forEach(function (T) { T.q.push({ buf: Mp4.initSegment(T.tr, T.id), init: true }); pumpSb(T); });
            sess.moovDone = sess.ready = true;
            R("moov " + mb(m.bytes.length) + (m.cached ? "（缓存）" : m.atHead ? "（开头）" : "（文件尾）") + " " + sess.moovMs + "ms 到手，解析 " + parseMs + "ms：" +
              v.codec + " " + v.width + "x" + v.height + " " + v.n + " 帧 " + (v.keys ? v.keys.length : v.n) + " 关键帧 / " +
              (a ? a.codec + " " + a.channels + "ch " + a.rate + "Hz" : "无音频") + (sess.audios.length > 1 ? "（" + sess.audios.length + " 条音轨，用 " + sess.audioKey + "）" : "") +
              (sess.subT.length ? "，字幕轨 " + sess.subT.map(function (s) { return s.tr.codec + (s.tr.lang ? "/" + s.tr.lang : ""); }).join(" ") : "") +
              "，" + Math.round(mv.duration / 60) + " 分" + levelNote(v) + (notes.length ? " | " + notes.join("；") : ""));
            if (notes.length) { state("note", notes.join(tx("；"))); }
            subsUpfront(sess);
            if (a) {
                /* 同一时刻的音视频在文件里各在哪：隔得远的文件，跳转要读很多用不上的字节 */
                R("布局：" + [0, 60, 600, mv.duration / 2].filter(function (t) { return t < mv.duration; }).map(function (t) {
                    return "t=" + Math.round(t) + " 视频@" + mb(v.offset[Mp4.sampleAt(v, t)]) + " 音频@" + mb(a.offset[Mp4.sampleAt(a, t)]);
                }).join("，") + "；视频 chunk " + chunkInfo(v) + "，音频 chunk " + chunkInfo(a));
            }
            /* 分不分路：整部片上取 21 个时间点，同一时刻音视频在文件里最远隔多少 */
            var main = sess.lanes[0], split = false;
            if (a) {
                var far = 0;
                for (var i = 0; i <= 20; i++) {
                    var tt = mv.duration * i / 20;
                    far = Math.max(far, Math.abs(v.offset[Mp4.sampleAt(v, tt)] - a.offset[Mp4.sampleAt(a, tt)]));
                }
                split = far > SPLIT;
                if (split) { R("音视频在文件里最远隔 " + mb(far) + "，分两路读"); }
            }
            if (split) {
                stopLane(main);
                sess.lanes = [newLane("视频", [sess.tracks[0]]), newLane("音频", [sess.tracks[1]])];
            } else {
                main.tracks = sess.tracks.slice();
            }
            if (startAt > 1) {
                reposition(Mp4.keyAtOrBefore(v, Mp4.sampleAt(v, startAt)), "续播", opts.exact ? startAt : 0);
            } else if (m.atHead && !split) {
                /* moov 在开头：同一条读取流接着往下读就是 mdat，不用重开 */
                main.onChunk = function () { produce(main); };
                produce(main);
            } else {
                reposition(0, "从头");
            }
        }

        /* 整条字幕轨在文件里挤在一小段里（不跟音视频交错 —— 有的工具这么写）：开头单独读一次，全拿出来 */
        function subsUpfront(sess) {
            sess.subT.forEach(function (st) {
                var tr = st.tr, a = tr.offset[st.order[0]], l = st.order[tr.n - 1], e = tr.offset[l] + tr.size[l];
                if (e - a > 4 * 1048576) { return; }
                readRange(sess.source, a, e - a).then(function (b) {
                    if (S !== sess) { return; }
                    for (var i = 0; i < tr.n; i++) {
                        if (st.got[i]) { continue; }
                        st.got[i] = 1;
                        emitSub(sess, st, i, b.subarray(tr.offset[i] - a, tr.offset[i] - a + tr.size[i]));
                    }
                    R("字幕轨 " + st.key + " 在文件里挤在一起（" + mb(e - a) + "），一次读完 " + tr.n + " 条");
                }).catch(function (e) { R("字幕轨 " + st.key + " 读不出来：" + errStr(e)); });
            });
        }

        /* chunk 平均多长（秒）：样本在文件里连续的一段算一个 chunk */
        function chunkInfo(tr) {
            var n = 0;
            for (var i = 1; i < Math.min(tr.n, 5000); i++) { if (tr.offset[i] !== tr.offset[i - 1] + tr.size[i - 1]) { n++; } }
            var span = (tr.dts[Math.min(tr.n, 5000) - 1] - tr.dts[0]) / tr.timescale;
            return n ? (span / n).toFixed(2) + "s" : "整条连续";
        }

        /* 清空两条轨的缓冲，清完再挪播放头（到 t，exact 给了就到 exact）。反过来的话，Chrome 会先在旧缓冲里跳：旧缓冲里关键帧
         * 后面跟着它的前导帧（open GOP），参考的上一个 GOP 不在解码器里 → PIPELINE_ERROR_DECODE（桌面 x265 实测）。
         * t < 0：先不挪（MKV 按码率猜的位置，等第一个关键帧拆出来再定）。 */
        function clearAll(sess, t, why, exact) {
            var to = exact > t ? exact : t;
            var left = sess.tracks.length, g = ++sess.repos;
            sess.cleared = false;
            sess.startTo = t >= 0 ? to : undefined;
            var removed = function () {
                if (--left > 0 || S !== sess || sess.repos !== g) { return; }
                sess.cleared = true;
                if (sess.startTo !== undefined) { video.currentTime = Math.max(0, sess.startTo); }
            };
            sess.tracks.forEach(function (T) {
                T.q = T.q.filter(function (op) { return op.init; });      // 还没进去的 init 段留着
                T.qBytes = 0;
                T.q.push({ remove: [0, Infinity], done: removed });
                pumpSb(T);
            });
            sess.done = false;
            sess.seekAt = { t: performance.now(), to: Math.max(0, to), why: why };
        }

        /* 从视频第 k 帧（关键帧）开始重新读；音频从不晚于它的那一帧开始。 */
        function reposition(k, why, exact) {
            var sess = S, V = sess.tracks[0], A = sess.tracks[1];
            var t = Mp4.pts(V.tr, k);
            V.next = k;
            V.lead = true;
            if (A) { A.next = Mp4.sampleAt(A.tr, Math.max(0, t - 0.05)); }
            clearAll(sess, t, why, exact);
            var where = [];
            sess.lanes.forEach(function (lane) {
                var off = Math.min.apply(null, lane.tracks.map(function (T) { return T.tr.offset[T.next]; }));
                lane.onChunk = function () { produce(lane); };
                startStream(lane, off, function () { return lane.onChunk(); });
                where.push(lane.name + "路从 " + mb(off));
            });
            R(why + " → " + t.toFixed(1) + "s" + (exact > t ? "（停在 " + exact.toFixed(1) + "s）" : "") + "，" + where.join("，") + " 读");
        }

        function levelNote(v) {
            var f = v && v.levelFix, p = v && v.profileFix;
            return (p ? "，avcC 的 profile " + p.from + " → " + p.to + "（不是 H.264 有的值）" : "") +
                   (f ? "，H.264 级别 " + f.from + " → " + f.to + "（一帧 " + f.mbs + " 个宏块，原来那级不够）" : "");
        }

        /* ---------- MKV 的打开、跳转 ---------- */

        function setupMkv(sess, info, ms, cached, opts) {
            var v = null, notes = [], startAt = opts.startAt || 0;
            sess.fmt = "mkv";
            sess.info = info;
            sess.duration = info.duration;
            info.tracks.forEach(function (t) {
                if (t.kind !== "video" || v) { return; }
                if (!t.unsupported && MediaSource.isTypeSupported(t.mime)) { v = t; } else { notes.push(t.unsupported ? tx(t.unsupported) : tx("视频 {0} 放不了", t.codec || t.codecId)); }
            });
            if (!v) { throw new Error(notes.join(tx("；")) || tx("没有视频轨")); }
            sess.audios = info.tracks.filter(function (t) { return t.kind === "audio"; }).map(function (t) {
                var ok = !t.unsupported && !!t.mime && audioOk(t);
                return { key: "a:" + t.num, mk: t, lang: t.lang, name: t.name, codec: t.codec || t.codecId, channels: t.channels, ok: ok,
                         why: ok ? "" : t.unsupported ? tx(t.unsupported) : t.tvNo || tx("{0} 电视放不了", t.codec || t.codecId), isDefault: t.isDefault };
            });
            var pick = pickAudio(sess.audios, opts.audio), a = pick ? pick.mk : null;
            sess.audioKey = pick ? pick.key : "";
            if (!a && sess.audios.length) { notes.push(tx("没有能放的音轨（{0}），没声音", sess.audios.map(function (x) { return x.why; }).join(tx("、")))); }
            sess.subsInfo = info.tracks.filter(function (t) { return t.kind === "sub" && !t.unsupported; });
            function trOf(t) { return { kind: t.kind, timescale: info.timescale, stsd: t.stsd, width: t.width, height: t.height, codec: t.codec, mime: t.mime }; }
            var V = addTrack(sess, trOf(v), VID), A = a ? addTrack(sess, trOf(a), AID) : null;
            sess.ms.duration = info.duration;
            V.q.push({ buf: Mp4.initSegment(V.tr, VID), init: true });
            pumpSb(V);
            if (A) {
                A.inited = !!a.stsd;
                if (A.inited) { A.q.push({ buf: Mp4.initSegment(A.tr, AID), init: true }); pumpSb(A); }
            }
            sess.dmx = Mkv.demuxer(info, { video: v.num, audio: a ? a.num : 0, subs: sess.subsInfo.map(function (t) { return t.num; }) });
            /* 认出 MKV 时主路已经下了开头一块（readHead 也是从它读的）：从头放的话第一个 Cluster 多半就在里面，留着接着用，省一次请求 */
            var head = sess.lanes[0].win;
            sess.lanes[0] = newLane("主", sess.tracks.slice());
            sess.lanes[0].win = head;
            sess.moovDone = sess.ready = true;
            R("MKV 头" + (cached ? "（缓存）" : "") + " " + sess.moovMs + "ms 到手（读头和 Cues " + ms + "ms" + (info.reads ? "，" + info.reads + " 次请求" : "") + "）：" + v.codec + " " + v.width + "x" + v.height + " / " +
              (a ? a.codec + " " + a.channels + "ch " + a.rate + "Hz" : "无音频") + (sess.audios.length > 1 ? "（" + sess.audios.length + " 条音轨，用 " + sess.audioKey + "）" : "") +
              (sess.subsInfo.length ? "，字幕轨 " + sess.subsInfo.map(function (t) { return t.codecId + (t.lang ? "/" + t.lang : ""); }).join(" ") : "") +
              "，" + Math.round(info.duration / 60) + " 分，Cues " + (info.cues ? info.cues.t.length + " 个" : "没有") + levelNote(v) +
              (notes.length ? " | " + notes.join("；") : ""));
            if (notes.length) { state("note", notes.join(tx("；"))); }
            if (startAt > 1) { repositionMkv(sess, cueOrGuess(sess, startAt, 0), "续播", opts.exact ? startAt : 0); }
            else { repositionMkv(sess, { t: 0, pos: info.firstCluster }, "从头"); }
        }

        function cueOrGuess(sess, sec, dir) {
            var info = sess.info, c = dir ? Mkv.cueNear(info, sec, dir, video.currentTime) : Mkv.cueAt(info, sec);
            return c || { t: sec, pos: Mkv.guessOffset(info, sec, sess.source.size), resync: true };
        }

        function repositionMkv(sess, c, why, exact) {
            var lane = sess.lanes[0];
            sess.dmx.reset(c.pos, c.t, !!c.resync);
            sess.dmxDone = false;
            sess.tracks.forEach(function (T) { T.pend = []; T.front = c.t; });
            sess.needStart = !!c.resync;
            sess.alignPending = !c.resync && !(exact > c.t);       // 按码率猜的位置有 needStart；停在指定那一秒（换音轨）的不挪
            sess.alignV = sess.alignA = undefined;
            clearAll(sess, c.resync ? -1 : c.t, why, exact);
            if (c.resync) { sess.seekAt.to = c.t; }
            lane.onChunk = function () { produce(lane); };
            lane.onEnd = function () { endMkv(sess, lane); };
            var keep = lane.win.startOff <= c.pos && c.pos < lane.win.endOff && lane.win.endOff % CH === 0;
            if (!keep) { lane.win.reset(c.pos); }
            startStream(lane, keep ? lane.win.endOff : c.pos, function () { return lane.onChunk(); }, keep);
            if (keep) { produce(lane); }
            R(why + " → " + c.t.toFixed(1) + "s" + (exact > c.t ? "（停在 " + exact.toFixed(1) + "s）" : "") + "，从 " + mb(c.pos) + " 读" + (c.resync ? "（没有 Cues，按码率猜的）" : ""));
        }

        function watchFirstFrame(sess, resolve, reject) {
            var started = false;
            var tick = setInterval(function () {
                if (S !== sess) { clearInterval(tick); return; }
                if (!started && video.readyState >= 2) {
                    started = true;
                    video.play().catch(function (e) { R("play() " + errStr(e)); });
                }
                /* 开头的空档：两条轨的缓冲（交集）从播放头后面一点才开始，readyState 到不了 2、永远不出画面（三星的 MSE 不跨空档；
                 * 播放中的 monitor 会跳，这时还没有 monitor）。交集攒够半秒再跳，一次跳到它开头 */
                if (!started && sess.cleared && video.readyState < 2) {
                    var b = video.buffered, ct = video.currentTime;
                    if (b.length && b.start(0) > ct + 0.001 && b.start(0) - ct < 6 && b.end(0) - b.start(0) > 0.5) {
                        R("开头空档 " + ct.toFixed(3) + " → " + b.start(0).toFixed(3) + "，跳过去（各轨 " + api.debug() + "）");
                        if (sess.seekAt) { sess.seekAt.to = b.start(0); }
                        video.currentTime = b.start(0) + 0.001;
                    }
                }
                var base = sess.seekAt ? sess.seekAt.to : 0;
                if (started && !video.paused && video.currentTime > base + 0.04 && video.currentTime < base + 5) {
                    clearInterval(tick);
                    sess.firstFrameMs = Math.round(performance.now() - sess.t0);
                    R("到画面 " + sess.firstFrameMs + "ms（第一块 " + sess.firstChunkMs + "ms，" + (sess.fmt === "mkv" ? "MKV 头" : "moov") + " 到手 " + sess.moovMs + "ms，取了 " + mb(sess.bytes) + "）" +
                      video.videoWidth + "x" + video.videoHeight);
                    sess.seekAt = null;
                    state("playing");
                    resolve();
                    monitor(sess);
                    var from = video.currentTime;
                    if (tallVideo(sess) && !tallOk()) {
                        setTimeout(function () {
                            if (S === sess && !sess.dead && video.currentTime > from + 2) {
                                try { localStorage.setItem(TALL_KEY, "1"); } catch (e) {}
                                R("高 " + tallVideo(sess).height + " 的 H.264 放成了：这台电视解得了");
                            }
                        }, 4000);
                    }
                }
                if (performance.now() - sess.t0 > 90000) {
                    clearInterval(tick);
                    /* 放弃了就别再取：2026-10-23 放弃之后下载还在每 10 秒重试一次，直到观众离开这个视频。 */
                    sess.lanes.forEach(stopLane);
                    /* 放弃时把现场都写下来：电视上没有调试器，下一次只能靠这一行（2026-10-26 印度那台的日志里只有一句「放弃」） */
                    R("90 秒没出画面，放弃：readyState " + video.readyState + "，" + (video.paused ? "暂停" : "在放") + "，t=" + video.currentTime.toFixed(3) +
                      "，各轨 " + api.debug() + "，收了 " + mb(sess.bytes) + "，最后一个字节 " + Math.round((performance.now() - (sess.lastByteAt || sess.t0)) / 1000) + " 秒前，" +
                      "队列 " + sess.tracks.map(function (T) { return T.tr.kind + " " + T.q.length + " 段"; }).join(" / ") + (sess.fmt === "mkv" ? "，起点 " + sess.startTo : ""));
                    state("error", tx("90 秒没出画面"));
                    reject(new Error("timeout"));
                }
            }, 20);
        }

        /* ---------- 跳转 ---------- */

        api.seek = function (sec, dir) {
            var sess = S;
            if (!sess || !sess.ready) { return; }
            sess.endSent = false;
            sec = Math.max(0, Math.min(sec, sess.duration - 3));
            var b = video.buffered, fr = frontier(), i;
            if (sess.fmt === "mkv") {
                var c = cueOrGuess(sess, sec, dir);
                /* 缓冲内跳转只在没见过 open GOP 的片子上做（理由同下） */
                for (i = 0; i < b.length && !c.resync && !sess.dmx.openGop; i++) {
                    if (b.start(i) <= c.t + 0.05 && b.end(i) > c.t + 0.5 && b.end(i) >= fr - 2) {
                        sess.seekAt = { t: performance.now(), to: c.t, why: "缓冲内跳转" };
                        video.currentTime = Math.max(c.t, b.start(i));
                        R("缓冲内跳转 → " + c.t.toFixed(1) + "s");
                        return;
                    }
                }
                repositionMkv(sess, c, dir > 0 ? "快进" : dir < 0 ? "快退" : "跳转");
                return;
            }
            var V = sess.tracks[0], tr = V.tr;
            var k = dir ? Mp4.keyNear(tr, sec, dir, video.currentTime) : Mp4.keyAtOrBefore(tr, Mp4.sampleAt(tr, sec));
            var t = Mp4.pts(tr, k);
            /* 目标在正在生产的那段缓冲里：只改播放头。关键帧带前导帧（open GOP）时不行 —— 缓冲里前导帧都在，
             * 从这个关键帧开始解它们就是错的，只能重新取、在 produce 里把前导帧丢掉。 */
            for (i = 0; i < b.length && Mp4.afterLeading(tr, k) === k + 1; i++) {
                if (b.start(i) <= t + 0.05 && b.end(i) > t + 0.5 && b.end(i) >= fr - 2) {
                    sess.seekAt = { t: performance.now(), to: t, why: "缓冲内跳转" };
                    video.currentTime = Math.max(t, b.start(i));
                    R("缓冲内跳转 → " + t.toFixed(1) + "s");
                    return;
                }
            }
            reposition(k, dir > 0 ? "快进" : dir < 0 ? "快退" : "跳转");
        };

        /* 从当前位置重读（停在原处）：中途换到一条图形字幕时，前面预读过的那一分钟里它的块已经扔了（app.js 只存正在显示的那条） */
        api.refetch = function (why) {
            var sess = S, t = video.currentTime;
            if (!sess || !sess.ready) { return; }
            if (sess.fmt === "mkv") { repositionMkv(sess, cueOrGuess(sess, t, 0), why || "重读", t); return; }
            reposition(Mp4.keyAtOrBefore(sess.tracks[0].tr, Mp4.sampleAt(sess.tracks[0].tr, t)), why || "重读", t);
        };

        /* 从 t 之前的关键帧重开（卡住时） */
        function restartAt(sess, t, why) {
            if (sess.fmt === "mkv") { repositionMkv(sess, cueOrGuess(sess, t, 0), why); return; }
            reposition(Mp4.keyAtOrBefore(sess.tracks[0].tr, Mp4.sampleAt(sess.tracks[0].tr, t)), why);
        }

        /* ---------- 监视：卡顿、出画面、空档、回收 ---------- */

        function monitor(sess) {
            var lastT = -1, stuckAt = 0, stalls = 0, lastLine = performance.now(), lastBytes = sess.bytes, lastEvict = 0;
            sess.mon = setInterval(function () {
                if (S !== sess) { clearInterval(sess.mon); return; }
                var t = video.currentTime, now = performance.now();
                /* 播放头要落在目标之后 5 秒内才算：清旧缓冲那几十毫秒里 currentTime 还停在原处（往回跳时它比目标大） */
                if (sess.seekAt && !video.paused && t > sess.seekAt.to + 0.04 && t < sess.seekAt.to + 5) {
                    R(sess.seekAt.why + " 出画面 " + Math.round(now - sess.seekAt.t) + "ms" + (sess.leadSkipped ? "（丢了 " + sess.leadSkipped + " 个前导帧）" : ""));
                    sess.seekAt = null;
                    sess.leadSkipped = 0;
                    state("playing");
                }
                /* 保险：播放头前面 3 秒内有缓冲、自己不在缓冲里 → 跳过去。真触发了说明还有空档来源，别当正常。 */
                if (!video.paused && video.readyState < 3) {
                    var b = video.buffered;
                    for (var i = 0; i < b.length; i++) {
                        if (b.start(i) > t && b.start(i) - t < 3) {
                            R("跳过空档 " + t.toFixed(2) + " → " + b.start(i).toFixed(2));
                            video.currentTime = b.start(i) + 0.02;
                            break;
                        }
                    }
                }
                if (!video.paused && !video.ended) {
                    if (t === lastT) {
                        if (!stuckAt) { stuckAt = now; }
                        if (now - stuckAt > 1000 && !sess.endSent) { state("buffering"); }
                        /* 整部片都取完了、离结尾不到一秒却不动：MKV 最后一帧视频比音频早结束几十毫秒，endOfStream 之后桌面 Chrome 停在
                         * 视频最后一帧上、ended 一直不来（2026-10-26 桌面引擎测试，MKV 一部部都是「播完=false」，MP4 没事）。
                         * 不当放完，「下一集」就等不来。 */
                        if (sess.done && !sess.endSent && now - stuckAt > 1500 && sess.duration - t < 1) {
                            sess.endSent = true;
                            R("结尾停在 " + t.toFixed(2) + "（时长 " + sess.duration.toFixed(2) + "，各轨 " + api.debug() + "），当放完了");
                            state("ended");
                        }
                        /* 卡住 20 秒、这段时间一个字节都没来 → 从当前位置重开读取 */
                        if (now - stuckAt > 20000 && now - sess.lastByteAt > 20000) {
                            R("卡了 20 秒、字节也停了，从 " + t.toFixed(1) + "s 重开");
                            stuckAt = now;
                            restartAt(sess, t, "重开");
                        }
                    } else if (stuckAt) {
                        var d = now - stuckAt;
                        if (d > 1000 && !sess.seekAt) { stalls++; R("卡了 " + (d / 1000).toFixed(1) + "s @" + t.toFixed(1) + "（第 " + stalls + " 次）"); }
                        stuckAt = 0;
                        state("playing");
                    }
                }
                lastT = t;
                if (now - lastEvict > 5000) { lastEvict = now; evict(BEHIND); }
                if (now - lastLine > 30000) {
                    var dt = (now - lastLine) / 1000;
                    R("状态 t=" + t.toFixed(0) + "/" + sess.duration.toFixed(0) + " 前方 " + (frontier() - t).toFixed(0) + "s 下载 " +
                      ((sess.bytes - lastBytes) / 1048576 / dt).toFixed(2) + "MB/s 窗口 " + mb(sess.lanes.reduce(function (n, l) { return n + l.win.total; }, 0)) + "（" + sess.lanes.length + " 路）卡顿 " + stalls);
                    lastLine = now;
                    lastBytes = sess.bytes;
                }
            }, 20);
            video.onended = function () { if (S === sess && !sess.endSent) { sess.endSent = true; state("ended"); } };
        }

        /* ---------- 其他 ---------- */

        api.close = function () {
            if (!S) { return; }
            var sess = S;
            S = null;
            sess.lanes.forEach(stopLane);
            clearInterval(sess.mon);
            video.onended = null;
            video.onerror = null;
            try { video.pause(); } catch (e) {}
            video.removeAttribute("src");
            try { video.load(); } catch (e) {}
            if (sess.url) { URL.revokeObjectURL(sess.url); }
        };
        /* play() 被随后的 pause() 打断会抛一个没人接的 Promise 异常（电视日志里出现过），吞掉 */
        api.toggle = function () { if (video.paused) { video.play().catch(function () {}); } else { video.pause(); } return !video.paused; };
        api.paused = function () { return video.paused; };
        api.time = function () { return video.currentTime; };
        api.duration = function () { return S && S.ready ? S.duration : 0; };
        api.info = function () { return S && S.ready ? S.tracks[0].tr : null; };
        /* 音轨和字幕轨（app 的菜单用） */
        api.tracks = function () {
            if (!S || !S.ready) { return { fmt: "", audio: [], subs: [] }; }
            var sess = S;
            return {
                fmt: sess.fmt,
                audio: (sess.audios || []).map(function (a) {
                    return { key: a.key, lang: a.lang, name: a.name, codec: a.codec, channels: a.channels, ok: a.ok, why: a.why, current: a.key === sess.audioKey };
                }),
                subs: sess.fmt === "mkv" ? sess.subsInfo.map(function (t) {
                    return { key: "s:" + t.num, lang: t.lang, name: t.name, codec: t.codecId, codecPrivate: t.codecPrivate, isDefault: t.isDefault, isForced: t.isForced };
                }) : (sess.subT || []).map(function (st) {
                    return { key: st.key, lang: st.tr.lang, name: st.tr.name, codec: st.tr.codec, codecPrivate: null, isDefault: st.tr.enabled, isForced: false };
                })
            };
        };
        /* 每个 SourceBuffer 的缓冲区间（音视频分开看，video.buffered 是交集） */
        api.debug = function () {
            return S ? S.tracks.map(function (T) {
                var b = T.sb.buffered, s = [];
                for (var i = 0; i < b.length; i++) { s.push(b.start(i).toFixed(3) + "-" + b.end(i).toFixed(3)); }
                return T.tr.kind + "[" + s.join(" ") + "]";
            }).join(" ") : "";
        };
        return api;
    }

    return { create: create, CH: CH, readRange: readRange };
})();
