/* 可行性探测（2026-10-01）：扫码登录 → 全局搜「末代皇帝」→ 量下载速度 → MSE 边下边播 → 跳转两次。
 * 每一步都报到 tools/collect.mjs（:8097）。测完留在播放状态：确认 = 暂停/继续，左右 / 快进快退 = ±60 秒，返回 = 退出。 */
(function () {
    "use strict";

    var T0 = performance.now();
    var $ = function (id) { return document.getElementById(id); };
    var video = $("v");
    function now() { return Math.round(performance.now() - T0); }
    function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }
    function sleep(t) { return new Promise(function (r) { setTimeout(r, t); }); }
    function say(s) {
        Log.report("tg", s);
        var d = document.createElement("div");
        d.textContent = s;
        $("lines").appendChild(d);
        while ($("lines").children.length > 16) { $("lines").removeChild($("lines").firstChild); }
    }
    function errStr(e) { return (e && (e.message || e.text || e.name)) || String(e); }

    try {
        ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaFastForward", "MediaRewind"].forEach(function (k) {
            tizen.tvinputdevice.registerKey(k);
        });
    } catch (e) {}

    function engine() {
        var types = {
            "avc1.640028": "video/mp4; codecs=\"avc1.640028\"",
            "hvc1.1.6.L120.90": "video/mp4; codecs=\"hvc1.1.6.L120.90\"",
            "hvc1.2.4.L153.B0": "video/mp4; codecs=\"hvc1.2.4.L153.B0\"",
            "av01.0.08M.08": "video/mp4; codecs=\"av01.0.08M.08\"",
            "mp4a.40.2": "audio/mp4; codecs=\"mp4a.40.2\"",
            "ac-3": "audio/mp4; codecs=\"ac-3\"",
            "ec-3": "audio/mp4; codecs=\"ec-3\"",
            "opus": "audio/mp4; codecs=\"opus\"",
            "flac": "audio/mp4; codecs=\"flac\""
        };
        var ok = [], no = [];
        Object.keys(types).forEach(function (k) {
            (window.MediaSource && MediaSource.isTypeSupported(types[k]) ? ok : no).push(k);
        });
        say("engine: " + (navigator.userAgent.match(/Chrome\/[\d.]+/) || ["?"])[0] + " 安全上下文=" + window.isSecureContext +
            " subtle=" + !!(window.crypto && crypto.subtle) + " wasm-simd=" + TGLib.simd + " idb=" + (typeof indexedDB) +
            " | MSE 支持 " + ok.join(",") + " 不支持 " + no.join(","));
    }

    /* ---------- 登录 ---------- */

    function askPassword() {
        say("账号开了两步验证，等输入密码");
        $("pwbox").className = "on";
        var pw = $("pw");
        pw.value = "";
        pw.focus();
        return new Promise(function (resolve) {
            function done(e) {
                if (e.type === "keydown" && e.keyCode !== 13 && e.keyCode !== 65376) { return; }
                if (!pw.value) { return; }
                pw.removeEventListener("keydown", done);
                pw.removeEventListener("change", done);
                $("pwbox").className = "";
                pw.blur();
                resolve(pw.value);
            }
            pw.addEventListener("keydown", done);
            pw.addEventListener("change", done);
        });
    }

    async function login(tg) {
        var me = null;
        try { me = await tg.getMe(); } catch (e) { say("没有可用的会话（" + errStr(e) + "），出二维码"); }
        if (me) { say("会话还在，不用扫码"); return me; }
        $("panel").className = "on";
        var n = 0, t = now();
        me = await tg.signInQr({
            onUrlUpdated: function (url, expires) {
                n++;
                $("qr").innerHTML = TGLib.qrSvg(url, 10);
                $("qrstate").textContent = "第 " + n + " 张码";
                say("二维码 第" + n + "张 出码 " + (now() - t) + "ms，" + Math.round((expires - Date.now()) / 1000) + " 秒后过期");
            },
            onQrScanned: function () { $("qrstate").textContent = "已扫码，正在登录…"; say("已扫码"); },
            password: askPassword,
            invalidPasswordCallback: function () { say("两步验证密码不对，再输一次"); }
        });
        $("panel").className = "";
        return me;
    }

    /* ---------- 搜索 ---------- */

    function isVideo(m) {
        var d = m.media;
        return d && (d.type === "video" || (d.type === "document" && /^video\//.test(d.mimeType || "")));
    }

    function desc(m) {
        var d = m.media, a = d.attr || {};
        var chat = m.chat ? (m.chat.title || m.chat.displayName || m.chat.id) : "?";
        return "「" + chat + "」#" + m.id + " " + (d.fileName || "(无文件名)") + " " + (d.mimeType || "?") + " " + mb(d.fileSize || 0) +
            (d.duration ? " " + Math.round(d.duration / 60) + "分" : "") + (d.width ? " " + d.width + "x" + d.height : "") +
            (d.codec ? " codec=" + d.codec : "") + " 边下边播=" + (a.supportsStreaming ? "是" : "否") + " dc=" + d.dcId + " 类型=" + d.type;
    }

    async function search(tg) {
        var qs = ["末代皇帝", "Last Emperor"], found = [];
        for (var i = 0; i < qs.length && !found.length; i++) {
            var t = now();
            var res = await tg.searchGlobal({ query: qs[i], limit: 50 });
            found = res.filter(isVideo);
            say("搜「" + qs[i] + "」" + (now() - t) + "ms：" + res.length + " 条消息，其中视频 " + found.length);
        }
        found.slice(0, 8).forEach(function (m) { say("  " + desc(m)); });
        found.sort(function (a, b) { return (b.media.duration || 0) - (a.media.duration || 0) || (b.media.fileSize || 0) - (a.media.fileSize || 0); });
        return found[0] || null;
    }

    /* ---------- 下载速度 ---------- */

    async function speed(tg, d, offset, bytes, label) {
        var ac = new AbortController(), t = performance.now(), first = 0, got = 0;
        try {
            for await (var c of tg.downloadAsIterable(d, { offset: offset, fileSize: d.fileSize, partSize: 512, abortSignal: ac.signal })) {
                if (!first) { first = performance.now() - t; }
                got += c.length;
                if (got >= bytes) { break; }
            }
        } catch (e) {
            if (!ac.signal.aborted) { say(label + " 出错 " + errStr(e)); return; }
        } finally { ac.abort(); }
        var dt = (performance.now() - t) / 1000;
        say(label + "：首块 " + Math.round(first) + "ms，" + mb(got) + " 用 " + dt.toFixed(1) + "s = " + (got / 1048576 / dt).toFixed(2) + " MB/s");
    }

    /* ---------- MSE 边下边播 ---------- */

    var CH = 512 * 1024;      // Telegram 每次最多 512KB；起点按它对齐，请求就不会跨 1MB 边界
    var WINDOW = 8 * 1048576; // 已请求、还没交给 mp4box 的字节上限 —— mtcute 的下载线程本身不管背压
    var AHEAD = 90;           // 前方缓冲够这么多秒就不再请求

    function Player(tg, d) {
        var size = d.fileSize, ms = new MediaSource(), mp4 = MP4Box.createFile();
        var sbs = {}, queues = {}, info = null, gen = 0, ac = null, requested = 0, consumed = 0;
        var bytes = 0, lastBytes = 0, stalls = 0, seeking = null, moovJump = false;
        var self = { info: null, bytes: function () { return bytes; } };

        function ahead() {
            var b = video.buffered, t = video.currentTime;
            for (var i = 0; i < b.length; i++) { if (b.start(i) <= t + 0.3 && b.end(i) > t) { return b.end(i) - t; } }
            return 0;
        }
        function ranges() {
            var b = video.buffered, s = [];
            for (var i = 0; i < b.length; i++) { s.push(b.start(i).toFixed(1) + "-" + b.end(i).toFixed(1)); }
            return s.join(" ");
        }
        function drain(id) {
            var sb = sbs[id], q = queues[id];
            if (!sb || sb.updating || !q.length || ms.readyState !== "open") { return; }
            var buf = q.shift();
            try { sb.appendBuffer(buf); }
            catch (e) {
                if (e.name === "QuotaExceededError") { q.unshift(buf); evict(); setTimeout(function () { drain(id); }, 1000); }
                else { say("append 出错 " + e.name + " " + e.message); }
            }
        }
        function evict() {
            var t = video.currentTime - 30;
            Object.keys(sbs).forEach(function (id) {
                var sb = sbs[id];
                if (!sb.updating && sb.buffered.length && sb.buffered.start(0) < t) { try { sb.remove(0, t); } catch (e) {} }
            });
        }

        mp4.onError = function (e) { say("mp4box 出错 " + e); };
        mp4.onReady = function (i) {
            info = self.info = i;
            var v = i.videoTracks[0], a = i.audioTracks[0];
            say("moov 到手 " + now() + "ms：" + (v ? v.codec + " " + v.video.width + "x" + v.video.height : "无视频") + " / " +
                (a ? a.codec + " " + a.audio.channel_count + "ch " + a.audio.sample_rate + "Hz" : "无音频") + "，" + Math.round(i.duration / i.timescale / 60) +
                " 分，fragmented=" + i.isFragmented + "，轨道 " + i.tracks.length);
            ms.duration = i.duration / i.timescale;
            [v, a].forEach(function (tr) {
                if (!tr) { return; }
                var mime = (tr === v ? "video" : "audio") + "/mp4; codecs=\"" + tr.codec + "\"";
                if (!MediaSource.isTypeSupported(mime)) { say("MSE 不支持 " + mime + (tr === v ? "，放不了" : "，没声音")); return; }
                var sb = ms.addSourceBuffer(mime);
                sbs[tr.id] = sb;
                queues[tr.id] = [];
                sb.addEventListener("updateend", function () { drain(tr.id); });
                sb.addEventListener("error", function () { say("SourceBuffer error " + mime); });
                mp4.setSegmentOptions(tr.id, null, { nbSamples: tr === v ? 60 : 100 });
            });
            mp4.initializeSegmentation().forEach(function (s) { queues[s.id] && queues[s.id].push(s.buffer); drain(s.id); });
            mp4.start();
        };
        mp4.onSegment = function (id, user, buf, sampleNum) {
            if (queues[id]) { queues[id].push(buf); drain(id); }
            mp4.releaseUsedSamples(id, sampleNum);
        };

        /* 背压：mtcute 每请求一块之前等这个 promise。 */
        async function gate(my) {
            while (my === gen && (requested - consumed + CH > WINDOW || (info && ahead() > AHEAD))) { await sleep(300); }
            if (my === gen) { requested += CH; }
        }

        async function pump(from) {
            var my = ++gen;
            if (ac) { ac.abort(); }
            var ctl = ac = new AbortController();
            var pos = Math.floor(from / CH) * CH;
            var t0 = performance.now(), firstAt = 0;
            requested = consumed = 0;
            try {
                var it = tg.downloadAsIterable(d, {
                    offset: pos, fileSize: size, partSize: 512, abortSignal: ctl.signal,
                    throttle: function () { return gate(my); }
                });
                for await (var c of it) {
                    if (my !== gen) { return; }
                    var ab = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength);
                    ab.fileStart = pos;
                    pos += c.byteLength;
                    bytes += c.byteLength;
                    consumed += CH;
                    if (!firstAt) { firstAt = performance.now(); say("第一块 " + Math.round(firstAt - t0) + "ms（从 " + mb(ab.fileStart) + "）"); }
                    var ta = performance.now();
                    var next = mp4.appendBuffer(ab);
                    var am = performance.now() - ta;
                    if (am > 200) { say("mp4box.appendBuffer 用了 " + Math.round(am) + "ms（" + mb(ab.fileStart) + "，moov " + (info ? "已解析" : "未解析") + "）"); }
                    /* moov 在文件尾：mp4box 读到 mdat 头就返回 mdat 的末尾，让我们直接去那里取 moov */
                    if (!info && typeof next === "number" && next > pos + 2 * CH) {
                        say("moov 不在开头，跳到 " + mb(next) + " 去取（当前 " + mb(pos) + "）");
                        moovJump = true;
                        pump(next);
                        return;
                    }
                    /* 从文件尾拿到了 moov：回到第一个样本那里开始取 */
                    if (moovJump && info) {
                        moovJump = false;
                        var s0 = mp4.seek(0, true);
                        say("moov 从文件尾拿到，回到 " + mb(s0.offset) + " 取第一段");
                        pump(s0.offset);
                        return;
                    }
                }
                if (my === gen) { mp4.flush(); say("整个文件取完了"); }
            } catch (e) {
                if (!ctl.signal.aborted) { say("下载出错 " + errStr(e)); }
            } finally { ctl.abort(); }
        }

        self.start = function () {
            return new Promise(function (resolve) {
                ms.addEventListener("sourceopen", function () { pump(0); resolve(); }, { once: true });
                video.src = URL.createObjectURL(ms);
            });
        };

        /* 跳转：mp4box 给出目标前最近关键帧的时间和文件偏移；播放头放在关键帧上（抖音那边测过：
         * 不对齐时解码器要从关键帧一路解到目标，966ms → 258ms）。 */
        self.seek = function (t, label) {
            if (!info) { return; }
            t = Math.max(0, Math.min(t, info.duration / info.timescale - 5));
            gen++;
            if (ac) { ac.abort(); }
            Object.keys(queues).forEach(function (id) { queues[id].length = 0; });
            /* 跳两次：第一次 mp4box 把视频退到关键帧、音频却落在要的时间上（每个音频样本都是关键帧），
             * 两条轨起点差几秒，video.buffered 取交集，播放头落在空档里不动（2026-10-01 第一次上设备：
             * 停在 6554.2，缓冲从 6557.1 开始）。拿关键帧时间再跳一次，音频也对齐到那里。 */
            var ts = performance.now();
            var s = mp4.seek(t, true);
            s = mp4.seek(s.time, true);
            var seekMs = Math.round(performance.now() - ts);
            seeking = { at: performance.now(), to: s.time, label: label || "跳转" };
            say((label || "跳转") + " → " + s.time.toFixed(1) + "s（要 " + t.toFixed(0) + "s），从 " + mb(s.offset) + " 开始取，mp4box.seek 两次 " + seekMs + "ms");
            video.currentTime = s.time;
            pump(s.offset);
        };

        /* 进展、卡顿、速度：每 10 秒一行。 */
        var lastT = -1, stuckSince = 0, lastLine = performance.now();
        setInterval(function () {
            var t = video.currentTime;
            /* 保险：播放头前面 5 秒内有一段缓冲、播放头自己不在缓冲里 → 跳过去。真触发了说明还有别的空档来源。 */
            if (!video.paused && video.readyState < 3 && info) {
                var b = video.buffered;
                for (var i = 0; i < b.length; i++) {
                    if (b.start(i) > t && b.start(i) - t < 5) {
                        say("跳过空档 " + t.toFixed(2) + " → " + b.start(i).toFixed(2) + " 缓冲[" + ranges() + "]");
                        video.currentTime = b.start(i) + 0.05;
                        break;
                    }
                }
            }
            if (seeking && !video.paused && t > seeking.to + 0.1) {
                say(seeking.label + " 出画面 " + Math.round(performance.now() - seeking.at) + "ms");
                seeking = null;
            }
            if (!video.paused && !seeking && info) {
                if (t === lastT) { if (!stuckSince) { stuckSince = performance.now(); } }
                else if (stuckSince) {
                    var dur = performance.now() - stuckSince;
                    if (dur > 1000) { stalls++; say("卡了 " + (dur / 1000).toFixed(1) + "s @" + t.toFixed(1) + "（第 " + stalls + " 次）"); }
                    stuckSince = 0;
                }
            }
            lastT = t;
            if (performance.now() - lastLine >= 10000) {
                var dt = (performance.now() - lastLine) / 1000;
                say("状态 t=" + t.toFixed(1) + " 前方 " + ahead().toFixed(0) + "s 缓冲[" + ranges() + "] 近 " + dt.toFixed(0) + "s 下载 " +
                    ((bytes - lastBytes) / 1048576 / dt).toFixed(2) + " MB/s 累计 " + mb(bytes) + " readyState=" + video.readyState + " 卡顿 " + stalls);
                lastBytes = bytes;
                lastLine = performance.now();
            }
            if (Math.random() < 0.05) { evict(); }
        }, 250);
        return self;
    }

    /* ---------- 主流程 ---------- */

    async function main() {
        engine();
        if (!TG_API_ID) { say("config.js 里没有 TG_API_ID —— 要用 tools/deploy.sh 装"); return; }
        var tg = await TGLib.create(TG_API_ID, TG_API_HASH, "tg-session");
        var t = now();
        await tg.connect();
        say("连上 Telegram " + (now() - t) + "ms");
        var me = await login(tg);
        say("已登录 id=" + me.id + " 会员=" + me.isPremium + " 主 DC=" + (await tg.getPrimaryDcId()));

        var m = await search(tg);
        if (!m) { say("没搜到视频。要先在手机上加入发这部片子的群或频道（只预览不加入，搜不到）"); return; }
        var d = m.media;
        say("选中 " + desc(m));

        await speed(tg, d, 0, 8 * 1048576, "测速 开头 8MB");
        var mid = Math.floor(d.fileSize / 2 / CH) * CH;
        await speed(tg, d, mid, 4 * 1048576, "测速 中间 4MB");

        var p = Player(tg, d);
        var t1 = now();
        await p.start();
        video.play().catch(function (e) { say("play() " + errStr(e)); });
        while (video.currentTime < 0.1) { await sleep(100); if (now() - t1 > 60000) { say("60 秒没出画面，放弃"); return; } }
        say("出画面 " + (now() - t1) + "ms（从开始取算），" + video.videoWidth + "x" + video.videoHeight);

        await sleep(40000);
        p.seek(video.duration * 0.5, "跳到一半");
        await sleep(30000);
        p.seek(video.duration * 0.25, "跳回四分之一");
        await sleep(30000);
        say("探测结束，继续放。确认 = 暂停/继续，左右 = ±60 秒，返回 = 退出");
        window.__player = p;
    }

    document.addEventListener("keydown", function (e) {
        var p = window.__player;
        switch (e.keyCode) {
            case 10009:
                try { tizen.application.getCurrentApplication().exit(); } catch (x) {}
                break;
            case 13: case 10252:
                if ($("pwbox").className) { return; }
                if (video.paused) { video.play(); } else { video.pause(); }
                break;
            case 37: case 412:
                if (p) { p.seek(video.currentTime - 60, "快退 60"); }
                break;
            case 39: case 417:
                if (p) { p.seek(video.currentTime + 60, "快进 60"); }
                break;
        }
    });

    main().catch(function (e) { say("主流程出错 " + errStr(e) + " | " + String(e && e.stack || "").split("\n").slice(0, 3).join(" ")); });
})();
