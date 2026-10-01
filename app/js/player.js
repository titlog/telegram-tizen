/* 播放引擎：一个 <video> + 每部片一个 MediaSource，音视频各一个 SourceBuffer。
 *
 * 数据源只要会一件事：stream(offset, signal, throttle) → {start, iter}，从 start（≤ offset，按 512KB 对齐）起
 * 按顺序吐 Uint8Array。Telegram（tg.js）和 HTTP Range（桌面测试台）各一个实现。
 *
 * 流程：从头读 → 找到 moov（在尾部就跳过去读）→ Mp4.parseMoov → 按样本在文件里的位置顺序读，读到哪条轨的样本
 * 就拼成 ~1 秒的 moof+mdat 塞进它的 SourceBuffer。跳转 = 换个偏移重新读（目标已经在缓冲里就只改 currentTime）。
 *
 * 「路」（lane）：一路 = 一个从某个偏移顺序往下读的下载 + 它自己的字节窗口。普通文件一路（音视频一起读）。
 * 音视频在文件里隔得远的文件（《黑鹰坠落》4K：10 分钟处视频在 381MB、音频在 51MB，越往后隔得越远）拆成两路，
 * 各读各的位置 —— 一路的话从 6:35 续播要先读过 176MB、60 秒才出画面（2026-10-01 电视实测），播放中音频也越跑越前。
 *
 *   var p = Player.create(videoEl, report, onState)
 *   p.open(source, {startAt})   → Promise（出画面时 resolve）
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

    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }
    function sleep(t) { return new Promise(function (r) { setTimeout(r, t); }); }
    function errStr(e) { return (e && (e.message || e.text || e.name)) || String(e); }

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

    function create(video, report, onState) {
        var R = function (s) { report && report(s); };
        var S = null;          // 当前这部片的会话
        var api = {};

        var lastPhase = "";
        function state(phase, msg) {
            if (phase === lastPhase && !msg) { return; }
            lastPhase = phase;
            if (onState) { try { onState(phase, msg); } catch (e) {} }
        }

        /* ---------- SourceBuffer 队列 ---------- */

        function pumpSb(T) {
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
                else { T.sb.appendBuffer(op.buf); T.full = false; if (op.t !== undefined) { T.lastT = op.t; } }
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
            var msg = "播放器出错 code=" + (e ? e.code : "?") + " " + (e && e.message ? e.message : "") + " @" + video.currentTime.toFixed(2);
            R(msg);
            S.lanes.forEach(stopLane);
            S.tracks.forEach(function (T) { T.q.length = 0; });
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
            var f = S.movie.duration;
            (lane ? lane.tracks : S.tracks).forEach(function (T) { if (T.next < T.tr.n) { f = Math.min(f, Mp4.pts(T.tr, T.next)); } });
            return f;
        }

        var prodMax = 0, prodSum = 0;
        function produce(lane) {
            var t0 = performance.now();
            produceInner(lane);
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
                    var frag = Mp4.fragment(tr, list, T.seq++, function (d, o, off, n) { win.copy(d, o, off, n); });
                    T.q.push({ buf: frag, t: Mp4.pts(tr, list[0]) });
                    T.qBytes += frag.length;
                    T.next = e;
                    pumpSb(T);
                }
            });
            var need = Infinity;
            lane.tracks.forEach(function (T) { if (T.next < T.tr.n) { need = Math.min(need, T.tr.offset[T.next]); } });
            win.release(need === Infinity ? win.endOff : need);
            if (win.total > WIN_WARN && !S.warnedWin) {
                S.warnedWin = true;
                R("窗口里攒了 " + mb(win.total) + "（" + lane.name + "）：音视频在文件里隔得很远（交错差）");
            }
            if (S.tracks.every(function (T) { return T.next >= T.tr.n; })) { finish(); }
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

        /* 这一路从 offset 开始读。onChunk 返回 false 就停（跳去别处）。出错自动重试。 */
        function startStream(lane, offset, onChunk) {
            var sess = S, g = ++lane.gen;
            if (lane.ac) { lane.ac.abort(); }
            var ac = lane.ac = new AbortController();
            (async function () {
                var tries = 0;
                while (S === sess && lane.gen === g) {
                    var st = sess.source.stream(offset, ac.signal, function () { return gate(sess, lane, g); });
                    /* 重试时从窗口末尾接着读，窗口里还没用掉的字节留着（对得上才留：起点按 512KB 对齐） */
                    if (!tries || st.start !== lane.win.endOff) { lane.win.reset(st.start); }
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
                            if (h.size === Infinity) { reject(new Error("mdat 一直到文件尾，没有 moov")); return false; }
                            sess.sawMdat = true;
                            pos = h.start + h.size;
                            R("moov 不在开头，跳到 " + mb(pos) + " 去读");
                            startStream(main, pos, step);
                            return false;
                        }
                        if (h.type === "moof") { reject(new Error("已经是分段 MP4（fragmented），还不支持")); return false; }
                        pos = h.start + h.size;
                        if (pos >= sess.source.size) { reject(new Error("读到文件尾也没找到 moov")); return false; }
                    }
                }
                main.onChunk = step;
                startStream(main, 0, function () { return main.onChunk(); });
            });
        }

        /* ---------- 打开 ---------- */

        api.open = function (source, opts) {
            opts = opts || {};
            api.close();
            var sess = S = {
                source: source, lanes: [newLane("主", [])], repos: 0, tracks: [], bytes: 0, t0: performance.now(),
                ms: new MediaSource(), lastByteAt: performance.now()
            };
            state("loading");
            return new Promise(function (resolve, reject) {
                sess.ms.addEventListener("sourceopen", function () {
                    /* 缓存里有这部片的 moov（opts.moov = {start, bytes}）就不用再下 —— 长片的 moov 有好几 MB，
                     * 电视上要 2.5–4 秒（2026-10-01 实测）。新取到的交给 opts.onMoov 存起来。 */
                    var got = opts.moov ? Promise.resolve({ start: opts.moov.start, bytes: opts.moov.bytes, atHead: false, cached: true }) : findMoov(sess);
                    got.then(function (m) {
                        if (S !== sess) { return; }
                        var tm = performance.now();
                        sess.movie = Mp4.parseMoov(m.bytes);
                        var parseMs = Math.round(performance.now() - tm);
                        sess.moovMs = Math.round(tm - sess.t0);
                        if (!m.cached && opts.onMoov) { try { opts.onMoov({ start: m.start, bytes: m.bytes }); } catch (e) {} }
                        setup(sess, m, parseMs, opts.startAt || 0);
                        watchFirstFrame(sess, resolve, reject);
                    }).catch(function (e) {
                        if (S !== sess) { return; }
                        R("打不开：" + errStr(e));
                        state("error", errStr(e));
                        reject(e);
                    });
                }, { once: true });
                sess.url = URL.createObjectURL(sess.ms);
                video.onerror = function () { if (S === sess) { fatal(); reject(new Error("播放器出错")); } };
                video.src = sess.url;
            });
        };

        function setup(sess, m, parseMs, startAt) {
            var mv = sess.movie, v = null, a = null, notes = [];
            mv.tracks.forEach(function (tr) {
                var ok = !tr.unsupported && MediaSource.isTypeSupported(tr.mime);
                if (tr.kind === "video" && !v) { if (ok) { v = tr; } else { notes.push("视频 " + (tr.unsupported || tr.codec) + " 放不了"); } }
                if (tr.kind === "audio" && !a) { if (ok) { a = tr; } else { notes.push("音频 " + (tr.unsupported || tr.codec) + " 放不了，没声音"); } }
            });
            if (!v) { throw new Error(notes.join("；") || "没有视频轨"); }
            [v, a].forEach(function (tr) {
                if (!tr) { return; }
                var T = { tr: tr, sb: sess.ms.addSourceBuffer(tr.mime), q: [], qBytes: 0, ahead: 90, next: 0, seq: 1 };
                T.sb.addEventListener("updateend", function () {
                    var r = T.removing;
                    T.removing = null;
                    if (r && r.done) { r.done(); }
                    pumpSb(T);
                });
                T.sb.addEventListener("error", function () { R("SourceBuffer error " + tr.mime); });
                sess.tracks.push(T);
            });
            sess.ms.duration = mv.duration;
            sess.tracks.forEach(function (T) { T.q.push({ buf: Mp4.initSegment(T.tr), init: true }); pumpSb(T); });
            sess.moovDone = true;
            R("moov " + mb(m.bytes.length) + (m.cached ? "（缓存）" : m.atHead ? "（开头）" : "（文件尾）") + " " + sess.moovMs + "ms 到手，解析 " + parseMs + "ms：" +
              v.codec + " " + v.width + "x" + v.height + " " + v.n + " 帧 " + (v.keys ? v.keys.length : v.n) + " 关键帧 / " +
              (a ? a.codec + " " + a.channels + "ch " + a.rate + "Hz" : "无音频") + "，" + Math.round(mv.duration / 60) + " 分" +
              (notes.length ? " | " + notes.join("；") : ""));
            if (notes.length) { state("note", notes.join("；")); }
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
                reposition(Mp4.keyAtOrBefore(v, Mp4.sampleAt(v, startAt)), "续播");
            } else if (m.atHead && !split) {
                /* moov 在开头：同一条读取流接着往下读就是 mdat，不用重开 */
                main.onChunk = function () { produce(main); };
                produce(main);
            } else {
                reposition(0, "从头");
            }
        }

        /* chunk 平均多长（秒）：样本在文件里连续的一段算一个 chunk */
        function chunkInfo(tr) {
            var n = 0;
            for (var i = 1; i < Math.min(tr.n, 5000); i++) { if (tr.offset[i] !== tr.offset[i - 1] + tr.size[i - 1]) { n++; } }
            var span = (tr.dts[Math.min(tr.n, 5000) - 1] - tr.dts[0]) / tr.timescale;
            return n ? (span / n).toFixed(2) + "s" : "整条连续";
        }

        /* 从视频第 k 帧（关键帧）开始重新读；音频从不晚于它的那一帧开始。 */
        function reposition(k, why) {
            var sess = S, V = sess.tracks[0], A = sess.tracks[1];
            var t = Mp4.pts(V.tr, k);
            V.next = k;
            V.lead = true;
            if (A) { A.next = Mp4.sampleAt(A.tr, Math.max(0, t - 0.05)); }
            /* 先清空旧缓冲、清完再挪播放头。反过来的话，Chrome 会先在旧缓冲里跳：旧缓冲里关键帧后面跟着它的前导帧
             * （open GOP），参考的上一个 GOP 不在解码器里 → PIPELINE_ERROR_DECODE（桌面 x265 实测）。 */
            var left = sess.tracks.length, g = ++sess.repos;
            var removed = function () { if (--left === 0 && S === sess && sess.repos === g) { video.currentTime = Math.max(0, t); } };
            sess.tracks.forEach(function (T) {
                T.q = T.q.filter(function (op) { return op.init; });      // 还没进去的 init 段留着
                T.qBytes = 0;
                T.q.push({ remove: [0, Infinity], done: removed });
                pumpSb(T);
            });
            sess.done = false;
            sess.seekAt = { t: performance.now(), to: t, why: why };
            var where = [];
            sess.lanes.forEach(function (lane) {
                var off = Math.min.apply(null, lane.tracks.map(function (T) { return T.tr.offset[T.next]; }));
                lane.onChunk = function () { produce(lane); };
                startStream(lane, off, function () { return lane.onChunk(); });
                where.push(lane.name + "路从 " + mb(off));
            });
            R(why + " → " + t.toFixed(1) + "s，" + where.join("，") + " 读");
        }

        function watchFirstFrame(sess, resolve, reject) {
            var started = false;
            var tick = setInterval(function () {
                if (S !== sess) { clearInterval(tick); return; }
                if (!started && video.readyState >= 2) {
                    started = true;
                    video.play().catch(function (e) { R("play() " + errStr(e)); });
                }
                var base = sess.seekAt ? sess.seekAt.to : 0;
                if (started && !video.paused && video.currentTime > base + 0.04 && video.currentTime < base + 5) {
                    clearInterval(tick);
                    sess.firstFrameMs = Math.round(performance.now() - sess.t0);
                    R("到画面 " + sess.firstFrameMs + "ms（第一块 " + sess.firstChunkMs + "ms，moov 到手 " + sess.moovMs + "ms，取了 " + mb(sess.bytes) + "）" +
                      video.videoWidth + "x" + video.videoHeight);
                    sess.seekAt = null;
                    state("playing");
                    resolve();
                    monitor(sess);
                }
                if (performance.now() - sess.t0 > 90000) {
                    clearInterval(tick);
                    R("90 秒没出画面，放弃");
                    state("error", "90 秒没出画面");
                    reject(new Error("timeout"));
                }
            }, 20);
        }

        /* ---------- 跳转 ---------- */

        api.seek = function (sec, dir) {
            var sess = S;
            if (!sess || !sess.movie) { return; }
            var V = sess.tracks[0], tr = V.tr;
            sec = Math.max(0, Math.min(sec, sess.movie.duration - 3));
            var k = dir ? Mp4.keyNear(tr, sec, dir, video.currentTime) : Mp4.keyAtOrBefore(tr, Mp4.sampleAt(tr, sec));
            var t = Mp4.pts(tr, k);
            /* 目标在正在生产的那段缓冲里：只改播放头。关键帧带前导帧（open GOP）时不行 —— 缓冲里前导帧都在，
             * 从这个关键帧开始解它们就是错的，只能重新取、在 produce 里把前导帧丢掉。 */
            var b = video.buffered, fr = frontier();
            for (var i = 0; i < b.length && Mp4.afterLeading(tr, k) === k + 1; i++) {
                if (b.start(i) <= t + 0.05 && b.end(i) > t + 0.5 && b.end(i) >= fr - 2) {
                    sess.seekAt = { t: performance.now(), to: t, why: "缓冲内跳转" };
                    video.currentTime = Math.max(t, b.start(i));
                    R("缓冲内跳转 → " + t.toFixed(1) + "s");
                    return;
                }
            }
            reposition(k, dir > 0 ? "快进" : dir < 0 ? "快退" : "跳转");
        };

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
                        if (now - stuckAt > 1000) { state("buffering"); }
                        /* 卡住 20 秒、这段时间一个字节都没来 → 从当前位置重开读取 */
                        if (now - stuckAt > 20000 && now - sess.lastByteAt > 20000) {
                            R("卡了 20 秒、字节也停了，从 " + t.toFixed(1) + "s 重开");
                            stuckAt = now;
                            reposition(Mp4.keyAtOrBefore(sess.tracks[0].tr, Mp4.sampleAt(sess.tracks[0].tr, t)), "重开");
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
                    R("状态 t=" + t.toFixed(0) + "/" + sess.movie.duration.toFixed(0) + " 前方 " + (frontier() - t).toFixed(0) + "s 下载 " +
                      ((sess.bytes - lastBytes) / 1048576 / dt).toFixed(2) + "MB/s 窗口 " + mb(sess.lanes.reduce(function (n, l) { return n + l.win.total; }, 0)) + "（" + sess.lanes.length + " 路）卡顿 " + stalls);
                    lastLine = now;
                    lastBytes = sess.bytes;
                }
            }, 20);
            video.onended = function () { if (S === sess) { state("ended"); } };
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
        api.duration = function () { return S && S.movie ? S.movie.duration : 0; };
        api.info = function () { return S && S.movie ? S.tracks[0].tr : null; };
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

    return { create: create, CH: CH };
})();
