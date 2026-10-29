/* 一台电视、好几个 Telegram 账号（2026-10-18，照 bilibili 客户端的样子）。
 *
 * 每个账号的会话是 mtcute 存在 IndexedDB 里的一个库（库名 = storage：第一个账号是原来的 tg-session，后加的 tg-session-2、-3…），
 * 各自一份授权密钥。不像 bilibili 那样有个全局的 cookie 坑位会串号 —— 哪个库起的客户端，请求就只带哪个账号的密钥。
 * 同一时间只开一个账号：切换 = 记下新的当前账号、重新加载页面，用它的库起后台线程（~2.5 秒）。
 *
 * 每人一份的（Accounts.scope）：看到哪里、上次的来源、来源栏、搜过的词、每部片子的音轨字幕选择、网页登录查到的账号编号。
 * 第一个账号（a1）沿用升级前的那些键名，升级之后什么都不用搬；后加的账号键名后面带 @a2 之类。
 * 整台电视共用的：封面、moov / MKV 头缓存、片子时长、界面语言 —— 那是片子和电视的属性。
 *
 *   Accounts.active() → {id, storage, userId, name}    Accounts.list()
 *   Accounts.scope(key[, id])          这个人的 localStorage 键
 *   Accounts.describe(id, user)        登录后 / 每次启动用 getMe 的结果写名字；已有的 userId 对不上就不采信（bilibili 的教训）
 *   Accounts.add() / switchTo(id) / remove(id)   改完要重新加载页面
 *   Accounts.cleanup() → Promise       启动时删掉退出的账号留下的库（退出那一刻后台线程还开着它，删不掉）
 */
var Accounts = (function () {
    "use strict";

    var KEY = "tg.accounts.v1";
    /* 每人一份的键（退出账号时一起删） */
    var PERSONAL = ["tg.progress.v1", "tg.lastSource.v1", "tg.srcCount.v1", "tg.webSources.v1", "tg.prefs.v1", "tg.searches.v1", "tg.webAccount.v1"];

    function read() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
    function write() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }

    /* 第一次跑多账号版本：原来那个会话就是第一个账号 */
    var st = read();
    if (!st || !st.list) { st = { list: [{ id: "a1", storage: "tg-session", userId: 0, name: "" }], active: "a1", next: 2, prev: "", drop: [] }; write(); }
    if (!st.list.length) { add(); }
    if (!byId(st.active)) { st.active = st.list[0].id; write(); }

    function byId(id) { return st.list.filter(function (a) { return a.id === id; })[0] || null; }
    function active() { return byId(st.active); }
    function scope(key, id) { id = id || st.active; return id === "a1" ? key : key + "@" + id; }

    /* 新账号：一个空的库，登录要扫码。prev 记着从哪个账号过来的 —— 扫码时按返回就切回去 */
    function add() {
        var n = st.next++, a = { id: "a" + n, storage: "tg-session-" + n, userId: 0, name: "" };
        st.list.push(a);
        st.prev = st.active || "";
        st.active = a.id;
        write();
        return a;
    }
    function switchTo(id) { if (byId(id)) { st.prev = ""; st.active = id; write(); } }

    /* 退出一个账号：从名单里拿掉、这个人的本地记录删掉、库排进待删（下次启动删）。还剩别的账号就切到别的，没有就加一个空的（回到扫码） */
    function remove(id) {
        var a = byId(id);
        if (!a) { return; }
        st.list = st.list.filter(function (x) { return x.id !== id; });
        st.drop.push(a.storage);
        PERSONAL.forEach(function (k) { try { localStorage.removeItem(scope(k, id)); } catch (e) {} });
        if (st.active === id) { st.active = st.prev && byId(st.prev) ? st.prev : st.list.length ? st.list[0].id : ""; }
        st.prev = "";
        if (!st.list.length) { add(); st.prev = ""; }
        write();
    }

    /* getMe 的结果。这一行已经有 userId 而 Telegram 答的是另一个人：说明这个库里的会话不是这一行的人（不该发生），名字不采信、记日志 */
    function describe(id, user) {
        var a = byId(id);
        if (!a || !user) { return "没有"; }
        /* 两个编号都不进这句：它原样接进日志那行，而那行自己已经把两个编号包着打过了 */
        if (a.userId && a.userId !== user.id) { return "对不上：这一行记的人和 Telegram 答的不是同一个"; }
        a.userId = user.id;
        a.name = user.displayName || user.firstName || user.username || String(user.id);
        write();
        return "对上了";
    }
    /* 同一个人登录了两次（添加账号时扫的是已经在的账号）：返回已有的那一行 */
    function duplicateOf(id) {
        var a = byId(id);
        return a && a.userId ? st.list.filter(function (x) { return x.id !== id && x.userId === a.userId; })[0] || null : null;
    }

    function cleanup() {
        var names = st.drop.slice();
        if (!names.length || !window.indexedDB) { return Promise.resolve([]); }
        return Promise.all(names.map(function (n) {
            return new Promise(function (resolve) {
                var r = indexedDB.deleteDatabase(n), done = false;
                var fin = function (ok) { if (done) { return; } done = true; if (ok) { st.drop = st.drop.filter(function (x) { return x !== n; }); write(); } resolve(n + (ok ? " 删了" : " 没删掉")); };
                r.onsuccess = function () { fin(true); };
                r.onerror = function () { fin(false); };
                r.onblocked = function () { fin(false); };
                setTimeout(function () { fin(false); }, 3000);
            });
        }));
    }

    return {
        active: active, list: function () { return st.list.slice(); }, prev: function () { return st.prev ? byId(st.prev) : null; },
        scope: scope, add: add, switchTo: switchTo, remove: remove, describe: describe, duplicateOf: duplicateOf, cleanup: cleanup
    };
})();
