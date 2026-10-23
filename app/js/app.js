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
    /* 诊断日志（diag.js）：先记一行「新的一次启动」，之后每一行日志都进那一圈 */
    Diag.init({ report: Log.report });
    I18n.apply();
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
    function fmtDate(d) { return I18n.date(d); }
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
        var dropped = await Accounts.cleanup();
        if (dropped.length) { R("退出的账号留下的库：" + dropped.join("，")); }
        /* 包里没带 API ID / Hash（deploy.sh --noapi），又没填过：先填（apikey.js）。发布包和从源码装的都带着，平时不会走到这里 */
        if (!ApiKey.get()) {
            R("包里没带 API ID / Hash，也没填过，等用户在电视上填");
            await askApi("", null);
            t0 = performance.now();
        }
        var api = ApiKey.get();
        try {
            await TG.init();
        } catch (e) {
            R("连不上 Telegram：" + errStr(e));
            Diag.incident("连不上 Telegram：" + errStr(e));
            $("home").classList.add("hide");
            $("panel").classList.add("on");
            $("how").innerHTML = "<div style='font-size:48px'>" + T("连不上 Telegram") + "</div><div style='font-size:30px;color:#999;margin-top:20px'>" +
                esc(errStr(e)) + "<br>" + T("检查网络后按确认重试") + "</div>";
            S.screen = "bootfail";
            return;
        }
        R("连上 Telegram " + Math.round(performance.now() - t0) + "ms，mtcute 在 " + TG.mode() + "；界面 " + I18n.lang + "（" + I18n.why + "，系统语言 " + I18n.sys + "）" +
          "；API ID 是" + (api.from === "build" ? "安装包里带的" : "电视上填的"));
        var acct = Accounts.active(), me = await TG.me();
        if (!me) {
            try { await login(); }
            catch (e) {
                /* Telegram 不认这组（连接、getMe 都不验它，扫码这一步才验）：电视上填的 → 带着刚填的回到填写页改；
                 * 包里带的（被停用了）→ 空着的填写页，填自己申请的。填好了重新来过 */
                if (!ApiKey.rejected(e)) { throw e; }
                R("Telegram 不认" + (api.from === "tv" ? "电视上填的" : "安装包里带的") + " API ID / Hash：" + errStr(e) + "，转到填写页");
                /* 安装包带的那组被拒是所有人的事（多半是被 Telegram 停了）；电视上填错的是这一台的事 */
                if (api.from === "build") { Diag.incident("安装包带的 API ID 被 Telegram 拒了：" + errStr(e)); }
                $("panel").classList.remove("on");
                var why = e.text || errStr(e);
                await askApi(api.from === "tv" ? T("Telegram 不认这组 API ID / Hash（{0}）。对着 my.telegram.org 核对一下再填。", why) :
                    T("Telegram 不再接受这个安装包带的 API ID（{0}）。填你自己申请的就能接着用。", why), api.from === "tv" ? api : null);
                location.reload();
                return;
            }
            me = await TG.me();
        }
        /* 认人的判据是 Telegram 答的用户编号，不是「认不认得出一个人」（bilibili 那边就是这么漏过去的）；名字也只从这里来 */
        var verdict = Accounts.describe(acct.id, me);
        var dup = Accounts.duplicateOf(acct.id);
        if (dup) {
            /* 添加账号时扫的是已经在电视上的那个人：新会话作废、这一行拿掉，切到原来那一行 */
            R("添加的账号 " + acct.id + " 和 " + dup.id + " 是同一个人（id=" + Diag.priv(dup.userId) + "），作废新会话，切回去");
            await TG.logout();
            Accounts.remove(acct.id);
            Accounts.switchTo(dup.id);
            Store.once(T("这个账号已经在这台电视上了，切到了它"));
            location.reload();
            return;
        }
        R("账号：" + Accounts.list().length + " 个，当前 " + acct.id + "（库 " + acct.storage + "，" + Diag.priv(acct.name) + " id=" + Diag.priv(acct.userId) + "），Telegram 答的是 id=" +
          Diag.priv((me && me.id)) + " —— " + verdict);
        var once = Store.once();
        if (once) { toast(once, 4000); }
        S.screen = "home";
        $("home").classList.remove("hide");
        /* 不要收藏夹（用户 2026-10-01：习惯用自己建的一个群）。上次的来源直接开；第一次用就等探测到第一个有视频的。 */
        var last = Store.lastSource();
        if (last && last.id === "me") { last = null; }
        if (last) {
            S.sources = [last];
            renderRail();
            await openSource(last, { quiet: true });
            R("启动到主页 " + Math.round(performance.now() - t0) + "ms，来源「" + Diag.priv(S.src.title) + "」" + S.items.length + " 个视频");
        } else {
            $("empty").innerHTML = T("正在找有视频的群和频道…");
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
            $("empty").innerHTML = T("还没有哪个群里有视频。<br>在手机上把想看的片子转发到一个群（比如自己建的），回到电视上按确认刷新。");
        }
    }

    async function login() {
        S.screen = "login";
        $("home").classList.add("hide");
        $("panel").classList.add("on");
        /* 电视上还有别的账号：说清楚这是在添加账号（还是这个账号的会话没了要重扫），按返回能回去 */
        var a = Accounts.active(), others = Accounts.list().length > 1;
        $("qrnote").textContent = !others ? "" : !a.userId ? T("添加账号：用另一个 Telegram 账号扫码 · 按返回键取消") : T("{0} 要重新扫码登录 · 按返回键换别的账号", a.name);
        var n = 0;
        await TG.login(function (url) {
            n++;
            $("qr").innerHTML = TGLib.qrSvg(url, 10);
            $("qrstate").textContent = T("二维码 30 秒换一张（第 {0} 张）", n);
        }, function () {
            $("qrstate").textContent = T("已扫码，正在登录…");
        }, askPassword, function () { toast(T("两步验证密码不对，再输一次")); });
        R("扫码登录成功（出了 " + n + " 张码）");
        $("panel").classList.remove("on");
    }

    /* 填 API ID / Hash（apikey.js）：填好、格式对了才 resolve；对不对要到扫码那一步 Telegram 才说（boot 里接着）。prev：上次填的，改一两个字就行 */
    function askApi(msg, prev) {
        S.screen = "api";
        $("home").classList.add("hide");
        $("api-qr").innerHTML = TGLib.qrSvg("https://my.telegram.org/apps", 8);
        $("api-id").value = prev ? String(prev.id) : "";
        $("api-hash").value = prev ? prev.hash : "";
        $("api-msg").textContent = msg || "";
        $("api").classList.add("on");
        setTimeout(function () { $(prev ? "api-hash" : "api-id").focus(); }, 50);
        return new Promise(function (resolve) { S.apiDone = resolve; });
    }
    function submitApi() {
        var c = ApiKey.check($("api-id").value, $("api-hash").value);
        if (!c.idOk) {
            $("api-msg").textContent = c.id ? T("App api_id 是一串数字，现在填的是「{0}」", c.id) : T("先填 App api_id");
            $("api-id").focus();
            return;
        }
        if (!c.hashOk) {
            $("api-msg").textContent = !c.hash ? T("再填 App api_hash") : /[^0-9a-f]/.test(c.hash) ? T("App api_hash 只有 0–9 和 a–f，里面有别的字") :
                T("App api_hash 是 32 位，现在是 {0} 位", c.hash.length);
            $("api-hash").focus();
            return;
        }
        if (!ApiKey.set(c.id, c.hash)) { $("api-msg").textContent = T("存不下来（电视的存储出错了）"); return; }
        R("API ID / Hash 在电视上填好了（格式对，Telegram 认不认要到扫码时才知道）");
        try { document.activeElement.blur(); } catch (e) {}
        $("api").classList.remove("on");
        $("home").classList.remove("hide");
        S.screen = "boot";
        var done = S.apiDone;
        S.apiDone = null;
        if (done) { done(); }
    }
    /* 13 = 确认，65376 = 屏幕键盘上的「完成」：api_id 那一栏去下一栏，api_hash 那一栏交 */
    ["api-id", "api-hash"].forEach(function (id) {
        $(id).addEventListener("keydown", function (e) {
            if (e.keyCode !== 13 && e.keyCode !== 65376) { return; }
            e.preventDefault();
            e.stopPropagation();      // 不然冒泡到 document 的按键处理，又交一次
            if (id === "api-id" && this.value.trim() && !$("api-hash").value.trim()) { $("api-hash").focus(); }
            else { submitApi(); }
        });
    });
    function apiKey(k) {
        var inInput = document.activeElement && document.activeElement.tagName === "INPUT";
        if (k === 10009) {
            /* 输入框里按返回先收起键盘；不在输入框里，没有凭证什么都做不了，按两次退出 */
            if (inInput) { document.activeElement.blur(); return; }
            if (Date.now() - S.backAt < 2000) { exitApp(); return; }
            S.backAt = Date.now();
            toast(T("再按一次返回键退出"));
            return;
        }
        if (inInput) { return; }
        if (k === 38) { $("api-id").focus(); }
        else if (k === 40) { $("api-hash").focus(); }
        else if (k === 13) { submitApi(); }
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

    var KIND = { self: "", group: T("群"), channel: T("频道"), user: T("私聊"), web: T("网页") };

    /* 来源栏最上面是「搜索」，最下面是「退出登录」、换界面语言。换语言那一项用要换成的那种语言写（看不懂当前语言的人也认得出） */
    function railItems() {
        var sx = { id: "__search", title: S.src && S.src.kind === "search" ? T("搜索：{0}", S.src.query) : T("搜索"), kind: "" };
        var a = Accounts.active();
        return [sx].concat(S.sources, [{ id: "__acct", title: a.name ? T("账号：{0}", a.name) : T("账号"), kind: "" },
                                       { id: "__opts", title: T("设置"), kind: "" },
                                       { id: "__lang", title: I18n.lang === "en" ? "中文界面" : "English", kind: "" }]);
    }

    function renderRail() {
        $("home").classList.toggle("railopen", S.zone === "rail");
        var list = railItems(), html = "";
        list.forEach(function (s, i) {
            var cur = S.src && (s.id === S.src.id || (s.id === "__search" && S.src.kind === "search"));
            var cls = "src" + (cur ? " cur" : "") + (S.zone === "rail" && i === S.railFocus ? " focus" : "");
            html += "<div class='" + cls + "'>" + (KIND[s.kind] ? "<span class='k'>" + KIND[s.kind] + "</span>" : "") + esc(s.title) + "</div>";
        });
        $("rail-list").innerHTML = html;
        var off = Math.max(0, Math.min((S.railFocus - 5) * SRC_H, list.length * SRC_H - 900));
        $("rail-list").style.transform = "translateY(" + (-Math.max(0, off)) + "px)";
    }

    /* opts.quiet：开机进上次的来源时，要登录的不自动弹登录框（用户 2026-10-02：每次开机都被它挡住），按确认才弹 */
    async function openSource(src, opts) {
        S.src = { id: src.id, title: src.title, kind: src.kind, url: src.url, query: src.query };
        if (src.kind !== "search") { Store.setLastSource(S.src); }      // 开机不重新搜一遍，进上次的群
        var g = ++S.gen;
        S.items = []; S.next = undefined; S.total = 0; S.focus = 0; S.gridOff = 0; S.loading = true;
        $("src-title").textContent = src.title;
        $("src-sub").textContent = T("加载中…");
        renderGrid();
        renderRail();
        var t0 = performance.now(), page, links;
        if (src.kind === "web") { return openWebList(S.src, g, t0, opts || {}); }
        if (src.kind === "search") { return openSearch(S.src, g, t0); }
        /* 群里发的网站链接（web.js）跟视频混在一起按时间排。只取最近 40 条带链接的消息，翻页只翻视频 */
        var linksP = TG.links(src.id, 40).catch(function (e) { R("来源「" + Diag.priv(src.title) + "」取链接出错 " + errStr(e)); return []; });
        try {
            page = await TG.videos(src.id, undefined, 40);
            links = await linksP;
        } catch (e) {
            if (g !== S.gen) { return; }
            S.loading = false;
            R("来源「" + Diag.priv(src.title) + "」出错 " + errStr(e));
            $("src-sub").textContent = "";
            $("empty").innerHTML = T("读不到这里的视频：{0}<br>按确认重试", esc(errStr(e)));
            Diag.incident("读不到来源里的视频：" + errStr(e));
            return;
        }
        if (g !== S.gen) { return; }
        S.loading = false;
        syncWebSources(src, links.filter(function (l) { return l.kind === "weblist"; }));
        links = links.filter(function (l) { return l.kind === "web"; });
        S.items = withDur(page.items).concat(links).sort(function (a, b) { return b.date - a.date; });
        S.next = page.next;
        S.total = page.total + links.length;
        /* 焦点落在最近看过的那一条 */
        var best = -1, at = 0;
        S.items.forEach(function (it, i) {
            var p = Store.getProgress(it.fileKey);
            if (p && p.at > at) { at = p.at; best = i; }
        });
        S.focus = best >= 0 ? best : 0;
        R("来源「" + Diag.priv(src.title) + "」" + Math.round(performance.now() - t0) + "ms，" + S.items.length + "/" + S.total + " 个视频" + (links.length ? "（其中网页链接 " + links.length + " 个）" : ""));
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
            var page = S.src.kind === "search" ? await TG.search(S.src.query, S.next, 40) : await TG.videos(S.src.id, S.next, 40);
            if (g !== S.gen) { return; }
            S.items = S.items.concat(withDur(page.items));
            S.next = page.next;
            renderGrid();
        } catch (e) {
            R("翻页出错 " + errStr(e));
        } finally { if (g === S.gen) { S.loading = false; } }
    }

    /* 当文件发的（MKV 之类）Telegram 不知道时长：放过一次记下来的 */
    function withDur(items) {
        items.forEach(function (it) { if (it.asFile && !it.duration) { it.duration = Store.dur(it.fileKey); } });
        return items;
    }

    /* ---------- 搜索（所有会话里的视频）---------- */

    async function openSearch(src, g, t0) {
        var page;
        try { page = await TG.search(src.query, undefined, 40); }
        catch (e) {
            if (g !== S.gen) { return; }
            S.loading = false;
            R("搜索「" + Diag.priv(src.query) + "」出错 " + errStr(e));
            $("empty").innerHTML = T("搜索出错：{0}<br>按确认重试", esc(errStr(e)));
            Diag.incident("搜索出错：" + errStr(e));
            return;
        }
        if (g !== S.gen) { return; }
        S.loading = false;
        S.items = withDur(page.items);
        S.next = page.next;
        S.total = page.total;
        R("搜索「" + Diag.priv(src.query) + "」" + Math.round(performance.now() - t0) + "ms，" + S.items.length + " 个" + (page.next ? "，还有" : ""));
        renderGrid();
        if (!S.items.length) { $("empty").innerHTML = T("没搜到「{0}」。<br>按 ← 打开来源栏，再选「搜索」换个词。", esc(src.query)); }
    }

    S.sx = { focus: -1 };
    function openSearchBox() {
        S.screen = "search";
        var list = Store.searches(), html = "";
        list.forEach(function (q, i) { html += "<span class='q' id='sq" + i + "'>" + esc(q) + "</span>"; });
        $("sx-recent").innerHTML = html;
        $("sx-lab").style.display = list.length ? "block" : "none";
        $("sx-q").value = "";
        S.sx.focus = -1;
        $("sx").classList.add("on");
        setTimeout(function () { $("sx-q").focus(); }, 50);
    }
    function closeSearchBox() {
        $("sx").classList.remove("on");
        try { document.activeElement.blur(); } catch (e) {}
        S.screen = "home";
    }
    function runSearch(q) {
        q = q.trim();
        if (!q) { return; }
        Store.addSearch(q);
        closeSearchBox();
        S.zone = "grid";
        openSource({ id: "__search:" + q, title: T("搜索「{0}」", q), kind: "search", query: q });
    }
    $("sx-q").addEventListener("keydown", function (e) {
        if (e.keyCode !== 13 && e.keyCode !== 65376) { return; }
        e.preventDefault();
        e.stopPropagation();      // 不然冒泡到 document 的按键处理
        runSearch(this.value);
    });
    function searchKey(k) {
        var inInput = document.activeElement === $("sx-q"), n = Store.searches().length;
        if (k === 10009) {
            /* 输入框里按返回先收起键盘（同网页登录框） */
            if (inInput) { document.activeElement.blur(); return; }
            closeSearchBox();
            return;
        }
        if (inInput) { if (k === 40 && n) { document.activeElement.blur(); S.sx.focus = 0; drawRecent(); } return; }
        if (k === 37 && S.sx.focus > 0) { S.sx.focus--; }
        else if (k === 39 && S.sx.focus + 1 < n) { S.sx.focus++; }
        else if (k === 40 && S.sx.focus < 0 && n) { S.sx.focus = 0; }
        else if (k === 38) { S.sx.focus = -1; $("sx-q").focus(); }
        else if (k === 13) { if (S.sx.focus >= 0) { runSearch(Store.searches()[S.sx.focus]); } else { $("sx-q").focus(); } return; }
        drawRecent();
    }
    function drawRecent() {
        document.querySelectorAll("#sx-recent .q").forEach(function (el, i) { el.classList.toggle("focus", i === S.sx.focus); });
    }

    /* ---------- 账号（accounts.js）：切换、添加、退出 ---------- */

    S.acct = { focus: 0, rows: [], outAt: 0 };
    /* ---------- 设置：诊断日志（diag.js）、自动更新（update.js）。属于这台电视，不跟账号走。按下去的回答是下面那两行字变了 ---------- */

    S.opts = { rows: [], focus: 0, note: "" };
    function hhmm(t) { var d = new Date(t), h = d.getHours(), m = d.getMinutes(); return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m; }
    function diagLine() {
        if (S.opts.note) { return S.opts.note; }
        var st = Diag.status();
        if (!st.enabled) { return T("诊断日志关着：什么都不记录，也不上传"); }
        var parts = [T("这台电视的编号 {0}", st.device)];
        if (!st.configured) { parts.push(T("这个版本没有接收地址，不会上传")); }
        if (st.sending) { parts.push(T("正在上传…")); }
        else if (st.last) { parts.push(st.last.ok ? T("{0} 已上传（编号 {1}）", hhmm(st.last.at), st.last.id) : T("{0} 没传上：{1}", hhmm(st.last.at), T(st.last.why))); }
        return parts.join(" · ");
    }
    function updateLine() {
        var u = Update.status();
        var parts = [u.running === u.packaged ? T("正在运行 {0}", u.running) : T("正在运行 {0}（装的是 {1}）", u.running, u.packaged)];
        if (!u.supported) { parts.push(T("这台电视验不了签名，不能自动更新")); }
        else if (u.checking) { parts.push(T("正在检查…")); }
        else if (u.downloaded) { parts.push(T("{0} 已下载，下次打开生效", u.downloaded)); }
        else if (u.lastCheck) { parts.push(u.lastError ? T("{0} 查过，没查成", hhmm(u.lastCheck)) : T("{0} 查过，没有新版本", hhmm(u.lastCheck))); }
        return parts.join(" · ");
    }
    function optsRows() {
        function redraw() { if (S.screen === "opts") { drawOpts(); } }
        return [
            { label: Diag.enabled() ? T("诊断日志：开") : T("诊断日志：关"), act: function () {
                Diag.setEnabled(!Diag.enabled());
                R("诊断日志=" + (Diag.enabled() ? "开" : "关"));
            } },
            { label: T("上传诊断日志"), act: function () {
                if (!Diag.enabled()) { S.opts.note = T("诊断日志关着，先把它打开"); return; }
                Diag.upload(redraw);
            } },
            { label: T("检查更新"), sep: true, act: function () { Update.check(redraw); } }
        ];
    }
    function drawOpts() {
        S.opts.rows = optsRows();
        $("opts-list").innerHTML = S.opts.rows.map(function (r, i) {
            return "<div class='ai" + (r.sep ? " sep" : "") + (i === S.opts.focus ? " focus" : "") + "'>" + esc(r.label) + "</div>";
        }).join("");
        $("opts-diag").textContent = diagLine();
        $("opts-update").textContent = updateLine();
    }
    function openOpts() {
        S.screen = "opts";
        S.opts.focus = 0;
        S.opts.note = "";
        drawOpts();
        $("opts").classList.add("on");
    }
    function closeOpts() { $("opts").classList.remove("on"); S.screen = "home"; }
    function optsKey(k) {
        if (k === 10009) { closeOpts(); return; }
        if (k === 38) { S.opts.focus = Math.max(0, S.opts.focus - 1); }
        else if (k === 40) { S.opts.focus = Math.min(S.opts.rows.length - 1, S.opts.focus + 1); }
        else if (k === 13) { S.opts.note = ""; S.opts.rows[S.opts.focus].act(); }
        else { return; }
        drawOpts();
    }

    function acctName(a, i) { return a.name || T("账号 {0}", i + 1); }
    function openAcct() {
        S.screen = "acct";
        var cur = Accounts.active(), rows = [];
        Accounts.list().forEach(function (a, i) {
            rows.push({ label: acctName(a, i), ck: a.id === cur.id, act: function () { switchAcct(a); } });
        });
        rows.push({ label: T("+ 添加账号"), sep: true, act: addAcct });
        rows.push({ label: T("退出 {0}", acctName(cur, Accounts.list().indexOf(cur))), act: signOut });
        S.acct.rows = rows;
        S.acct.focus = rows.findIndex(function (r) { return r.ck; });
        S.acct.outAt = 0;
        drawAcct();
        $("acct").classList.add("on");
    }
    function drawAcct() {
        $("acct-list").innerHTML = S.acct.rows.map(function (r, i) {
            return "<div class='ai" + (r.sep ? " sep" : "") + (i === S.acct.focus ? " focus" : "") + "'><span class='ck'>" + (r.ck ? "✓" : "") + "</span>" + esc(r.label) + "</div>";
        }).join("");
    }
    function closeAcct() { $("acct").classList.remove("on"); S.screen = "home"; }
    function acctKey(k) {
        if (k === 10009) { closeAcct(); return; }
        if (k === 38) { S.acct.focus = Math.max(0, S.acct.focus - 1); }
        else if (k === 40) { S.acct.focus = Math.min(S.acct.rows.length - 1, S.acct.focus + 1); }
        else if (k === 13) { S.acct.rows[S.acct.focus].act(); return; }
        else { return; }
        drawAcct();
    }
    /* 切换 / 添加都是记下新的当前账号、重新加载页面（用它的库起后台线程） */
    function switchAcct(a) {
        if (a.id === Accounts.active().id) { closeAcct(); return; }
        R("切换账号 " + Accounts.active().id + " → " + a.id + "（" + Diag.priv(a.name) + "）");
        Accounts.switchTo(a.id);
        Store.once(T("已切换到 {0}", a.name));
        location.reload();
    }
    function addAcct() {
        var a = Accounts.add();
        R("添加账号 " + a.id + "（库 " + a.storage + "），去扫码");
        location.reload();
    }
    /* 退出：按两下。先让 Telegram 作废这个会话（手机上「设备」里那条也没了），再从电视上拿掉这个人的记录 */
    function signOut() {
        var cur = Accounts.active();
        if (Date.now() - S.acct.outAt > 3000) { S.acct.outAt = Date.now(); toast(T("再按一次确认，退出 {0}", acctName(cur, Accounts.list().indexOf(cur)))); return; }
        R("退出账号 " + cur.id + "（" + Diag.priv(cur.name) + "）");
        TG.logout().then(function () { Accounts.remove(cur.id); location.reload(); });
    }
    /* 扫码登录时按返回：在添加账号就取消（切回原来的），是哪个账号的会话没了就换到别的账号；电视上只有这一个账号才退出应用 */
    function leaveLogin() {
        var a = Accounts.active(), others = Accounts.list().filter(function (x) { return x.id !== a.id && x.userId; });
        if (!others.length) { exitApp(); return; }
        if (!a.userId) { R("取消添加账号 " + a.id); Accounts.remove(a.id); }
        else { R(a.id + "（" + Diag.priv(a.name) + "）要重新扫码，先换到 " + others[0].id); Accounts.switchTo(others[0].id); }
        location.reload();
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
            R("群「" + Diag.priv(group.title) + "」里的列表链接 → 来源：" + added.map(function (s) { return Diag.priv(s.title) + " " + Diag.priv(s.url); }).join("，"));
            toast(added.length > 1 ? T("左边多了 {0} 个来源，按 ← 打开", added.length) : T("左边多了一个来源「{0}」，按 ← 打开", added[0].title), 5000);
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
            } catch (e) { R("刷新群「" + Diag.priv(d.title) + "」的列表链接出错 " + errStr(e)); }
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
                R("列表「" + Diag.priv(src.title) + "」要登录：" + errStr(e) + (S.loggedIn[src.id] ? "（刚登录成功过 —— 登录状态没带上）" : ""));
                if (S.loggedIn[src.id]) {
                    $("empty").innerHTML = T("登录成功了，但还是看不到这个列表。<br>电视可能带不上这个网站的登录状态（日志里有详情）。");
                    Diag.incident("网页列表登录成功了还是看不到：" + errStr(e));
                } else {
                    $("empty").innerHTML = T("这个列表要登录一次才能看（查账号编号）。<br>按确认登录");
                    if (!opts.quiet) { webLogin(src); }
                }
                return;
            }
            R("列表「" + Diag.priv(src.title) + "」出错 " + errStr(e));
            $("empty").innerHTML = T("读不到这个列表：{0}<br>按确认重试", esc(errStr(e)));
            Diag.incident("读不到网页列表：" + errStr(e));
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
        R("列表「" + Diag.priv(src.title) + "」" + Math.round(performance.now() - t0) + "ms（" + page.how + "），" + S.items.length + "/" + (page.total || "?") + " 个" + (page.next ? "，有下一页" : ""));
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
        $("wl-msg").textContent = T("正在登录…");
        try { document.activeElement.blur(); } catch (e) {}
        var t0 = performance.now();
        Web.login(src.url, user, pass).then(function (r) {
            R("登录 " + Diag.priv(new URL(src.url).hostname) + "：" + (r.ok ? "成功，账号编号 " + Diag.priv(r.userId) + (r.favs != null ? "，收藏 " + r.favs + " 个" : "") : "失败 " + Diag.priv(r.msg)) + "，" + Math.round(performance.now() - t0) + "ms");
            if (!r.ok) { $("wl-msg").textContent = T("登录失败：{0}", r.msg); $("wl-pass").value = ""; $("wl-pass").focus(); return; }
            S.loggedIn[src.id] = true;
            closeWebLogin();
            toast(T("登录成功"));
            openSource(src);
        }).catch(function (e) {
            R("登录出错 " + errStr(e));
            $("wl-msg").textContent = T("登录出错：{0}", errStr(e));
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
        var ext = it.asFile && /\.(mkv|webm|mov|m4v)$/i.exec(it.fileName || "");
        var meta = [S.src && S.src.kind === "search" ? it.chatTitle : "", it.kind === "web" ? T("网页 · {0}", it.site) : (ext ? ext[1].toUpperCase() + " · " : "") + fmtSize(it.size), fmtDate(it.date)].filter(Boolean).join(" · ");
        if (p && p.done) { meta = T("看完了 · {0}", meta); }
        else if (p && p.t > 0) { meta = T("看到 {0} · {1}", fmtTime(p.t), meta); }
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
            $("empty").innerHTML = T("加载中…");
        } else if (!S.items.length) {
            $("empty").innerHTML = T("这里没有视频。<br>在手机上找到想看的片子，长按 → <b>转发</b> → 选这个群，回到电视上按确认刷新。");
        } else {
            $("empty").innerHTML = "";
        }
        if (S.src && !S.loading) {
            $("src-sub").textContent = S.total ? T("共 {0} 个视频", S.total) + (S.items.length < S.total ? T("（已加载 {0}）", S.items.length) : "") : "";
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
        /* 当文件发的没有时长：1GB 以上的当电影 */
        if ((it.duration || (it.asFile && it.size > 1073741824 ? 3600 : 0)) < 2400 || Store.noPoster(it.fileKey)) { Cover.keepNone(it); return; }
        Cover.poster(it).then(function (ps) {
            if (ps) { R("海报「" + Diag.priv(it.title) + "」← " + Diag.priv(ps.info)); setThumb(it, ps); }
            else { Store.markNoPoster(it.fileKey); Cover.keepNone(it); R("海报：维基百科没找到对得上的「" + Diag.priv(it.title) + "」"); }
        }).catch(function (e) { R("海报出错「" + Diag.priv(it.title) + "」" + errStr(e)); });
    }
    function pumpCover() {
        if (S.coverBusy || !S.coverQ.length || S.screen !== "home") { return; }
        var job = S.coverQ.shift(), it = job.it;
        S.coverBusy = true;
        if (S.coverLogs < 4) { R("封面帧开始「" + Diag.priv(it.title) + "」" + job.why); }
        Cover.grab(it).then(function (r) {
            S.coverDone[it.fileKey] = true;
            setThumb(it, { url: r.url, kind: "frame" });
            R("封面帧「" + Diag.priv(it.title) + "」" + job.why + " → " + r.info);
        }).catch(function (e) {
            if (e && e.cancelled) { S.coverQ.unshift(job); return; }
            S.coverDone[it.fileKey] = true;
            Store.markNoFrame(it.fileKey);
            if (S.coverLogs++ < 4) { R("封面帧失败「" + Diag.priv(it.title) + "」" + job.why + "：" + errStr(e)); }
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
                    var first = it.hasCover ? TG.cover(it, CARD_W).catch(function (e) { R("频道封面出错「" + Diag.priv(it.title) + "」" + errStr(e)); return null; }) : Promise.resolve(null);
                    return first.then(function (cv) {
                        if (cv) {
                            setThumb(it, { url: cv.url, kind: "cover" });
                            Cover.keepThumb(it, cv.bytes, "cover");
                            if ((S.coverLogged = (S.coverLogged || 0) + 1) <= 3) { R("频道封面「" + Diag.priv(it.title) + "」" + cv.w + "x" + cv.h + (c ? "（替掉缓存里的 " + c.kind + "）" : "")); }
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
                })).catch(function (e) { R("封面出错「" + Diag.priv(it.title) + "」" + errStr(e)); }).then(function () { S.thumbBusy--; pumpThumbs(); });
            })(it);
        }
    }

    /* ---------- 播放器 ---------- */

    var mse = Player.create(video, function (s) { Log.report("player", s); }, onPlayerState);
    var webPlayer = Web.player(video, function (s) { Log.report("web", s); }, onPlayerState);
    var player = mse;      // 当前在用的那个：Telegram 的文件 → mse，网页链接 → webPlayer
    var saveTimer = 0, ovTick = 0, subTimer = 0;

    function onPlayerState(phase, msg) {
        if (S.screen !== "player") { return; }
        if (phase === "loading") { spin(true, T("正在打开…")); }
        else if (phase === "buffering") { spin(true, T("缓冲中…")); }
        else if (phase === "playing") { spin(false); }
        else if (phase === "note") { toast(msg, 5000); }
        else if (phase === "ended") { onEnded(); }
        else if (phase === "error") { showError(msg); }
    }

    function spin(on, text) { $("spin").classList.toggle("on", !!on); $("spin-text").textContent = text || ""; }

    /* opts.reopen：同一部片在当前位置重开（换音轨），字幕、菜单的状态留着 */
    async function play(it, opts) {
        opts = opts || {};
        var again = !!opts.reopen && S.playing === it;
        S.screen = "player";
        S.playing = it;
        S.pending = null;
        hideUpnext();
        closeMenu();
        $("home").classList.add("hide");
        $("player").classList.add("on");
        $("perr").style.display = "none";
        $("seekhint").style.display = "none";
        $("ov-title").textContent = it.title;
        if (!again) { resetSubs(it); }
        showOverlay();
        spin(true, again ? T("换音轨…") : T("正在打开…"));
        var p = Store.getProgress(it.fileKey);
        var startAt = again ? opts.startAt : p && !p.done && p.t > 20 ? p.t : 0;
        await Cover.cancel();
        if (!again) { findSubFiles(it); }
        if (it.kind === "web") { playWeb(it, startAt); return; }
        player = mse;
        var moov = await Store.getMoov(it.fileKey);
        if (S.playing !== it) { return; }
        var pref = Store.getPrefs(it.fileKey);
        R((again ? "换音轨重开「" : "播放「") + Diag.priv(it.title) + "」" + fmtSize(it.size) + " " + fmtTime(it.duration) + (it.asFile ? "（文件 " + Diag.priv(it.fileName || it.mime) + "）" : "") +
          (startAt ? "，从 " + fmtTime(startAt) + (again ? "" : " 接着放") : "") + (moov ? "，" + (moov.mkv ? "MKV 头" : "moov") + "有缓存" : "") + (opts.audio || pref.audio ? "，音轨 " + (opts.audio || pref.audio) : ""));
        if (startAt && !again) { toast(T("从 {0} 接着放", fmtTime(startAt))); }
        var t0 = performance.now();
        player.open(TG.source(it), {
            startAt: startAt,
            exact: again,
            moov: moov,
            audio: opts.audio || pref.audio,
            onMoov: function (m) { Store.putMoov(it.fileKey, m); },
            onTracks: function (tr) { if (S.playing === it) { gotTracks(it, tr); } },
            onSub: function (key, pts, dur, data, extra) {
                var e = S.subs && S.subs.it === it && S.subs.emb[key];
                /* 图形字幕（PGS）一个显示集几 KB 到几十 KB、一部片几千个，蓝光 remux 常带四五条：定下显示哪条之后只存那一条
                 * （中途换到别的图形字幕轨时让播放器重读，见 applySub）。文字的都存，换轨马上有 */
                if (e && (e.track.kind !== "image" || !S.subs.decided || S.subs.on === key)) { e.track.add(pts, dur, data, extra); }
            }
        }).then(function () {
            if (S.playing !== it) { return; }
            R("出画面 " + Math.round(performance.now() - t0) + "ms");
            spin(false);
            hideOverlaySoon();
            /* 当文件发的片子，Telegram 不知道时长：记下来，网格上的卡片和续播进度条要用 */
            if (it.asFile && player.duration()) { it.duration = player.duration(); Store.setDur(it.fileKey, it.duration); }
        }).catch(function (e) {
            if (S.playing === it) { showError(errStr(e)); }
        });
        clearInterval(saveTimer);
        saveTimer = setInterval(saveProgress, 5000);
        clearInterval(ovTick);
        ovTick = setInterval(drawOverlay, 250);
        clearInterval(subTimer);
        subTimer = setInterval(function () { if (S.subR) { S.subR.tick(video.currentTime); } }, 100);
    }

    function playWeb(it, startAt) {
        if (S.playing !== it) { return; }
        player = webPlayer;
        R("播放网页「" + Diag.priv(it.title) + "」" + Diag.priv(it.url) + (startAt ? "，从 " + fmtTime(startAt) + " 接着放" : ""));
        if (startAt) { toast(T("从 {0} 接着放", fmtTime(startAt))); }
        var t0 = performance.now(), opening = player.open(it, { startAt: startAt });
        spin(true, T("正在解析网页…"));      // open 里报的 loading 会写成「正在打开…」，这里盖掉
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

    /* 停下这部片（存进度、关播放器、清字幕），不管接下来去哪 */
    function stopPlayback(ended) {
        var it = S.playing;
        if (!it) { return null; }
        if (ended) { Store.setProgress(it.fileKey, player.duration(), player.duration(), it.title); }
        else { saveProgress(); }
        clearInterval(saveTimer);
        clearInterval(ovTick);
        clearInterval(subTimer);
        clearTimeout(S.pendTimer);
        hideUpnext();
        closeMenu();
        if (S.subR) { S.subR.set(null); }
        S.playing = null;
        S.pending = null;
        player.close();
        spin(false);
        ovShow(false);
        return it;
    }

    function finishPlayback(ended) {
        var it = stopPlayback(ended);
        if (!it) { return; }
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
        if (ended) { toast(T("看完了")); }
    }

    function showError(msg) {
        spin(false);
        $("perr").innerHTML = T("放不了：{0}", esc(msg || T("未知错误"))) + "<br><span style='color:#8b939b;font-size:28px'>" + T("按返回键回到列表") + "</span>";
        $("perr").style.display = "block";
        R("放不了：" + msg);
        Diag.incident("放不了：" + msg);
    }

    /* 浮层出来时字幕抬到它上面（#player.ovon） */
    function ovShow(on) { $("ov").classList.toggle("on", on); $("player").classList.toggle("ovon", on); }
    function showOverlay() {
        ovShow(true);
        drawOverlay();
        clearTimeout(S.ovTimer);
    }
    function hideOverlaySoon() {
        clearTimeout(S.ovTimer);
        S.ovTimer = setTimeout(function () {
            if (!video.paused && S.pending === null) { ovShow(false); }
        }, 4000);
    }

    function drawOverlay() {
        if (!$("ov").classList.contains("on")) { return; }
        var d = player.duration(), t = S.pending !== null ? S.pending : video.currentTime;
        if (!d) { $("ov-time").textContent = T("正在打开…"); return; }
        var pct = Math.min(100, t / d * 100);
        $("ov-fill").style.width = pct + "%";
        $("ov-dot").style.left = pct + "%";
        var b = video.buffered, end = 0;
        for (var i = 0; i < b.length; i++) { if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > video.currentTime) { end = b.end(i); } }
        $("ov-buf").style.width = Math.min(100, end / d * 100) + "%";
        $("ov-time").textContent = fmtTime(t) + " / " + fmtTime(d) + (video.paused && S.pending === null ? "　" + T("已暂停") : "");
    }

    /* ---------- 音轨、字幕 ---------- */

    var LANG = { chi: "中文", zho: "中文", zh: "中文", cmn: "国语", yue: "粤语", eng: "英语", en: "英语", jpn: "日语", ja: "日语",
                 kor: "韩语", ko: "韩语", fre: "法语", fra: "法语", fr: "法语", ger: "德语", deu: "德语", de: "德语", spa: "西班牙语", es: "西班牙语",
                 ita: "意大利语", it: "意大利语", rus: "俄语", ru: "俄语", tha: "泰语", th: "泰语", por: "葡萄牙语", pt: "葡萄牙语", vie: "越南语", hin: "印地语" };
    function langName(l) {
        l = String(l || "").toLowerCase();
        if (/^zh-?(hans|cn|sg)/.test(l)) { return T("简体中文"); }
        if (/^zh-?(hant|tw|hk|mo)/.test(l)) { return T("繁体中文"); }
        var n = LANG[l] || LANG[l.split("-")[0]];
        return n ? T(n) : "";
    }
    function isZh(x) {
        return /^(chi|zho|zh|cmn|yue)\b/i.test(x.lang || "") || /中|国语|國語|普通话|粤|简|繁|chs|cht|chinese|mandarin|cantonese/i.test(x.name || "");
    }
    function isEn(x) { return /^(eng|en)\b/i.test(x.lang || "") || /english|英/i.test(x.name || ""); }
    /* 「看得懂的语言」跟界面走：中文界面 = 中文，英文界面 = 英文 */
    function isMine(x) { return I18n.lang === "en" ? isEn(x) : isZh(x); }
    var CODEC = { "ac-3": "杜比 AC-3", "ec-3": "杜比 E-AC-3", opus: "Opus", flac: "FLAC", "mp4a.6B": "MP3", "mp4a.69": "MP3" };
    function codecName(c) { c = String(c || ""); return CODEC[c] ? T(CODEC[c]) : /^mp4a\.40/.test(c) ? "AAC" : c.replace(/^A_/, ""); }
    function paren(x) { return I18n.lang === "en" ? " (" + x + ")" : "（" + x + "）"; }
    function chName(n) { return n === 1 ? T("单声道") : n === 2 ? T("立体声") : n === 6 ? "5.1" : n === 8 ? "7.1" : n ? T("{0} 声道", n) : ""; }
    function audioLabel(a, i) {
        var l = langName(a.lang), nm = a.name && a.name !== l ? a.name : "";
        return [l || nm || T("音轨 {0}", i + 1), l && nm ? nm : "", codecName(a.codec), chName(a.channels)].filter(Boolean).join(" · ");
    }
    function subLabel(t, i) {
        var l = langName(t.lang), nm = t.name && t.name !== l ? t.name : "";
        return [l || nm || T("字幕 {0}", i + 1), l && nm ? nm : "", /PGS/.test(t.codec) && !/图形|image|pgs/i.test(nm) ? T("图形") : ""].filter(Boolean).join(" · ") + T("（片子里）");
    }

    /* S.subs：这部片子的字幕状态。emb = 片子里的轨（key → {info, track, label}）；files = 群里找到的字幕文件；
     * on = 正在显示的（"" 关，"s:3" 片子里的，"f:文件名" 群里的文件） */
    S.subR = null;
    function resetSubs(it) {
        if (!S.subR && window.Subs) { S.subR = Subs.renderer($("sub"), $("subtop"), $("subpic")); }
        S.subs = { it: it, emb: {}, embList: [], files: [], fileTracks: {}, on: "", gotTracks: false, gotFiles: false, decided: false,
                   off: Store.getPrefs(it.fileKey).off || 0 };
        S.tracks = null;
        if (S.subR) { S.subR.set(null); S.subR.offset(S.subs.off); }
    }
    function gotTracks(it, tr) {
        var ss = S.subs;
        S.tracks = tr;
        tr.subs.forEach(function (t, i) {
            if (ss.emb[t.key]) { return; }
            ss.emb[t.key] = { info: t, track: Subs.track(t.codec, t.codecPrivate), label: subLabel(t, i) };
            ss.embList.push(t.key);
        });
        ss.gotTracks = true;
        if (tr.audio.length > 1) { R("音轨：" + tr.audio.map(function (a, i) { return (a.current ? "▶" : "") + audioLabel(a, i) + (a.ok ? "" : "（" + a.why + "）"); }).join("，")); }
        if (tr.subs.length) { R("片子里的字幕：" + tr.subs.map(function (t, i) { return subLabel(t, i) + " " + t.codec + (t.isDefault ? " 默认" : "") + (t.isForced ? " 强制" : ""); }).join("，")); }
        decideSubs();
    }
    function findSubFiles(it) {
        if (it.kind === "web" || !it.msg) { S.subs.gotFiles = true; decideSubs(); return; }
        TG.subtitlesFor(it).then(function (list) {
            if (!S.subs || S.subs.it !== it) { return; }
            S.subs.files = list;
            S.subs.gotFiles = true;
            if (list.length) { R("群里的字幕文件：" + list.map(function (f) { return Diag.priv(f.name) + "（" + f.score.toFixed(1) + "）"; }).join("，")); }
            decideSubs();
        }).catch(function (e) { R("找字幕文件出错 " + errStr(e)); S.subs.gotFiles = true; decideSubs(); });
    }

    /* 默认开哪个：这部片子上次选过的 → 强制字幕 → 对白不是中文时，中文字幕（片子里的优先，再看群里对得上名字的文件）→ 关。
     * 对白是中文就不自动开（国产片多半是硬字幕）。等音轨和字幕文件都知道了才定。
     * 英文界面同样的规则换成英文：对白不是英文时开英文字幕。 */
    function decideSubs() {
        var ss = S.subs;
        if (!ss || ss.decided || !ss.gotTracks || !ss.gotFiles) { return; }
        ss.decided = true;
        var pref = Store.getPrefs(ss.it.fileKey);
        if (pref.sub !== undefined) { if (pref.sub) { applySub(pref.sub, "上次选的"); } return; }
        var emb = ss.embList.map(function (k) { return ss.emb[k].info; });
        var forced = emb.filter(function (t) { return t.isForced; })[0];
        if (forced) { applySub(forced.key, "强制字幕"); return; }
        var cur = S.tracks && S.tracks.audio.filter(function (a) { return a.current; })[0];
        if (cur && isMine(cur)) { if (emb.length || ss.files.length) { toast(T("有字幕，长按确认键可以打开"), 4000); } return; }
        var mine = emb.filter(isMine), pick = mine.filter(function (t) { return t.isDefault; })[0] || mine[0];
        if (pick) { applySub(pick.key, I18n.lang === "en" ? "英文字幕" : "中文字幕"); return; }
        /* 字幕文件：没写语言的也算（群里发的多半就是群里人看得懂的） */
        var f = ss.files[0], fl = f && f.lang;
        if (f && f.score >= 3 && (!fl || (I18n.lang === "en" ? fl === "英文" || fl === "中英" : fl !== "英文"))) { applySub("f:" + f.name, "名字对得上的字幕文件"); return; }
        if (emb.length || ss.files.length) { toast(T("有字幕，长按确认键可以选"), 4000); }
    }

    /* why 有值 = 自动选的（不记）；没有 = 用户在菜单里选的（记下来，下次这部片子直接用） */
    function applySub(key, why) {
        var ss = S.subs, it = ss.it;
        if (!why) { Store.setPrefs(it.fileKey, { sub: key }); }
        ss.on = key;
        if (!key) { S.subR.set(null); if (!why) { toast(T("字幕关了")); } return; }
        if (key.indexOf("s:") === 0) {
            var e = ss.emb[key];
            if (!e) { ss.on = ""; return; }
            S.subR.set(e.track);
            R("字幕 → " + e.label + (why ? "（" + why + "）" : ""));
            if (e.track.kind === "image" && !why) { player.refetch("换图形字幕，重读"); }
            toast(T("字幕：{0}", e.label.replace(T("（片子里）"), "")));
            return;
        }
        var name = key.slice(2), f = ss.files.filter(function (x) { return x.name === name; })[0];
        if (ss.fileTracks[name]) { S.subR.set(ss.fileTracks[name]); toast(T("字幕：{0}", name)); return; }
        if (!f) { ss.on = ""; return; }
        var t0 = performance.now();
        TG.download(f.doc).then(function (bytes) {
            var text = Subs.decode(new Uint8Array(bytes)), ev = Subs.parse(text, name);
            var tr = Subs.track("file", null);
            tr.addEvents(ev);
            ss.fileTracks[name] = tr;
            R("字幕文件「" + Diag.priv(name) + "」" + Math.round(bytes.length / 1024) + "KB " + ev.length + " 条，" + Math.round(performance.now() - t0) + "ms" + (why ? "（" + why + "）" : ""));
            if (S.subs !== ss || ss.on !== key) { return; }
            if (!ev.length) {
                toast(T("字幕文件「{0}」里读不出字幕", name));
                Diag.incident("字幕文件里读不出字幕");
                ss.on = "";
                return;
            }
            S.subR.set(tr);
            toast(T("字幕：{0}", (f.lang ? T(f.lang) + " · " : "") + name));
        }).catch(function (e) {
            R("字幕文件「" + Diag.priv(name) + "」下载出错 " + errStr(e));
            if (S.subs === ss && ss.on === key) {
                ss.on = "";
                toast(T("字幕文件下不下来：{0}", errStr(e)));
                Diag.incident("字幕文件下不下来：" + errStr(e));
            }
        });
    }
    function setSubOffset(d) {
        var ss = S.subs;
        ss.off = Math.round((ss.off + d) * 10) / 10;
        S.subR.offset(ss.off);
        Store.setPrefs(ss.it.fileKey, { off: ss.off });
    }

    /* 换音轨：在当前位置重开（见 player.js 开头），停在原来那一秒 */
    function switchAudio(key) {
        var it = S.playing, t = video.currentTime;
        if (!it || (S.tracks && S.tracks.audio.some(function (a) { return a.current && a.key === key; }))) { return; }
        Store.setPrefs(it.fileKey, { audio: key });
        saveProgress();
        play(it, { reopen: true, startAt: t, audio: key });
    }

    /* ---------- 菜单（播放时长按确认键）---------- */

    S.menu = null;
    function menuRows() {
        var rows = [], tr = S.tracks || { audio: [], subs: [] }, ss = S.subs;
        if (tr.audio.length > 1) {
            rows.push({ h: T("音轨") });
            tr.audio.forEach(function (a, i) {
                rows.push({ label: audioLabel(a, i) + (a.ok ? "" : paren(a.why)), ck: a.current, dis: !a.ok, act: function () { closeMenu(); switchAudio(a.key); } });
            });
        }
        rows.push({ h: T("字幕") });
        rows.push({ label: T("关"), ck: !ss.on, act: function () { applySub(""); closeMenu(); } });
        ss.embList.forEach(function (k) {
            var e = ss.emb[k];
            rows.push({ label: e.label, ck: ss.on === k, act: function () { applySub(k); closeMenu(); } });
        });
        ss.files.forEach(function (f) {
            var k = "f:" + f.name;
            rows.push({ label: (f.lang ? T(f.lang) + " · " : "") + f.name + T("（群里的文件）"), ck: ss.on === k, act: function () { applySub(k); closeMenu(); } });
        });
        if (!ss.embList.length && !ss.files.length) {
            rows.push({ label: ss.gotFiles ? T("没有找到字幕") : T("正在找群里的字幕文件…"), dis: true });
        }
        if (ss.on) {
            rows.push({ h: T("字幕时间（和对白对不上时调）") });
            rows.push({ label: ss.off > 0 ? T("← 推迟 {0} 秒 →", ss.off.toFixed(1)) : ss.off < 0 ? T("← 提前 {0} 秒 →", (-ss.off).toFixed(1)) : T("← 不调 0.0 秒 →"), adjust: true });
        }
        var nx = nextEpisodeLoaded(S.playing);
        if (nx) {
            rows.push({ h: T("下一集") });
            rows.push({ label: nx.title, act: function () { closeMenu(); playNext(nx); } });
        }
        return rows;
    }
    function openMenu() {
        if (!S.subs || $("perr").style.display === "block") { return; }
        S.menu = { rows: menuRows(), focus: -1 };
        var r = S.menu.rows, cur = r.findIndex(function (x) { return x.ck && !x.dis; });
        S.menu.focus = cur >= 0 ? cur : r.findIndex(function (x) { return !x.h && !x.dis; });
        drawMenu();
        $("toast").style.display = "none";      // 提示条在上方正中，会压在菜单的标题上
        $("menu").classList.add("on");
    }
    function closeMenu() { S.menu = null; $("menu").classList.remove("on"); }
    function drawMenu() {
        var m = S.menu, html = "";
        m.rows.forEach(function (x, i) {
            if (x.h) { html += "<div class='mh'>" + esc(x.h) + "</div>"; return; }
            html += "<div class='mi" + (x.dis ? " dis" : "") + (i === m.focus ? " focus" : "") + "' id='mi" + i + "'><span class='ck'>" + (x.ck ? "✓" : "") + "</span>" + esc(x.label) + "</div>";
        });
        $("menu-list").innerHTML = html;
        var el = $("mi" + m.focus), y = el ? el.offsetTop : 0;
        $("menu-list").style.transform = "translateY(" + (-Math.max(0, y - 700)) + "px)";
    }
    function menuKey(k) {
        var m = S.menu, r = m.rows, i;
        if (k === 10009) { closeMenu(); return; }
        if (k === 38 || k === 40) {
            for (i = m.focus + (k === 40 ? 1 : -1); i >= 0 && i < r.length; i += (k === 40 ? 1 : -1)) {
                if (!r[i].h && !r[i].dis) { m.focus = i; break; }
            }
            drawMenu();
            return;
        }
        var x = r[m.focus];
        if (!x) { return; }
        if (x.adjust && (k === 37 || k === 39)) { setSubOffset(k === 39 ? 0.5 : -0.5); m.rows = menuRows(); drawMenu(); return; }
        if (k === 13 && x.act) { x.act(); }
    }

    /* ---------- 下一集 ---------- */

    var CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    function cnNum(s) {
        if (/^\d+$/.test(s)) { return +s; }
        var n = 0, cur = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (c === "百") { n += (cur || 1) * 100; cur = 0; }
            else if (c === "十") { n += (cur || 1) * 10; cur = 0; }
            else if (CN_NUM[c] !== undefined) { cur = CN_NUM[c]; }
            else { return NaN; }
        }
        return n + cur;
    }
    /* 集数：S01E02、第3集 / 第三话、EP02 / E02、[02]、「 - 02」。剧名 = 去掉集数（和画质、方括号之类）剩下的，用来认同一部剧 */
    var EP_PATTERNS = [
        [/s(\d{1,2})\s*e(\d{1,3})/i, function (m) { return +m[1] * 1000 + +m[2]; }],
        [/第\s*([0-9零一二两三四五六七八九十百]+)\s*[集话話回期]/, function (m) { return cnNum(m[1]); }],
        [/\bep?\.?\s*(\d{1,3})\b/i, function (m) { return +m[1]; }],
        [/[\[【]\s*(\d{1,3})(?:v\d)?\s*[\]】]/i, function (m) { return +m[1]; }],
        [/\s-\s(\d{1,3})(?=\s|$|\[|\.)/, function (m) { return +m[1]; }]
    ];
    function episodeOf(it) {
        var srcs = [it.title || "", (it.fileName || "").replace(/\.[a-z0-9]{2,4}$/i, "")];
        for (var j = 0; j < srcs.length; j++) {
            for (var i = 0; i < EP_PATTERNS.length; i++) {
                var m = EP_PATTERNS[i][0].exec(srcs[j]);
                if (!m) { continue; }
                var ep = EP_PATTERNS[i][1](m);
                if (isNaN(ep)) { continue; }
                var series = (srcs[j].slice(0, m.index) + " " + srcs[j].slice(m.index + m[0].length))
                    .replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)/g, " ")
                    .replace(/\b(2160p|1080[pi]|720p|480p|4k|web-?dl|webrip|blu-?ray|hdtv|x26[45]|hevc|aac|中字|国语|高清)\b/gi, " ")
                    .replace(/[\s._\-–·|｜:：,，]+/g, "").toLowerCase();
                if (series.length >= 1) { return { series: series, ep: ep }; }
            }
        }
        return null;
    }
    /* 已经加载的列表里，同一部剧、集数比它大的里最小的那一集 */
    function nextEpisodeLoaded(it) {
        if (!it) { return null; }
        var me = episodeOf(it);
        if (!me) { return null; }
        var best = null, bestEp = Infinity;
        S.items.forEach(function (x) {
            if (x === it || (x.kind === "web") !== (it.kind === "web")) { return; }
            var e = episodeOf(x);
            if (e && e.series === me.series && e.ep > me.ep && e.ep < bestEp) { best = x; bestEp = e.ep; }
        });
        return best;
    }
    /* 没加载到的话往后翻几页再找（新的在前，前面几集在后面的页里） */
    async function findNext(it) {
        var nx = nextEpisodeLoaded(it);
        for (var i = 0; !nx && i < 3 && episodeOf(it) && S.next !== undefined && S.next !== null; i++) {
            await loadMore();
            nx = nextEpisodeLoaded(it);
        }
        return nx;
    }

    function onEnded() {
        var it = S.playing;
        if (!it) { return; }
        findNext(it).then(function (nx) {
            if (S.playing !== it) { return; }
            if (!nx) { finishPlayback(true); return; }
            R("放完了，下一集「" + Diag.priv(nx.title) + "」");
            showUpnext(nx);
        });
    }
    S.upnext = null;
    function showUpnext(nx) {
        closeMenu();
        var u = S.upnext = { it: nx, left: 8 };
        $("upnext-t").textContent = nx.title;
        var draw = function () { $("upnext-k").textContent = T("{0} 秒后开始　·　确认 现在放　·　返回 不放了", u.left); };
        draw();
        $("upnext").classList.add("on");
        clearTimeout(S.ovTimer);
        ovShow(false);
        u.timer = setInterval(function () {
            if (S.upnext !== u) { clearInterval(u.timer); return; }
            if (--u.left <= 0) { clearInterval(u.timer); playNext(nx); return; }
            draw();
        }, 1000);
    }
    function hideUpnext() {
        if (S.upnext) { clearInterval(S.upnext.timer); }
        S.upnext = null;
        $("upnext").classList.remove("on");
    }
    function playNext(nx) {
        var cur = S.playing;
        var ended = cur && player.duration() && video.currentTime > player.duration() - 90;
        stopPlayback(ended);
        if (cur) { var ci = S.items.indexOf(cur), el = ci >= 0 && $("c" + ci); if (el) { el.outerHTML = cardHtml(cur, ci); } }
        var i = S.items.indexOf(nx);
        if (i >= 0) { S.focus = i; }
        play(nx);
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
            "<div style='font-size:30px;font-weight:normal;color:#c5cad0;margin-top:10px'>" +
            (Math.abs(delta) >= 60 ? T("每下 {0} 分钟", Math.abs(delta) / 60) : T("每下 {0} 秒", Math.abs(delta))) + "</div>";
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
            toast(T("再按一次返回键退出"));
            return;
        }
        if (S.zone === "rail") {
            var list = railItems();
            if (k === 38) { S.railFocus = Math.max(0, S.railFocus - 1); renderRail(); }
            else if (k === 40) { S.railFocus = Math.min(list.length - 1, S.railFocus + 1); renderRail(); }
            else if (k === 39) { S.zone = "grid"; renderRail(); updateFocus(); }
            else if (k === 13) {
                var s = list[S.railFocus];
                if (s.id === "__search") { S.zone = "grid"; renderRail(); updateFocus(); openSearchBox(); return; }
                if (s.id === "__lang") {
                    var to = I18n.lang === "en" ? "zh" : "en";
                    R("界面语言 " + I18n.lang + " → " + to);
                    I18n.set(to);
                    location.reload();
                    return;
                }
                if (s.id === "__acct") { S.zone = "grid"; renderRail(); updateFocus(); openAcct(); return; }
                if (s.id === "__opts") { S.zone = "grid"; renderRail(); updateFocus(); openOpts(); return; }
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
        else if (k === 13) { S.enterArmed = false; play(S.items[S.focus]); return; }
        else { return; }
        updateFocus();
    }

    function toRail() {
        refreshSources(false);
        S.zone = "rail";
        /* 光标落在当前来源上（搜索结果 → 「搜索」那一项）；第 0 项是「搜索」，没有当前来源就落在第一个群上 */
        var i = railItems().findIndex(function (s) { return S.src && (s.id === S.src.id || (s.id === "__search" && S.src.kind === "search")); });
        S.railFocus = i >= 0 ? i : Math.min(1, railItems().length - 1);
        renderRail();
        updateFocus();
    }

    function togglePlay() {
        player.toggle();
        showOverlay();
        if (!video.paused) { hideOverlaySoon(); }
        saveProgress();
    }

    /* 确认键：短按暂停 / 继续，按住 650ms 开菜单（和 bilibili 客户端卡片上的长按一样）。松开时才判断是短按，
     * 按住时遥控器的自动重复不算新的一下。 */
    var LONG_MS = 650, enterHold = null;
    function enterDown() {
        if (enterHold || !S.enterArmed) { return; }
        var h = enterHold = { at: Date.now(), fired: false };
        h.timer = setTimeout(function () { if (enterHold === h && S.screen === "player") { h.fired = true; openMenu(); } }, LONG_MS);
    }
    /* 在卡片上按确认开始播放：这一下的自动重复和松开都还落在播放器里，不能算「按住开菜单」。等它松开了才认确认键 */
    S.enterArmed = true;
    document.addEventListener("keyup", function (e) {
        if (e.keyCode === 13 && !enterHold) { S.enterArmed = true; }
        if (e.keyCode !== 13 || !enterHold) { return; }
        var h = enterHold;
        enterHold = null;
        clearTimeout(h.timer);
        if (h.fired || S.screen !== "player" || S.menu || S.upnext) { return; }
        if (Date.now() - h.at >= LONG_MS) { openMenu(); } else { togglePlay(); }
    });
    window.addEventListener("blur", function () { if (enterHold) { clearTimeout(enterHold.timer); enterHold = null; } });

    function playerKey(k) {
        if (enterHold && k !== 13) { clearTimeout(enterHold.timer); enterHold = null; }
        /* 按住确认键时遥控器的自动重复：不算新的一下（不然菜单一弹出来，下一个重复就在菜单里按了确认） */
        if (k === 13 && enterHold) { return; }
        if (S.upnext) {
            if (k === 13) { playNext(S.upnext.it); }
            else if (k === 10009 || k === 413) { hideUpnext(); finishPlayback(true); }
            return;
        }
        if (S.menu) { menuKey(k); return; }
        if (k === 10009 || k === 413) {
            if (S.pending !== null) { clearTimeout(S.pendTimer); S.pending = null; $("seekhint").style.display = "none"; return; }
            finishPlayback(false);
            return;
        }
        if ($("perr").style.display === "block") { return; }
        if (k === 13) { enterDown(); return; }
        if (k === 10252 || k === 415 || k === 19) {
            if (k === 415 && !video.paused) { return; }
            if (k === 19 && video.paused) { return; }
            togglePlay();
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
        if (S.screen === "api") { apiKey(k); return; }
        if (S.screen === "search") { searchKey(k); return; }
        if (S.screen === "bootfail") { if (k === 13) { location.reload(); } else if (k === 10009) { exitApp(); } return; }
        if (S.screen === "login") { if (k === 10009) { leaveLogin(); } return; }
        if (S.screen === "acct") { acctKey(k); e.preventDefault(); return; }
        if (S.screen === "opts") { optsKey(k); e.preventDefault(); return; }
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

    /* 给自测（js/selftest.js）读的 */
    window.__app = { screen: function () { return S.screen; }, openOpts: openOpts };

    boot().catch(function (e) {
        /* 扫码页按返回、换账号都是 reload：卸载时 mtcute 销毁 port，等着的 signInQr 跟着断。那不是出事，以前每次都记成「启动出错」、报一次出事 */
        if (TG.leaving()) { return; }
        R("启动出错 " + errStr(e) + " | " + String(e && e.stack || "").split("\n").slice(0, 3).join(" "));
        Diag.incident("启动出错：" + errStr(e));
    });

    /* 自动更新（update.js）：先报这次跑的是哪份代码、为什么，每次开机一分钟后查，开着每六小时；第一次跑一个新下载的版本时提示一次 */
    try { Update.init({ report: Log.report, notice: function () { toast(T("已更新到 {0}", Boot.info().running), 4000); } }); }
    catch (e) { R("Update.init 抛异常：" + errStr(e)); }
    /* 这次启动 boot.js 扔掉了一个走不到首页的更新包。观众什么都看不到（照常跑安装包），开发者只能从这里知道 */
    try {
        var bootNote = Boot.info().note || "";
        if (/标坏|选代码时出错/.test(bootNote)) { Diag.incident("更新包启动失败：" + bootNote); }
    } catch (e) {}
    /* 这次启动的代码是好的：脚本都跑完、之后两秒没有一个 js 错误。boot.js 见到 Boot.ok() 才清掉 booting；没说这句的启动，下次打开
     * 把它跑的那个更新标坏、改跑安装包。不等连上 Telegram —— 断网时连不上，那不是代码坏了 */
    setTimeout(function () {
        if (Log.errors()) {
            R("启动后两秒内出过 " + Log.errors() + " 次 js 错误，这次启动不算成功（跑的是更新的话，下次打开退回安装包）");
            return;
        }
        try { Boot.ok(); } catch (e) {}
    }, 2000);
})();
