/* 网页链接：群里发的网站链接 → 解析出视频地址 → 放（用户 2026-10-02：「群里发一个网站的视频链接，电视自动解析出来开始放」）。
 *
 * 解析：先用 XHR 取页面 HTML、按站点规则找地址；找不到（被 Cloudflare 挡了之类）再用隐藏框打开页面、读页面里的变量 ——
 * widget 能读跨域框的文档（抖音项目 2026-09-29 设备实测）。框里的页面会跑广告、可能自动放视频，所以找到就拆掉。
 *
 * 链接本身就是 .m3u8 / .mp4 的，不用规则，直接放。别的站要一条站点规则，用 Web.register(规则) 加进来 ——
 * 仓库里只带 archive.org 一条（js/sites.js，随更新下发）；别的写在 js/sites.local.js 里（不进仓库，部署时照样打进包里）：
 *
 *   Web.register({
 *       name: "example",                         // 卡片上「网页 · 站名」
 *       host: /(^|\.)example\.com$/i,             // 哪个站
 *       path: /^\/video\/[^/]+/,                  // 哪些地址是片子页（对得上的比「.mp4 结尾就是直链」优先）
 *       normalize: function (u) {},              // 可选：规整地址（u 是 URL 对象，原地改）
 *       title: function (t) { … },                // 可选：整理 Telegram 预览、页面给的标题（去掉站名之类）
 *       resolve: async function (u, H) { … },     // 可选：有公开接口的站直接问接口，不取页面 → {url, note, size}
 *       fromHtml: function (html) { … },          // 从页面 HTML 里找视频地址（.m3u8 或 .mp4），找不到返回 null
 *       fromWin: function (w) { … },              // 可选：从隐藏框里的 window 读（页面用脚本拼地址时）
 *       // 下面是列表（群里发一个列表页的链接，左边来源栏多一项，右边是它的片子），都可选：
 *       list: function (u) { … },                 // 这个地址是不是列表页
 *       listTitle: function (u, 预览标题) { … },   // 来源栏上的名字
 *       parseList: function (html, base, page, H) { … },   // → {items: [{url, title, image, duration}], next: {page, url} | null, total}
 *       listReady: function (doc) { … },          // 隐藏框里的列表页加载好了没有
 *       // 要登录才看得到的列表：
 *       needLogin: function (u) { … },
 *       isLoginPage: function (url) { … },        // XHR 落到的地址是不是登录页（= 没登录上）
 *       publicUrl: function (u, 账号) { … },       // 登录过一次之后改读的公开地址（账号 = login 返回的 {userId, name}）
 *       login: async function (user, pass, H) { … }   // → {ok, msg, userId, name}
 *   });
 *
 * H 是给规则用的工具：get / post / getRetry / postRetry（Cloudflare 挡了隔一会儿再试）/ cloudflare / durSec / normalize / playable。
 *
 *   Web.playable(url)                   这个链接进不进网格
 *   Web.resolve(url)                    → Promise<{url, type: "hls"|"mp4", how, ms, size?}>
 *   Web.httpSource(mp4 地址, 大小?)       → Promise<数据源>：MP4 给播放引擎（player.js）按段读，和 tg.js 的数据源一个样；不认 Range 就失败
 *   Web.meta(url)                       → Promise<{title, image}>（页面的 og:title / og:image，卡片用；存在电视上）
 *   Web.player(video, report, onState)  和 Player 一样的接口：open(item, {startAt}) / seek / toggle / close / time / duration
 *   Web.listable(url) / Web.listTitle(url, 预览标题)
 *   Web.list(url, cursor)               → Promise<{items, next, total}>；要登录时抛 err.needLogin
 *   Web.login(url, 账号, 密码)           → Promise<{ok, msg}>
 *
 * 登录状态多半用不上：网站的会话 cookie 常常没设 SameSite（= Lax），电视页面是 file://、对网站是跨站，跨站请求的 Lax cookie
 * 存不下来（桌面实测：从 file:// 页面 XHR 之后那个站的 cookie 一个都没有）。所以登录只用来拿一次账号编号，之后读公开地址
 * （publicUrl），只存编号和名字，不存密码（2026-10-02）。 */
var Web = (function () {
    "use strict";
    /* 显示给用户的话（i18n.js）；node 里的离线测试没有 I18n，原样用中文 */
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    var SITES = [];
    function register(site) { SITES.push(site); }
    var DIRECT = /\.(m3u8|mp4)$/i;

    function errStr(e) { return (e && (e.message || e.name)) || String(e); }
    function parse(url) { try { return new URL(url); } catch (e) { return null; } }
    function host(url) { var u = parse(url); return u ? u.hostname : ""; }

    /* 规则的 path 对得上的排在直链前面：archive.org 的 /details/<编号>/<文件名>.mp4 是网页，不是文件 */
    function siteOf(url) {
        var u = parse(url), i;
        if (!u || !/^https?:$/.test(u.protocol)) { return null; }
        for (i = 0; i < SITES.length; i++) {
            if (SITES[i].path && SITES[i].host.test(u.hostname) && SITES[i].path.test(u.pathname)) { return SITES[i]; }
        }
        if (DIRECT.test(u.pathname)) { return { name: "direct" }; }
        for (i = 0; i < SITES.length; i++) {
            if (!SITES[i].path && SITES[i].host.test(u.hostname)) { return SITES[i]; }
        }
        return null;
    }
    /* 卡片上的片名：Telegram 预览、页面给的标题多半带着站名 */
    function titleOf(url, t) {
        var s = siteOf(url);
        t = String(t || "");
        return (s && s.title ? s.title(t) : t.split(/\s[-|｜–]\s/)[0]).trim();
    }
    function listOf(url) {
        var u = parse(url);
        if (!u || !/^https?:$/.test(u.protocol)) { return null; }
        for (var i = 0; i < SITES.length; i++) {
            if (SITES[i].list && SITES[i].host.test(u.hostname) && SITES[i].list(u)) { return SITES[i]; }
        }
        return null;
    }
    function typeOf(url) { var u = parse(url); return u && /\.mp4$/i.test(u.pathname) ? "mp4" : "hls"; }

    /* 带 cookie（withCredentials）：Cloudflare 的 cookie、登录的会话都靠它 */
    function get(url, ms) { return xhr("GET", url, null, ms); }
    function xhr(method, url, body, ms) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open(method, url, true);
            x.withCredentials = true;
            x.timeout = ms;
            if (body) { x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded"); x.setRequestHeader("X-Requested-With", "XMLHttpRequest"); }
            x.onload = function () { resolve({ status: x.status, text: x.responseText || "", url: x.responseURL || url }); };
            x.onerror = function () { reject(new Error(tx("网络错误"))); };
            x.ontimeout = function () { reject(new Error(tx("{0} 秒没回", ms / 1000))); };
            x.send(body);
        });
    }
    function cloudflare(text) { return /Just a moment|cf-chl|challenge-platform/i.test(text); }

    /* 隐藏框打开页面，每 150ms 用 pick(框的 window) 看一次，拿到东西就拆掉框。
     * Cloudflare 挡 XHR 不是每次都挡（2026-10-02 桌面：同一个页面一次 403、一次 200）；框是正常打开网页，过了它的检查之后
     * 同一个 cookie 让后面的 XHR 也能过。 */
    function viaFrame(url, pick, ms) {
        return new Promise(function (resolve) {
            var f = document.createElement("iframe"), t0 = Date.now(), note = tx("没开始");
            f.style.cssText = "position:absolute;left:-4000px;top:0;width:640px;height:360px;border:0;visibility:hidden";
            var timer = setInterval(function () {
                var found = null;
                try {
                    var w = f.contentWindow;
                    found = pick(w);
                    note = tx("读得到框，{0}「{1}」", w.location.host, String(w.document.title).slice(0, 30));
                    /* chromewebdata = 浏览器自己的错误页（电视 2026-10-02 开收藏页落到这里），把错误码带上 */
                    if (/chromewebdata/.test(w.location.host) || w.location.protocol === "chrome-error:") {
                        note += " " + tx("错误页：{0}", String(w.document.body && w.document.body.innerText || "").replace(/\s+/g, " ").slice(0, 120));
                    }
                } catch (e) { note = tx("读不了框：{0}", errStr(e)); }
                if (found || Date.now() - t0 > ms) {
                    clearInterval(timer);
                    f.remove();
                    resolve({ url: found || null, note: note });
                }
            }, 150);
            f.src = url;
            document.body.appendChild(f);
        });
    }

    async function resolve(url) {
        url = normalize(url);
        var s = siteOf(url), t0 = performance.now(), notes = [];
        if (!s) { throw new Error(tx("不认识这个网站：{0}", host(url))); }
        if (s.name === "direct") { return { url: url, type: typeOf(url), how: "直链", ms: 0 }; }
        if (s.resolve) {
            var a = await s.resolve(new URL(url), H);
            return { url: a.url, type: typeOf(a.url), size: a.size || 0, how: "接口" + (a.note ? " " + a.note : ""), ms: performance.now() - t0 };
        }
        try {
            var r = await get(url, 15000), found = r.status === 200 ? s.fromHtml(r.text) : null;
            if (found) {
                found = new URL(found, r.url).href;
                return { url: found, type: typeOf(found), how: "XHR", ms: performance.now() - t0 };
            }
            notes.push("XHR " + r.status + (cloudflare(r.text) ? " " + tx("Cloudflare 挡了") : r.status === 200 ? " " + tx("页面里没有地址") : ""));
        } catch (e) { notes.push("XHR " + errStr(e)); }
        var fr = await viaFrame(url, function (w) { return (s.fromWin && s.fromWin(w)) || s.fromHtml(w.document.documentElement.innerHTML); }, 25000);
        notes.push(tx("框：{0}", fr.note));
        if (fr.url) {
            var u = new URL(fr.url, url).href;
            return { url: u, type: typeOf(u), how: notes.join("；"), ms: performance.now() - t0 };
        }
        throw new Error(tx("解析不出视频地址（{0}）", notes.join(tx("；"))));
    }

    /* ---------- 列表 ---------- */

    /* 登录过的站：host → {userId, name}。只存编号和名字，不存密码 */
    var AKEY = typeof Accounts !== "undefined" ? Accounts.scope("tg.webAccount.v1") : "tg.webAccount.v1";     // 每个 Telegram 账号各记各的
    function accounts() { try { return JSON.parse(localStorage.getItem(AKEY) || "{}"); } catch (e) { return {}; } }
    function setAccount(host, a) { var m = accounts(); m[host] = a; try { localStorage.setItem(AKEY, JSON.stringify(m)); } catch (e) {} }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    /* Cloudflare 挡 XHR 是时挡时不挡的（电视 10:19 挡、10:20 放；桌面同一个地址连续几轮都放）。电视上打开列表两次都是
     * 前两次挡、第三次放（等 1.5 + 3 秒，一共 4.9 秒）—— 等待缩短，多试一次（用户 2026-10-02） */
    var CF_WAIT = [0, 300, 600, 1200];
    async function retry(send) {
        var r = null;
        for (var i = 0; i < CF_WAIT.length; i++) {
            if (i) { await sleep(CF_WAIT[i]); }
            try { r = await send(); } catch (e) { r = { status: 0, text: "", err: errStr(e) }; }
            r.tries = i + 1;
            if (!(r.status === 403 && cloudflare(r.text))) { break; }
        }
        return r;
    }
    function getRetry(url, ms) { return retry(function () { return get(url, ms); }).then(function (r) { r.url = r.url || url; return r; }); }
    function postRetry(url, body, ms) { return retry(function () { return xhr("POST", url, body, ms); }); }

    function durSec(t) {
        var p = String(t || "").trim().split(":").map(Number), s = 0;
        if (!p.length || p.some(isNaN)) { return 0; }
        p.forEach(function (x) { s = s * 60 + x; });
        return s;
    }

    /* 给站点规则用的工具（见开头） */
    var H = {
        get: get, post: function (url, body, ms) { return xhr("POST", url, body, ms); },
        getRetry: getRetry, postRetry: postRetry, cloudflare: cloudflare, durSec: durSec,
        normalize: function (url) { return normalize(url); }, playable: function (url) { return !!siteOf(url); }
    };

    /* cursor：第一页传 undefined，之后传上一页返回的 next */
    async function list(url, cursor) {
        var s = listOf(url), page = cursor ? cursor.page : 1, t0 = performance.now();
        if (!s) { throw new Error(tx("不认识这个列表：{0}", url)); }
        if (!s.parseList) { throw new Error(s.name + " 的规则没有 parseList"); }
        var wantLogin = s.needLogin && s.needLogin(new URL(url));
        if (wantLogin) {
            var acct = accounts()[new URL(url).hostname];
            if (!acct) { var e0 = new Error(tx("要登录一次（查账号编号）")); e0.needLogin = true; throw e0; }
            url = s.publicUrl(new URL(url), acct);
            wantLogin = false;
        }
        var at = cursor ? cursor.url : url;
        var r = await getRetry(at, 15000), html = null, how = "XHR" + (r.tries > 1 ? " 第 " + r.tries + " 次" : "");
        /* 要登录的页面没登录：站点多半跳到首页或登录页 */
        if (wantLogin && r.status === 200 && s.isLoginPage && s.isLoginPage(r.url)) {
            var e1 = new Error(tx("要登录（XHR 落到 {0}）", r.url));
            e1.needLogin = true;
            throw e1;
        }
        if (r.status === 200) { html = r.text; }
        else if (!cursor) {
            /* 第一页被 Cloudflare 挡了：框打开一次（过了检查，之后的翻页 XHR 也就通了） */
            how = "框（XHR " + (r.status || r.err) + (cloudflare(r.text) ? " Cloudflare" : "") + "）";
            var fr = await viaFrame(at, function (w) {
                var d = w.document;
                /* 框刚建好时是 about:blank（readyState 也是 complete），要等它真的到了那个站 */
                if (!s.host.test(w.location.hostname) || d.readyState === "loading" || cloudflare(d.title)) { return null; }
                if (wantLogin && s.isLoginPage && s.isLoginPage(w.location.href)) { return "LOGIN"; }
                return (s.listReady ? s.listReady(d) : d.readyState === "complete") ? d.documentElement.outerHTML : null;
            }, 25000);
            if (fr.url === "LOGIN") { var e2 = new Error(tx("要登录（框落到登录页）")); e2.needLogin = true; throw e2; }
            html = fr.url;
            if (!html) { throw new Error(tx("取不到列表（{0}；框：{1}）", how, fr.note)); }
        } else {
            throw new Error(tx("翻页 {0}", r.status || r.err));
        }
        var out = s.parseList(html, r.url || at, page, H);
        out.how = how;
        out.ms = performance.now() - t0;
        if (!out.items.length && wantLogin) { var e3 = new Error(tx("列表是空的（多半是没登录上）")); e3.needLogin = true; throw e3; }
        return out;
    }

    /* 登录由站点规则做（各站的表单不一样）；这里只记下它返回的账号编号和名字，不存密码 */
    async function login(url, user, pass) {
        var s = listOf(url) || siteOf(url);
        if (!s || !s.login) { return { ok: false, msg: tx("这个站不会登录") }; }
        var r;
        try { r = await s.login(user, pass, H); } catch (e) { return { ok: false, msg: errStr(e) }; }
        if (r && r.ok && r.userId) { setAccount(new URL(url).hostname, { userId: String(r.userId), name: r.name || "" }); }
        return r || { ok: false, msg: tx("登录没有结果") };
    }

    function listTitle(url, preview) {
        var s = listOf(url), u = parse(url);
        if (!s || !u) { return ""; }
        var cleanPreview = preview && !/just a moment|attention required/i.test(preview) ? preview : "";
        var t = s.listTitle && s.listTitle(u, cleanPreview);
        if (t) { return t; }
        if (cleanPreview) { return cleanPreview.split(/\s[-|｜–]\s/)[0]; }
        return decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
    }

    /* ---------- 卡片：页面的标题和封面图 ---------- */

    var MKEY = "tg.webMeta.v1", metas = null;
    function metaStore() {
        if (!metas) { try { metas = JSON.parse(localStorage.getItem(MKEY) || "{}"); } catch (e) { metas = {}; } }
        return metas;
    }
    function ogOf(doc, base) {
        function og(p) { var e = doc.querySelector("meta[property='og:" + p + "']"); return e ? e.getAttribute("content") || "" : ""; }
        var title = og("title") || (doc.title || "").split(/\s[-|｜–]\s/)[0], img = og("image");
        return title || img ? { title: title.trim().slice(0, 120), image: img ? new URL(img, base).href : "", at: Date.now() } : null;
    }
    /* 卡片用的框一次只开一个（每个框都是一整个网页、带广告），排队 */
    var frameQ = Promise.resolve();
    async function meta(url) {
        var m = metaStore();
        if (m[url] && Date.now() - m[url].at < 30 * 86400000) { return m[url]; }
        if (!siteOf(url) || siteOf(url).name === "direct") { return null; }
        var out = null, why = "";
        try {
            var r = await get(url, 15000);
            if (r.status === 200) { out = ogOf(new DOMParser().parseFromString(r.text, "text/html"), r.url); }
            else { why = "XHR " + r.status + (cloudflare(r.text) ? "（Cloudflare）" : ""); }
        } catch (e) { why = "XHR " + errStr(e); }
        if (!out) {
            var job = frameQ.then(function () {
                return viaFrame(url, function (w) {
                    var d = w.document;
                    return d.readyState !== "loading" && !cloudflare(d.title) ? ogOf(d, url) : null;
                }, 25000);
            });
            frameQ = job.catch(function () {});
            var fr = await job;
            out = fr.url;
            if (!out) { throw new Error(tx("取不到页面信息（{0}；框：{1}）", why, fr.note)); }
        }
        if (out.title && siteOf(url).title) { out.title = titleOf(url, out.title); }
        m[url] = out;
        var keys = Object.keys(m);
        if (keys.length > 200) { keys.sort(function (a, b) { return m[a].at - m[b].at; }).slice(0, keys.length - 200).forEach(function (k) { delete m[k]; }); }
        try { localStorage.setItem(MKEY, JSON.stringify(m)); } catch (e) {}
        return out;
    }
    function cachedMeta(url) { return metaStore()[url] || null; }

    /* ---------- 播放 ---------- */

    function player(video, report, onState) {
        var S = null, api = {};
        function R(s) { report(s); }
        function mb(n) { return (n / 1048576).toFixed(1) + "MB"; }

        function finish(sess, err) {
            if (sess.settled) { return; }
            sess.settled = true;
            clearTimeout(sess.timer);
            if (err) { sess.reject(err); } else { sess.resolve(); }
        }
        function fail(sess, msg) {
            R("放不了：" + msg);
            if (!sess.settled) { finish(sess, new Error(msg)); } else { onState("error", msg); }
        }

        function teardown(sess) {
            if (sess.hls) { try { sess.hls.destroy(); } catch (e) {} sess.hls = null; }
            try { video.pause(); } catch (e) {}
            video.removeAttribute("src");
            try { video.load(); } catch (e) {}
        }

        function start(sess, url, type, at) {
            sess.url = url;
            sess.type = type;
            if (type === "mp4") {
                video.src = url;
                video.addEventListener("loadedmetadata", function once() {
                    video.removeEventListener("loadedmetadata", once);
                    if (at) { video.currentTime = at; }
                }, false);
                video.play().catch(function () {});
                return;
            }
            if (!window.Hls || !Hls.isSupported()) { fail(sess, tx("这台电视上 hls.js 用不了（没有 MSE？）")); return; }
            /* 缓冲：电视的 SourceBuffer 小（音频那条 ~8MB，见 CLAUDE.md），往前 30–60 秒、往后留 15 秒 */
            var h = sess.hls = new Hls({
                startPosition: at > 0 ? at : -1,
                maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 15, maxBufferSize: 30 * 1000 * 1000,
                enableWorker: true
            });
            h.on(Hls.Events.MANIFEST_PARSED, function (e, d) {
                if (S !== sess) { return; }
                var lv = d.levels.map(function (l) { return (l.width ? l.width + "x" + l.height : "?") + (l.bitrate ? " " + Math.round(l.bitrate / 1000) + "k" : ""); });
                R("清单 " + Math.round(performance.now() - sess.t0) + "ms，" + d.levels.length + " 档：" + lv.join("、"));
                video.play().catch(function () {});
            });
            h.on(Hls.Events.LEVEL_LOADED, function (e, d) {
                if (S !== sess || sess.levelLogged) { return; }
                sess.levelLogged = true;
                var det = d.details;
                R("播放列表：" + det.fragments.length + " 段，" + Math.round(det.totalduration / 60) + " 分钟，" + (det.live ? "直播" : "点播") +
                  (det.fragments[0] && det.fragments[0].decryptdata && det.fragments[0].decryptdata.method ? "，加密 " + det.fragments[0].decryptdata.method : ""));
            });
            h.on(Hls.Events.FRAG_LOADED, function (e, d) {
                if (S !== sess) { return; }
                var st = d.frag.stats, ms = st.loading.end - st.loading.start;
                sess.bytes += st.loaded;
                sess.loadMs += ms;
                sess.frags++;
                if (sess.frags === 1) { R("第一段 " + mb(st.loaded) + " " + Math.round(ms) + "ms（第一个字节 " + Math.round(st.loading.first - st.loading.start) + "ms）"); }
            });
            h.on(Hls.Events.ERROR, function (e, d) {
                if (S !== sess) { return; }
                var code = d.response && d.response.code ? " " + d.response.code : "";
                if (!d.fatal) {
                    if (sess.minor++ < 5) { R("hls 小错 " + d.details + code); }
                    return;
                }
                R("hls 致命 " + d.type + " " + d.details + code);
                if (d.type === Hls.ErrorTypes.NETWORK_ERROR && Date.now() - sess.refreshAt > 60000) {
                    /* 地址签名过期（403）或者网络断过：重新解析拿新地址，从原处接着放。一分钟内只一次，别死循环 */
                    sess.refreshAt = Date.now();
                    refresh(sess, d.details + code);
                    return;
                }
                if (d.type === Hls.ErrorTypes.MEDIA_ERROR && sess.mediaRec < 2) {
                    if (++sess.mediaRec === 2) { h.swapAudioCodec(); }
                    h.recoverMediaError();
                    return;
                }
                fail(sess, d.details + code);
            });
            h.loadSource(url);
            h.attachMedia(video);
        }

        function refresh(sess, why) {
            var at = video.currentTime || sess.startAt, t0 = performance.now();
            onState("buffering");
            teardown(sess);
            resolve(sess.item.url).then(function (r) {
                if (S !== sess) { return; }
                R("重新解析（" + why + "）" + Math.round(performance.now() - t0) + "ms，从 " + Math.round(at) + " 秒接着放");
                start(sess, r.url, r.type, at);
            }).catch(function (e) { if (S === sess) { fail(sess, errStr(e)); } });
        }

        /* 跳转用时：发出跳转到播放头真的在目标那里往前走 */
        video.addEventListener("timeupdate", function () {
            var sess = S;
            if (!sess || !sess.seek || video.paused || video.seeking) { return; }
            var t = video.currentTime, sk = sess.seek;
            if (t > sk.target + 0.2 && t < sk.target + 5) {
                R("跳转到 " + Math.round(sk.target) + " 秒，" + Math.round(performance.now() - sk.t0) + "ms 后接着放");
                sess.seek = null;
            }
        });
        video.addEventListener("playing", function () {
            var sess = S;
            if (!sess) { return; }
            if (!sess.settled) {
                R("出画面 " + Math.round(performance.now() - sess.t0) + "ms，" + video.videoWidth + "x" + video.videoHeight + "，时长 " + Math.round(video.duration / 60) + " 分钟");
                finish(sess);
            }
            onState("playing");
        });
        video.addEventListener("waiting", function () { if (S && S.settled) { onState("buffering"); } });
        video.addEventListener("ended", function () { if (S && S.settled) { onState("ended"); } });
        video.addEventListener("error", function () {
            var sess = S;
            if (!sess || sess.type !== "mp4") { return; }    // hls 那条路的错误走 hls.js 的 ERROR
            fail(sess, "video error " + (video.error && video.error.code));
        });

        api.open = function (item, opts) {
            api.close();
            var sess = S = {
                item: item, t0: performance.now(), startAt: (opts && opts.startAt) || 0,
                hls: null, settled: false, refreshAt: 0, mediaRec: 0, minor: 0, bytes: 0, loadMs: 0, frags: 0, seek: null
            };
            onState("loading");
            /* 一分钟报一次下载速度和缓冲 */
            sess.mon = setInterval(function () {
                if (S !== sess || !sess.frags) { return; }
                var b = video.buffered, ahead = 0;
                for (var i = 0; i < b.length; i++) { if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > video.currentTime) { ahead = b.end(i) - video.currentTime; } }
                R("下载 " + sess.frags + " 段 " + mb(sess.bytes) + "，" + (sess.bytes / 1048576 / (sess.loadMs / 1000)).toFixed(2) + " MB/s，前面缓冲 " + Math.round(ahead) + " 秒，t=" + Math.round(video.currentTime));
            }, 60000);
            return new Promise(function (res, rej) {
                sess.resolve = res;
                sess.reject = rej;
                sess.timer = setTimeout(function () { fail(sess, tx("40 秒没出画面")); }, 40000);
                (opts && opts.resolved ? Promise.resolve(opts.resolved) : resolve(item.url)).then(function (r) {
                    if (S !== sess) { return; }
                    R("解析 " + Math.round(r.ms) + "ms（" + r.how + "）→ " + r.type + " " + Diag.priv(host(r.url)));
                    start(sess, r.url, r.type, sess.startAt);
                }).catch(function (e) { if (S === sess) { fail(sess, errStr(e)); } });
            });
        };

        api.seek = function (sec) {
            /* 还没出画面就设 currentTime，Chromium 记成「默认起播位置」，之后换片子 load() 了也还在（桌面测试抓到的） */
            if (!S || !S.settled) { return; }
            S.seek = { target: sec, t0: performance.now() };
            video.currentTime = sec;
        };
        api.close = function () {
            if (!S) { return; }
            var sess = S;
            S = null;
            clearInterval(sess.mon);
            clearTimeout(sess.timer);
            teardown(sess);
        };
        api.toggle = function () { if (video.paused) { video.play().catch(function () {}); } else { video.pause(); } return !video.paused; };
        api.paused = function () { return video.paused; };
        api.time = function () { return video.currentTime; };
        api.duration = function () { return S && isFinite(video.duration) ? video.duration : 0; };
        return api;
    }

    /* ---------- MP4 给播放引擎读 ---------- */

    /* 网页链接里的 MP4 不交给电视自己的播放器（见 app.js 的 playWeb），给 player.js 读：和 tg.js 的数据源一样的接口
     * {size, stream(offset, signal, throttle) → {start, iter}}。先要一个字节，探出大小（Content-Range；探不到用 sizeHint，
     * archive.org 的接口里有）和跳转之后的地址 —— archive.org 的下载地址 302 到存储节点，之后直接找节点，每次跳转省一个来回；
     * 节点那边不行了再回原地址。读：从 offset 所在的那块起一个请求读到尾，切成 Player.CH 一块，每块交出去之前等 throttle
     * （背压：播放器够了就停在那，TCP 跟着停）。 */
    async function httpSource(url, sizeHint) {
        var t0 = performance.now(), ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 15000), r;
        try { r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: ac.signal }); }
        catch (e) { throw new Error(ac.signal.aborted ? tx("{0} 秒没回", 15) : errStr(e)); }
        finally { clearTimeout(timer); }
        if (r.status !== 206) { throw new Error("HTTP " + r.status); }
        var m = /\/(\d+)\s*$/.exec(r.headers.get("content-range") || ""), size = m ? +m[1] : +sizeHint || 0;
        if (!size) { throw new Error(tx("不知道文件多大")); }
        var at = r.url || url, CH = Player.CH;
        return {
            size: size, probeMs: Math.round(performance.now() - t0), redirected: at !== url ? at : "", sizeFrom: m ? "" : "接口",
            stream: function (offset, signal, throttle) {
                var start = Math.floor(offset / CH) * CH;
                async function* gen() {
                    var res = null;
                    try { res = await fetch(at, { headers: { Range: "bytes=" + start + "-" }, signal: signal }); } catch (e) { if (signal.aborted || at === url) { throw e; } }
                    if ((!res || res.status !== 206) && at !== url && !signal.aborted) {
                        at = url;
                        res = await fetch(at, { headers: { Range: "bytes=" + start + "-" }, signal: signal });
                    }
                    if (res.status !== 206) { throw new Error("HTTP " + res.status); }
                    var rd = res.body.getReader(), buf = new Uint8Array(CH), n = 0;
                    for (;;) {
                        var x = await rd.read();
                        if (x.done) { break; }
                        for (var i = 0; i < x.value.length;) {
                            var take = Math.min(CH - n, x.value.length - i);
                            buf.set(x.value.subarray(i, i + take), n);
                            n += take;
                            i += take;
                            if (n === CH) { await throttle(); yield buf; buf = new Uint8Array(CH); n = 0; }
                        }
                    }
                    if (n) { await throttle(); yield buf.subarray(0, n); }
                }
                return { start: start, iter: gen() };
            }
        };
    }

    /* 去掉 #…，再按站点规整（见各站的 normalize） */
    function normalize(url) {
        var s = siteOf(url), u = parse(url);
        if (!s || !u) { return url; }
        u.hash = "";
        if (s.normalize) { s.normalize(u); }
        return u.href;
    }

    return {
        register: register,
        playable: function (url) { return !!siteOf(url); },
        listable: function (url) { return !siteOf(url) && !!listOf(url); },
        list: list, login: login, listTitle: listTitle, title: titleOf,
        normalize: normalize,
        site: function (url) { var s = siteOf(url); return s ? (s.name === "direct" ? host(url) : s.name) : ""; },
        resolve: resolve, meta: meta, cachedMeta: cachedMeta, player: player, httpSource: httpSource, host: host
    };
})();
