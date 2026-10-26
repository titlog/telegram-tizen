/* 设备上的自动走查。只在 zsh tools/deploy.sh --diag / --loginexpiry / --samples 打出来的构建（config.js 的 SELFTEST）里跑，别的构建一进来就返回。
 *
 * --diag：诊断日志的上传在电视上走一遍（照 bilibili / douyin 的 --diag）—— 设置页里按「上传诊断日志」，开关关掉再打开，造一次出事等
 * 自动的那一份，传到 TG_DIAG_TO（默认这台电脑上的 PORT=8096 node ../bilibili-tizen/tools/diag-local.mjs）。开关最后放回原样。
 * --loginexpiry：扫码页上后台线程的连接作废（挂到后台、电视待机一分钟以上，主线程发不出心跳）。添加一个账号到扫码页，port 往后台
 * 线程发的东西全扣下（和挂到后台时一样，只是主线程照常跑），等后台线程作废这条连接，看是不是重连、换一张码、还在扫码页；最后按返回
 * 取消添加。只停心跳不够：后台线程把请求也当心跳，扫码页每 30 秒换码要发请求，第一版停了 90 秒心跳连接都没作废。
 * 1.1.2 上这里 boot() 停住、二维码不再换（2026-10-23 一台别人的电视：「启动出错 signal is aborted without reason」）。
 *
 * --samples：README「拿什么试」那几部片（见 samplesRun）。
 * 派发和遥控器一样的 keydown。最后一行 SELFTEST: 结束，全部通过 / N 步失败。⚠️ 测完马上 zsh tools/deploy.sh 装回正常构建。 */
(function () {
    "use strict";
    if (typeof SELFTEST === "undefined" || ["diag", "loginexpiry", "samples", "music", "legacy"].indexOf(SELFTEST) < 0) { return; }

    var fails = 0, steps = 0;
    function R(s) { Log.report("SELFTEST", s); }
    function check(name, ok, detail) { steps++; if (!ok) { fails++; } R((ok ? "PASS " : "FAIL ") + name + (detail ? " | " + detail : "")); }
    function key(code) {
        var e = document.createEvent("Event");
        e.initEvent("keydown", true, true);
        e.keyCode = code;
        document.dispatchEvent(e);
    }
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function until(test, ms) {
        var t0 = Date.now();
        function poll() {
            var v = test();
            if (v) { return Promise.resolve(v); }
            if (Date.now() - t0 > ms) { return Promise.resolve(null); }
            return wait(300).then(poll);
        }
        return poll();
    }
    function line() { return document.getElementById("opts-diag").textContent; }

    function diagRun() {
        var wasOn = Diag.enabled(), manualId = "";
        R("开始");
        return until(function () { return window.__app.screen() === "home"; }, 60000).then(function (ok) {
            check("启动到主页", !!ok, "现在是 " + window.__app.screen());
            if (!wasOn) { Diag.setEnabled(true); }
            window.__app.openOpts();
            return wait(500);
        }).then(function () {
            var st = Diag.status();
            check("设置页：诊断日志开着、写着这台电视的编号、有接收地址", window.__app.screen() === "opts" && line().indexOf(st.device) >= 0 && st.configured,
                  "那行字：" + line() + (st.configured ? "" : "（这个构建没有接收地址：deploy.sh --diag 应该写进了 DIAG_TO）"));
            key(40);
            return wait(300);
        }).then(function () {
            key(13);
            return until(function () { var l = Diag.status().last; return l && l.manual ? l : null; }, 25000);
        }).then(function (l) {
            check("按「上传诊断日志」，那行字写出编号", l && l.ok && line().indexOf(l.id) >= 0, l ? (l.ok ? "编号 " + l.id + "，那行字：" + line() : "没传上：" + l.why) : "25 秒没结果");
            manualId = l && l.id || "";
            key(38);
            return wait(300);
        }).then(function () {
            key(13);
            return wait(300);
        }).then(function () {
            check("关掉：不记录、缓冲清空", !Diag.enabled() && Diag.status().lines === 0, "enabled=" + Diag.enabled() + "，缓冲 " + Diag.status().lines + " 行，那行字：" + line());
            key(13);
            return wait(300);
        }).then(function () {
            check("再打开", Diag.enabled() && line().indexOf(Diag.status().device) >= 0, "那行字：" + line());
            /* 三分钟内自动传过一份的话（上一轮 --diag），这一次会被限流挡掉 —— 自测构建里把那个时间清掉。 */
            try { var sent = JSON.parse(localStorage.getItem("tg.diag.sent") || "{}"); sent.at = 0; localStorage.setItem("tg.diag.sent", JSON.stringify(sent)); } catch (e) {}
            Diag.incident("自测：造的一次出事");
            return until(function () { var l = Diag.status().last; return l && !l.manual ? l : null; }, 30000);
        }).then(function (l) {
            check("出一次事，8 秒后自动上传", l && l.ok && l.id !== manualId, l ? (l.ok ? "编号 " + l.id : "没传上：" + l.why) : "30 秒没结果");
            if (Diag.enabled() !== wasOn) { Diag.setEnabled(wasOn); }
            key(10009);
            return wait(500);
        }).then(function () {
            check("返回键回到主页", window.__app.screen() === "home", "现在是 " + window.__app.screen());
            R(fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
        }, function (e) { R("中止：" + (e && e.message) + "（" + fails + "/" + steps + " 步失败）"); });
    }

    /* 两段，中间隔一次 reload（添加账号就是 reload 进扫码页）。段号带时间记在 localStorage，一分钟内有效：最后按返回取消添加
     * 又是一次 reload，第一版没记「测完了」，就又从头添加、一直循环（2026-10-23，a2、a3、a4…） */
    var PHASE = "tg.selftest.loginexpiry";
    function phase() {
        /* 应用新开的（装上、重新打开）不看段号，从头来；只有 reload 进来的才是这一轮的下一段 */
        var nav = null, m = null;
        try { nav = performance.getEntriesByType("navigation")[0]; } catch (e) {}
        if (!nav || nav.type !== "reload") { return ""; }
        try { m = JSON.parse(localStorage.getItem(PHASE)); } catch (e) {}
        return m && Date.now() - m.at < 60000 ? m.phase : "";
    }
    function setPhase(p) { localStorage.setItem(PHASE, JSON.stringify({ phase: p, at: Date.now() })); }
    function loginExpiryRun() {
        if (phase() === "done") { R("刚测完（这是取消添加之后的 reload），不再来一遍。装回正常构建：zsh tools/deploy.sh"); return Promise.resolve(); }
        if (phase() !== "login") {
            R("开始：添加一个账号，去扫码页");
            return until(function () { var s = window.__app.screen(); return s === "home" || s === "login" ? s : null; }, 60000).then(function (s) {
                setPhase("login");
                if (s === "login") { return loginExpiryRun(); }
                var a = Accounts.add();
                R("添加了 " + a.id + "，reload");
                location.reload();
            });
        }
        var c = null, port = null, send = null, held = 0, t0 = 0, qr0 = "";
        return until(function () { return window.__app.screen() === "login" && document.querySelector("#qr svg") ? true : null; }, 30000).then(function (ok) {
            check("到了扫码页、出了码", !!ok, "现在是 " + window.__app.screen());
            /* TelegramClient 包着 port（mtcute 的 TelegramWorkerPort，_client）：发消息走 port._invoker.send，stopSignal 也是 port 的 */
            c = TG.client();
            port = c && c._client;
            if (!ok || !port || !port._invoker || !port._invoker.send) { throw new Error("不在扫码页，或者 mtcute 不在后台线程（" + TG.mode() + "）"); }
            send = port._invoker.send;
            qr0 = document.getElementById("qr").innerHTML;
            port._invoker.send = function () { held++; };
            t0 = Date.now();
            R("port 发往后台线程的全扣下，等它作废这条连接（60 秒没动静，每 10 秒查一次）");
            return until(function () { return c.stopSignal.aborted ? true : null; }, 90000);
        }).then(function (expired) {
            port._invoker.send = send;
            check("连接作废了", !!expired, Math.round((Date.now() - t0) / 1000) + " 秒，扣下 " + held + " 条");
            /* 旧码在扣之前记下：作废之后才记，重连换出的新码已经在上面了（第一版就这么判错的） */
            return until(function () { return TG.client() !== c && document.getElementById("qr").innerHTML !== qr0 ? true : null; }, 15000);
        }).then(function (ok) {
            check("作废之后重连、换了一张码，还在扫码页", !!ok && window.__app.screen() === "login",
                  "现在是 " + window.__app.screen() + "，重连了=" + (TG.client() !== c) + "，" + document.getElementById("qrstate").textContent);
        }).then(null, function (e) { R("中止：" + (e && e.message)); }).then(function () {
            R(fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
            /* 返回键：取消添加，删掉这一行、切回原来的账号（leaveLogin） */
            setPhase("done");
            if (window.__app.screen() === "login") { key(10009); }
        });
    }

    /* --samples：README「拿什么试」那几部片在电视上走一遍（2026-10-26）。不往 Telegram 群里发东西 —— archive.org 的片子页直接交给
     * 应用的播放器（和群里的链接卡片一样走 web.js + sites.js）；Sintel 官方的 MKV（H.264 + AC-3 5.1 + 10 条字幕）和中文外挂字幕从
     * download.blender.org 读：只把这一部的 TG.source / subtitlesFor / download 换成 HTTP，MKV 拆块、MSE、选字幕、菜单都是真的。 */
    var IA = ["Sita_Sings_the_Blues", "TheGeneral1926", "his_girl_friday"], aacCounted = null;
    var SINTEL = "https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv", CHS = "https://download.blender.org/durian/subs/sintel_chs.srt";
    function up(code) { var e = document.createEvent("Event"); e.initEvent("keyup", true, true); e.keyCode = code; document.dispatchEvent(e); }
    function press(code) { key(code); up(code); }
    async function hold(code, ms) { var t0 = Date.now(); while (Date.now() - t0 < ms) { key(code); await wait(100); } up(code); }
    function vid() { return document.getElementById("v"); }
    function txt(id) { var e = document.getElementById(id); return e ? (e.textContent || "").replace(/\s+/g, " ").trim() : ""; }
    function menuRows() { return [].map.call(document.querySelectorAll("#menu .mi"), function (e) { return (e.classList.contains("focus") ? ">" : "") + e.textContent; }); }
    function ahead() {
        var v = vid(), b = v.buffered;
        for (var i = 0; i < b.length; i++) { if (b.start(i) <= v.currentTime + 0.5 && b.end(i) > v.currentTime) { return Math.round(b.end(i) - v.currentTime); } }
        return 0;
    }
    function playing(after) { return function () { var v = vid(); return v.currentTime > after && !v.paused ? true : null; }; }
    function stateNow() { return "t=" + vid().currentTime.toFixed(1) + "，错误「" + txt("perr") + "」，提示「" + txt("toast") + "」"; }
    async function backHome() { key(10009); await until(function () { return window.__app.screen() === "home" ? true : null; }, 5000); await wait(1000); }
    async function webPlay(id, full) {
        var url = "https://archive.org/details/" + id, t0 = Date.now(), stalls = 0;
        var it = { kind: "web", key: "selftest:" + id, fileKey: "web:" + url, url: url, site: "archive.org", title: id + "（自测）",
                   date: new Date(), info: { year: "", rating: "", director: "" }, size: 0, duration: 0, fileName: "", caption: "" };
        function w() { stalls++; }
        window.__app.play(it);
        var ok = await until(playing(1), 60000);
        check("网页链接 " + id + " 放起来", !!ok, ok ? (Date.now() - t0) + "ms 走起来，" + vid().videoWidth + "x" + vid().videoHeight : "60 秒没走起来：" + stateNow());
        if (ok && full) {
            vid().addEventListener("waiting", w);
            var a = vid().currentTime, ab = vid().webkitAudioDecodedByteCount;
            await wait(30000);
            /* 音频解码字节数：AAC 这里动不动，用来判断下面 AC-3 那一步量到的 0 是没解，还是这台电视根本不数 ——
             * 2026-10-26 这台电视上 AAC 也是 +0：三星的 MSE 不数（桌面 Chrome 数） */
            aacCounted = ab !== undefined && vid().webkitAudioDecodedByteCount > ab;
            check("连着放 30 秒", vid().currentTime - a > 25, "走了 " + (vid().currentTime - a).toFixed(1) + " 秒，卡了 " + stalls + " 次，前面缓冲 " + ahead() + " 秒，" +
                  "AAC 解码字节数 " + (ab === undefined ? "没有这个属性" : "+" + (vid().webkitAudioDecodedByteCount - ab)));
            var before = vid().currentTime, t1 = Date.now();
            key(39);
            var moved = await until(function () { return vid().currentTime > before + 12 && !vid().seeking && !vid().paused ? true : null; }, 30000);
            check("快进 15 秒（没下载到的地方）", !!moved, moved ? (Date.now() - t1) + "ms（含停手 0.7 秒），" + before.toFixed(0) + " → " + vid().currentTime.toFixed(0) + " 秒" : "30 秒没到：" + stateNow());
            vid().removeEventListener("waiting", w);
        }
        await backHome();
    }

    async function sintel() {
        var zh = I18n.lang !== "en", orig = { source: TG.source, subtitlesFor: TG.subtitlesFor, download: TG.download };
        /* 数据源用 web.js 的 httpSource（网页链接里的 MP4 也是它）：顺带看电视上读不读得到 Content-Range（不给大小提示） */
        var src = await Web.httpSource(SINTEL);
        check("探 MKV 的大小（Content-Range）", src.size === 1180090590 && !src.sizeFrom, src.size + " 字节，" + src.probeMs + "ms");
        var it = { key: "selftest:sintel", fileKey: "selftest:sintel", title: "Sintel（自测）", fileName: "Sintel.2010.1080p.mkv", asFile: true, size: src.size,
                   duration: 888, date: new Date(), msg: { id: 0, chat: { id: 0 } }, info: { year: "", rating: "", director: "" }, mime: "video/x-matroska", http: SINTEL };
        TG.source = function (x) { return x.http ? src : orig.source(x); };
        TG.subtitlesFor = function (x) { return x.http ? Promise.resolve([{ name: "Sintel.2010.1080p.chs.srt", lang: "简体", size: 1441, score: 4, doc: { http: CHS } }]) : orig.subtitlesFor(x); };
        TG.download = function (d) { return d && d.http ? fetch(d.http).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return new Uint8Array(b); }) : orig.download(d); };
        try {
            /* 从 1:40 接着放：第一句对白在 1:47 */
            Store.setProgress(it.fileKey, 100, 888, it.title);
            Store.setPrefs(it.fileKey, { sub: undefined, audio: undefined });
            var t0 = Date.now();
            window.__app.play(it);
            var ok = await until(playing(100.5), 90000);
            check("MKV 从 1:40 接着放", !!ok, ok ? (Date.now() - t0) + "ms 走起来，" + vid().videoWidth + "x" + vid().videoHeight : "90 秒没走起来：" + stateNow());
            if (!ok) { return; }
            var a0 = vid().webkitAudioDecodedByteCount;
            await wait(3000);
            if (a0 === undefined || aacCounted === false) { R("音频：这台电视不数解码字节（AAC 也是 0），AC-3 有没有声音要听（提示「" + txt("toast") + "」）"); }
            else { check("AC-3 5.1 在解码", vid().webkitAudioDecodedByteCount > a0, "3 秒解了 " + (vid().webkitAudioDecodedByteCount - a0) + " 字节，提示「" + txt("toast") + "」"); }
            if (zh) {
                var s = await until(function () { var t = txt("sub"); return /[\u4e00-\u9fff]/.test(t) ? t : null; }, 25000);
                check("自动开群里的中文字幕文件（GBK）", !!s, s ? "「" + s + "」 t=" + vid().currentTime.toFixed(1) : "25 秒没有中文字幕：" + stateNow() + "，字幕区「" + txt("sub") + "」");
            } else {
                R("英文界面：对白是英语，不自动开字幕（字幕区「" + txt("sub") + "」）");
            }
            await hold(13, 900);
            var rows = await until(function () { var r = menuRows(); return r.length ? r : null; }, 3000) || [];
            check("长按确认开菜单：10 条内嵌字幕 + 群里的字幕文件", rows.filter(function (x) { return /片子里|in the file/.test(x); }).length === 10 && rows.some(function (x) { return /chs\.srt/.test(x); }), rows.join(" | ") || "菜单没开");
            var want = rows.findIndex(function (x) { return /^>?✓?(英语|English)/.test(x); }), cur = rows.findIndex(function (x) { return x[0] === ">"; });
            for (var i = 0; want >= 0 && i < Math.abs(want - cur); i++) { key(want > cur ? 40 : 38); await wait(150); }
            press(13);
            var en = await until(function () { var t = txt("sub"); return /[A-Za-z]{3}/.test(t) && !/[\u4e00-\u9fff]/.test(t) ? t : null; }, 20000);
            check("菜单里换成片子里的英语字幕", !!en, en ? "「" + en + "」 t=" + vid().currentTime.toFixed(1) : "20 秒没看到英文字幕：字幕区「" + txt("sub") + "」");
            var before = vid().currentTime, t1 = Date.now();
            key(39);
            var moved = await until(function () { return vid().currentTime > before + 12 && !vid().seeking && !vid().paused ? true : null; }, 30000);
            check("MKV 快进 15 秒", !!moved, moved ? (Date.now() - t1) + "ms（含停手 0.7 秒），" + before.toFixed(0) + " → " + vid().currentTime.toFixed(0) + " 秒" : "30 秒没到：" + stateNow());
            await backHome();
        } finally {
            TG.source = orig.source; TG.subtitlesFor = orig.subtitlesFor; TG.download = orig.download;
        }
    }

    async function samplesRun() {
        R("开始（界面 " + I18n.lang + "）");
        var home = await until(function () { return window.__app.screen() === "home" ? true : null; }, 60000);
        check("启动到主页", !!home, "现在是 " + window.__app.screen());
        try {
            for (var i = 0; i < IA.length; i++) {
                var t0 = performance.now();
                try {
                    var r = await Web.resolve("https://archive.org/details/" + IA[i]);
                    check("解析 archive.org " + IA[i], r.type === "mp4" && /^https:\/\/archive\.org\/download\//.test(r.url), Math.round(performance.now() - t0) + "ms，" + r.how);
                } catch (e) { check("解析 archive.org " + IA[i], false, Math.round(performance.now() - t0) + "ms，" + e.message); }
            }
            check("卡片标题去掉站名", Web.title("https://archive.org/details/x", "His Girl Friday : Free Download, Borrow, and Streaming : Internet Archive") === "His Girl Friday");
            await webPlay("Sita_Sings_the_Blues", true);
            await webPlay("TheGeneral1926", false);
            await sintel();
        } catch (e) { R("中止：" + (e && e.message)); }
        R(fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
    }

    /* --music：电视怎么放音频文件。格式探测：MP3 / M4A / FLAC / Opus / WAV（这台电脑上 test/serve.mjs 给，test/media/music/），
     * 每种两种放法 —— 整个下下来做成 blob: 地址、直接给 http 地址 —— 交给 <audio>，看走不走、报什么错。
     * （video.src 放网上的 MP4 在这台电视上不行，2026-10-26；音乐打算整首下下来放，先看 blob 这条路通不通） */
    var MUSIC = ["t.mp3", "t.m4a", "t.flac", "t.opus", "src.wav", "t_flac.mp4"];
    async function musicProbe(base) {
        var types = { mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", opus: "audio/ogg; codecs=opus", wav: "audio/wav", mp4: "audio/mp4" };
        var au = document.createElement("audio");
        R("canPlayType：" + Object.keys(types).map(function (k) { return k + "=" + (au.canPlayType(types[k]) || "否"); }).join(" "));
        for (var i = 0; i < MUSIC.length; i++) {
            var name = MUSIC[i], ext = name.split(".").pop();
            for (var mode = 0; mode < 2; mode++) {
                var t0 = Date.now(), url = base + name, blobUrl = "", got = 0;
                try {
                    if (mode === 0) {
                        var buf = await (await fetch(url)).arrayBuffer();
                        got = buf.byteLength;
                        blobUrl = url = URL.createObjectURL(new Blob([buf], { type: types[ext] }));
                    }
                } catch (e) { check(name + (mode ? " http" : " blob"), false, "取不到：" + e.message); continue; }
                var a = document.createElement("audio"), err = null, dl = Date.now() - t0;
                a.addEventListener("error", function () { err = a.error ? a.error.code + " " + (a.error.message || "") : "?"; });
                document.body.appendChild(a);
                a.src = url;
                var p = a.play();
                if (p && p.catch) { p.catch(function (e) { err = err || "play() " + e.name + " " + e.message; }); }
                var ok = await until(function () { return a.currentTime > 2 || err ? true : null; }, 12000);
                var info = (mode === 0 ? "下载 " + Math.round(got / 1024) + "KB " + dl + "ms，" : "") + "t=" + a.currentTime.toFixed(1) + "，时长 " + (isFinite(a.duration) ? a.duration.toFixed(1) : a.duration) +
                           "，" + (Date.now() - t0) + "ms" + (err ? "，错误 " + err : "");
                check(name + (mode ? " http" : " blob"), !!ok && !err && a.currentTime > 2, info);
                /* 跳到中间：电视自己的播放器对 blob 跳不跳得动 */
                if (!err && a.currentTime > 2) {
                    a.currentTime = 25;
                    var j = await until(function () { return a.currentTime > 26 ? true : null; }, 6000);
                    check(name + (mode ? " http" : " blob") + " 跳到 25 秒", !!j, "t=" + a.currentTime.toFixed(1));
                }
                a.pause(); a.removeAttribute("src"); try { a.load(); } catch (e) {}
                a.remove();
                if (blobUrl) { URL.revokeObjectURL(blobUrl); }
            }
        }
    }
    /* MSE 放音频：整个分段 MP4 一次 append 进一个 SourceBuffer，看播放头走不走。FLAC 只有音频时数据进得去、播放头不动（10-26），
     * 用 AAC 只有音频、FLAC / AAC 配一条 64x64 黑画面视频对照，分清是「只有音频」还是「FLAC」的问题 */
    async function mseProbe(base, file, mime, el) {
        R("MSE isTypeSupported(" + mime + ") = " + MediaSource.isTypeSupported(mime));
        var buf = await (await fetch(base + file)).arrayBuffer(), a = document.createElement(el), ms = new MediaSource(), err = null;
        a.addEventListener("error", function () { err = a.error ? a.error.code + " " + (a.error.message || "") : "?"; });
        if (el === "video") { a.style.cssText = "position:absolute;left:0;top:0;width:64px;height:64px"; }
        document.body.appendChild(a);
        a.src = URL.createObjectURL(ms);
        await new Promise(function (ok) { ms.addEventListener("sourceopen", ok, { once: true }); });
        var sb = ms.addSourceBuffer(mime);
        await new Promise(function (ok) { sb.addEventListener("updateend", ok, { once: true }); sb.appendBuffer(buf); });
        try { ms.endOfStream(); } catch (e) {}
        a.play().catch(function (e) { err = err || "play() " + e.name; });
        var ok = await until(function () { return a.currentTime > 2 || err ? true : null; }, 12000);
        var b = sb.buffered;
        check(file + " 走 MSE（" + el + "）", !!ok && !err && a.currentTime > 2, "t=" + a.currentTime.toFixed(1) + "，readyState " + a.readyState + "，缓冲 " +
              (b.length ? b.start(0).toFixed(2) + "-" + b.end(b.length - 1).toFixed(2) : "无") + (err ? "，错误 " + err : ""));
        a.pause(); a.remove();
    }
    async function mseProbes(base) {
        await mseProbe(base, "t_aac_frag.mp4", 'audio/mp4; codecs="mp4a.40.2"', "audio");
        await mseProbe(base, "t_flac_frag.mp4", 'audio/mp4; codecs="flac"', "audio");
        await mseProbe(base, "t_flac_frag.mp4", 'audio/mp4; codecs="flac"', "video");
        for (var f of [["av_aac_frag.mp4", "mp4a.40.2"], ["av_flac_frag.mp4", "flac"]]) {
            try { await mseProbe(base, f[0], 'video/mp4; codecs="avc1.4d401e, ' + f[1] + '"', "video"); } catch (e) { check(f[0] + " 走 MSE（video）", false, e.message); }
        }
    }
    /* 音乐的整个流程（app 的音乐画面、music.js、flac.js）：一串假的歌，数据从这台电脑上取（TG.source / thumb 对它们换成 HTTP），
     * MP3 → ↓ FLAC（量下载、解码）→ → 快进 → ↓ M4A → ↑↑ 回到 FLAC（解好的留着，应该马上出声）→ 返回列表接着放 */
    async function musicFlow(base) {
        var files = [["t.mp3", "audio/mpeg", "mp3"], ["../flac/long_16.flac", "audio/flac", "flac"], ["t.m4a", "audio/mp4", "m4a"]], list = [], srcs = {};
        for (var i = 0; i < files.length; i++) {
            var f = files[i], src = await Web.httpSource(base + f[0]);
            srcs["selftest:mu" + i] = src;
            list.push({ kind: "music", key: "selftest:mu" + i, fileKey: "selftest:mu" + i, title: "自测 " + f[2].toUpperCase(), performer: "自测", ext: f[2], mime: f[1],
                        size: src.size, duration: 0, date: new Date(), msg: { id: 0, chat: { id: 0 } }, doc: {}, info: { year: "", rating: "", director: "" } });
        }
        var orig = { source: TG.source, thumb: TG.thumb };
        TG.source = function (x) { return srcs[x.fileKey] || orig.source(x); };
        TG.thumb = function (x, w) { return srcs[x.fileKey] ? Promise.resolve(null) : orig.thumb(x, w); };
        var au = document.getElementById("au"), m = window.__app.music;
        function playingIdx(i, t) { return function () { var s = m(); return s.index === i && au.currentTime > t && !au.paused ? true : null; }; }
        try {
            var t0 = Date.now();
            window.__app.playMusic(list, 0);
            var ok = await until(playingIdx(0, 1), 20000);
            check("音乐：MP3 放起来", !!ok, (Date.now() - t0) + "ms，画面「" + txt("mu-title") + " / " + txt("mu-state") + "」");
            t0 = Date.now();
            key(40);
            ok = await until(playingIdx(1, 1), 120000);
            check("音乐：↓ 下一首 FLAC（3 分钟，边下边解成 WAV）", !!ok, (Date.now() - t0) + "ms 出声，时长 " + (isFinite(au.duration) ? au.duration.toFixed(1) : au.duration) + "，状态「" + txt("mu-state") + "」");
            if (ok) {
                var b = au.currentTime;
                key(39);
                var j = await until(function () { return au.currentTime > b + 8 ? true : null; }, 5000);
                check("音乐：FLAC 解出来的 WAV 快进 10 秒", !!j, b.toFixed(1) + " → " + au.currentTime.toFixed(1));
            }
            t0 = Date.now();
            key(40);
            ok = await until(playingIdx(2, 1), 20000);
            check("音乐：↓ 下一首 M4A", !!ok, (Date.now() - t0) + "ms");
            key(38);        // 这首放了不到 5 秒：直接回上一首（放了 5 秒以上的话第一下是回到开头）
            t0 = Date.now();
            ok = await until(playingIdx(1, 0.5), 10000);
            check("音乐：↑ 回到 FLAC（解好的留着）", !!ok, (Date.now() - t0) + "ms 出声");
            key(10009);
            await wait(2500);
            var s = m();
            check("音乐：返回列表接着放", window.__app.screen() === "home" && !s.paused && s.time > 2, "界面 " + window.__app.screen() + "，第 " + (s.index + 1) + " 首 t=" + s.time.toFixed(1));
        } finally {
            window.__app.stopMusic();
            TG.source = orig.source; TG.thumb = orig.thumb;
        }
    }
    async function musicRun() {
        R("开始（界面 " + I18n.lang + "）");
        var home = await until(function () { var s = window.__app.screen(); return s === "home" || s === "login" ? true : null; }, 60000);
        check("启动了", !!home, "现在是 " + window.__app.screen());
        /* 测试文件在部署这台电脑上：上报地址（REPORT_TO = http://<电脑>:8097）换成 test/serve.mjs 的 8768 */
        var base = String(REPORT_TO).replace(/:\d+\/?$/, ":8768") + "/test/media/music/";
        try { await musicFlow(base); } catch (e) { R("音乐流程中止：" + (e && e.message)); }
        /* MSE 放各种音频：10-26 量过了（FLAC 怎么都不解，AAC 行），要再量时打开
         * try { await mseProbes(base); } catch (e) { R("MSE 探测中止：" + (e && e.message)); } */
        /* <audio> 直接放各种格式：10-26 量过了（FLAC 不行，别的都行），要再量时打开
         * try { await musicProbe(base); } catch (e) { R("中止：" + (e && e.message)); } */
        R(fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
    }

    /* --legacy：在这台（有 BigInt 的）电视上强制加载老电视那份 mtcute（tg.legacy.js：大数换成 JSBI、语法降到 Chromium 63，
     * build/legacy/），走一遍真的流程：连 Telegram、认人、取上次那个来源的片子、用单独的播放器下载并放几秒（不进观看进度、不进播放记录）。
     * 第一段设标记、重新加载（boot.js 读 tg.mtcute.v1），第二段测，最后去掉标记再重新加载回正常那份。 */
    var LKEY = "tg.mtcute.v1";
    /* 用单独的播放器、单独的 video 放上次那个来源里的一部（20MB–2GB 里的第一部，两段挑的是同一部），不碰应用的播放器、观看进度、播放记录 */
    async function playCheck(label) {
        var src = Store.lastSource();
        if (!src || src.kind === "web") { R("没有上次的群，不测播放"); return; }
        var t0 = Date.now(), page = await TG.videos(src.id, undefined, 40);
        var it = page.items.filter(function (x) { return x.kind !== "music" && x.kind !== "web" && x.size > 20 * 1048576 && x.size < 2048 * 1048576; })[0];
        check(label + "：取片子", !!it, page.items.length + " 个，" + (Date.now() - t0) + "ms");
        if (!it) { return; }
        var v = document.createElement("video");
        v.muted = true;
        v.style.cssText = "position:absolute;left:0;top:0;width:320px;height:180px;z-index:99";
        document.body.appendChild(v);
        var p = Player.create(v, function (s) { R("（" + label + "）" + s); }, function () {});
        t0 = Date.now();
        var opened = await Promise.race([p.open(TG.source(it), { startAt: 0 }).then(function () { return true; }, function (e) { return "出错：" + (e && e.message); }),
                                         wait(60000).then(function () { return "60 秒没出画面"; })]);
        var ok = opened === true && await until(function () { return v.currentTime > 3 ? true : null; }, 20000);
        check(label + "：下载并放 3 秒（" + (it.asFile ? "文件" : "视频") + " " + Math.round(it.size / 1048576) + "MB）", !!ok,
              (Date.now() - t0) + "ms，" + (opened === true ? "t=" + v.currentTime.toFixed(1) + "，" + v.videoWidth + "x" + v.videoHeight : opened));
        try { p.close(); } catch (e) {}
        v.remove();
    }
    async function legacyRun() {
        if (localStorage.getItem(LKEY) !== "legacy") {
            if (localStorage.getItem("tg.selftest.legacyDone")) { localStorage.removeItem("tg.selftest.legacyDone"); R("测完了，这是装回正常那份的重新加载。装回正常构建：zsh tools/deploy.sh"); return; }
            R("第一段：正常那份（mtcute = " + Boot.info().mtcute + "）放一部，作对照");
            await until(function () { return window.__app.screen() === "home" ? true : null; }, 90000);
            try { await playCheck("正常那份"); } catch (e) { R("第一段中止：" + (e && e.message)); }
            R("设标记，重新加载成老电视那份");
            localStorage.setItem(LKEY, "legacy");
            setTimeout(function () { location.reload(); }, 1000);
            return;
        }
        R("第二段（mtcute = " + Boot.info().mtcute + "，BigInt 在这台电视上" + (typeof BigInt === "undefined" ? "没有" : "有") + "）");
        try {
            check("加载的是老电视那份", Boot.info().mtcute === "legacy", "Boot.info().mtcute = " + Boot.info().mtcute);
            var home = await until(function () { return window.__app.screen() === "home" ? true : null; }, 90000);
            check("连上 Telegram、到主页", !!home, "现在是 " + window.__app.screen());
            var t0 = Date.now(), me = await TG.me();
            check("问「我是谁」", !!(me && me.id), (Date.now() - t0) + "ms");
            await playCheck("老电视那份");
        } catch (e) { R("中止：" + (e && e.message)); }
        finally {
            R(fails ? "结束，" + fails + "/" + steps + " 步失败" : "结束，全部通过（" + steps + " 步）");
            localStorage.removeItem(LKEY);
            localStorage.setItem("tg.selftest.legacyDone", "1");
            setTimeout(function () { location.reload(); }, 1500);
        }
    }

    setTimeout(SELFTEST === "diag" ? diagRun : SELFTEST === "samples" ? samplesRun : SELFTEST === "music" ? musicRun : SELFTEST === "legacy" ? legacyRun : loginExpiryRun, 500);
})();
