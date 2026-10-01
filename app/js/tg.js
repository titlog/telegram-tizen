/* Telegram 这一层：客户端、扫码登录、来源（收藏夹 + 群 / 频道）、来源里的视频、封面、给播放器的数据源。
 * 底下是 mtcute（build/ 打成 js/tg.bundle.js，全局 TGLib）。 */
var TG = (function () {
    "use strict";

    var client = null, mode = "";
    var VIDEO = { _: "inputMessagesFilterVideo" };

    function timeout(p, ms, what) {
        return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(what + " " + ms / 1000 + " 秒没回")); }, ms); })]);
    }

    /* mtcute 默认在后台线程（见 build/src/worker.js）；15 秒连不上就退回主线程直连 */
    async function init() {
        var r = await TGLib.create(TG_API_ID, TG_API_HASH);
        client = r.client;
        mode = r.mode;
        try {
            await timeout(client.connect(), 15000, "连接");
        } catch (e) {
            if (mode !== "worker") { throw e; }
            mode = "direct（后台线程：" + e.message + "）";
            client = (await TGLib.create(TG_API_ID, TG_API_HASH, "direct")).client;
            await client.connect();
        }
        return client;
    }

    async function me() {
        try { return await client.getMe(); } catch (e) { return null; }
    }

    /* onUrl(url, expires) 每换一张码调一次；askPassword() → Promise<string>（两步验证） */
    function login(onUrl, onScanned, askPassword, onBadPassword) {
        return client.signInQr({ onUrlUpdated: onUrl, onQrScanned: onScanned, password: askPassword, invalidPasswordCallback: onBadPassword });
    }

    async function logout() { try { await client.logOut(); } catch (e) {} }

    /* 来源：收藏夹排第一，后面是最近的群 / 频道 / 私聊（不管里面有没有视频 —— 一个个去搜太慢；点进去是空的就写「没有视频」） */
    async function sources(limit) {
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

    /* 这个来源里有几个视频（只问数量，limit 1） */
    async function videoCount(sourceId) {
        var res = await client.searchMessages({ chatId: sourceId, filter: VIDEO, limit: 1 });
        return res.total || res.length;
    }

    /* 一个来源里的视频，新的在前。page.next 传回来取下一页。 */
    async function videos(sourceId, next, limit) {
        var res = await client.searchMessages({ chatId: sourceId, filter: VIDEO, limit: limit || 40, offset: next });
        var items = [];
        res.forEach(function (m) {
            var d = m.media;
            if (!d || d.type !== "video" || d.isRound || d.isAnimation) { return; }
            items.push(describe(m));
        });
        return { items: items, next: res.next, total: res.total };
    }

    /* 标题：说明文字的第一行（去掉链接、@ 提及、标签的 #），没有就用文件名 */
    /* 标题：说明文字第一行。有《》就取书名号里面的（这类频道的惯例：「《#黑鹰坠落 国语 高清》 #2001年美国高分怀旧电影 #动作电影」）；
     * 没有就去掉 #标签（只剩标签时保留标签的字）。链接、@提及都去掉。没有说明文字用文件名。
     * 第一版把 #标签连字一起删了，电视上只剩「《 国语 高清》」（用户 2026-10-01 拍照报的）。 */
    function title(m) {
        var d = m.media;
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
        return (d.fileName || "视频").replace(/\.[a-z0-9]{2,4}$/i, "");
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
        return {
            key: m.chat.id + ":" + m.id,           // 续播、本地记录用
            fileKey: d.uniqueFileId,                // 同一个文件转发到不同地方也一样
            msg: m,
            doc: d,
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
            info: captionInfo(m.text || "")
        };
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
        var buf = await client.downloadAsBuffer(best);
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
        var buf = await client.downloadAsBuffer(best);
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
                if (/FILE_REFERENCE|File ref/i.test(String(e && (e.message || e.text)))) {
                    var ms = await client.getMessages(item.msg.chat.id, [item.msg.id]);
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
        init: init, me: me, login: login, logout: logout, sources: sources, videos: videos, videoCount: videoCount, thumb: thumb, cover: cover, source: source,
        searchGlobal: function (q) { return client.searchGlobal({ query: q, limit: 50, filter: VIDEO }); },
        describe: describe,
        mode: function () { return mode; },
        primaryDc: function () { return client.getPrimaryDcId(); }
    };
})();
