/* 界面和遥控器。三屏：登录（扫码）、主页（左边来源、右边视频网格）、播放器。
 *
 * 用法设计（用户 2026-10-01）：电视上不打字 —— 在手机上搜到片子，转发到「收藏夹」（或自己建的群），电视上点开就放。
 * 所以启动直接进上次看的来源，焦点落在最近看过的那一条上。 */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };
    var video = $("v");
    var COLS = 3, CARD_W = 576, CARD_H = 450, GAP_X = 36, PITCH_Y = 470, LEFT = 60, TOP = 12, VIEW_H = 1030, SRC_H = 72;
    /* TOP：选中卡片的描边比卡片多出 5px，第一排贴着网格区域上沿时被 overflow:hidden 切掉（用户 2026-10-01 拍照指出） */   // 三列、占满全宽（来源栏收起来，用户 2026-10-01）
    var S = {
        screen: "boot", zone: "grid",
        sources: [], railFocus: 0,
        src: null, items: [], next: undefined, total: 0, loading: false, gen: 0, focus: 0,
        thumbs: {}, thumbQ: [], thumbBusy: 0,
        playing: null, pending: null, pendTimer: 0, ovTimer: 0, backAt: 0, logoutAt: 0
    };
    function R(s) { Log.report("app", s); }
    function errStr(e) { return (e && (e.message || e.text || e.name)) || String(e); }

    try {
        ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaFastForward", "MediaRewind"].forEach(function (k) {
            tizen.tvinputdevice.registerKey(k);
        });
    } catch (e) {}

    /* ---------- 小工具 ---------- */

    function fmtTime(s) {
        s = Math.max(0, Math.floor(s || 0));
        var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
        return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (x < 10 ? "0" : "") + x;
    }
    function fmtSize(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB"; }
    function fmtDate(d) {
        if (!d) { return ""; }
        var now = new Date();
        return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]; }); }

    var toastTimer = 0;
    function toast(msg, ms) {
        var t = $("toast");
        t.innerHTML = "<span>" + esc(msg) + "</span>";
        t.style.display = "block";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.style.display = "none"; }, ms || 2500);
    }

    /* ---------- 启动 ---------- */

    async function boot() {
        var t0 = performance.now();
        try {
            await TG.init();
        } catch (e) {
            R("连不上 Telegram：" + errStr(e));
            $("home").classList.add("hide");
            $("panel").classList.add("on");
            $("how").innerHTML = "<div style='font-size:48px'>连不上 Telegram</div><div style='font-size:30px;color:#999;margin-top:20px'>" +
                esc(errStr(e)) + "<br>检查网络后按确认重试</div>";
            S.screen = "bootfail";
            return;
        }
        R("连上 Telegram " + Math.round(performance.now() - t0) + "ms，mtcute 在 " + TG.mode());
        var me = await TG.me();
        if (!me) { await login(); }
        S.screen = "home";
        $("home").classList.remove("hide");
        /* 不要收藏夹（用户 2026-10-01：习惯用自己建的一个群）。上次的来源直接开；第一次用就等探测到第一个有视频的。 */
        var last = Store.lastSource();
        if (last && last.id === "me") { last = null; }
        if (last) {
            S.sources = [last];
            renderRail();
            await openSource(last, { quiet: true });
            R("启动到主页 " + Math.round(performance.now() - t0) + "ms，来源「" + S.src.title + "」" + S.items.length + " 个视频");
        } else {
            $("empty").innerHTML = "正在找有视频的群和频道…";
        }
        loadSources(!last);
    }

    /* 左边只列有视频的来源。每个来源问一次「有几个视频」（limit 1），结果存在电视上，下次启动先用存的、后台再问一遍。 */
    /* 来源栏的刷新：第一版只在启动时取一次，之后新建 / 加入的群、刚转发进视频的群都不出现（用户 2026-10-01 问「怎么没有及时更新」）。
     * 现在打开来源栏时（20 秒内只一次）、从后台切回来时、停在主页每 5 分钟都重新取一遍。 */
    var srcAt = 0;
    function refreshSources(force) {
        if (S.srcLoading || S.screen !== "home") { return; }
        if (!force && Date.now() - srcAt < 20000) { return; }
        loadSources(false);
    }
    setInterval(function () { refreshSources(false); }, 5 * 60000);

    async function loadSources(openFirst) {
        var list;
        S.srcLoading = true;
        srcAt = Date.now();
        try { list = await TG.sources(40); } catch (e) { S.srcLoading = false; R("来源列表出错 " + errStr(e)); return; }
        S.allSources = list;
        var before = S.sources.map(function (s) { return s.id; }).join(",");
        function refresh() {
            /* 光标留在原来那个来源上（列表变了下标会变） */
            var focusedId = S.zone === "rail" && railItems()[S.railFocus] ? railItems()[S.railFocus].id : null;
            /* 网页列表（群里发的收藏、分类链接）排最前面 */
            S.sources = Store.webSources().concat(list.filter(function (s) {
                var c = Store.srcCount(s.id);
                return (c && c.n > 0) || (S.src && s.id === S.src.id);
            }));
            var fi = focusedId === null ? -1 : railItems().findIndex(function (s) { return s.id === focusedId; });
            S.railFocus = fi >= 0 ? fi : Math.min(S.railFocus, railItems().length - 1);
            renderRail();
        }
        refresh();
        var t0 = performance.now(), probed = 0, withVideo = 0, i = 0;
        async function worker() {
            while (i < list.length) {
                var s = list[i++];
                try {
                    var n = await TG.videoCount(s.id);
                    Store.setSrcCount(s.id, n);
                    probed++;
                    if (n > 0) {
                        withVideo++;
                        if (openFirst && !S.src) { openSource(s); }
                    }
                    refresh();
                } catch (e) { /* 频道没权限之类，跳过 */ }
            }
        }
        await Promise.all([worker(), worker()]);
        await refreshWebSources(list);
        S.srcLoading = false;
        var after = S.sources.map(function (s) { return s.id; }).join(",");
        R("来源：" + list.length + " 个会话里 " + withVideo + " 个有视频（问了 " + probed + " 个，" + Math.round(performance.now() - t0) + "ms）" +
          (before && before !== after ? "，列表变了" : ""));
        if (openFirst && !S.src) {
            $("src-sub").textContent = "";
            $("empty").innerHTML = "还没有哪个群里有视频。<br>在手机上把想看的片子转发到一个群（比如自己建的），回到电视上按确认刷新。";
        }
    }

    async function login() {
        S.screen = "login";
        $("home").classList.add("hide");
        $("panel").classList.add("on");
        var n = 0;
        await TG.login(function (url) {
            n++;
            $("qr").innerHTML = TGLib.qrSvg(url, 10);
            $("qrstate").textContent = "二维码 30 秒换一张（第 " + n + " 张）";
        }, function () {
            $("qrstate").textContent = "已扫码，正在登录…";
        }, askPassword, function () { toast("两步验证密码不对，再输一次"); });
        R("扫码登录成功（出了 " + n + " 张码）");
        $("panel").classList.remove("on");
    }

    function askPassword() {
        S.screen = "password";
        $("pwbox").className = "on";
        var pw = $("pw");
        pw.value = "";
        pw.focus();
        return new Promise(function (resolve) {
            pw.onkeydown = function (e) {
                if ((e.keyCode === 13 || e.keyCode === 65376) && pw.value) {
                    $("pwbox").className = "";
                    pw.blur();
                    S.screen = "login";
                    resolve(pw.value);
                }
            };
        });
    }

    /* ---------- 来源 ---------- */

    var KIND = { self: "", group: "群", channel: "频道", user: "私聊", web: "网页" };

    function railItems() { return S.sources.concat([{ id: "__logout", title: "退出登录", kind: "" }]); }

    function renderRail() {
        $("home").classList.toggle("railopen", S.zone === "rail");
        var list = railItems(), html = "";
        list.forEach(function (s, i) {
            var cls = "src" + (S.src && s.id === S.src.id ? " cur" : "") + (S.zone === "rail" && i === S.railFocus ? " focus" : "");
            html += "<div class='" + cls + "'>" + (KIND[s.kind] ? "<span class='k'>" + KIND[s.kind] + "</span>" : "") + esc(s.title) + "</div>";
        });
        $("rail-list").innerHTML = html;
        var off = Math.max(0, Math.min((S.railFocus - 5) * SRC_H, list.length * SRC_H - 900));
        $("rail-list").style.transform = "translateY(" + (-Math.max(0, off)) + "px)";
    }

    /* opts.quiet：开机进上次的来源时，要登录的不自动弹登录框（用户 2026-10-02：每次开机都被它挡住），按确认才弹 */
    async function openSource(src, opts) {
        S.src = { id: src.id, title: src.title, kind: src.kind, url: src.url };
        Store.setLastSource(S.src);
        var g = ++S.gen;
        S.items = []; S.next = undefined; S.total = 0; S.focus = 0; S.gridOff = 0; S.loading = true;
        $("src-title").textContent = src.title;
        $("src-sub").textContent = "加载中…";
        renderGrid();
        renderRail();
        var t0 = performance.now(), page, links;
        if (src.kind === "web") { return openWebList(S.src, g, t0, opts || {}); }
        /* 群里发的网站链接（web.js）跟视频混在一起按时间排。只取最近 40 条带链接的消息，翻页只翻视频 */
        var linksP = TG.links(src.id, 40).catch(function (e) { R("来源「" + src.title + "」取链接出错 " + errStr(e)); return []; });
        try {
            page = await TG.videos(src.id, undefined, 40);
            links = await linksP;
        } catch (e) {
            if (g !== S.gen) { return; }
            S.loading = false;
            R("来源「" + src.title + "」出错 " + errStr(e));
            $("src-sub").textContent = "";
            $("empty").innerHTML = "读不到这里的视频：" + esc(errStr(e)) + "<br>按确认重试";
            return;
        }
        if (g !== S.gen) { return; }
        S.loading = false;
        syncWebSources(src, links.filter(function (l) { return l.kind === "weblist"; }));
        links = links.filter(function (l) { return l.kind === "web"; });
        S.items = page.items.concat(links).sort(function (a, b) { return b.date - a.date; });
        S.next = page.next;
        S.total = page.total + links.length;
        /* 焦点落在最近看过的那一条 */
        var best = -1, at = 0;
        S.items.forEach(function (it, i) {
            var p = Store.getProgress(it.fileKey);
            if (p && p.at > at) { at = p.at; best = i; }
        });
        S.focus = best >= 0 ? best : 0;
        R("来源「" + src.title + "」" + Math.round(performance.now() - t0) + "ms，" + S.items.length + "/" + S.total + " 个视频" + (links.length ? "（其中网页链接 " + links.length + " 个）" : ""));
        renderGrid();
    }

    async function loadMore() {
        if (S.loading || S.next === undefined || S.next === null) { return; }
        S.loading = true;
        var g = S.gen;
        if (S.src.kind === "web") {
            try {
                var wp = await Web.list(S.src.url, S.next);
                if (g !== S.gen) { return; }
                /* 翻页期间网站上新加了片子，整个列表往后挪，同一个会在下一页再出现一次 */
                var have = {};
                S.items.forEach(function (it) { have[it.url] = true; });
                S.items = S.items.concat(wp.items.filter(function (x) { return !have[x.url]; }).map(webItem));
                S.next = wp.next;
                if (wp.total) { S.total = wp.total; }
                renderGrid();
            } catch (e) {
                R("列表翻页出错 " + errStr(e));
            } finally { if (g === S.gen) { S.loading = false; } }
            return;
        }
        try {
            var page = await TG.videos(S.src.id, S.next, 40);
            if (g !== S.gen) { return; }
            S.items = S.items.concat(page.items);
            S.next = page.items.length ? page.next : undefined;
            renderGrid();
        } catch (e) {
            R("翻页出错 " + errStr(e));
        } finally { if (g === S.gen) { S.loading = false; } }
    }

    /* ---------- 网页列表当来源（web.js）：群里发的收藏、分类链接 ---------- */

    /* 这个群里这次找到的列表链接，替换掉上次存的；新出现的提示一下 */
    function syncWebSources(group, lists) {
        var before = {};
        Store.webSources().forEach(function (s) { before[s.id] = true; });
        var mine = lists.map(function (l) { return { id: "web:" + l.url, title: l.title, kind: "web", url: l.url }; });
        Store.setWebSources(String(group.id), mine);
        var added = mine.filter(function (s) { return !before[s.id]; });
        S.sources = Store.webSources().concat(S.sources.filter(function (s) { return s.kind !== "web"; }));
        renderRail();
        if (added.length) {
            R("群「" + group.title + "」里的列表链接 → 来源：" + added.map(function (s) { return s.title + " " + s.url; }).join("，"));
            toast("左边多了" + (added.length > 1 ? " " + added.length + " 个来源" : "一个来源「" + added[0].title + "」") + "，按 ← 打开", 5000);
        }
    }

    /* 发过列表链接的群，跟着来源栏一起刷新（开机、打开来源栏、每 5 分钟）：手机上刚发的链接，电视上按一下 ← 就出来，
     * 不用先进那个群（第一版只在打开那个群时才读，用户发完公开链接电视上一直没出来，2026-10-02） */
    async function refreshWebSources(dialogs) {
        var groups = Store.webSourceGroups();
        for (var i = 0; i < groups.length; i++) {
            var d = dialogs.filter(function (x) { return String(x.id) === groups[i]; })[0];
            if (!d) { continue; }
            try {
                var ls = await TG.links(d.id, 40);
                syncWebSources(d, ls.filter(function (l) { return l.kind === "weblist"; }));
            } catch (e) { R("刷新群「" + d.title + "」的列表链接出错 " + errStr(e)); }
        }
    }

    function webItem(x) {
        return {
            kind: "web", key: "web:" + x.url, fileKey: "web:" + x.url, url: x.url, site: new URL(x.url).hostname.replace(/^www\./, ""),
            doc: null, image: x.image, title: x.title || x.url, caption: "", size: 0, duration: x.duration || 0, date: null,
            hasCover: false, info: { year: "", rating: "", director: "" }
        };
    }

    async function openWebList(src, g, t0, opts) {
        var page;
        try {
            page = await Web.list(src.url);
        } catch (e) {
            if (g !== S.gen) { return; }
            S.loading = false;
            $("src-sub").textContent = "";
            if (e.needLogin) {
                R("列表「" + src.title + "」要登录：" + errStr(e) + (S.loggedIn[src.id] ? "（刚登录成功过 —— 登录状态没带上）" : ""));
                if (S.loggedIn[src.id]) {
                    $("empty").innerHTML = "登录成功了，但还是看不到这个列表。<br>电视可能带不上这个网站的登录状态（日志里有详情）。";
                } else {
                    $("empty").innerHTML = "这个列表要登录一次才能看（查账号编号）。<br>按确认登录";
                    if (!opts.quiet) { webLogin(src); }
                }
                return;
            }
            R("列表「" + src.title + "」出错 " + errStr(e));
            $("empty").innerHTML = "读不到这个列表：" + esc(errStr(e)) + "<br>按确认重试";
            return;
        }
        if (g !== S.gen) { return; }
        S.loading = false;
        S.items = page.items.map(webItem);
        S.next = page.next;
        S.total = page.total || S.items.length;
        var best = -1, at = 0;
        S.items.forEach(function (it, i) {
            var p = Store.getProgress(it.fileKey);
            if (p && p.at > at) { at = p.at; best = i; }
        });
        S.focus = best >= 0 ? best : 0;
        R("列表「" + src.title + "」" + Math.round(performance.now() - t0) + "ms（" + page.how + "），" + S.items.length + "/" + (page.total || "?") + " 个" + (page.next ? "，有下一页" : ""));
        renderGrid();
    }

    /* ---------- 网页登录（有的站的列表要登录）：两个输入框，遥控器调出屏幕键盘输入，键盘上的「完成」跳下一格 / 提交。
     * 密码不存、不写日志；登录状态是网站的 cookie，留在电视的浏览器引擎里。 ---------- */

    S.loggedIn = {};
    function webLogin(src) {
        S.screen = "weblogin";
        S.loginSrc = src;
        $("wl-site").textContent = new URL(src.url).hostname;
        $("wl-msg").textContent = "";
        $("wl-user").value = "";
        $("wl-pass").value = "";
        $("wl").classList.add("on");
        setTimeout(function () { $("wl-user").focus(); }, 50);
    }
    function closeWebLogin() {
        $("wl").classList.remove("on");
        try { document.activeElement.blur(); } catch (e) {}
        S.screen = "home";
    }
    function submitWebLogin() {
        var src = S.loginSrc, user = $("wl-user").value.trim(), pass = $("wl-pass").value;
        if (!user) { $("wl-user").focus(); return; }
        if (!pass) { $("wl-pass").focus(); return; }
        $("wl-msg").textContent = "正在登录…";
        try { document.activeElement.blur(); } catch (e) {}
        var t0 = performance.now();
        Web.login(src.url, user, pass).then(function (r) {
            R("登录 " + new URL(src.url).hostname + "：" + (r.ok ? "成功，账号编号 " + r.userId + (r.favs != null ? "，收藏 " + r.favs + " 个" : "") : "失败 " + r.msg) + "，" + Math.round(performance.now() - t0) + "ms");
            if (!r.ok) { $("wl-msg").textContent = "登录失败：" + r.msg; $("wl-pass").value = ""; $("wl-pass").focus(); return; }
            S.loggedIn[src.id] = true;
            closeWebLogin();
            toast("登录成功");
            openSource(src);
        }).catch(function (e) {
            R("登录出错 " + errStr(e));
            $("wl-msg").textContent = "登录出错：" + errStr(e);
        });
    }
    /* 13 = 确认，65376 = 屏幕键盘上的「完成」 */
    ["wl-user", "wl-pass"].forEach(function (id) {
        $(id).addEventListener("keydown", function (e) {
            if (e.keyCode !== 13 && e.keyCode !== 65376) { return; }
            e.preventDefault();
            e.stopPropagation();      // 不然冒泡到 document 的按键处理，又提交一次
            if (id === "wl-user" && this.value.trim()) { $("wl-pass").focus(); }
            else { submitWebLogin(); }
        });
    });
    function webLoginKey(k) {
        var inInput = document.activeElement && document.activeElement.tagName === "INPUT";
        if (k === 10009) {
            /* 输入框里按返回先收起键盘、不退出；不在输入框里再按一次才退出 */
            if (inInput) { document.activeElement.blur(); return; }
            closeWebLogin();
            return;
        }
        if (inInput) { return; }
        if (k === 38) { $("wl-user").focus(); }
        else if (k === 40) { $("wl-pass").focus(); }
        else if (k === 13) { if ($("wl-user").value.trim() && $("wl-pass").value) { submitWebLogin(); } else { $(!$("wl-user").value.trim() ? "wl-user" : "wl-pass").focus(); } }
    }

    /* ---------- 网格 ---------- */

    function cardHtml(it, i) {
        var p = Store.getProgress(it.fileKey);
        var x = LEFT + (i % COLS) * (CARD_W + GAP_X), y = TOP + Math.floor(i / COLS) * PITCH_Y;
        var th = S.thumbs[it.fileKey];
        var meta = [it.kind === "web" ? "网页 · " + it.site : fmtSize(it.size), fmtDate(it.date)].filter(Boolean).join(" · ");
        if (p && p.done) { meta = "看完了 · " + meta; }
        else if (p && p.t > 0) { meta = "看到 " + fmtTime(p.t) + " · " + meta; }
        return "<div class='card' id='c" + i + "' style='left:" + x + "px;top:" + y + "px'>" +
            "<div class='thumb" + (th && th.kind === "poster" ? " hasposter" : "") + "'><div class='ph' style='" + phStyle(it.title) + "'><span>" + esc(it.title) + "</span></div>" + (th && th.url ? coverHtml(it, th) : "") +
            (it.duration ? "<div class='dur'>" + fmtTime(it.duration) + "</div>" : "") +
            (p && p.t > 0 && p.d ? "<div class='prog' style='width:" + Math.min(100, p.t / p.d * 100).toFixed(1) + "%'></div>" : "") +
            "</div><div class='title'>" + esc(it.title) + "</div><div class='meta'>" + esc(meta) + "</div></div>";
    }

    /* 片名卡片的底色：按片名算一个色相，深色渐变（用户嫌纯文字卡片不好看，2026-10-01） */
    function phStyle(title) {
        var h = 0;
        for (var i = 0; i < title.length; i++) { h = (h * 31 + title.charCodeAt(i)) % 360; }
        return "background:linear-gradient(135deg,hsl(" + h + ",45%,26%),hsl(" + ((h + 40) % 360) + ",50%,12%))";
    }

    function renderGrid() {
        var html = "";
        S.items.forEach(function (it, i) { html += cardHtml(it, i); });
        $("grid").innerHTML = html;
        $("grid").style.height = TOP + Math.ceil(S.items.length / COLS) * PITCH_Y + "px";
        if (S.loading && !S.items.length) {
            $("empty").innerHTML = "加载中…";
        } else if (!S.items.length) {
            $("empty").innerHTML = "这里没有视频。<br>在手机上找到想看的片子，长按 → <b>转发</b> → 选这个群，回到电视上按确认刷新。";
        } else {
            $("empty").innerHTML = "";
        }
        if (S.src && !S.loading) {
            $("src-sub").textContent = S.total ? "共 " + S.total + " 个视频" + (S.items.length < S.total ? "（已加载 " + S.items.length + "）" : "") : "";
        }
        updateFocus();
    }

    function updateFocus() {
        var old = document.querySelector(".card.focus");
        if (old) { old.classList.remove("focus"); }
        if (!S.items.length) { return; }
        S.focus = Math.max(0, Math.min(S.focus, S.items.length - 1));
        var el = $("c" + S.focus);
        if (el && S.zone === "grid") { el.classList.add("focus"); }
        var row = Math.floor(S.focus / COLS), rows = Math.ceil(S.items.length / COLS);
        /* 只在要选的那一排露不全时才滚，滚到刚好露全为止；看得见的就只挪焦点、画面不动（用户 2026-10-02：「眼睛里有 9 个视频，
         * 想选第一行中间那个，一按上键那一行就滑下来，眼睛还得跟着动」—— 第一版是焦点那一排永远停在第二排的位置）。
         * 卡片 450 高，上面留 TOP（描边），下面留 10 */
        var y = TOP + row * PITCH_Y, off = S.gridOff || 0;
        if (y - TOP < off) { off = y - TOP; }
        else if (y + CARD_H + 10 > off + VIEW_H) { off = y + CARD_H + 10 - VIEW_H; }
        off = Math.max(0, Math.min(off, Math.max(0, TOP + rows * PITCH_Y - VIEW_H + 30)));
        S.gridOff = off;
        $("grid").style.transform = "translateY(" + (-off) + "px)";
        wantThumbs(Math.max(0, (row - 1) * COLS), Math.min(S.items.length, (row + 4) * COLS));
        if (row >= rows - 2) { loadMore(); }
    }

    /* 封面：只取焦点附近几行，同时最多 3 个。顺带把文件所在的数据中心连上，点播放时第一块就快了。 */
    function wantThumbs(a, b) {
        for (var i = a; i < b; i++) {
            var it = S.items[i];
            if (it && S.thumbs[it.fileKey] === undefined && S.thumbQ.indexOf(it) < 0) { S.thumbQ.push(it); }
        }
        pumpThumbs();
    }
    function setThumb(it, c) {
        /* 海报先做一张「缩小再放大」的背景（见 posterBg），做好了再放上去 */
        if (c.kind === "poster" && !c.bg) {
            posterBg(c.url).then(function (bg) { c.bg = bg || "none"; setThumb(it, c); });
            return;
        }
        S.thumbs[it.fileKey] = c;
        var i = S.items.indexOf(it), el = i >= 0 && $("c" + i);
        if (el) {
            var th = el.querySelector(".thumb");
            th.querySelectorAll("img, .pbg").forEach(function (n) { n.remove(); });
            th.classList.toggle("hasposter", c.kind === "poster");
            th.insertAdjacentHTML("beforeend", coverHtml(it, c));
        }
    }

    /* 海报是竖的、卡片是横的：海报完整居中，两边用同一张海报铺底（用户 2026-10-01：卡片上不要字，只放海报，片名看卡片下面）。
     * 底图是把海报画进 24×14 的小画布再拉伸 —— 缩小本身就是模糊，不用 CSS 滤镜（抖音项目实测滤镜在这台电视上很贵）。 */
    function coverHtml(it, c) {
        if (c.kind !== "poster") { return "<img src='" + c.url + "'>"; }
        return (c.bg && c.bg !== "none" ? "<div class='pbg' style='background-image:url(" + c.bg + ")'></div>" : "") +
            "<img class='pimg' src='" + c.url + "'>";
    }

    function posterBg(url) {
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                try {
                    var c = document.createElement("canvas");
                    c.width = 24; c.height = 14;
                    var g = c.getContext("2d"), s = Math.max(24 / img.width, 14 / img.height);
                    g.drawImage(img, (24 - img.width * s) / 2, (14 - img.height * s) / 2, img.width * s, img.height * s);
                    resolve(c.toDataURL("image/png"));
                } catch (e) { resolve(null); }
            };
            img.onerror = function () { resolve(null); };
            img.src = url;
        });
    }

    /* 从片子中间解一帧当封面：一次一个，只在主页、没在播放的时候做 */
    S.coverQ = []; S.coverBusy = false; S.coverDone = {}; S.coverLogs = 0;
    function wantCover(it, why) {
        if (S.coverDone[it.fileKey] || S.coverQ.some(function (q) { return q.it === it; })) { return; }
        S.coverQ.push({ it: it, why: why });
        pumpCover();
    }

    /* 兜底：电影去维基百科找海报；不是电影或者没找到 → 记下「没有封面」，只显示片名卡片 */
    function fallbackPoster(it) {
        if (it.duration < 2400 || Store.noPoster(it.fileKey)) { Cover.keepNone(it); return; }
        Cover.poster(it).then(function (ps) {
            if (ps) { R("海报「" + it.title + "」← " + ps.info); setThumb(it, ps); }
            else { Store.markNoPoster(it.fileKey); Cover.keepNone(it); R("海报：维基百科没找到对得上的「" + it.title + "」"); }
        }).catch(function (e) { R("海报出错「" + it.title + "」" + errStr(e)); });
    }
    function pumpCover() {
        if (S.coverBusy || !S.coverQ.length || S.screen !== "home") { return; }
        var job = S.coverQ.shift(), it = job.it;
        S.coverBusy = true;
        if (S.coverLogs < 4) { R("封面帧开始「" + it.title + "」" + job.why); }
        Cover.grab(it).then(function (r) {
            S.coverDone[it.fileKey] = true;
            setThumb(it, { url: r.url, kind: "frame" });
            R("封面帧「" + it.title + "」" + job.why + " → " + r.info);
        }).catch(function (e) {
            if (e && e.cancelled) { S.coverQ.unshift(job); return; }
            S.coverDone[it.fileKey] = true;
            Store.markNoFrame(it.fileKey);
            if (S.coverLogs++ < 4) { R("封面帧失败「" + it.title + "」" + job.why + "：" + errStr(e)); }
            fallbackPoster(it);
        }).then(function () { S.coverBusy = false; pumpCover(); });
    }

    /* 图片缩到 16×9 算平均亮度（0–255）。blob: 地址同源，画布读得出来（视频帧读不出来，图片可以） */
    function darkness(url) {
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                try {
                    var c = document.createElement("canvas");
                    c.width = 16; c.height = 9;
                    var g = c.getContext("2d");
                    g.drawImage(img, 0, 0, 16, 9);
                    var d = g.getImageData(0, 0, 16, 9).data, sum = 0;
                    for (var i = 0; i < d.length; i += 4) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; }
                    resolve(sum / (d.length / 4));
                } catch (e) { resolve(255); }
            };
            img.onerror = function () { resolve(0); };
            img.src = url;
        });
    }

    /* 网页链接的封面：本地缓存 → Telegram 给链接生成的预览图 → 页面的 og:image（顺带拿 og:title 当片名）。
     * 不截帧、不找海报 —— 那两样都要读 Telegram 上的文件。 */
    function fetchImage(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) { throw new Error("封面图 " + r.status); }
            return r.arrayBuffer();
        });
    }
    function webThumb(it) {
        return Cover.cached(it).then(function (c) {
            if (c) { if (c.kind !== "none") { setThumb(it, c); } return; }
            /* 列表里来的：列表页上就有封面图 */
            if (it.image) {
                return fetchImage(it.image).then(function (b) {
                    setThumb(it, { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), kind: "thumb" });
                    Cover.keepThumb(it, b);
                });
            }
            var first = it.doc ? TG.thumb(it, CARD_W).catch(function () { return null; }) : Promise.resolve(null);
            return first.then(function (th) {
                if (th) { setThumb(it, { url: th.url, kind: "thumb" }); Cover.keepThumb(it, th.bytes); return; }
                return Web.meta(it.url).then(function (m) {
                    if (m && m.title && it.title === it.site) { it.title = m.title; retitle(it); }
                    if (!m || !m.image) { Cover.keepNone(it); return; }
                    return fetchImage(m.image).then(function (b) {
                        setThumb(it, { url: URL.createObjectURL(new Blob([b], { type: "image/jpeg" })), kind: "thumb" });
                        Cover.keepThumb(it, b);
                    });
                });
            });
        });
    }
    function retitle(it) {
        var i = S.items.indexOf(it), el = i >= 0 && $("c" + i);
        if (el) { el.querySelector(".title").textContent = it.title; el.querySelector(".ph span").textContent = it.title; }
    }

    function pumpThumbs() {
        while (S.thumbBusy < 3 && S.thumbQ.length) {
            var it = S.thumbQ.shift();
            if (S.thumbs[it.fileKey] !== undefined) { continue; }
            S.thumbs[it.fileKey] = null;
            S.thumbBusy++;
            (function (it) {
                /* 顺序（用户 2026-10-01：群里的优先，网上搜的兜底）：频道给视频设的封面 → Telegram 缩略图（不太暗的话）
                 * → 从片子里解一帧 → 电影（≥40 分钟）的维基百科海报 → 片名卡片。
                 * 定下来的结果（包括「没有」）都存在电视上，下次直接用。缓存里存的不是频道封面、而这条有频道封面的（以前没读这个字段），重新取。 */
                (it.kind === "web" ? webThumb(it) : Cover.cached(it).then(function (c) {
                    if (c && (c.kind === "cover" || !it.hasCover)) { if (c.kind !== "none") { setThumb(it, c); } return; }
                    var first = it.hasCover ? TG.cover(it, CARD_W).catch(function (e) { R("频道封面出错「" + it.title + "」" + errStr(e)); return null; }) : Promise.resolve(null);
                    return first.then(function (cv) {
                        if (cv) {
                            setThumb(it, { url: cv.url, kind: "cover" });
                            Cover.keepThumb(it, cv.bytes, "cover");
                            if ((S.coverLogged = (S.coverLogged || 0) + 1) <= 3) { R("频道封面「" + it.title + "」" + cv.w + "x" + cv.h + (c ? "（替掉缓存里的 " + c.kind + "）" : "")); }
                            return;
                        }
                        if (c) { if (c.kind !== "none") { setThumb(it, c); } return; }
                        return TG.thumb(it, CARD_W).then(function (th) {
                            if (!th) { return "没有缩略图"; }
                            return darkness(th.url).then(function (lum) {
                                /* 不少片子的缩略图是开头那一帧 —— 黑的（手机上也是黑块） */
                                if (lum < 24) { return "缩略图太暗（亮度 " + Math.round(lum) + "）"; }
                                setThumb(it, { url: th.url, kind: "thumb" });
                                Cover.keepThumb(it, th.bytes);
                                return null;
                            });
                        }).then(function (why) {
                            if (!why) { return; }
                            if (!Store.noFrame(it.fileKey)) { wantCover(it, why); }
                            else { fallbackPoster(it); }
                        });
                    });
                })).catch(function (e) { R("封面出错「" + it.title + "」" + errStr(e)); }).then(function () { S.thumbBusy--; pumpThumbs(); });
            })(it);
        }
    }

    /* ---------- 播放器 ---------- */

    var mse = Player.create(video, function (s) { Log.report("player", s); }, onPlayerState);
    var webPlayer = Web.player(video, function (s) { Log.report("web", s); }, onPlayerState);
    var player = mse;      // 当前在用的那个：Telegram 的文件 → mse，网页链接 → webPlayer
    var saveTimer = 0, ovTick = 0;

    function onPlayerState(phase, msg) {
        if (S.screen !== "player") { return; }
        if (phase === "loading") { spin(true, "正在打开…"); }
        else if (phase === "buffering") { spin(true, "缓冲中…"); }
        else if (phase === "playing") { spin(false); }
        else if (phase === "note") { toast(msg, 5000); }
        else if (phase === "ended") { finishPlayback(true); }
        else if (phase === "error") { showError(msg); }
    }

    function spin(on, text) { $("spin").classList.toggle("on", !!on); $("spin-text").textContent = text || ""; }

    async function play(it) {
        S.screen = "player";
        S.playing = it;
        S.pending = null;
        $("home").classList.add("hide");
        $("player").classList.add("on");
        $("perr").style.display = "none";
        $("seekhint").style.display = "none";
        $("ov-title").textContent = it.title;
        showOverlay();
        spin(true, "正在打开…");
        var p = Store.getProgress(it.fileKey);
        var startAt = p && !p.done && p.t > 20 ? p.t : 0;
        await Cover.cancel();
        if (it.kind === "web") { playWeb(it, startAt); return; }
        player = mse;
        var moov = await Store.getMoov(it.fileKey);
        if (S.playing !== it) { return; }
        R("播放「" + it.title + "」" + fmtSize(it.size) + " " + fmtTime(it.duration) + (startAt ? "，从 " + fmtTime(startAt) + " 接着放" : "") + (moov ? "，moov 有缓存" : ""));
        if (startAt) { toast("从 " + fmtTime(startAt) + " 接着放"); }
        var t0 = performance.now();
        player.open(TG.source(it), {
            startAt: startAt,
            moov: moov,
            onMoov: function (m) { Store.putMoov(it.fileKey, m); }
        }).then(function () {
            if (S.playing !== it) { return; }
            R("出画面 " + Math.round(performance.now() - t0) + "ms");
            spin(false);
            hideOverlaySoon();
        }).catch(function (e) {
            if (S.playing === it) { showError(errStr(e)); }
        });
        clearInterval(saveTimer);
        saveTimer = setInterval(saveProgress, 5000);
        clearInterval(ovTick);
        ovTick = setInterval(drawOverlay, 250);
    }

    function playWeb(it, startAt) {
        if (S.playing !== it) { return; }
        player = webPlayer;
        R("播放网页「" + it.title + "」" + it.url + (startAt ? "，从 " + fmtTime(startAt) + " 接着放" : ""));
        if (startAt) { toast("从 " + fmtTime(startAt) + " 接着放"); }
        var t0 = performance.now(), opening = player.open(it, { startAt: startAt });
        spin(true, "正在解析网页…");      // open 里报的 loading 会写成「正在打开…」，这里盖掉
        opening.then(function () {
            if (S.playing !== it) { return; }
            R("出画面 " + Math.round(performance.now() - t0) + "ms");
            spin(false);
            hideOverlaySoon();
        }).catch(function (e) {
            if (S.playing === it) { showError(errStr(e)); }
        });
        clearInterval(saveTimer);
        saveTimer = setInterval(saveProgress, 5000);
        clearInterval(ovTick);
        ovTick = setInterval(drawOverlay, 250);
    }

    function saveProgress() {
        var it = S.playing, d = player.duration();
        if (it && d && video.currentTime > 1) { Store.setProgress(it.fileKey, video.currentTime, d, it.title); }
    }

    function finishPlayback(ended) {
        var it = S.playing;
        if (!it) { return; }
        if (ended) { Store.setProgress(it.fileKey, player.duration(), player.duration(), it.title); }
        else { saveProgress(); }
        clearInterval(saveTimer);
        clearInterval(ovTick);
        clearTimeout(S.pendTimer);
        S.playing = null;
        S.pending = null;
        player.close();
        spin(false);
        $("ov").classList.remove("on");
        $("player").classList.remove("on");
        $("home").classList.remove("hide");
        S.screen = "home";
        pumpCover();
        var i = S.items.indexOf(it);
        if (i >= 0) {
            var el = $("c" + i);
            if (el) { el.outerHTML = cardHtml(it, i); }
            S.focus = i;
            updateFocus();
        }
        if (ended) { toast("看完了"); }
    }

    function showError(msg) {
        spin(false);
        $("perr").innerHTML = "放不了：" + esc(msg || "未知错误") + "<br><span style='color:#8b939b;font-size:28px'>按返回键回到列表</span>";
        $("perr").style.display = "block";
        R("放不了：" + msg);
    }

    function showOverlay() {
        $("ov").classList.add("on");
        drawOverlay();
        clearTimeout(S.ovTimer);
    }
    function hideOverlaySoon() {
        clearTimeout(S.ovTimer);
        S.ovTimer = setTimeout(function () {
            if (!video.paused && S.pending === null) { $("ov").classList.remove("on"); }
        }, 4000);
    }

    function drawOverlay() {
        if (!$("ov").classList.contains("on")) { return; }
        var d = player.duration(), t = S.pending !== null ? S.pending : video.currentTime;
        if (!d) { $("ov-time").textContent = "正在打开…"; return; }
        var pct = Math.min(100, t / d * 100);
        $("ov-fill").style.width = pct + "%";
        $("ov-dot").style.left = pct + "%";
        var b = video.buffered, end = 0;
        for (var i = 0; i < b.length; i++) { if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > video.currentTime) { end = b.end(i); } }
        $("ov-buf").style.width = Math.min(100, end / d * 100) + "%";
        $("ov-time").textContent = fmtTime(t) + " / " + fmtTime(d) + (video.paused && S.pending === null ? "　已暂停" : "");
    }

    /* 快进快退：连按的步长累加，停手 0.7 秒才真的跳（每跳一次可能要重新下载）。
     * 按住不放越按越快（用户 2026-10-01：「无论按多久都是逐秒快进」）：同一个键两次之间不到 0.4 秒算按住，
     * 按住的时间决定每一下的步长。 */
    var STEPS = {
        small: { at: [0, 1, 2, 3, 5], step: [15, 30, 60, 120, 300] },      // ← →（按一下 15 秒，用户 2026-10-02；原来 10 秒）
        big: { at: [0, 1, 2, 3, 5], step: [60, 120, 300, 600, 900] }       // ↑ ↓ / 快进快退键
    };
    var hold = { key: 0, start: 0, last: 0 };
    function stepFor(k, table) {
        var now = Date.now();
        if (hold.key !== k || now - hold.last > 400) { hold.key = k; hold.start = now; }
        hold.last = now;
        var h = (now - hold.start) / 1000, t = STEPS[table], i = 0;
        while (i + 1 < t.at.length && h >= t.at[i + 1]) { i++; }
        return t.step[i];
    }

    function nudge(delta) {
        var d = player.duration();
        if (!d) { return; }
        var base = S.pending !== null ? S.pending : video.currentTime;
        S.pending = Math.max(0, Math.min(d - 3, base + delta));
        var diff = S.pending - video.currentTime;
        var h = $("seekhint");
        h.innerHTML = esc((diff >= 0 ? "+" : "−") + fmtTime(Math.abs(diff)) + "　→ " + fmtTime(S.pending)) +
            "<div style='font-size:30px;font-weight:normal;color:#c5cad0;margin-top:10px'>每下 " +
            (Math.abs(delta) >= 60 ? Math.abs(delta) / 60 + " 分钟" : Math.abs(delta) + " 秒") + "</div>";
        h.style.display = "block";
        showOverlay();
        clearTimeout(S.pendTimer);
        S.pendTimer = setTimeout(function () {
            var target = S.pending;
            S.pending = null;
            h.style.display = "none";
            if (target === null) { return; }
            player.seek(target, target >= video.currentTime ? 1 : -1);
            hideOverlaySoon();
        }, 700);
    }

    /* ---------- 按键 ---------- */

    function exitApp() {
        try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }

    function homeKey(k) {
        var n = S.items.length;
        if (k === 10009) {
            if (S.zone === "rail") { S.zone = "grid"; renderRail(); updateFocus(); return; }
            if (Date.now() - S.backAt < 2000) { exitApp(); return; }
            S.backAt = Date.now();
            toast("再按一次返回键退出");
            return;
        }
        if (S.zone === "rail") {
            var list = railItems();
            if (k === 38) { S.railFocus = Math.max(0, S.railFocus - 1); renderRail(); }
            else if (k === 40) { S.railFocus = Math.min(list.length - 1, S.railFocus + 1); renderRail(); }
            else if (k === 39) { S.zone = "grid"; renderRail(); updateFocus(); }
            else if (k === 13) {
                var s = list[S.railFocus];
                if (s.id === "__logout") {
                    if (Date.now() - S.logoutAt < 3000) {
                        R("退出登录");
                        TG.logout().then(function () { location.reload(); });
                    } else { S.logoutAt = Date.now(); toast("再按一次确认，退出 Telegram 登录"); }
                    return;
                }
                S.zone = "grid";
                openSource(s);
            }
            return;
        }
        if (!n) {
            if (k === 13 && S.src) { if (S.src.kind === "web") { S.loggedIn[S.src.id] = false; } openSource(S.src); }
            else if (k === 37) { toRail(); }
            return;
        }
        if (k === 37) {
            if (S.focus % COLS === 0) { toRail(); return; }
            S.focus--;
        } else if (k === 39) { if (S.focus + 1 < n && (S.focus + 1) % COLS) { S.focus++; } }
        else if (k === 38) { if (S.focus >= COLS) { S.focus -= COLS; } }
        else if (k === 40) { S.focus = Math.min(n - 1, S.focus + COLS); }
        else if (k === 13) { play(S.items[S.focus]); return; }
        else { return; }
        updateFocus();
    }

    function toRail() {
        refreshSources(false);
        S.zone = "rail";
        var i = S.sources.findIndex(function (s) { return S.src && s.id === S.src.id; });
        S.railFocus = i >= 0 ? i : 0;
        renderRail();
        updateFocus();
    }

    function playerKey(k) {
        if (k === 10009 || k === 413) {
            if (S.pending !== null) { clearTimeout(S.pendTimer); S.pending = null; $("seekhint").style.display = "none"; return; }
            finishPlayback(false);
            return;
        }
        if ($("perr").style.display === "block") { return; }
        if (k === 13 || k === 10252 || k === 415 || k === 19) {
            if (k === 415 && !video.paused) { return; }
            if (k === 19 && video.paused) { return; }
            player.toggle();
            showOverlay();
            if (!video.paused) { hideOverlaySoon(); }
            saveProgress();
        }
        else if (k === 37) { nudge(-stepFor(k, "small")); }
        else if (k === 39) { nudge(stepFor(k, "small")); }
        else if (k === 38 || k === 417) { nudge(stepFor(k, "big")); }
        else if (k === 40 || k === 412) { nudge(-stepFor(k, "big")); }
        else { showOverlay(); hideOverlaySoon(); }
    }

    document.addEventListener("keydown", function (e) {
        var k = e.keyCode;
        if (S.screen === "password") { return; }
        if (S.screen === "weblogin") { webLoginKey(k); return; }
        if (S.screen === "bootfail") { if (k === 13) { location.reload(); } else if (k === 10009) { exitApp(); } return; }
        if (S.screen === "login") { if (k === 10009) { exitApp(); } return; }
        if (S.screen === "home") { homeKey(k); e.preventDefault(); }
        else if (S.screen === "player") { playerKey(k); e.preventDefault(); }
    });

    /* 从别的应用切回来：刷新当前来源（手机上刚转发的片子出现在最前面） */
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) { if (S.screen === "player") { saveProgress(); video.pause(); } return; }
        refreshSources(true);
        if (S.screen === "home" && S.src) {
            var keep = S.items[S.focus] && S.items[S.focus].fileKey;
            openSource(S.src).then(function () {
                var i = S.items.findIndex(function (it) { return it.fileKey === keep; });
                if (i >= 0) { S.focus = i; updateFocus(); }
            });
        }
    });

    boot().catch(function (e) { R("启动出错 " + errStr(e) + " | " + String(e && e.stack || "").split("\n").slice(0, 3).join(" ")); });
})();
