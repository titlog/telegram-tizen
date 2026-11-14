/* 音乐（issue #3「Telegram Music」，2026-10-26）：整首下下来、做成 blob: 地址交给 <audio>。
 * 为什么不边下边放：电视自己的播放器放网上的 MP4 会出错（video.src，见 CLAUDE.md「archive.org 规则」），而 deploy.sh --music 在电视上
 * 量过：MP3 / M4A / Opus / WAV 做成 blob 给 <audio> 都放得了、跳得动（下载完 0.5 秒出声）。一首 MP3 几 MB，按 Telegram ~2MB/s
 * 几秒；放着这首就把下一首下好，切歌不用等。内存里最多留 3 首（这首、下一首、上一首）。
 * FLAC 电视解不了（<audio>、MP4、MSE 都试过），app 下的时候交给 flac.js 边下边解成 WAV（stage "decode" 是在等它解完）。
 * 别的放起来不报错、一直不走的，12 秒不走就当放不了，3 秒后放下一首。
 *
 *   var m = Music.create(audio元素, { report, onState(phase, info), load(item, onProgress(got, total, stage), signal) → Promise<Blob> })
 *   m.play(list, i)   从 list 的第 i 首放起，放完一首接下一首
 *   m.next() / m.prev() / m.toggle() / m.seek(秒) / m.stop()
 *   m.current() / m.index() / m.list() / m.time() / m.duration() / m.paused()
 *   onState："track" {item, index}（换了一首）、"loading" {got, total, stage}、"playing"、"paused"、"error" {msg}、"done"（整串放完）
 */
var Music = (function () {
    "use strict";
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };
    var MIME = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav" };
    var KEEP = 3, STUCK_MS = 12000, SKIP_MS = 3000, MAX_FAILS = 5;

    function errStr(e) { return (e && (e.message || e.name)) || String(e); }
    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }

    /* WAV 里的 16 位 PCM（flac.js 拼的就是这种）：{ ch, rate, pcm: Int16Array（交错） }，不是这种就 null */
    function wavPcm(ab) {
        var dv = new DataView(ab), o = 12, fmt = null, data = null;
        if (dv.byteLength < 44 || dv.getUint32(0) !== 0x52494646 || dv.getUint32(8) !== 0x57415645) { return null; }
        while (o + 8 <= dv.byteLength) {
            var id = dv.getUint32(o), size = dv.getUint32(o + 4, true);
            if (id === 0x666d7420) { fmt = { tag: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) }; }
            else if (id === 0x64617461) { data = { p: o + 8, n: Math.min(size, dv.byteLength - o - 8) }; break; }
            o += 8 + size + (size & 1);
        }
        if (!fmt || !data || fmt.bits !== 16 || !fmt.ch || (fmt.tag !== 1 && fmt.tag !== 0xFFFE)) { return null; }
        var n = (data.n >> 1) - ((data.n >> 1) % fmt.ch);
        return { ch: fmt.ch, rate: fmt.rate, pcm: data.p % 2 ? new Int16Array(ab.slice(data.p, data.p + n * 2)) : new Int16Array(ab, data.p, n) };
    }

    /* <audio> 不收的大 WAV 用 Web Audio 自己放。11-13 越南一台 Tizen 6.0 连着三首 FLAC 解成 42–52 MB 的 WAV 都是
     * Format error（canPlayType=maybe），放成过的 WAV 都在 16 MB 以下 —— 像是 blob 太大。PCM 一直是那份 Int16Array，
     * 每次只把前面几秒变成 AudioBuffer，首尾相接排在 AudioContext 的时间轴上（无缝）；暂停 = suspend，跳转 = 停掉从那里重排 */
    function pcmPlayer(w, onEnd) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctx(), SEC = 5, frames = w.pcm.length / w.ch, dur = frames / w.rate;
        var srcs = [], startCtx = 0, startPos = 0, nextPos = 0, nextAt = 0, paused = false, done = false, timer = 0, started = false;
        function chunk(pos) {
            var f0 = Math.floor(pos * w.rate), f1 = Math.min(frames, f0 + SEC * w.rate), b = ctx.createBuffer(w.ch, f1 - f0, w.rate);
            for (var c = 0; c < w.ch; c++) {
                var d = b.getChannelData(c);
                for (var i = 0, j = f0 * w.ch + c; i < d.length; i++, j += w.ch) { d[i] = w.pcm[j] / 32768; }
            }
            return b;
        }
        function pump() {
            if (done || paused) { return; }
            while (nextPos < dur - 0.001 && nextAt - ctx.currentTime < SEC * 1.5) {
                var b = chunk(nextPos), s = ctx.createBufferSource();
                s.buffer = b;
                s.connect(ctx.destination);
                s.start(Math.max(nextAt, ctx.currentTime));
                srcs.push(s);
                nextAt += b.duration;
                nextPos += b.duration;
            }
            while (srcs.length > 3) { srcs.shift(); }
            if (nextPos >= dur - 0.001 && ctx.currentTime >= nextAt) { done = true; clearInterval(timer); onEnd(); }
        }
        function stopAll() { srcs.forEach(function (x) { try { x.stop(); } catch (e) {} }); srcs = []; }
        function from(pos) {
            stopAll();
            startPos = nextPos = Math.max(0, Math.min(pos, dur));
            startCtx = nextAt = ctx.currentTime + 0.05;
            done = false;
            pump();
        }
        var p = {
            duration: dur,
            time: function () { return started ? Math.max(0, Math.min(dur, startPos + (ctx.currentTime - startCtx))) : 0; },
            paused: function () { return paused; },
            play: function () {
                paused = false;
                return (ctx.resume ? ctx.resume() : Promise.resolve()).then(function () {
                    if (!started) { started = true; from(0); }
                    clearInterval(timer);
                    timer = setInterval(pump, 500);
                });
            },
            pause: function () { paused = true; if (ctx.suspend) { ctx.suspend(); } },
            seek: function (sec) { from(sec); },
            stop: function () { done = true; clearInterval(timer); stopAll(); try { ctx.close(); } catch (e) {} }
        };
        return p;
    }

    /* 自测（deploy.sh --music）：让 <audio> 假装不收 WAV，走上面那条路 */
    var rejectWav = false;

    function create(audio, o) {
        var R = function (s) { if (o.report) { o.report(s); } };
        var list = [], idx = -1, token = 0, cache = {}, order = [], fails = 0, watch = 0, skip = 0, pre = 0;
        var wav = null;      // 这一首走的 Web Audio（pcmPlayer）；null 是 <audio>
        function dropWav() { if (wav) { wav.stop(); wav = null; } }

        function mimeOf(it) { return it.mime || MIME[it.ext] || "audio/mpeg"; }

        /* 下载（同一首正在下就等它）。缓存按最近用过留 KEEP 首，挤出去的放掉 blob 地址 */
        function fetchTrack(it, onProgress) {
            var k = it.fileKey, c = cache[k];
            touch(k);
            if (c) {
                c.onProgress = onProgress;
                return c.url ? Promise.resolve(c.url) : c.p;
            }
            var ctl = new AbortController(), t0 = performance.now();
            c = cache[k] = { ctl: ctl, onProgress: onProgress, url: "" };
            c.p = o.load(it, function (got, total, stage) { if (c.onProgress) { c.onProgress(got, total, stage); } }, ctl.signal).then(function (blob) {
                c.url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: mimeOf(it) }));
                c.p = null;
                R("下载完 " + mb(blob.size) + " " + Math.round(performance.now() - t0) + "ms（" + (it.ext || it.mime) + "）");
                return c.url;
            }, function (e) {
                if (cache[k] === c) { delete cache[k]; }
                throw e;
            });
            return c.p;
        }
        function touch(k) {
            order = order.filter(function (x) { return x !== k; });
            order.push(k);
            while (order.length > KEEP) { drop(order.shift()); }
        }
        function drop(k) {
            var c = cache[k];
            if (!c) { return; }
            delete cache[k];
            if (c.url) { URL.revokeObjectURL(c.url); } else { try { c.ctl.abort(); } catch (e) {} }
        }

        function start(i) {
            var my = ++token, it = list[i];
            idx = i;
            clearInterval(watch);
            clearTimeout(skip);
            clearTimeout(pre);
            dropWav();
            audio.pause();
            /* 切得快的时候，别的歌还在下的就停掉（这首和下一首除外） */
            Object.keys(cache).forEach(function (k) {
                if (!cache[k].url && k !== it.fileKey && !(list[i + 1] && k === list[i + 1].fileKey)) { drop(k); order = order.filter(function (x) { return x !== k; }); }
            });
            o.onState("track", { item: it, index: i });
            o.onState("loading", { got: 0, total: it.size });
            fetchTrack(it, function (got, total, stage) { if (my === token) { o.onState("loading", { got: got, total: total, stage: stage }); } }).then(function (url) {
                if (my !== token) { return; }
                if (rejectWav && it.ext === "flac") { R("自测：假装 <audio> 不收这份 WAV"); audio.pause(); audio.removeAttribute("src"); viaWebAudio(my, it, url, "自测"); return; }
                audio.src = url;
                var p = audio.play();
                if (p && p.catch) { p.catch(function (e) { if (my === token && e.name !== "AbortError") { fail(my, "play() " + errStr(e)); } }); }
                /* 放不起来也不报错的（FLAC）：12 秒播放头没动就算放不了 */
                var t0 = Date.now();
                watch = setInterval(function () {
                    if (my !== token) { clearInterval(watch); return; }
                    if (audio.currentTime > 0.3) { clearInterval(watch); return; }
                    if (Date.now() - t0 > STUCK_MS) { clearInterval(watch); fail(my, tx("{0} 秒没放起来", STUCK_MS / 1000)); }
                }, 500);
            }, function (e) {
                if (my !== token || e.name === "AbortError") { return; }
                if (e.known) { fail(my, e.message, true); return; }      // 电视解不了的编码（ALAC），app 下的时候看出来的
                fail(my, tx("下载出错：{0}", errStr(e)));
            });
        }

        function fail(my, msg, known) {
            if (my !== token) { return; }
            fails++;
            R("放不了（第 " + (idx + 1) + "/" + list.length + " 首，" + (list[idx].ext || list[idx].mime) + "）：" + msg);
            o.onState("error", { msg: msg, known: !!known });
            /* 3 秒后放下一首；连着 5 首都放不了就停（一整串 FLAC 别一直跳） */
            if (idx + 1 < list.length && fails < MAX_FAILS) { skip = setTimeout(function () { if (my === token) { start(idx + 1); } }, SKIP_MS); }
        }

        /* <audio> 报错的那首 WAV 改用 Web Audio 放：下好的 blob 里读出 PCM */
        function viaWebAudio(my, it, url, why) {
            clearInterval(watch);
            var t0 = performance.now();
            fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
                if (my !== token) { return; }
                var w = wavPcm(ab);
                if (!w || !(window.AudioContext || window.webkitAudioContext)) { fail(my, why + "；Web Audio 也放不了（" + (w ? "没有 AudioContext" : "读不出 WAV") + "）"); return; }
                dropWav();
                var my2 = token;
                wav = pcmPlayer(w, function () { if (my2 === token) { ended(); } });
                return wav.play().then(function () {
                    R("改用 Web Audio 放：" + (why || "") + "，" + w.ch + " 声道 " + w.rate + "Hz " + Math.round(wav.duration) + " 秒，读 PCM " + Math.round(performance.now() - t0) + "ms");
                    playing();
                });
            }).catch(function (e) { if (my === token) { fail(my, why + "；Web Audio 也放不了：" + errStr(e)); } });
        }
        function playing() {
            fails = 0;
            o.onState("playing");
            /* 放起来 3 秒后下下一首 */
            clearTimeout(pre);
            var my = token;
            pre = setTimeout(function () {
                if (my === token && list[idx + 1]) { fetchTrack(list[idx + 1]).catch(function (e) { R("预先下一首出错：" + errStr(e)); }); }
            }, 3000);
        }
        function ended() {
            if (idx + 1 < list.length) { start(idx + 1); }
            else { R("一串放完了（" + list.length + " 首）"); o.onState("done"); }
        }
        audio.addEventListener("playing", playing);
        audio.addEventListener("pause", function () { if (!audio.ended && idx >= 0 && audio.src) { o.onState("paused"); } });
        audio.addEventListener("ended", ended);
        audio.addEventListener("error", function () {
            if (!audio.getAttribute("src")) { return; }
            var e = audio.error;
            /* 2026-10-28 Tizen 6.0 上一首 FLAC 解成 50 MB 的 WAV 报 Format error，放成过的 WAV 都在 16 MB 以下：分不开「不认 WAV」和「太大」 */
            var it = list[idx] || {}, mime = it.ext === "flac" ? "audio/wav" : mimeOf(it);
            var msg = "audio error " + (e ? e.code + (e.message ? " " + e.message : "") : "?") + "（" + mime + " canPlayType=" + (audio.canPlayType(mime) || "空") + "）";
            var c = cache[it.fileKey];
            if (mime === "audio/wav" && c && c.url) {
                R("<audio> 不收这份 WAV（" + msg + "），改用 Web Audio");
                var url = c.url;
                audio.removeAttribute("src");
                viaWebAudio(token, it, url, msg);
                return;
            }
            fail(token, msg);
        });

        var api = {};
        api.play = function (l, i) { list = l.slice(); fails = 0; start(i); };
        api.next = function () { if (idx + 1 < list.length) { start(idx + 1); return true; } return false; };
        /* 上一首：这首放了 5 秒以上先回到开头（和手机上的播放器一样） */
        api.prev = function () {
            if (wav) { if (wav.time() > 5) { wav.seek(0); return true; } }
            else if (audio.currentTime > 5) { audio.currentTime = 0; return true; }
            if (idx > 0) { start(idx - 1); return true; }
            return false;
        };
        api.toggle = function () {
            if (wav) {
                if (wav.paused()) { wav.play().catch(function () {}); o.onState("playing"); } else { wav.pause(); o.onState("paused"); }
                return !wav.paused();
            }
            if (!audio.getAttribute("src")) { return false; }
            if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
            return !audio.paused;
        };
        api.seek = function (sec) {
            if (wav) { wav.seek(Math.max(0, Math.min(sec, wav.duration - 0.5))); return; }
            if (!audio.getAttribute("src") || !isFinite(audio.duration)) { return; }
            audio.currentTime = Math.max(0, Math.min(sec, audio.duration - 0.5));
        };
        api.stop = function () {
            token++;
            dropWav();
            clearInterval(watch);
            clearTimeout(skip);
            clearTimeout(pre);
            audio.pause();
            audio.removeAttribute("src");
            try { audio.load(); } catch (e) {}
            Object.keys(cache).forEach(drop);
            order = [];
            list = [];
            idx = -1;
        };
        api.current = function () { return idx >= 0 ? list[idx] : null; };
        api.index = function () { return idx; };
        api.list = function () { return list; };
        api.time = function () { return wav ? wav.time() : audio.currentTime || 0; };
        api.duration = function () { return wav ? wav.duration : isFinite(audio.duration) ? audio.duration : 0; };
        api.paused = function () { return wav ? wav.paused() : audio.paused; };
        api.webAudio = function () { return !!wav; };
        return api;
    }

    return { create: create, test: { rejectWav: function (on) { rejectWav = !!on; } } };
})();
