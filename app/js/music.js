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

    function create(audio, o) {
        var R = function (s) { if (o.report) { o.report(s); } };
        var list = [], idx = -1, token = 0, cache = {}, order = [], fails = 0, watch = 0, skip = 0, pre = 0;

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
            audio.pause();
            /* 切得快的时候，别的歌还在下的就停掉（这首和下一首除外） */
            Object.keys(cache).forEach(function (k) {
                if (!cache[k].url && k !== it.fileKey && !(list[i + 1] && k === list[i + 1].fileKey)) { drop(k); order = order.filter(function (x) { return x !== k; }); }
            });
            o.onState("track", { item: it, index: i });
            o.onState("loading", { got: 0, total: it.size });
            fetchTrack(it, function (got, total, stage) { if (my === token) { o.onState("loading", { got: got, total: total, stage: stage }); } }).then(function (url) {
                if (my !== token) { return; }
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

        audio.addEventListener("playing", function () {
            fails = 0;
            o.onState("playing");
            /* 放起来 3 秒后下下一首 */
            clearTimeout(pre);
            var my = token;
            pre = setTimeout(function () {
                if (my === token && list[idx + 1]) { fetchTrack(list[idx + 1]).catch(function (e) { R("预先下一首出错：" + errStr(e)); }); }
            }, 3000);
        });
        audio.addEventListener("pause", function () { if (!audio.ended && idx >= 0 && audio.src) { o.onState("paused"); } });
        audio.addEventListener("ended", function () {
            if (idx + 1 < list.length) { start(idx + 1); }
            else { R("一串放完了（" + list.length + " 首）"); o.onState("done"); }
        });
        audio.addEventListener("error", function () {
            if (!audio.getAttribute("src")) { return; }
            var e = audio.error;
            fail(token, "audio error " + (e ? e.code + (e.message ? " " + e.message : "") : "?"));
        });

        var api = {};
        api.play = function (l, i) { list = l.slice(); fails = 0; start(i); };
        api.next = function () { if (idx + 1 < list.length) { start(idx + 1); return true; } return false; };
        /* 上一首：这首放了 5 秒以上先回到开头（和手机上的播放器一样） */
        api.prev = function () {
            if (audio.currentTime > 5) { audio.currentTime = 0; return true; }
            if (idx > 0) { start(idx - 1); return true; }
            return false;
        };
        api.toggle = function () {
            if (!audio.getAttribute("src")) { return false; }
            if (audio.paused) { audio.play().catch(function () {}); } else { audio.pause(); }
            return !audio.paused;
        };
        api.seek = function (sec) {
            if (!audio.getAttribute("src") || !isFinite(audio.duration)) { return; }
            audio.currentTime = Math.max(0, Math.min(sec, audio.duration - 0.5));
        };
        api.stop = function () {
            token++;
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
        api.time = function () { return audio.currentTime || 0; };
        api.duration = function () { return isFinite(audio.duration) ? audio.duration : 0; };
        api.paused = function () { return audio.paused; };
        return api;
    }

    return { create: create };
})();
