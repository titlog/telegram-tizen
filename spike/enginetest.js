/* 新播放引擎（mp4.js + player.js）上电视的测量：搜「末代皇帝」，起播、快进、跳到一半、跳回 30%、快退，
 * 然后关掉重开、从 50 分钟续播。每步报一行，外加主线程卡顿检测。测完留在播放：确认 = 暂停，左右 = ±10 秒。 */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var video = $("v");
    function sleep(t) { return new Promise(function (r) { setTimeout(r, t); }); }
    function say(s) {
        Log.report("tg", s);
        var d = document.createElement("div");
        d.textContent = s;
        $("lines").appendChild(d);
        while ($("lines").children.length > 16) { $("lines").removeChild($("lines").firstChild); }
    }
    function errStr(e) { return (e && (e.message || e.text || e.name)) || String(e); }

    try { ["MediaPlayPause", "MediaFastForward", "MediaRewind"].forEach(function (k) { tizen.tvinputdevice.registerKey(k); }); } catch (e) {}

    /* 主线程卡顿：50ms 的定时器晚到 300ms 以上就报。附上这段时间里我们自己拼分段花了多久（produce）、
     * JS 堆前后的大小（掉得多 = 垃圾回收）—— 用来分清是我们、mtcute 解密，还是 GC。 */
    var lastTick = performance.now(), worst = 0, lastHeap = heap();
    function heap() { return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0; }
    setInterval(function () {
        var now = performance.now(), gap = now - lastTick - 50, h = heap();
        lastTick = now;
        var st = window.__player ? window.__player.takeStats() : { prodMax: 0, prodSum: 0 };
        if (gap > 300) {
            say("主线程卡了 " + Math.round(gap) + "ms | produce 最长 " + Math.round(st.prodMax) + "ms 合计 " + Math.round(st.prodSum) +
                "ms | 堆 " + lastHeap.toFixed(0) + "→" + h.toFixed(0) + "MB");
        }
        lastHeap = h;
        worst = Math.max(worst, gap);
    }, 50);

    function askPassword() {
        say("账号开了两步验证，等输入密码");
        $("pwbox").className = "on";
        var pw = $("pw");
        pw.value = "";
        pw.focus();
        return new Promise(function (resolve) {
            pw.onkeydown = function (e) {
                if ((e.keyCode === 13 || e.keyCode === 65376) && pw.value) { $("pwbox").className = ""; pw.blur(); resolve(pw.value); }
            };
        });
    }

    async function waitMoving(from, ms) {
        var t0 = performance.now();
        while (performance.now() - t0 < ms) {
            if (!video.paused && video.currentTime > from + 0.04) { return Math.round(performance.now() - t0); }
            await sleep(20);
        }
        return -1;
    }

    var player = window.__player = Player.create(video, function (s) { say(s); }, function (ph, msg) { if (msg) { say("状态 " + ph + " " + msg); } });

    async function main() {
        var t = performance.now();
        await TG.init();
        say("连上 Telegram " + Math.round(performance.now() - t) + "ms，mtcute 在 " + TG.mode());
        var me = await TG.me();
        if (!me) {
            $("panel").className = "on";
            me = await TG.login(function (url) { $("qr").innerHTML = TGLib.qrSvg(url, 10); say("出二维码"); },
                function () { $("qrstate").textContent = "已扫码，正在登录…"; }, askPassword, function () { say("密码不对"); });
            $("panel").className = "";
        }
        say("已登录 会员=" + me.isPremium);

        var res = await TG.searchGlobal("末代皇帝");
        var items = res.filter(function (m) { return m.media && m.media.type === "video"; }).map(TG.describe);
        items.sort(function (a, b) { return b.duration - a.duration; });
        if (!items.length) { say("没搜到"); return; }
        var it = items[0];
        say("选中 " + it.title + " | " + it.fileName + " " + (it.size / 1048576).toFixed(0) + "MB " + Math.round(it.duration / 60) + "分");

        worst = 0;
        t = performance.now();
        await player.open(TG.source(it), {});
        say("RESULT 起播 " + Math.round(performance.now() - t) + "ms，期间主线程最长卡 " + Math.round(worst) + "ms");

        await sleep(15000);
        var dur = player.duration();
        var steps = [["快进 +10", function () { player.seek(video.currentTime + 10, 1); }],
                     ["跳到一半", function () { player.seek(dur * 0.5, 0); }],
                     ["跳回 30%", function () { player.seek(dur * 0.3, 0); }],
                     ["快退 -10", function () { player.seek(video.currentTime - 10, -1); }]];
        for (var i = 0; i < steps.length; i++) {
            worst = 0;
            var from = video.currentTime;
            steps[i][1]();
            await sleep(30);
            var ms = await waitMoving(video.currentTime, 30000);
            say("RESULT " + steps[i][0] + "：" + from.toFixed(0) + " → " + video.currentTime.toFixed(1) + "，动起来 " + ms + "ms，主线程最长卡 " + Math.round(worst) + "ms");
            await sleep(12000);
        }

        player.close();
        await sleep(1000);
        worst = 0;
        t = performance.now();
        await player.open(TG.source(it), { startAt: 3000 });
        say("RESULT 关掉重开、从 50 分钟续播 " + Math.round(performance.now() - t) + "ms，t=" + video.currentTime.toFixed(1) + "，主线程最长卡 " + Math.round(worst) + "ms");
        say("测完，接着放。确认 = 暂停，左右 = ±10 秒，返回 = 退出");
    }

    document.addEventListener("keydown", function (e) {
        if ($("pwbox").className) { return; }
        switch (e.keyCode) {
            case 10009: try { tizen.application.getCurrentApplication().exit(); } catch (x) {} break;
            case 13: case 10252: player.toggle(); break;
            case 37: case 412: player.seek(video.currentTime - 10, -1); break;
            case 39: case 417: player.seek(video.currentTime + 10, 1); break;
        }
    });

    main().catch(function (e) { say("主流程出错 " + errStr(e) + " | " + String(e && e.stack || "").split("\n").slice(0, 3).join(" ")); });
})();
