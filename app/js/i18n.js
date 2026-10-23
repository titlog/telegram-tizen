/* 界面语言：中文 / 英文（2026-10-18，开源后给外国用户）。
 *
 * 写法：界面上的字照旧写中文，套一层 T("…")。中文原句就是键，英文模式下查 EN；查不到就原样显示中文（不会空着）。
 * 带变量的用 {0} {1}：T("从 {0} 接着放", fmtTime(t))。test/i18n.mjs 检查每个 T("…") 和 index.html 里的 data-i18n 在 EN 里都有。
 * 日志（Log.report / R(...)）不翻，那是给开发看的。
 *
 * 选哪个：手动选过的（来源栏最下面那一项，存 tg.lang.v1）→ 电视系统语言是中文就中文、别的都英文。
 * 例外：已经在用的电视（本地有看过的记录、上次的来源）第一次升级到双语版时定成中文 —— 2026-10-18 之前只有中文界面，
 * 用户的电视系统语言不一定是中文，升级之后突然变成英文不对。
 *
 *   I18n.lang（"zh" | "en"）、I18n.t(key, ...)、I18n.date(d)、I18n.apply()（换掉 index.html 里 data-i18n 的元素）、I18n.set(lang)
 */
var I18n = (function () {
    "use strict";

    var KEY = "tg.lang.v1";
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

    var sys = String(navigator.language || (navigator.languages && navigator.languages[0]) || "");
    var lang = get(KEY), why = "手动选的";
    if (lang !== "zh" && lang !== "en") {
        if (get("tg.progress.v1") || get("tg.lastSource.v1")) { lang = "zh"; why = "升级前就在用（保持中文）"; put(KEY, lang); }
        else { lang = /^zh/i.test(sys) ? "zh" : "en"; why = "跟系统语言"; }
    }

    var EN = {
        /* ---------- index.html ---------- */
        "TG 视频": "TG Video",
        "← 换群": "← Groups",
        "确认 暂停 · 长按确认 音轨 / 字幕 · ←→ ↑↓ 快进快退（按住越来越快）· 返回 回列表":
            "OK pause · Hold OK audio / subtitles · ←→ ↑↓ seek (hold to go faster) · Back to the list",
        "↑↓ 选 · 确认 · ←→ 调字幕时间 · 返回 关掉": "↑↓ choose · OK select · ←→ subtitle timing · Back close",
        "接着放下一集": "Up next",
        "登录 Telegram": "Sign in to Telegram",
        "手机打开 Telegram →<br><b>设置 → 设备 → 关联桌面设备</b><br>扫右边这个码":
            "On your phone, open Telegram →<br><b>Settings → Devices → Link Desktop Device</b><br>and scan the code on the right",
        "这个账号开了两步验证，输入密码后按确认：": "This account has two-step verification. Enter the password and press OK:",
        "登录": "Sign in to",
        "登录一次，查到你的账号编号，之后直接读公开的页面，不用再登录。<br>用遥控器输入，输完按屏幕键盘上的「完成」。密码不保存。按返回键取消。":
            "Sign in once to look up your account number; after that the public pages are read directly, with no more signing in.<br>" +
            "Type with the remote and press “Done” on the on-screen keyboard. The password is not saved. Press Back to cancel.",
        "账号": "Account",
        "密码": "Password",
        "搜索": "Search",
        "在你所有的群和频道里找视频：片名、说明文字、文件名都算。<br>用遥控器输入，输完按屏幕键盘上的「完成」。按返回键取消。":
            "Find videos in all your groups and channels — titles, captions and file names all count.<br>" +
            "Type with the remote and press “Done” on the on-screen keyboard. Press Back to cancel.",
        "最近搜过（按 ↓ 选）": "Recent searches (press ↓ to choose)",
        "填你自己的 Telegram API ID": "Enter your own Telegram API ID",
        "这台电视要用一组你自己的 Telegram API ID 才能连上。只要填一次，只存在这台电视上。<br>用手机扫右边的码打开 my.telegram.org，用你的手机号登录，点「API development tools」，随便填个名字建一个应用，把 App api_id 和 App api_hash 填在下面。<br>用遥控器输入，输完按屏幕键盘上的「完成」。":
            "This TV needs a Telegram API ID of your own to connect. You enter it once; it stays on this TV.<br>" +
            "Scan the code on the right to open my.telegram.org, sign in with your phone number, choose “API development tools”, create an app (any name will do) " +
            "and enter its App api_id and App api_hash below.<br>Type with the remote and press “Done” on the on-screen keyboard.",

        /* ---------- API ID / Hash（apikey.js） ---------- */
        "Telegram 不认这组 API ID / Hash（{0}）。对着 my.telegram.org 核对一下再填。":
            "Telegram did not accept this API ID / Hash ({0}). Check them against my.telegram.org and try again.",
        "Telegram 不再接受这个安装包带的 API ID（{0}）。填你自己申请的就能接着用。":
            "Telegram no longer accepts the API ID this package ships with ({0}). Enter one of your own to keep using the app.",
        "App api_id 是一串数字，现在填的是「{0}」": "App api_id is a number; what is entered now is “{0}”",
        "先填 App api_id": "Enter the App api_id first",
        "再填 App api_hash": "Now enter the App api_hash",
        "App api_hash 只有 0–9 和 a–f，里面有别的字": "App api_hash only has 0–9 and a–f, and this has other characters",
        "App api_hash 是 32 位，现在是 {0} 位": "App api_hash is 32 characters long; this is {0}",
        "存不下来（电视的存储出错了）": "Could not save it (the TV's storage failed)",
        "没有 API ID / Hash": "No API ID / Hash",
        "已更新到 {0}": "Updated to {0}",

        /* ---------- 设置：诊断日志、自动更新 ---------- */
        "设置": "Settings",
        "诊断日志：出问题时（连不上、读不到、放不了），应用会把排查需要的运行信息传给开发者，不会泄露个人隐私。到 GitHub 报问题时附上这台电视的编号。<br>自动更新：新版本从这个项目的 GitHub 仓库下载，带签名，验过才用，下次打开生效；新版本启动不起来会自动退回装的这一版。":
            "Diagnostic logs: when something goes wrong (can't connect, can't load, won't play), the app sends the developer the information needed to find out why, and nothing that identifies you. " +
            "When reporting a problem on GitHub, quote this TV's code.<br>Self-update: new versions come from this project's GitHub repository, signed, and are used only once verified, from the next launch; " +
            "a new version that cannot start falls back to the installed one.",
        "诊断日志：开": "Diagnostic logs: on",
        "诊断日志：关": "Diagnostic logs: off",
        "上传诊断日志": "Send diagnostic logs",
        "检查更新": "Check for updates",
        "诊断日志关着：什么都不记录，也不上传": "Diagnostic logs are off: nothing is recorded or sent",
        "这台电视的编号 {0}": "This TV's code: {0}",
        "这个版本没有接收地址，不会上传": "this build has no address to send to",
        "正在上传…": "sending…",
        "{0} 已上传（编号 {1}）": "sent at {0} (code {1})",
        "{0} 没传上：{1}": "not sent at {0}: {1}",
        "诊断日志关着，先把它打开": "Diagnostic logs are off — switch them on first",
        "诊断日志关着": "diagnostic logs are off",
        "这个版本没有接收地址": "this build has no address to send to",
        "正在上传上一份": "still sending the previous one",
        "刚传过，过几秒再按": "just sent — wait a few seconds",
        "连不上": "can't connect",
        "超时": "timed out",
        "正在运行 {0}": "Running {0}",
        "正在运行 {0}（装的是 {1}）": "Running {0} (installed: {1})",
        "这台电视验不了签名，不能自动更新": "this TV cannot verify signatures, so it cannot update itself",
        "正在检查…": "checking…",
        "{0} 已下载，下次打开生效": "{0} downloaded, runs from the next launch",
        "{0} 查过，没查成": "checked at {0}, the check failed",
        "{0} 查过，没有新版本": "checked at {0}, no newer version",

        /* ---------- 启动、登录、来源 ---------- */
        "连不上 Telegram": "Can't reach Telegram",
        "检查网络后按确认重试": "Check the network, then press OK to retry",
        "要重新安装一次": "Reinstall the app once",
        "按返回键退出": "Press Back to exit",
        "这台电视上装的版本打不开，自动更新换不了它。用 Apps2Samsung 再装一次最新版就好。": "The version installed on this TV can't start here, and automatic updates can't replace it. Install the latest version once more with Apps2Samsung.",
        "正在找有视频的群和频道…": "Looking for groups and channels with videos…",
        "还没有哪个群里有视频。<br>在手机上把想看的片子转发到一个群（比如自己建的），回到电视上按确认刷新。":
            "None of your groups has videos yet.<br>On your phone, forward a video to a group (one of your own, for example), then press OK here to refresh.",
        "二维码 30 秒换一张（第 {0} 张）": "The code changes every 30 seconds (code {0})",
        "已扫码，正在登录…": "Scanned — signing in…",
        "两步验证密码不对，再输一次": "Wrong two-step verification password, try again",
        "群": "Group",
        "频道": "Channel",
        "私聊": "Chat",
        "网页": "Web",
        "搜索：{0}": "Search: {0}",
        "加载中…": "Loading…",
        "读不到这里的视频：{0}<br>按确认重试": "Couldn't load the videos here: {0}<br>Press OK to retry",
        "搜索出错：{0}<br>按确认重试": "Search failed: {0}<br>Press OK to retry",
        "没搜到「{0}」。<br>按 ← 打开来源栏，再选「搜索」换个词。": "Nothing found for “{0}”.<br>Press ← to open the source list and choose Search to try another word.",
        "搜索「{0}」": "Search “{0}”",
        "左边多了 {0} 个来源，按 ← 打开": "{0} new sources on the left — press ← to open",
        "左边多了一个来源「{0}」，按 ← 打开": "New source on the left: “{0}” — press ← to open",
        "登录成功了，但还是看不到这个列表。<br>电视可能带不上这个网站的登录状态（日志里有详情）。":
            "Signed in, but the list still isn't visible.<br>The TV may not be able to keep this site's sign-in (details in the log).",
        "这个列表要登录一次才能看（查账号编号）。<br>按确认登录": "This list needs a one-time sign-in (to look up your account number).<br>Press OK to sign in",
        "读不到这个列表：{0}<br>按确认重试": "Couldn't load this list: {0}<br>Press OK to retry",
        "正在登录…": "Signing in…",
        "登录失败：{0}": "Sign-in failed: {0}",
        "登录成功": "Signed in",
        "登录出错：{0}": "Sign-in error: {0}",
        "再按一次返回键退出": "Press Back again to quit",
        /* 账号 */
        "账号：{0}": "Account: {0}",
        "账号 {0}": "Account {0}",
        "这台电视上登录的 Telegram 账号。切换不用重新扫码；每个人的来源、看到哪里各记各的。":
            "Telegram accounts signed in on this TV. Switching needs no new scan; everyone's sources and progress are kept separately.",
        "+ 添加账号": "+ Add an account",
        "退出 {0}": "Sign out {0}",
        "再按一次确认，退出 {0}": "Press OK again to sign out {0}",
        "添加账号：用另一个 Telegram 账号扫码 · 按返回键取消": "Adding an account: scan with another Telegram account · Back to cancel",
        "{0} 要重新扫码登录 · 按返回键换别的账号": "{0} needs to sign in again · Back for another account",
        "这个账号已经在这台电视上了，切到了它": "This account is already on this TV — switched to it",
        "已切换到 {0}": "Switched to {0}",
        "共 {0} 个视频": "{0} videos",
        "（已加载 {0}）": " ({0} loaded)",

        /* ---------- 网格 ---------- */
        "网页 · {0}": "Web · {0}",
        "看完了 · {0}": "Watched · {0}",
        "看到 {0} · {1}": "At {0} · {1}",
        "这里没有视频。<br>在手机上找到想看的片子，长按 → <b>转发</b> → 选这个群，回到电视上按确认刷新。":
            "No videos here.<br>On your phone, long-press a video → <b>Forward</b> → this group, then press OK here to refresh.",
        "视频": "Video",

        /* ---------- 播放 ---------- */
        "正在打开…": "Opening…",
        "缓冲中…": "Buffering…",
        "换音轨…": "Switching audio…",
        "正在解析网页…": "Reading the web page…",
        "从 {0} 接着放": "Resuming from {0}",
        "看完了": "Finished",
        "放不了：{0}": "Can't play: {0}",
        "未知错误": "unknown error",
        "按返回键回到列表": "Press Back to return to the list",
        "已暂停": "Paused",
        "每下 {0} 分钟": "{0} min per press",
        "每下 {0} 秒": "{0} s per press",
        "{0} 秒后开始　·　确认 现在放　·　返回 不放了": "Starts in {0} s　·　OK play now　·　Back cancel",

        /* ---------- 音轨、字幕、菜单 ---------- */
        "中文": "Chinese", "国语": "Mandarin", "粤语": "Cantonese", "英语": "English", "日语": "Japanese", "韩语": "Korean",
        "法语": "French", "德语": "German", "西班牙语": "Spanish", "意大利语": "Italian", "俄语": "Russian", "泰语": "Thai",
        "葡萄牙语": "Portuguese", "越南语": "Vietnamese", "印地语": "Hindi", "简体中文": "Chinese (Simplified)", "繁体中文": "Chinese (Traditional)",
        "简体": "Simplified Chinese", "繁体": "Traditional Chinese", "英文": "English", "中英": "Chinese + English",
        "杜比 AC-3": "Dolby AC-3", "杜比 E-AC-3": "Dolby E-AC-3",
        "单声道": "Mono", "立体声": "Stereo", "{0} 声道": "{0} ch",
        "音轨 {0}": "Audio {0}",
        "字幕 {0}": "Subtitles {0}",
        "图形": "image",
        "（片子里）": " (in the file)",
        "（群里的文件）": " (file in the group)",
        "有字幕，长按确认键可以打开": "Subtitles available — hold OK to turn them on",
        "有字幕，长按确认键可以选": "Subtitles available — hold OK to choose",
        "字幕关了": "Subtitles off",
        "字幕：{0}": "Subtitles: {0}",
        "字幕文件「{0}」里读不出字幕": "No subtitles could be read from “{0}”",
        "字幕文件下不下来：{0}": "Couldn't download the subtitle file: {0}",
        "音轨": "Audio",
        "字幕": "Subtitles",
        "关": "Off",
        "没有找到字幕": "No subtitles found",
        "正在找群里的字幕文件…": "Looking for subtitle files in the group…",
        "字幕时间（和对白对不上时调）": "Subtitle timing (if it's out of sync with the dialogue)",
        "← 推迟 {0} 秒 →": "← Delay {0} s →",
        "← 提前 {0} 秒 →": "← Advance {0} s →",
        "← 不调 0.0 秒 →": "← No shift (0.0 s) →",
        "下一集": "Next episode",
        "English": "English",
        "中文界面": "中文界面",

        /* ---------- 播放器、MKV、MP4 交出来的原因（显示在「放不了：…」和提示条里） ---------- */
        "；": "; ",
        "、": ", ",
        "没有视频轨": "No video track",
        "视频 {0} 放不了": "Video {0} can't be played",
        "{0} 电视放不了": "The TV can't play {0}",
        "没有能放的音轨（{0}），没声音": "No playable audio track ({0}) — playing without sound",
        "90 秒没出画面": "No picture after 90 seconds",
        "播放器出错": "Player error",
        "没读够（{0}/{1}）": "Short read ({0}/{1})",
        "mdat 一直到文件尾，没有 moov": "No moov: the media data runs to the end of the file",
        "已经是分段 MP4（fragmented），还不支持": "Fragmented MP4 isn't supported yet",
        "不认识的文件格式（不是 MP4 也不是 MKV）": "Unknown file format (neither MP4 nor MKV)",
        "读到文件尾也没找到 moov": "No moov found before the end of the file",
        "不是 MKV（没有 EBML 头）": "Not an MKV (no EBML header)",
        "MKV 里没有 Segment": "No Segment in the MKV",
        "MKV 里没有 Tracks": "No Tracks in the MKV",
        "MKV 里找不到 Cluster": "No Cluster found in the MKV",
        "加密的轨道放不了": "Encrypted tracks can't be played",
        "压缩过的视频轨放不了": "Compressed video tracks can't be played",
        "压缩过的音频轨放不了": "Compressed audio tracks can't be played",
        "视频格式 {0} 放不了": "Video format {0} isn't supported",
        "音频格式 {0} 放不了": "Audio format {0} isn't supported",
        "字幕格式 {0} 放不了": "Subtitle format {0} isn't supported",
        "未知": "unknown",
        "DTS 音轨电视放不了": "The TV can't play DTS audio",
        "TrueHD 音轨电视放不了": "The TV can't play TrueHD audio",
        "Vorbis 音轨放不了": "Vorbis audio isn't supported",
        "PCM 音轨放不了": "PCM audio isn't supported",
        "DVD 图形字幕（VobSub）放不了": "DVD image subtitles (VobSub) aren't supported",
        "FLAC 头不对": "Bad FLAC header",
        "{0} {1} 秒没回": "{0}: no reply in {1} s",
        "连接": "Connecting",

        /* ---------- 网页链接（web.js） ---------- */
        "网络错误": "Network error",
        "{0} 秒没回": "No reply in {0} s",
        "不认识这个网站：{0}": "No site rule for {0}",
        "解析不出视频地址（{0}）": "Couldn't find the video address ({0})",
        "Cloudflare 挡了": "blocked by Cloudflare",
        "页面里没有地址": "no address in the page",
        "框：{0}": "frame: {0}",
        "没开始": "not started",
        "读得到框，{0}「{1}」": "frame readable, {0} “{1}”",
        "错误页：{0}": "error page: {0}",
        "读不了框：{0}": "can't read the frame: {0}",
        "不认识这个列表：{0}": "No site rule for this list: {0}",
        "要登录一次（查账号编号）": "A one-time sign-in is needed (to look up the account number)",
        "要登录（XHR 落到 {0}）": "Sign-in needed (redirected to {0})",
        "要登录（框落到登录页）": "Sign-in needed (the frame landed on the sign-in page)",
        "取不到列表（{0}；框：{1}）": "Couldn't load the list ({0}; frame: {1})",
        "翻页 {0}": "Next page: {0}",
        "列表是空的（多半是没登录上）": "The list is empty (probably not signed in)",
        "这个站不会登录": "This site rule can't sign in",
        "登录没有结果": "Sign-in returned nothing",
        "取不到页面信息（{0}；框：{1}）": "Couldn't read the page ({0}; frame: {1})",
        "这台电视上 hls.js 用不了（没有 MSE？）": "hls.js doesn't work on this TV (no MSE?)",
        "40 秒没出画面": "No picture after 40 seconds"
    };

    function fill(s, args, from) { return String(s).replace(/\{(\d)\}/g, function (m, i) { var v = args[+i + from]; return v === undefined ? m : v; }); }
    function t(key) { return fill(lang === "en" && EN[key] !== undefined ? EN[key] : key, arguments, 1); }

    var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    /* 卡片上的日期：今年的不写年 */
    function date(d) {
        if (!d) { return ""; }
        var y = d.getFullYear() !== new Date().getFullYear();
        if (lang === "en") { return MON[d.getMonth()] + " " + d.getDate() + (y ? ", " + d.getFullYear() : ""); }
        return (y ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    /* index.html 里带 data-i18n 的元素：里面的 HTML 就是键 */
    function apply() {
        document.documentElement.lang = lang === "en" ? "en" : "zh";
        document.title = t("TG 视频");
        var els = document.querySelectorAll("[data-i18n]");
        for (var i = 0; i < els.length; i++) { els[i].innerHTML = t(els[i].innerHTML.trim()); }
    }

    function set(l) { put(KEY, l); }

    return { lang: lang, sys: sys, why: why, t: t, date: date, apply: apply, set: set, keys: function () { return Object.keys(EN); } };
})();
var T = I18n.t;
