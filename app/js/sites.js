/* 仓库里带的站点规则（随更新下发）。格式见 web.js 开头；本机自己写的在 sites.local.js（不进仓库），加载在这个文件后面。
 *
 * archive.org（Internet Archive）：公有领域的老电影、CC 授权的片子，README 拿它当「群里发个网页链接就能放」的例子（2026-10-26）。
 * 片子页 /details/<编号>（也有 /details/<编号>/<文件名>、/embed/<编号>）不取网页，问公开接口 /metadata/<编号>：页面里 og:video
 * 给的是转出来的 640 宽那份，接口里常有原始的 720p / 1080p（Sita Sings the Blues：网页 640×360，接口里有 1920×1080）。
 * 挑法：.mp4 / .m4v、不是 private 的（借阅的片子文件是 private）；时长最长的那一组（同一部片子转出好几份，差 5% 以内算一组 ——
 * DVD 转来的条目里还有一段一段的 VTS_01_1…）；组里不超过 1080 行、不超过 10 Mbps 的先挑（archive.org 单连接常常只有
 * 1–2 MB/s），再挑分辨率高的，一样高取 h.264、取小的。合集（/details/feature_films 这种）不是片子，照直说。 */
(function () {
    "use strict";
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    function pick(files, want, durSec) {
        var v = files.filter(function (f) { return /\.(mp4|m4v)$/i.test(f.name) && String(f.private) !== "true"; });
        /* 指定了文件的：那个文件，或者从它转出来的 */
        var w = want ? v.filter(function (f) { return f.name === want || f.original === want; }) : [];
        if (w.length) { v = w; }
        function len(f) { return durSec(f.length); }
        function h(f) { return +f.height || 0; }
        function mbps(f) { return len(f) ? f.size * 8 / len(f) / 1e6 : 0; }
        function fits(f) { return h(f) <= 1080 && mbps(f) <= 10 ? 1 : 0; }
        function avc(f) { return /h\.?264/i.test(f.format || "") ? 1 : 0; }
        var longest = Math.max.apply(null, v.map(len).concat(0));
        var main = v.filter(function (f) { return len(f) >= longest * 0.95; });
        main.sort(function (a, b) { return fits(b) - fits(a) || h(b) - h(a) || avc(b) - avc(a) || (+a.size || 0) - (+b.size || 0); });
        return main[0] ? { f: main[0], of: v.length, mbps: mbps(main[0]) } : null;
    }

    Web.register({
        name: "archive.org",
        host: /(^|\.)archive\.org$/i,
        path: /^\/(details|embed)\/[^/]+/,
        /* 「His Girl Friday : Free Download, Borrow, and Streaming : Internet Archive」 */
        title: function (t) { return t.replace(/\s*:\s*Free Download, Borrow,? and Streaming\s*:\s*Internet Archive\s*$/i, "").replace(/\s*:\s*Internet Archive\s*$/i, ""); },
        normalize: function (u) { u.search = ""; },
        resolve: async function (u, H) {
            var p = u.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent), id = p[0], d = {};
            /* 接口偶尔回 200 和一个空的 {}（2026-10-26 桌面上两部片子连着这样，过一会儿同样的请求就好了），隔一秒再问一次 */
            for (var i = 0; i < 2 && !d.metadata && !d.is_dark; i++) {
                if (i) { await new Promise(function (ok) { setTimeout(ok, 1000); }); }
                var r = await H.get("https://archive.org/metadata/" + encodeURIComponent(id), 15000);
                if (r.status !== 200) { throw new Error(tx("archive.org 回 {0}", r.status)); }
                d = JSON.parse(r.text || "{}");
            }
            if (d.is_dark) { throw new Error(tx("这个条目在 archive.org 上已经下架了")); }
            if (!d.metadata) { throw new Error(tx("archive.org 上没有这个条目")); }
            if (d.metadata.mediatype === "collection") { throw new Error(tx("这是 archive.org 上的一个合集，不是一部片子")); }
            var c = pick(d.files || [], p.slice(1).join("/"), H.durSec);
            if (!c) { throw new Error(tx("这个条目里没有能放的 MP4")); }
            return {
                url: "https://archive.org/download/" + encodeURIComponent(id) + "/" + c.f.name.split("/").map(encodeURIComponent).join("/"), size: +c.f.size || 0,
                note: (c.f.width ? c.f.width + "x" + c.f.height + " " : "") + c.mbps.toFixed(1) + "Mbps " + (c.f.format || "") + "，" + c.of + " 个 MP4 里挑的"
            };
        }
    });
})();
