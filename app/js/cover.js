/* 没有可用封面的片子（缩略图是开头那一帧 —— 黑的，2026-10-01 电视上《黑鹰坠落》《末代皇帝》平均亮度都是 0）：
 * 从片子中间取一个关键帧，用 WebCodecs 解成图片当封面。
 *
 * 为什么不用 <video> 截图：这台电视的视频走硬件视频层，画到画布上全是黑的（抖音项目实测）。
 * WebCodecs 单独解一帧，只要下这一帧的字节（几百 KB）加上 moov（顺手存进缓存，之后点开播放更快）。
 *
 *   Cover.grab(item) → Promise<{url, info}>   失败会抛出带原因的错误
 *   Cover.busy()     → 正在解的话返回它的 Promise —— 开始播放前等它，别和播放抢解码器 */
var Cover = (function () {
    "use strict";

    var CH = 512 * 1024, current = null, cancelled = false;
    function check() { if (cancelled) { var e = new Error("取消了（要开始播放）"); e.cancelled = true; throw e; } }

    /* 读 [off, off+size)。Telegram 按 512KB 对齐取块；mtcute 会一口气并发好几块，用 throttle 卡住只发需要的那几个请求 */
    async function readRange(src, off, size) {
        var ac = new AbortController(), n = 0, need = 0;
        var st = src.stream(off, ac.signal, function () { return n++ < need ? Promise.resolve() : new Promise(function () {}); });
        need = Math.ceil((off + size - st.start) / CH);
        var out = new Uint8Array(size), pos = st.start;
        try {
            for await (var c of st.iter) {
                var s = Math.max(off, pos), e = Math.min(off + size, pos + c.length);
                if (e > s) { out.set(c.subarray(s - pos, e - pos), s - off); }
                pos += c.length;
                if (pos >= off + size || cancelled) { break; }
            }
        } finally { ac.abort(); }
        check();
        if (pos < off + size) { throw new Error("没读够（" + pos + "/" + (off + size) + "）"); }
        return out;
    }

    /* moov：缓存里有就用；没有就从文件头找，在文件尾就跳过 mdat 去找。找到的存进缓存（播放也用得上） */
    async function moovOf(item, src) {
        var cached = await Store.getMoov(item.fileKey);
        if (cached) { return cached; }
        var head = await readRange(src, 0, Math.min(src.size, 64 * 1024));
        /* MKV：头和 Cues 交给 mkv.js（存进同一个缓存，播放也用得上） */
        if (typeof Mkv !== "undefined" && Mkv.sniff(head)) {
            var info = await Mkv.readHead(function (off, len) { return readRange(src, off, Math.min(len, src.size - off)); }, src.size);
            Store.putMoov(item.fileKey, { mkv: info });
            return { mkv: info };
        }
        var top = Mp4.scanTop(head, 0), m = null, pos = 0;
        for (var i = 0; i < top.length; i++) {
            if (top[i].type === "moov") { m = top[i]; break; }
            pos = top[i].start + top[i].size;
            if (top[i].type === "mdat") { break; }
        }
        while (!m && pos + 8 <= src.size) {
            var h = Mp4.scanTop(await readRange(src, pos, Math.min(16, src.size - pos)), pos)[0];
            if (!h || h.size === Infinity) { break; }
            if (h.type === "moov") { m = h; } else { pos = h.start + h.size; }
        }
        if (!m) { throw new Error("找不到 moov"); }
        var bytes = m.start + m.size <= head.length ? head.slice(m.start, m.start + m.size) : await readRange(src, m.start, m.size);
        var mv = { start: m.start, bytes: bytes };
        Store.putMoov(item.fileKey, mv);
        return mv;
    }

    /* 解码方式：默认、强制硬件、强制软件。电视上 4K HEVC 10bit 默认方式报 Decoding error（2026-10-01），
     * 失败就换下一种；哪种成了记住，同一种编码以后直接用它。 */
    var HW = [undefined, "prefer-hardware", "prefer-software"], goodHw = {};
    async function decodeAny(tr, bytes, log) {
        var fam = tr.codec.slice(0, 4), order = goodHw[fam] !== undefined ? [goodHw[fam]] : HW, last = null;
        for (var i = 0; i < order.length; i++) {
            try {
                var f = await decodeFrame(tr, bytes, order[i]);
                if (goodHw[fam] === undefined) { goodHw[fam] = order[i]; if (i) { log.push("解码方式 " + order[i] + " 成了"); } }
                return f;
            } catch (e) { last = e; log.push((order[i] || "默认") + " 失败：" + (e && e.message)); }
        }
        throw last;
    }

    /* 硬件解码器有时既不出帧也不报错（电视上 4K HEVC，2026-10-01）：8 秒没结果就当失败 */
    function decodeFrame(tr, bytes, hw) {
        return new Promise(function (resolve, reject) {
            var done = false, dec = null;
            var timer = setTimeout(function () {
                if (done) { return; }
                done = true;
                try { dec.close(); } catch (e) {}
                reject(new Error("8 秒没解出来"));
            }, 8000);
            dec = new VideoDecoder({
                output: function (f) { if (done) { f.close(); return; } done = true; clearTimeout(timer); resolve(f); },
                error: function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
            });
            var cfg = { codec: tr.codec, codedWidth: tr.width, codedHeight: tr.height };
            if (tr.config) { cfg.description = tr.config; }          // VP9 没有 description
            if (hw) { cfg.hardwareAcceleration = hw; }
            dec.configure(cfg);
            dec.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: bytes }));
            dec.flush().catch(function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }).then(function () {
                try { dec.close(); } catch (e) {}
                if (!done) { done = true; clearTimeout(timer); reject(new Error("解码器没吐出帧")); }
            });
        });
    }

    /* 按「铺满、居中裁」画进 16:9 的画布（宽银幕片两边会裁掉一点） */
    function draw(g, f, W, H) {
        var w = f.displayWidth, h = f.displayHeight, s = Math.max(W / w, H / h);
        var dw = w * s, dh = h * s;
        g.drawImage(f, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    function luminance(g, W, H) {
        var d = g.getImageData(0, 0, W, H).data, sum = 0, n = 0;
        for (var i = 0; i < d.length; i += 64) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
        return sum / n;
    }
    function toJpeg(c) {
        return new Promise(function (resolve) { c.toBlob(function (b) { resolve(b); }, "image/jpeg", 0.82); });
    }

    async function grabInner(item) {
        if (!window.VideoDecoder) { throw new Error("这台电视没有 WebCodecs"); }
        var t0 = performance.now(), src = TG.source(item);
        var mv = await moovOf(item, src), movie, v;
        if (mv.mkv) {
            movie = { duration: mv.mkv.duration };
            v = mv.mkv.tracks.filter(function (t) { return t.kind === "video" && !t.unsupported; })[0];
            if (!v || !mv.mkv.cues) { throw new Error(v ? "MKV 没有 Cues，找不到关键帧" : "没有能解的视频轨"); }
        } else {
            movie = Mp4.parseMoov(mv.bytes);
            v = movie.tracks.filter(function (t) { return t.kind === "video"; })[0];
            if (!v || !v.config) { throw new Error("没有能解的视频轨"); }
        }
        var sup = await VideoDecoder.isConfigSupported({ codec: v.codec, description: v.config || undefined, codedWidth: v.width, codedHeight: v.height });
        if (!sup.supported) { throw new Error("WebCodecs 不支持 " + v.codec); }
        var W = 576, H = 324, c = document.createElement("canvas");
        c.width = W; c.height = H;
        var g = c.getContext("2d"), best = null, bestLum = -1, tries = [];
        var fracs = [0.12, 0.3, 0.5];
        for (var i = 0; i < fracs.length; i++) {
            var tr0 = performance.now(), bytes, at;
            if (mv.mkv) {
                var kf = await Mkv.keyframeAt(function (off, len) { check(); return readRange(src, off, Math.min(len, src.size - off)); }, mv.mkv, movie.duration * fracs[i]);
                bytes = kf.data;
                at = kf.pts;
            } else {
                var k = Mp4.keyAtOrBefore(v, Mp4.sampleAt(v, movie.duration * fracs[i]));
                bytes = await readRange(src, v.offset[k], v.size[k]);
                at = Mp4.pts(v, k);
            }
            var td = performance.now();
            check();
            var f;
            try { f = await decodeAny(v, bytes, tries); }
            catch (e) { tries.push(Math.round(at) + "s 解不了"); continue; }
            g.fillStyle = "#000";
            g.fillRect(0, 0, W, H);
            draw(g, f, W, H);
            f.close();
            var lum = luminance(g, W, H);
            tries.push(Math.round(at) + "s 读 " + Math.round(td - tr0) + "ms 解 " + Math.round(performance.now() - td) + "ms 亮度 " + Math.round(lum));
            if (lum > bestLum) { bestLum = lum; best = await toJpeg(c); }
            if (lum >= 45) { break; }
        }
        if (!best) { throw new Error("一帧都没解出来（" + tries.join("，") + "）"); }
        if (bestLum < 8) { throw new Error("解出来全是黑的（" + tries.join("，") + "）"); }
        var buf = await best.arrayBuffer();
        Store.putCover(item.fileKey, buf, { kind: "frame" });
        return { url: URL.createObjectURL(best), kind: "frame", info: v.codec + " " + v.width + "x" + v.height + "：" + tries.join("，") + "，共 " + Math.round(performance.now() - t0) + "ms" };
    }

    function grab(item) {
        cancelled = false;
        /* 整个过程最多 40 秒：卡住的话别把后面排队的都堵死 */
        var p = Promise.race([grabInner(item), new Promise(function (_, rej) { setTimeout(function () { rej(new Error("40 秒没取完")); }, 40000); })]);
        current = p.catch(function () {});
        return p;
    }

    async function cached(item) {
        var c = await Store.getCover(item.fileKey);
        /* 第一版的海报只看搜索排名，配错过（2026 新片配成了人物、别的片子）：没有 v2 标记的海报当作没有，按新判据重找 */
        if (c && c.kind === "poster" && !(c.meta && c.meta.v === 2)) { c = null; }
        /* 「没有封面」也记着（只显示片名卡片），7 天后再试一次 —— 维基上可能新增了词条 */
        if (c && c.kind === "none") { return c.meta && Date.now() - c.meta.made < 7 * 86400000 ? { kind: "none" } : null; }
        return c ? { url: URL.createObjectURL(new Blob([c.bytes], { type: c.mime || "image/jpeg" })), kind: c.kind || "frame", meta: c.meta || {} } : null;
    }

    /* ---------- 电影海报：维基百科 ---------- */

    /* 片名里的版本、画质字样去掉（「黑鹰坠落 国语 高清」→「黑鹰坠落」） */
    var NOISE = /(国语|粤语|国粤|中字|中英字幕|中英双字|双语|字幕|高清|超清|蓝光|原盘|4K|2160P|1080P|720P|HDR10|HDR|HD|BD|DV|杜比视界|杜比|未删减|完整版|加长版|导演剪辑版|剪辑版|修复版|典藏版|电影|无水印)/gi;

    /* 维基百科：豆瓣对海外请求回空、iTunes 搜不到、TMDB 要 key，维基中文 / 英文的电影词条带海报。
     * 判据（2026-10-01 在 Mac 上对 10 部片调出来的）：搜「片名 年份 电影」取前 3 条，要「有图 + 是电影 + 标题或简介里有片名」
     * （简介转成简体，常写「中国大陆译作《黑鹰坠落》」—— 词条标题是台湾译名「黑鷹計劃」也认得出）；标题里有片名的优先于只在简介里提到的
     * （「让子弹飞」不然会配成演员周韵）。第一版只看搜索排名，2026 年的新片维基上没有，配成了人物、别的片子、电视剧。宁可不配。 */
    var FILM = /电影|電影|影片|动画|[剧喜动作爱情恐怖科幻战争犯罪纪录史诗传记惊悚悬疑灾难歌舞]片|\bfilm\b|\bmovie\b/i;
    function norm(s) { return s.replace(/[\s\p{P}\p{S}_]+/gu, "").toLowerCase(); }

    async function wikiPoster(item) {
        var t = item.title.replace(NOISE, " ").replace(/[\[\]【】()（）《》]/g, " ").replace(/\b(19|20)\d\d\b/g, " ");
        var zh = (t.match(/[\u4e00-\u9fff·：:！!0-9]+/g) || []).join(" ").trim();
        var en = t.replace(/[\u4e00-\u9fff·！]/g, " ").replace(/\s+/g, " ").trim();
        /* 年份：说明文字里的，没有就用片名里的（文件名当片名的「The Last Emperor 1987」） */
        var yr = (item.info && item.info.year) || ((/\b(19[2-9]\d|20[0-4]\d)\b/.exec(item.title) || [])[1]) || "";
        var year = yr ? " " + yr : "";
        var tries = [];
        if (/[\u4e00-\u9fff]{2}/.test(zh)) { tries.push(["zh", zh, zh + year + " 电影"]); }
        if (/[a-z]{3}/i.test(en)) { tries.push(["en", en, en + year + " film"]); }
        for (var i = 0; i < tries.length; i++) {
            var lang = tries[i][0], name = norm(tries[i][1]);
            var url = "https://" + lang + ".wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=3" +
                "&prop=pageimages|extracts&piprop=original&pilicense=any&exintro=1&explaintext=1&exlimit=3&exchars=600&converttitles=1" +
                (lang === "zh" ? "&variant=zh-cn" : "") + "&gsrsearch=" + encodeURIComponent(tries[i][2]);
            var j = await (await fetch(url)).json();
            var pages = Object.keys((j.query || {}).pages || {}).map(function (k) { return j.query.pages[k]; })
                .sort(function (a, b) { return a.index - b.index; })
                .filter(function (p) { return p.original && p.original.source && FILM.test((p.extract || "") + p.title); });
            var pick = pages.filter(function (p) { return norm(p.title).indexOf(name) >= 0; })[0] ||
                       pages.filter(function (p) { return norm(p.extract || "").indexOf(name) >= 0; })[0];
            if (!pick) { continue; }
            var resp = await fetch(pick.original.source);
            if (!resp.ok) { continue; }
            var bytes = await resp.arrayBuffer();
            return { bytes: bytes, mime: resp.headers.get("content-type") || "image/jpeg", wiki: lang + ":" + pick.title, w: pick.original.width, h: pick.original.height };
        }
        return null;
    }

    async function poster(item) {
        var p = await wikiPoster(item);
        if (!p) { return null; }
        Store.putCover(item.fileKey, p.bytes, { kind: "poster", mime: p.mime, meta: { wiki: p.wiki, v: 2 } });
        return { url: URL.createObjectURL(new Blob([p.bytes], { type: p.mime })), kind: "poster", meta: { wiki: p.wiki, v: 2 }, info: p.wiki + " " + p.w + "x" + p.h };
    }

    /* 要开始播放了：正在取的那一个在下一步停下，等它停稳再开播放器（这台电视只有一个硬件解码器） */
    function cancel() { cancelled = true; return current || Promise.resolve(); }

    /* 海报卡片上的片名：去掉版本、画质字样；去掉的那些另外列出来 */
    function cleanName(title) {
        var tags = (title.match(NOISE) || []).filter(function (x, i, arr) { return arr.indexOf(x) === i && x !== "电影"; });
        var name = title.replace(NOISE, " ").replace(/[\[\]【】《》]/g, " ").replace(/\s+/g, " ").trim();
        return { name: name || title, tags: tags };
    }

    /* 封面定下来了就存：Telegram 缩略图存字节；什么都没找到存一个「没有」 */
    function keepThumb(item, bytes, kind) { Store.putCover(item.fileKey, bytes, { kind: kind || "thumb" }); }
    function keepNone(item) { Store.putCover(item.fileKey, null, { kind: "none", meta: { made: Date.now() } }); }

    return { grab: grab, cached: cached, poster: poster, cancel: cancel, cleanName: cleanName, keepThumb: keepThumb, keepNone: keepNone };
})();
