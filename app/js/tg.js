/* Telegram 这一层：客户端、扫码登录、来源（收藏夹 + 群 / 频道）、来源里的视频、封面、给播放器的数据源。
 * 底下是 mtcute（build/ 打成 js/tg.bundle.js，全局 TGLib）。 */
var TG = (function () {
    "use strict";
    /* 显示给用户的话（i18n.js）；node 里的离线测试没有 I18n，原样用中文 */
    var tx = typeof I18n !== "undefined" ? I18n.t : function (s) { var a = arguments; return String(s).replace(/\{(\d)\}/g, function (m, i) { return a[+i + 1]; }); };

    var client = null, mode = "", remake = null, reconnecting = null, reconnects = 0;
    var VIDEO = { _: "inputMessagesFilterVideo" };
    var DOCS = { _: "inputMessagesFilterDocument" };
    var URLS = { _: "inputMessagesFilterUrl" };
    /* 音乐（issue #3「Telegram Music」，2026-10-26）：Telegram 的「音乐」筛的是带歌名 / 歌手属性的音频文件，语音消息不在里面 */
    var MUSIC = { _: "inputMessagesFilterMusic" };
    /* 当文件发的视频：MKV 几乎都是这么发的，MP4 选「不压缩」发也是。它们在 Telegram 的「文件」里，「视频」筛不出来
     * （手机上能放，是因为手机客户端认扩展名）。avi / rmvb / ts 之类电视放不了，不列。 */
    var VIDEO_EXT = /\.(mkv|webm|mp4|m4v|mov)$/i, VIDEO_MIME = /^video\/(x-matroska|webm|mp4|quicktime|x-m4v)$/i;
    var SUB_EXT = /\.(srt|ass|ssa|vtt)$/i;

    function timeout(p, ms, what) {
        return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(tx("{0} {1} 秒没回", tx(what), ms / 1000))); }, ms); })]);
    }

    /* mtcute 默认在后台线程（见 build/src/worker.js）；15 秒连不上就退回主线程直连。会话在当前账号的库里（accounts.js）。
     * API ID / Hash：安装包里的（从源码装），或者电视上填的（发布包），见 apikey.js */
    async function init() {
        var storage = Accounts.active().storage, api = ApiKey.get();
        if (!api) { throw new Error(tx("没有 API ID / Hash")); }
        var r = await TGLib.create(api.id, api.hash, undefined, storage);
        client = r.client;
        remake = r.reconnect || null;
        mode = r.mode;
        try {
            await timeout(client.connect(), 15000, "连接");
        } catch (e) {
            if (mode !== "worker") { throw e; }
            mode = "direct（后台线程：" + e.message + "）";
            client = (await TGLib.create(api.id, api.hash, "direct", storage)).client;
            remake = null;     // 主线程直连没有后台线程，也就没有「连接作废」
            await client.connect();
        }
        return client;
    }

    /* 后台线程的连接被作废（应用在后台挂了一分钟以上，见 build/src/entry.js）：在同一个线程上重连，再把失败的那次重试一遍 */
    function gone(e) { return /Worker connection (expired|closed)/.test(String(e && e.message)); }
    function reconnect() {
        if (!reconnecting) {
            var t0 = performance.now();
            reconnecting = (async function () {
                client = remake();
                await client.connect();
                reconnects++;
                Log.report("tg", "后台线程的连接作废了，重连 " + Math.round(performance.now() - t0) + "ms（第 " + reconnects + " 次）");
            })().finally(function () { reconnecting = null; });
        }
        return reconnecting;
    }
    async function again(fn) {
        try { return await fn(); }
        catch (e) {
            if (!remake || !gone(e)) { throw e; }
            await reconnect();
            return await fn();
        }
    }

    async function me() {
        try { return await again(function () { return client.getMe(); }); } catch (e) { return null; }
    }

    /* 页面在卸载（扫码页按返回、换账号都是 reload）：mtcute 自己在这时销毁 port，同样是 stopSignal 中止，那不是作废，不重连 */
    var leaving = false;
    window.addEventListener("beforeunload", function () { leaving = true; });

    /* onUrl(url, expires) 每换一张码调一次；askPassword() → Promise<string>（两步验证）。
     * 扫码页上挂到后台一分钟以上（电视待机也是）：后台线程把这条连接作废，等着的 signInQr 跟着断 —— 正等一个请求时报
     * 「Worker connection expired」，在两次换码之间时报「signal is aborted without reason」（port 的 stopSignal 被中止）。
     * 1.1.2 上 boot() 就停在这里、二维码不再换（2026-10-23 一台别人的电视；--loginexpiry 复现）。重连、重新出码，最多三次 */
    async function login(onUrl, onScanned, askPassword, onBadPassword) {
        for (var tries = 0; ; tries++) {
            try {
                return await client.signInQr({ onUrlUpdated: onUrl, onQrScanned: onScanned, password: askPassword, invalidPasswordCallback: onBadPassword });
            } catch (e) {
                if (leaving || !remake || tries >= 3 || !(gone(e) || (client.stopSignal && client.stopSignal.aborted))) { throw e; }
                Log.report("tg", "扫码时后台线程的连接作废了（" + (e && e.message) + "），重连、重新出码");
                await reconnect();
            }
        }
    }

    async function logout() { try { await client.logOut(); } catch (e) {} }

    /* 来源：收藏夹排第一，后面是最近的群 / 频道 / 私聊（不管里面有没有视频 —— 一个个去搜太慢；点进去是空的就写「没有视频」） */
    function sources(limit) { return again(function () { return sourcesOnce(limit); }); }
    async function sourcesOnce(limit) {
        var out = [];   // 不要收藏夹（用户 2026-10-01：习惯用自己建的一个群）
        var n = 0;
        for await (var d of client.iterDialogs({ limit: limit || 40, archived: "exclude" })) {
            var p = d.peer;
            if (p.isSelf) { continue; }
            out.push({
                id: p.id,
                title: p.title || p.displayName || String(p.id),
                kind: p.type === "user" ? "user" : (p.chatType === "channel" ? "channel" : "group")
            });
            if (++n >= (limit || 40)) { break; }
        }
        return out;
    }

    function isVideoMsg(m) { var d = m.media; return !!d && d.type === "video" && !d.isRound && !d.isAnimation; }
    function isMusic(m) { return !!m.media && m.media.type === "audio"; }
    function isVideoDoc(m) {
        var d = m.media;
        return !!d && d.type === "document" && (VIDEO_EXT.test(d.fileName || "") || VIDEO_MIME.test(d.mimeType || ""));
    }

    /* 这个来源里有几个视频（只问数量，limit 1）。一个「视频」都没有的，再看最近 40 个文件里有没有当文件发的（只有 MKV 的群），
     * 再没有就问音乐（只有歌的频道也进来源栏） */
    async function videoCount(sourceId) {
        var res = await again(function () { return client.searchMessages({ chatId: sourceId, filter: VIDEO, limit: 1 }); });
        var n = res.total || res.length;
        if (n) { return n; }
        var docs = await again(function () { return client.searchMessages({ chatId: sourceId, filter: DOCS, limit: 40 }); });
        docs.forEach(noteSub);
        n = docs.filter(isVideoDoc).length;
        if (n) { return n; }
        var mu = await again(function () { return client.searchMessages({ chatId: sourceId, filter: MUSIC, limit: 1 }); });
        return mu.total || mu.length;
    }

    /* 「视频」「文件」「音乐」几路按时间合并成一串，新的在前。cursor 由 app 存着、原样传回来（page.next）。
     * 文件那一路里大多不是视频（PDF、压缩包、字幕…）：翻到的字幕文件顺手记下来（subtitlesFor 用）。
     * 各路各自一页一页往前翻；第一路以外的哪一路暂时手上没有，要翻到比已有的最新那个更早的时间，才能确定先出哪个
     * （每页最多多翻 4 页 × 路数，翻不到就先按手上的出，顺序可能差一点）。 */
    function run(fetch, keep) { return { fetch: fetch, keep: keep, next: undefined, buf: [], end: false, minDate: Infinity, total: 0, kept: 0 }; }
    async function pull(r) {
        var res = await again(function () { return r.fetch(r.next); });
        r.total = res.total || 0;
        res.forEach(function (m) {
            if (m.date.getTime() < r.minDate) { r.minDate = m.date.getTime(); }
            if (r.keep(m)) { r.buf.push(describe(m)); r.kept++; }
            else { noteSub(m); }
        });
        r.next = res.next;
        if (!res.length || res.next === undefined) { r.end = true; }
    }
    async function merged(c, limit) {
        var rs = c.runs, v = rs[0], out = [], extra = 0;
        if (!c.started) { c.started = true; await Promise.all(rs.map(pull)); }
        while (out.length < limit) {
            if (!v.buf.length && !v.end) { await pull(v); continue; }
            var best = null;
            rs.forEach(function (r) { if (r.buf[0] && (!best || r.buf[0].date > best.buf[0].date)) { best = r; } });
            var newest = best ? best.buf[0].date.getTime() : -Infinity;
            var lag = rs.filter(function (r) { return r !== v && !r.buf.length && !r.end && newest < r.minDate; })[0];
            if (lag && extra < 4 * (rs.length - 1)) { extra++; await pull(lag); continue; }
            if (!best) { break; }
            out.push(best.buf.shift());
        }
        var more = rs.some(function (r) { return r.buf.length || !r.end; });
        /* 第一路（视频）报的是总数；文件那一路大多不是视频，按留下的算 */
        return { items: out, next: more ? c : undefined, total: rs.reduce(function (n, r, i) { return n + (i === 1 ? r.kept : r.total); }, 0) };
    }

    /* 一个来源里的视频，新的在前。page.next 传回来取下一页。 */
    function videos(sourceId, cursor, limit) {
        var c = cursor || { runs: [
            run(function (next) { return client.searchMessages({ chatId: sourceId, filter: VIDEO, limit: 40, offset: next }); }, isVideoMsg),
            run(function (next) { return client.searchMessages({ chatId: sourceId, filter: DOCS, limit: 40, offset: next }); }, isVideoDoc),
            run(function (next) { return client.searchMessages({ chatId: sourceId, filter: MUSIC, limit: 40, offset: next }); }, isMusic)
        ] };
        return merged(c, limit || 40);
    }

    /* 搜索（所有会话里的视频，加上文件名对得上的视频文件）。用法同 videos */
    function search(query, cursor, limit) {
        var c = cursor || { runs: [
            run(function (next) { return client.searchGlobal({ query: query, filter: VIDEO, limit: 40, offset: next }); }, isVideoMsg),
            run(function (next) { return client.searchGlobal({ query: query, filter: DOCS, limit: 40, offset: next }); }, isVideoDoc),
            run(function (next) { return client.searchGlobal({ query: query, filter: MUSIC, limit: 40, offset: next }); }, isMusic)
        ] };
        return merged(c, limit || 40);
    }

    /* ---------- 字幕文件（.srt / .ass 和片子发在同一个群里） ---------- */

    var subFiles = {};      // 会话 id → {消息 id: {name, date, id, doc, size}}
    function noteSub(m) {
        var d = m.media;
        if (!d || d.type !== "document" || !SUB_EXT.test(d.fileName || "")) { return; }
        var k = String(m.chat.id);
        (subFiles[k] = subFiles[k] || {})[m.id] = { name: d.fileName, date: m.date, id: m.id, doc: d, size: d.fileSize || 0 };
    }
    function stem(n) { return String(n || "").replace(/\.[a-z0-9]{2,4}$/i, "").toLowerCase().replace(/[\s._\-\[\]()（）【】]+/g, " ").trim(); }
    /* 字幕文件名里的语言：chs / sc / 简 → 简体，cht / tc / 繁 → 繁体，两个都有 / 双语 → 中英 */
    function subLang(name) {
        var n = stem(name).replace(/\s/g, "."), zh = /(^|\.)(chs|sc|gb|zh-?(hans|cn)|简体?|简中)(\.|$)/.test(n) || /简/.test(name),
            tw = /(^|\.)(cht|tc|big5|zh-?(hant|tw|hk)|繁體?|繁中)(\.|$)/.test(n) || /繁/.test(name),
            en = /(^|\.)(eng?|english)(\.|$)/.test(n) || /英/.test(name);
        if (/双语|雙語/.test(name) || ((zh || tw) && en)) { return "中英"; }
        return zh ? "简体" : tw ? "繁体" : en ? "英文" : "";
    }
    /* 给这个视频挑字幕文件：文件名同前缀最像（Movie.2001.1080p.mkv ↔ Movie.2001.1080p.chs.srt）；片名在文件名里；
     * 发的时间、消息编号挨着。分数 ≥ 1 才列，≥ 3 算「就是它」（app 自动打开）。 */
    function subScore(item, s) {
        var vs = stem(item.fileName), ss = stem(s.name), t = stem(item.title).replace(/\s/g, ""), score = 0;
        if (vs.length > 3 && ss.indexOf(vs) === 0) { score += 3; }
        else if (vs) {
            var tok = vs.split(" ").filter(function (x) { return x.length > 1; }), hit = tok.filter(function (x) { return ss.indexOf(x) >= 0; }).length;
            if (tok.length) { score += 2.5 * hit / tok.length; }
        }
        if (t.length > 1 && ss.replace(/\s/g, "").indexOf(t) >= 0) { score += 2; }
        var dt = Math.abs(s.date - item.date) / 60000;
        score += dt < 10 ? 1.5 : dt < 180 ? 0.5 : 0;
        if (item.msg && Math.abs(s.id - item.msg.id) <= 3) { score += 1; }
        return score;
    }
    var subLooked = {};
    async function subtitlesFor(item) {
        if (!item.msg || !item.msg.chat) { return []; }
        var k = String(item.msg.chat.id);
        /* 从搜索打开的、或者那个群的文件还没翻到这条的时间：按这条的时间问一次（它前后发的文件） */
        var lk = k + ":" + Math.floor(item.date.getTime() / 86400000);
        if (!subLooked[lk]) {
            subLooked[lk] = true;
            try {
                var res = await again(function () { return client.searchMessages({ chatId: item.msg.chat.id, filter: DOCS, limit: 40, maxDate: new Date(item.date.getTime() + 2 * 86400000) }); });
                res.forEach(noteSub);
            } catch (e) { Log.report("tg", "找字幕文件出错 " + (e && e.message)); }
        }
        var all = subFiles[k] || {};
        return Object.keys(all).map(function (id) {
            var s = all[id];
            return { name: s.name, lang: subLang(s.name), size: s.size, score: subScore(item, s), doc: s.doc };
        }).filter(function (s) { return s.score >= 1 && s.size < 8 * 1048576; })
          .sort(function (a, b) { return b.score - a.score; }).slice(0, 8);
    }
    function download(doc) { return again(function () { return client.downloadAsBuffer(doc); }); }

    /* 网页链接（见 web.js）：最近的 limit 条带链接的消息里，认识的站、或者直接是 .m3u8 / .mp4 的。带视频的消息（说明文字里
     * 常有频道链接）不算，那条已经在视频里了。新的在前。 */
    async function links(sourceId, limit) {
        var res = await again(function () { return client.searchMessages({ chatId: sourceId, filter: URLS, limit: limit || 40 }); });
        var items = [], seen = {};
        res.forEach(function (m) {
            if (m.media && m.media.type !== "webpage") { return; }
            var url = linkOf(m);
            if (!url || seen[url]) { return; }
            seen[url] = true;
            if (Web.playable(url)) { items.push(describeLink(m, url)); }
            else if (Web.listable(url)) {
                /* 列表页的链接（收藏、分类…）：不进网格，变成左边的一个来源（见 app.js） */
                var w = m.media && m.media.type === "webpage" ? m.media.preview : null;
                items.push({ kind: "weblist", url: url, title: captionTitle(m) || Web.listTitle(url, w && w.title), date: m.date });
            }
        });
        return items;
    }

    /* 消息里原样写的地址优先，Telegram 预览里的地址排最后：预览会把末尾的「/」规整掉，有的站上没有「/」的地址是 404、
     * 带「/」的才是片子（2026-10-02 电视上第一次就栽在这）。 */
    function linkOf(m) {
        var urls = [];
        (m.entities || []).forEach(function (e) { if (e.kind === "text_link" && e.params && e.params.url) { urls.push(e.params.url); } });
        (m.text || "").replace(/https?:\/\/[^\s<>"'）)]+/g, function (u) { urls.push(u); return u; });
        if (m.media && m.media.type === "webpage" && m.media.preview && m.media.preview.url) { urls.push(m.media.preview.url); }
        for (var i = 0; i < urls.length; i++) { if (Web.playable(urls[i]) || Web.listable(urls[i])) { return Web.normalize(urls[i]); } }
        return urls[0] || null;
    }

    /* Telegram 给链接生成的预览：标题、图。Cloudflare 后面的站多半只拿到「Just a moment...」，不算 */
    function describeLink(m, url) {
        var w = m.media && m.media.type === "webpage" ? m.media.preview : null;
        var bare = new URL(url).hostname.replace(/^www\./, "");
        /* 只有站名（预览没拿到片子页的标题）也不算 */
        var wt = w && w.title && !/just a moment|attention required/i.test(w.title) && w.title.trim().toLowerCase() !== bare ? Web.title(url, w.title) : "";
        var meta = Web.cachedMeta(url);
        var host = new URL(url).hostname.replace(/^www\./, "");
        return {
            kind: "web",
            key: m.chat.id + ":" + m.id,
            fileKey: "web:" + url,
            msg: m,
            url: url,
            site: host,
            doc: w && w.photo && !/just a moment/i.test(w.title || "") ? w.photo : null,
            title: captionTitle(m) || wt || (meta && meta.title) || host,
            fileName: "",
            caption: m.text || "",
            size: 0,
            duration: 0,
            width: 0,
            height: 0,
            mime: "",
            date: m.date,
            hasCover: false,
            info: captionInfo(m.text || "")
        };
    }

    /* 标题：说明文字的第一行（去掉链接、@ 提及、标签的 #），没有就用文件名 */
    /* 标题：说明文字第一行。有《》就取书名号里面的（这类频道的惯例：「《#黑鹰坠落 国语 高清》 #2001年美国高分怀旧电影 #动作电影」）；
     * 没有就去掉 #标签（只剩标签时保留标签的字）。链接、@提及都去掉。没有说明文字用文件名。
     * 第一版把 #标签连字一起删了，电视上只剩「《 国语 高清》」（用户 2026-10-01 拍照报的）。 */
    function title(m) {
        return captionTitle(m) || nameTitle((m.media && m.media.fileName) || tx("视频"));
    }
    /* 文件名当片名：「The.Last.Emperor.1987.1080p.BluRay.x264-WiKi.mkv」→「The Last Emperor 1987」。开头的 [字幕组] 去掉，
     * 年份留着、年份后面（分辨率、片源、编码、发布组）截掉；没有年份就截在第一个分辨率 / 片源词上。集数（S01E02、第3集）不截。 */
    function nameTitle(fn) {
        var base = fn.replace(/\.[a-z0-9]{2,4}$/i, ""), s = base.replace(/\[[^\]]*\]/g, " ").trim();
        /* 整个名字都在方括号里（「[字幕组][进击的巨人][第01集]」）：第一组多半是字幕组，用后面的 */
        if (!s) { var gs = (base.match(/\[([^\]]*)\]/g) || []).map(function (g) { return g.slice(1, -1); }); s = (gs.length > 1 ? gs.slice(1) : gs).join(" "); }
        if (/[\u4e00-\u9fff]/.test(s) && !/\.\w+\./.test(s)) { return s.trim() || fn; }
        var t = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
        var cut = /\b(2160p|1080[pi]|720p|480p|4k|uhd|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|remux|x26[45]|h ?26[45]|hevc|avc|hdr|dts|aac|ac3)\b/i.exec(t);
        if (cut) { t = t.slice(0, cut.index); }
        var yr = /^(.+?\b(19|20)\d\d)\b/.exec(t);
        if (yr && !/\bS\d{1,2}E\d{1,3}\b/i.test(t.slice(yr[1].length))) { t = yr[1]; }
        t = t.replace(/[\s\-–([]+$/, "").trim();
        return t.length > 1 ? t : fn;
    }
    function captionTitle(m) {
        var lines = (m.text || "").split("\n").map(function (s) {
            return s.replace(/https?:\/\/\S+/g, "").replace(/@\w+/g, "").trim();
        }).filter(function (s) { return s.replace(/[#\s]/g, "").length > 1; });
        if (lines.length) {
            var line = lines[0], t;
            var book = /《([^》]+)》/.exec(line);
            if (book) { t = book[1].replace(/#/g, ""); }
            else {
                var noTags = line.replace(/#\S+/g, "").trim();
                t = noTags.replace(/[\s|｜·,，]/g, "").length > 1 ? noTags : line.replace(/#/g, "");
            }
            t = t.replace(/\s+/g, " ").trim();
            if (t.length > 1) { return t.slice(0, 60); }
        }
        return "";
    }

    /* 说明文字里的片子信息（这类频道的惯例格式：「豆瓣评分\n8.7」「上映日期: 2001-12-18」「导演: 雷德利·斯科特」） */
    function captionInfo(t) {
        var year = /上映日期[:：]\s*(\d{4})/.exec(t) || /[（(](19\d\d|20\d\d)[)）]/.exec(t) || /(19\d\d|20\d\d)年/.exec(t);
        var rating = /豆瓣评分[:：]?\s*\n?\s*(\d(?:\.\d)?)/.exec(t);
        var director = /导演[:：]\s*([^\n/]+)/.exec(t);
        return { year: year ? year[1] : "", rating: rating ? rating[1] : "", director: director ? director[1].trim() : "" };
    }

    function describe(m) {
        var d = m.media;
        if (d.type === "audio") { return describeMusic(m); }
        return {
            key: m.chat.id + ":" + m.id,           // 续播、本地记录用
            fileKey: d.uniqueFileId,                // 同一个文件转发到不同地方也一样
            msg: m,
            doc: d,
            asFile: d.type === "document",          // 当文件发的（没有时长、宽高，播放时才知道）
            chatTitle: (m.chat && (m.chat.title || m.chat.displayName)) || "",
            title: title(m),
            fileName: d.fileName || "",
            caption: m.text || "",
            size: d.fileSize || 0,
            duration: d.duration || 0,
            width: d.width || 0,
            height: d.height || 0,
            mime: d.mimeType || "",
            date: m.date,
            hasCover: !!d.videoCover,
            alts: altsOf(m),
            info: captionInfo(m.text || "")
        };
    }

    /* Telegram 给视频另外转好的清晰度（messageMediaDocument.alt_documents）。现在只记进「播放」那行：高过 1088 的 H.264 在 Tizen 5.5 / 6.0
     * 上解不了，要是这些片子有矮一档的，那些电视就能改放它 —— 先看别人电视上的片子有没有（2026-10-27）。 */
    function altsOf(m) {
        var a = m.raw && m.raw.media && m.raw.media.altDocuments;
        if (!a || !a.length) { return []; }
        return a.map(function (d) {
            var v = (d.attributes || []).filter(function (x) { return x._ === "documentAttributeVideo"; })[0] || {};
            return { w: v.w || 0, h: v.h || 0, codec: v.videoCodec || "", size: Number(d.size) || 0 };
        });
    }

    /* 一首歌：歌名、歌手从音频属性里来（频道的说明文字多半是推广），没有就用文件名。封面是 Telegram 给的专辑图（缩略图） */
    function describeMusic(m) {
        var d = m.media, fn = d.fileName || "", ext = (/\.([a-z0-9]{2,4})$/i.exec(fn) || [])[1] || (/audio\/(?:x-)?([a-z0-9]+)/i.exec(d.mimeType || "") || [])[1] || "";
        return {
            kind: "music",
            key: m.chat.id + ":" + m.id,
            fileKey: d.uniqueFileId,
            msg: m,
            doc: d,
            asFile: false,
            chatTitle: (m.chat && (m.chat.title || m.chat.displayName)) || "",
            title: (d.title || "").trim() || fn.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/_/g, " ").trim() || tx("音乐"),
            performer: (d.performer || "").trim(),
            fileName: fn,
            ext: ext.toLowerCase().replace(/^mpeg$/, "mp3"),
            caption: m.text || "",
            size: d.fileSize || 0,
            duration: d.duration || 0,
            width: 0, height: 0,
            mime: d.mimeType || "",
            date: m.date,
            hasCover: false,
            info: { year: "", rating: "", director: "" }
        };
    }

    /* 播放记录里的那些（Store.history）找回来：按会话分组，一个会话一次 getMessages。消息删了、频道退了的跳过（返回里数着）。
     * 网页链接不用取消息，存的地址、标题就够。顺序照记录的（最近放的在前） */
    async function byRefs(refs) {
        var byChat = {}, got = {}, missing = 0;
        refs.forEach(function (h) { if (h.chat && h.msg) { (byChat[h.chat] = byChat[h.chat] || []).push(h.msg); } });
        await Promise.all(Object.keys(byChat).map(async function (chat) {
            try {
                var ms = await again(function () { return client.getMessages(isNaN(+chat) ? chat : +chat, byChat[chat]); });
                ms.forEach(function (m) { if (m && m.media) { got[chat + ":" + m.id] = m; } });
            } catch (e) { /* 频道退了、没权限：这个会话里的都算找不到 */ }
        }));
        var items = [];
        refs.forEach(function (h) {
            if (h.kind === "web") {
                var site = h.site || (function () { try { return new URL(h.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })();
                items.push({ kind: "web", key: "web:" + h.url, fileKey: h.k, url: h.url, site: site, doc: null, image: h.image || "", title: h.title || h.url,
                             caption: "", size: 0, duration: 0, date: new Date(h.at), playedAt: h.at, hasCover: false, info: { year: "", rating: "", director: "" } });
                return;
            }
            var m = got[h.chat + ":" + h.msg];
            if (!m || !(isVideoMsg(m) || isVideoDoc(m) || isMusic(m))) { missing++; return; }
            var it = describe(m);
            it.playedAt = h.at;
            items.push(it);
        });
        return { items: items, missing: missing };
    }

    /* 封面：挑宽度接近 want 的那张缩略图，下下来做成 blob: 地址 */
    async function thumb(item, want) {
        var ts = item.doc.thumbnails || [];
        var best = null;
        ts.forEach(function (t) {
            if (!t.width || t.isVideo || t.type === "i" || t.type === "j") { return; }    // i = 内嵌的超小模糊图，j = 轮廓
            if (!best || Math.abs(t.width - want) < Math.abs(best.width - want)) { best = t; }
        });
        if (!best) { return null; }
        var buf = await again(function () { return client.downloadAsBuffer(best); });
        return { url: URL.createObjectURL(new Blob([buf], { type: "image/jpeg" })), bytes: buf };
    }

    /* 频道给视频单独设的封面（Telegram 的 video cover，手机上看到的那张海报 / 标题画）。视频文件自带的缩略图多半是开头那一帧、
     * 是黑的；第一版只读了那个，于是全去截帧了（用户 2026-10-01 拿手机截图对比指出）。挑宽度 ≥ want 里最小的那个尺寸。 */
    async function cover(item, want) {
        var p = item.doc.videoCover;
        if (!p) { return null; }
        var ts = (p.thumbnails || []).filter(function (t) { return t.width && !t.isVideo && t.type !== "i" && t.type !== "j"; })
            .sort(function (a, b) { return a.width - b.width; });
        var best = ts.filter(function (t) { return t.width >= want; })[0] || ts[ts.length - 1];
        if (!best) { return null; }
        var buf = await again(function () { return client.downloadAsBuffer(best); });
        return { url: URL.createObjectURL(new Blob([buf], { type: "image/jpeg" })), bytes: buf, w: best.width, h: best.height };
    }

    /* 播放器的数据源。Telegram 一次最多 512KB，请求不能跨 1MB 边界 → 起点按 512KB 对齐。
     * mtcute 的下载线程不管背压，throttle 在每块请求之前被 await（见 CLAUDE.md）。 */
    function source(item) {
        var CH = Player.CH, size = item.size;
        /* 文件引用（file reference）过几个小时就失效：列表开着放久了再点播放，下载报 FILE_REFERENCE_EXPIRED。
         * 重新取一次这条消息拿新的引用，再抛出去 —— 播放器的重试会用新引用重新请求。 */
        async function* guard(it) {
            try { for await (var c of it) { yield c; } }
            catch (e) {
                /* 连接作废：先重连，再抛出去让播放器重试（重试时用的是新的 client） */
                if (remake && gone(e) && !leaving) { await reconnect(); throw e; }      // 页面正在卸载（换账号、重新加载）就不重连了
                if (/FILE_REFERENCE|File ref/i.test(String(e && (e.message || e.text)))) {
                    var ms = await again(function () { return client.getMessages(item.msg.chat.id, [item.msg.id]); });
                    if (ms && ms[0] && ms[0].media) { item.msg = ms[0]; item.doc = ms[0].media; }
                }
                throw e;
            }
        }
        return {
            size: size,
            stream: function (offset, signal, throttle) {
                var start = Math.floor(offset / CH) * CH;
                return {
                    start: start,
                    iter: guard(client.downloadAsIterable(item.doc, { offset: start, fileSize: size, partSize: 512, abortSignal: signal, throttle: throttle }))
                };
            }
        };
    }

    return {
        init: init, me: me, login: login, logout: logout, sources: sources, videos: videos, links: links, videoCount: videoCount, thumb: thumb, cover: cover, source: source,
        search: search, subtitlesFor: subtitlesFor, download: download, byRefs: byRefs,
        describe: describe,
        mode: function () { return mode; },
        primaryDc: function () { return client.getPrimaryDcId(); },
        leaving: function () { return leaving; },
        /* 给自测（js/selftest.js --loginexpiry）扣消息用 */
        client: function () { return client; }
    };
})();
