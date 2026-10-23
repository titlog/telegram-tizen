/* 设备上的自动走查。只在 zsh tools/deploy.sh --diag / --loginexpiry 打出来的构建（config.js 的 SELFTEST）里跑，别的构建一进来就返回。
 *
 * --diag：诊断日志的上传在电视上走一遍（照 bilibili / douyin 的 --diag）—— 设置页里按「上传诊断日志」，开关关掉再打开，造一次出事等
 * 自动的那一份，传到 TG_DIAG_TO（默认这台电脑上的 PORT=8096 node ../bilibili-tizen/tools/diag-local.mjs）。开关最后放回原样。
 * --loginexpiry：扫码页上后台线程的连接作废（挂到后台、电视待机一分钟以上，主线程发不出心跳）。添加一个账号到扫码页，port 往后台
 * 线程发的东西全扣下（和挂到后台时一样，只是主线程照常跑），等后台线程作废这条连接，看是不是重连、换一张码、还在扫码页；最后按返回
 * 取消添加。只停心跳不够：后台线程把请求也当心跳，扫码页每 30 秒换码要发请求，第一版停了 90 秒心跳连接都没作废。
 * 1.1.2 上这里 boot() 停住、二维码不再换（2026-10-23 一台别人的电视：「启动出错 signal is aborted without reason」）。
 *
 * 派发和遥控器一样的 keydown。最后一行 SELFTEST: 结束，全部通过 / N 步失败。⚠️ 测完马上 zsh tools/deploy.sh 装回正常构建。 */
(function () {
    "use strict";
    if (typeof SELFTEST === "undefined" || (SELFTEST !== "diag" && SELFTEST !== "loginexpiry")) { return; }

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

    setTimeout(SELFTEST === "diag" ? diagRun : loginExpiryRun, 500);
})();
