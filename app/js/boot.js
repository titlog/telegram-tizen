/* 这次启动跑哪份代码：安装包里的，还是 update.js 之前下载、验过签名的新版本。也是自动更新的信任根 ——
 * 下面那把公钥是唯一能让这个应用跑「不是装进来的代码」的东西，这个文件永远不随更新下发。
 *
 * 照搬 douyin-tizen 的 boot.js（它照搬 bilibili-tizen，2026-10-18 起在那边跑；2026-10-21 搬到这里）。脚本和样式都走 blob: 地址 ——
 * 这里不是「CSP 模式」（config.xml 里刻意没有 allow-navigation 和 CSP），内联 <style> 也行，用 blob: 是为了万一哪天加了 CSP
 * 也照样能跑（那时 script-src、style-src 要加 blob:，tools/update-verify.mjs 卡着）。
 *
 * 和那两个应用不一样的一处：mtcute（js/tg.bundle.js，2.8MB）、hls.js（js/vendor/hls.min.js，600KB）不随更新下发，一直用安装包里的
 * —— 整份存进 localStorage 要 7–8MB（UTF-16），配额没在电视上量过；我们自己的代码只有 ~400KB。更新包里没有的脚本，run() 照样写
 * js/<名字> 从安装包读（js/sites.local.js 也是：它本来就只在自己打的包里有）。所以这两样一变就是换了「壳」：SHELL 加一，
 * 老电视跳过那一版、要重装（tools/update-release.mjs 记着每个 SHELL 对应的这两样的指纹，变了没加一就拒绝发布）。
 *
 * 必须在页面解析期间决定。app.js 从 window.onload 启动；解析结束后才插进去的脚本在 load 之后才跑，
 * 应用就永远起不来。所以选中的脚本用 document.write 写进去，解析器按顺序执行，每个都在 load 之前跑完 ——
 * 和原来的 <script> 标签时机一样。
 *
 * 签名在下载时验（update.js），不在这里：更新包来自这个应用自己的 localStorage，能写那里的东西本来就能在
 * 这个应用里跑代码。这里再验一次意味着在唯一不能有异步步骤的地方加一个异步步骤。
 *
 * 走不到首页的更新包，下次启动标坏、改跑安装包：脚本写进去之前记 booting，只有 Boot.ok()（app.js 启动两秒
 * 没出 js 错误时调）清掉它。ES5，和 app/js 里的一切一样。 */
var Boot = (function () {
    "use strict";

    /* 这个文件实现的更新包约定：body、按顺序的样式、按顺序的脚本（见 tools/update-release.mjs），加上安装包里的 mtcute 和 hls.js。
     * 哪一版的 boot.js 对更新包的期待变了、或者 mtcute / hls.js 换了，就把它加一；SHELL 更老的电视跳过那一版，要重装。
     * 只换了打包目标、补了旧引擎缺的 API（1.1.3）不加：见 CLAUDE.md「Tizen 6.0 上打不开」。 */
    var SHELL = 1;

    /* 安装包的版本，给没有 tizen.application 的引擎（桌面浏览器）用。tools/update-verify.mjs 卡着它和 config.xml 一致。 */
    var PACKAGED_FALLBACK = "1.1.5";

    /* ECDSA P-256 公钥，SPKI，base64。tools/update-key.mjs 写进来；私钥永远不进仓库。 */
    var PUBKEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEE9Z+Uan4otX60X0tFBnW0SeeG9d3GWpAiSJ1Mbk5dygmDUiO+UGhz5hNArZx6/pRtqLERnErGWAWFnrDsCAlDw==";

    /* 安装包的加载顺序，排在 config.js（它有自己的标签：deploy.sh 改写它）和这个文件之后。更新包带着自己的一份，所以一个版本
     * 可以加文件。tg.bundle.js、vendor/hls.min.js、sites.local.js 不在更新包里，永远从安装包读（tools/update-lib.mjs 的 PACKAGED）。 */
    var SCRIPTS = ["diag.js", "log.js", "i18n.js", "accounts.js", "apikey.js", "tg.bundle.js", "mp4.js", "mkv.js", "player.js",
                   "vendor/hls.min.js", "web.js", "sites.local.js", "tg.js", "store.js", "cover.js", "subs.js", "update.js", "app.js", "selftest.js"];

    var K_BUNDLE = "tg.update.bundle", K_META = "tg.update.meta",
        K_BOOTING = "tg.update.booting", K_BAD = "tg.update.bad";

    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
    function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

    function packagedVersion() {
        try {
            var v = tizen.application.getCurrentApplication().appInfo.version;
            if (v) { return String(v); }
        } catch (e) {}
        return PACKAGED_FALLBACK;
    }

    /* 点分数字逐段比较；缺的段算 0。 */
    function cmp(a, b) {
        var x = String(a || "").split("."), y = String(b || "").split(".");
        for (var i = 0; i < Math.max(x.length, y.length); i++) {
            var p = parseInt(x[i] || "0", 10) || 0, q = parseInt(y[i] || "0", 10) || 0;
            if (p !== q) { return p > q ? 1 : -1; }
        }
        return 0;
    }

    function badList() { return parse(get(K_BAD)) || {}; }
    function markBad(version) {
        var bad = badList();
        bad[version] = new Date().getTime();
        put(K_BAD, JSON.stringify(bad));
    }
    function drop() { del(K_BUNDLE); del(K_META); del(K_BOOTING); }

    /* 这次启动决定了什么，给 update.js 报 —— 这个文件自己没有日志通道，没人读得到的决定就是
     * 「退回安装包」变成悬案的方式。 */
    var info = { packaged: packagedVersion(), running: "", note: "" };
    var names = {};   /* blob 地址 → 文件名，给 onerror 那行用 */

    function choose() {
        var meta = parse(get(K_META));
        if (!meta || !meta.version) { return null; }
        if (cmp(meta.version, info.packaged) <= 0) {
            /* 下载之后又手动装了更新的安装包。 */
            drop();
            info.note = "下载过的 " + meta.version + " 不比安装包 " + info.packaged + " 新，删掉了";
            return null;
        }
        if ((meta.shell || 1) > SHELL) {
            drop();
            info.note = meta.version + " 要更新的安装包（shell " + meta.shell + "，这台 " + SHELL + "），删掉了";
            return null;
        }
        if (badList()[meta.version]) {
            drop();
            info.note = meta.version + " 在这台电视上启动失败过，用安装包";
            return null;
        }
        if (get(K_BOOTING) === meta.version) {
            markBad(meta.version);
            drop();
            info.note = "上次用 " + meta.version + " 启动没走到首页，标坏，退回安装包 " + info.packaged;
            return null;
        }
        var b = parse(get(K_BUNDLE));
        if (!b || b.version !== meta.version || !b.files || !b.scripts || !b.scripts.length) {
            drop();
            info.note = "本地的 " + meta.version + " 更新包读不出来（存了一半？），删掉了";
            return null;
        }
        return b;
    }

    function tag(src) { document.write('<script src="' + src + '"><\/script>'); }

    function blobUrl(text, type) {
        return URL.createObjectURL(new Blob([text], { type: type }));
    }

    /* 先换更新包的界面和样式，再写它的脚本。更新包有毛病时会抛异常的步骤都在碰页面之前。 */
    function run(b) {
        var urls = [], sheets = [];
        for (var i = 0; i < b.scripts.length; i++) {
            var name = b.scripts[i], text = b.files["js/" + name];
            var u = text != null ? blobUrl(text, "application/javascript") : "js/" + name;
            names[u] = name;
            urls.push(u);
        }
        var styles = b.styles || [];
        for (var s = 0; s < styles.length; s++) {
            var css = b.files[styles[s]];
            sheets.push(css != null ? blobUrl(css, "text/css") : styles[s]);
        }

        if (typeof b.files.body === "string") {
            var body = document.body, kids = body.childNodes;
            for (var j = kids.length - 1; j >= 0; j--) {
                if (kids[j].nodeName !== "SCRIPT") { body.removeChild(kids[j]); }
            }
            body.insertAdjacentHTML("afterbegin", b.files.body);
        }
        if (sheets.length) {
            var links = document.querySelectorAll('link[rel="stylesheet"]');
            for (var k = 0; k < links.length; k++) { links[k].parentNode.removeChild(links[k]); }
            for (var n = 0; n < sheets.length; n++) {
                var node = document.createElement("link");
                node.rel = "stylesheet";
                node.href = sheets[n];
                document.head.appendChild(node);
            }
        }

        put(K_BOOTING, b.version);
        for (var m = 0; m < urls.length; m++) { tag(urls[m]); }
    }

    function packaged() {
        info.running = info.packaged;
        for (var i = 0; i < SCRIPTS.length; i++) { tag("js/" + SCRIPTS[i]); }
    }

    if (typeof document !== "undefined" && document.write) {
        var chosen = null;
        try { chosen = choose(); }
        catch (e) { info.note = "选代码时出错：" + (e && e.message) + "，用安装包"; }
        if (chosen) {
            try {
                run(chosen);
                info.running = chosen.version;
            } catch (e2) {
                /* 页面可能已经换了一半；重新加载从头开始，版本已经标坏，会走安装包。 */
                markBad(chosen.version);
                drop();
                try { location.reload(); } catch (e3) { packaged(); }
            }
        } else {
            packaged();
        }
    }

    return {
        SHELL: SHELL,
        PUBKEY: PUBKEY,
        cmp: cmp,
        keys: { bundle: K_BUNDLE, meta: K_META, booting: K_BOOTING, bad: K_BAD },
        isBad: function (version) { return !!badList()[version]; },
        /* {packaged, running, note}：这次选了什么、为什么。 */
        info: function () { return { packaged: info.packaged, running: info.running, note: info.note }; },
        /* 应用起来了：这次启动的代码是好的。 */
        ok: function () { del(K_BOOTING); },
        /* 更新包的脚本在 onerror 里是 blob: 地址，一串 uuid 说不出是哪个文件；这里换回文件名。 */
        scriptName: function (src) { return names[src] || String(src || "").split("/").pop(); }
    };
})();
