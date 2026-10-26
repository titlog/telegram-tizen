/* 这台电视用哪组 Telegram API ID / Hash（2026-10-21，为了发布包：issue #1 问为什么没有 .wgt）。
 *
 * Telegram 要求发布出去的应用用发布者自己申请的 API ID（core.telegram.org/api/obtaining_api_id：「It is necessary that you obtain
 * your own API id before you publish your app」），用户不用各自申请 —— Nicegram 这类上架的第三方客户端都是内置一组。Hash 藏不住
 * （Telegram 官方 Android 客户端的源码里就写着它自己的），Telegram 管的是应用的行为：违规先通知负责的账号，10 天不改才停掉。
 * 所以（用户 2026-10-21 定的）安装包里带一组，取自 ~/.telegram-tizen.conf，仓库里不存：deploy.sh 打进自己电视的包是明文
 * （TG_API_ID / TG_API_HASH），release.sh 打进发布包的是打乱过的一串（TG_API_PACKED，包里不放明文）。那不是加密 —— 解开它的
 * 代码就在下面，下决心的人照样解得出来（闭源的客户端也一样，凭证总得在包里）；挡的是解压之后 grep、扫 32 位十六进制串的工具。
 *
 * 填写页（app.js 的 #api）是后路：包里那组被 Telegram 停了、或者包里压根没带（deploy.sh --noapi），用户填自己在 my.telegram.org
 * 申请的，存在这台电视的 localStorage 里（活得过重新安装）。填过的优先于包里带的 —— 包里那组被拒过，才会有填过的。
 *
 * 被拒要到扫码那一步才知道：连接、getMe 都不验它，扫码登录的第一个请求回 400 API_ID_INVALID（2026-10-21 桌面上用真的 mtcute、
 * 一组编出来的凭证量过，主线程和后台线程都是这几个字）。一组被停用的 API ID 回什么没量过（没有这样一组可以试），按同一个错认。
 * app.js 在登录出错时用 rejected(e) 认它，回到填写页。
 *
 *   ApiKey.get() → {id, hash, from: "tv" | "build"} | null
 *   ApiKey.check(id, hash) → {id, hash, idOk, hashOk}     去掉空白，hash 转小写
 *   ApiKey.set(id, hash) → 存上没有        ApiKey.clear()
 *   ApiKey.rejected(err) → Telegram 不认这组凭证
 */
var ApiKey = (function () {
    "use strict";

    var KEY = "tg.api.v1";

    function check(id, hash) {
        id = String(id == null ? "" : id).replace(/\s+/g, "");
        hash = String(hash == null ? "" : hash).replace(/\s+/g, "").toLowerCase();
        return { id: id, hash: hash, idOk: /^[1-9]\d{0,11}$/.test(id), hashOk: /^[0-9a-f]{32}$/.test(hash) };
    }

    /* TG_API_PACKED：base64(8 字节盐 + 「id:hash」逐字节异或 (盐[i%8]·31 + i·17 + 0x5a))，tools/release.sh 的 pack() 写的 */
    function unpack(s) {
        try {
            var b = atob(s), out = "";
            for (var i = 8; i < b.length; i++) {
                var j = i - 8;
                out += String.fromCharCode(b.charCodeAt(i) ^ ((b.charCodeAt(j % 8) * 31 + j * 17 + 0x5a) & 0xff));
            }
            var m = /^([1-9]\d{0,11}):([0-9a-f]{32})$/.exec(out);
            return m ? { id: +m[1], hash: m[2] } : null;
        } catch (e) { return null; }
    }

    function get() {
        var v = null;
        try { v = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { v = null; }
        var c = v ? check(v.id, v.hash) : null;
        if (c && c.idOk && c.hashOk) { return { id: +c.id, hash: c.hash, from: "tv" }; }
        if (typeof TG_API_ID !== "undefined" && TG_API_ID && typeof TG_API_HASH !== "undefined" && TG_API_HASH) {
            return { id: TG_API_ID, hash: TG_API_HASH, from: "build" };
        }
        var p = typeof TG_API_PACKED !== "undefined" && TG_API_PACKED ? unpack(TG_API_PACKED) : null;
        return p ? { id: p.id, hash: p.hash, from: "build" } : null;
    }

    function set(id, hash) {
        var c = check(id, hash);
        if (!c.idOk || !c.hashOk) { return false; }
        try { localStorage.setItem(KEY, JSON.stringify({ id: +c.id, hash: c.hash })); return true; } catch (e) { return false; }
    }

    function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

    function rejected(e) {
        return /API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(String(e && (e.text || e.message) || e));
    }

    return { get: get, check: check, set: set, clear: clear, rejected: rejected };
})();
