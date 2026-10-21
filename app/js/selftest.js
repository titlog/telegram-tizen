/* 设备上的自动走查。只在 zsh tools/deploy.sh --diag 打出来的构建（config.js 的 SELFTEST = "diag"）里跑，别的构建一进来就返回。
 *
 * --diag：诊断日志的上传在电视上走一遍（照 bilibili / douyin 的 --diag）—— 设置页里按「上传诊断日志」，开关关掉再打开，造一次出事等
 * 自动的那一份，传到 TG_DIAG_TO（默认这台电脑上的 PORT=8096 node ../bilibili-tizen/tools/diag-local.mjs）。开关最后放回原样。
 * 派发和遥控器一样的 keydown。最后一行 SELFTEST: 结束，全部通过 / N 步失败。⚠️ 测完马上 zsh tools/deploy.sh 装回正常构建。 */
(function () {
    "use strict";
    if (typeof SELFTEST === "undefined" || SELFTEST !== "diag") { return; }

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

    setTimeout(diagRun, 500);
})();
