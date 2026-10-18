/* 电视本地存的东西：
 * - 看到哪里（localStorage，抖音那边实测活得过重装）：fileKey → {t, d, at, title}
 * - 上次看的来源
 * - moov 缓存（IndexedDB，按最近用过留 12 个）：长片的 moov 有几 MB，下一次要 2.5–4 秒，续播时省掉 */
var Store = (function () {
    "use strict";

    var PKEY = "tg.progress.v1", SKEY = "tg.lastSource.v1";

    function read(k, dflt) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
    function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    var progress = read(PKEY, {});

    /* 看到 t 秒（共 d 秒）。过了 97%、或者离结尾不到 min(60 秒, 5%) 算看完，下次从头放。只留最近 300 条。
     * （第一版是「离结尾不到 60 秒」，一分钟的短片一点开就算看完了 —— 桌面界面模拟抓到的） */
    function setProgress(key, t, d, title) {
        if (!key || !d) { return; }
        var done = t > d * 0.97 || d - t < Math.min(60, d * 0.05);
        progress[key] = { t: done ? 0 : Math.floor(t), d: Math.floor(d), at: Date.now(), title: title || "", done: done };
        var keys = Object.keys(progress);
        if (keys.length > 300) {
            keys.sort(function (a, b) { return progress[a].at - progress[b].at; });
            keys.slice(0, keys.length - 300).forEach(function (k) { delete progress[k]; });
        }
        write(PKEY, progress);
    }
    function getProgress(key) { return progress[key] || null; }

    /* 每个来源有几个视频（探测结果，主页左边只列有视频的）：id → {n, at} */
    var CKEY = "tg.srcCount.v1", counts = read(CKEY, {});
    function srcCount(id) { return counts[id] || null; }
    function setSrcCount(id, n) { counts[id] = { n: n, at: Date.now() }; write(CKEY, counts); }

    /* 维基百科上没找到海报的片子：一周内不再找 */
    var NKEY = "tg.noPoster.v2", noP = read(NKEY, {});
    function noPoster(key) { return noP[key] && Date.now() - noP[key] < 7 * 86400000; }
    function markNoPoster(key) { noP[key] = Date.now(); write(NKEY, noP); }

    /* 从片子里解不出帧的（4K HEVC 10bit 在这台电视的 WebCodecs 上解不了）：一周内不再试 */
    var FKEY = "tg.noFrame.v1", noF = read(FKEY, {});
    function noFrame(key) { return noF[key] && Date.now() - noF[key] < 7 * 86400000; }
    function markNoFrame(key) { noF[key] = Date.now(); write(FKEY, noF); }

    /* 每部片子自己的选择：音轨、字幕、字幕时间偏移（秒）。fileKey → {audio, sub, off, at}，留最近 300 部 */
    var PRKEY = "tg.prefs.v1", prefs = read(PRKEY, {});
    function getPrefs(key) { return prefs[key] || {}; }
    function setPrefs(key, patch) {
        if (!key) { return; }
        var p = prefs[key] || {};
        Object.keys(patch).forEach(function (k) { p[k] = patch[k]; });
        p.at = Date.now();
        prefs[key] = p;
        var keys = Object.keys(prefs);
        if (keys.length > 300) {
            keys.sort(function (a, b) { return prefs[a].at - prefs[b].at; });
            keys.slice(0, keys.length - 300).forEach(function (k) { delete prefs[k]; });
        }
        write(PRKEY, prefs);
    }

    /* 当文件发的片子没有时长（Telegram 不知道），放过一次才知道：fileKey → 秒，留 500 个 */
    var DKEY = "tg.dur.v1", durs = read(DKEY, {});
    function dur(key) { return (durs[key] && durs[key].d) || 0; }
    function setDur(key, d) {
        if (!key || !d || dur(key) === Math.round(d)) { return; }
        durs[key] = { d: Math.round(d), at: Date.now() };
        var keys = Object.keys(durs);
        if (keys.length > 500) {
            keys.sort(function (a, b) { return durs[a].at - durs[b].at; });
            keys.slice(0, keys.length - 500).forEach(function (k) { delete durs[k]; });
        }
        write(DKEY, durs);
    }

    /* 搜过的词（遥控器上打字慢，最便宜的搜索是已经打过的那个 —— bilibili 项目的经验），最近的在前，留 12 个 */
    var QKEY = "tg.searches.v1";
    function searches() { return read(QKEY, []); }
    function addSearch(q) {
        var list = searches().filter(function (x) { return x !== q; });
        list.unshift(q);
        write(QKEY, list.slice(0, 12));
    }

    function lastSource() { return read(SKEY, null); }
    function setLastSource(src) { write(SKEY, { id: src.id, title: src.title, kind: src.kind, url: src.url }); }

    /* 网页列表当来源（web.js）：群里发的列表链接。按发在哪个群分组存 —— 每次打开那个群就用这次找到的替换掉，
     * 群里删了那条消息，来源栏里也就没了。group id → [{id, title, kind: "web", url}] */
    var WKEY = "tg.webSources.v1", webSrc = read(WKEY, {});
    function webSources() {
        var out = [], seen = {};
        Object.keys(webSrc).forEach(function (g) { webSrc[g].forEach(function (s) { if (!seen[s.id]) { seen[s.id] = true; out.push(s); } }); });
        return out;
    }
    function setWebSources(group, list) { webSrc[group] = list; write(WKEY, webSrc); }
    function webSourceGroups() { return Object.keys(webSrc); }

    /* ---------- moov 缓存、封面缓存（IndexedDB） ---------- */

    var dbp = null;
    function db() {
        if (!dbp) {
            dbp = new Promise(function (resolve, reject) {
                var r = indexedDB.open("tg-moov", 2);
                r.onupgradeneeded = function () {
                    var d = r.result;
                    if (!d.objectStoreNames.contains("moov")) { d.createObjectStore("moov"); }
                    if (!d.objectStoreNames.contains("cover")) { d.createObjectStore("cover"); }
                };
                r.onsuccess = function () { resolve(r.result); };
                r.onerror = function () { reject(r.error); };
            });
        }
        return dbp;
    }
    function tx(store, mode, fn) {
        return db().then(function (d) {
            return new Promise(function (resolve, reject) {
                var t = d.transaction(store, mode), out = fn(t.objectStore(store));
                /* fn 返回 IDBRequest 就取它的 result（没有这个 key 时是 undefined —— 不能拿请求对象本身当结果） */
                t.oncomplete = function () { resolve(out instanceof IDBRequest ? out.result : out); };
                t.onerror = function () { reject(t.error); };
            });
        });
    }
    function get(store, key) {
        return tx(store, "readonly", function (st) { return st.get(key); }).then(function (v) {
            if (v) { tx(store, "readwrite", function (st) { v.at = Date.now(); st.put(v, key); }).catch(function () {}); }
            return v || null;
        }).catch(function () { return null; });
    }
    /* 存一条，只留最近用过的 keep 条 */
    function put(store, key, v, keep) {
        v.at = Date.now();
        return tx(store, "readwrite", function (st) { st.put(v, key); }).then(function () {
            return tx(store, "readonly", function (st) { return st.getAll(); }).then(function (all) {
                return tx(store, "readonly", function (st) { return st.getAllKeys(); }).then(function (keys) {
                    if (keys.length <= keep) { return; }
                    var order = keys.map(function (k, i) { return { k: k, at: all[i].at }; }).sort(function (a, b) { return a.at - b.at; });
                    return tx(store, "readwrite", function (st) { order.slice(0, keys.length - keep).forEach(function (o) { st.delete(o.k); }); });
                });
            });
        }).catch(function () {});
    }

    function getMoov(key) { return get("moov", key); }
    /* MP4：{start, bytes}（moov 原样）；MKV：{mkv: info}（mkv.js 解析好的头 + Cues，结构化克隆存进去） */
    function putMoov(key, m) { return put("moov", key, m.mkv ? { mkv: m.mkv } : { start: m.start, bytes: m.bytes }, 12); }
    /* 封面：电影海报（维基百科）或者从片子中间解出来的一帧。{bytes, kind: "poster" | "frame", mime, meta} */
    function getCover(key) { return get("cover", key); }
    function putCover(key, bytes, extra) {
        var v = { bytes: bytes };
        if (extra) { v.kind = extra.kind; v.mime = extra.mime; v.meta = extra.meta; }
        return put("cover", key, v, 800);    // 缩略图 20–40KB，800 张 ~30MB
    }

    return { setProgress: setProgress, getProgress: getProgress, srcCount: srcCount, setSrcCount: setSrcCount, noPoster: noPoster, markNoPoster: markNoPoster, noFrame: noFrame, markNoFrame: markNoFrame, lastSource: lastSource, setLastSource: setLastSource, getPrefs: getPrefs, setPrefs: setPrefs, dur: dur, setDur: setDur, searches: searches, addSearch: addSearch, webSources: webSources, setWebSources: setWebSources, webSourceGroups: webSourceGroups, getMoov: getMoov, putMoov: putMoov, getCover: getCover, putCover: putCover };
})();
