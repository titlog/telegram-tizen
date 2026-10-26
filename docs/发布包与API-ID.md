# 发布包和 API ID / Hash（apikey.js、release.sh）

> 这是 [CLAUDE.md](../CLAUDE.md) 指过来的专题。上面「结论」是现在成立的；下面是前因后果和测量记录，按当时的样子留着，日期是那天的。

## 结论

- 发布包带这个项目自己的那组 API ID / Hash（Telegram 的规定允许），打乱后写进去（不是加密，挡 grep）；电视上填过的优先。
- **ID / Hash 不进仓库、日志、issue、发布说明。**
- Telegram 只在扫码登录的第一个请求才拒（`API_ID_INVALID`），boot 只在 `login()` 出错时认它。

### 发布包和 API ID（2026-10-21，issue #1：「为什么不发 .wgt」）

以前只能从源码装，因为包里要有 API ID / Hash。查 Telegram 的规定（core.telegram.org/api/obtaining_api_id、/api/terms）：**发布出去的应用
用发布者自己申请的那组**，用户不用各自申请；一个手机号只能有一个 API ID；违规时先通知负责的账号，10 天不改才停掉。Hash 藏不住 ——
Telegram 官方 Android 客户端的源码里就写着它自己的（`APP_ID = 4`），闭源客户端也得把它放在包里。用户（10-21）定的：**像 Nicegram 那样
内置这个项目的那组，填写页兜底**，并且「别泄露明文」。
- **包里怎么带**：deploy.sh 给自己电视打的包是明文（`TG_API_ID` / `TG_API_HASH`）；release.sh 打的发布包只写 `TG_API_PACKED`
  （8 字节随机盐 + 逐字节异或，base64），`apikey.js` 的 `unpack()` 解。**不是加密**，挡的是解压之后 grep、扫 32 位十六进制串。
  release.sh 读回：包里每个文件都没有明文 hash，config.js 里没有 ID 的数字，用 apikey.js 本身解开就是 `~/.telegram-tizen.conf` 那一组。
  **ID / Hash 不进仓库、不进日志、不进 issue 和发布说明**（`test/apikey.mjs` 查日志里没有 hash）。
- **顺序**：电视上填过的 → 包里明文的 → 包里打乱过的。填过的只在包里那组被拒之后才有，所以填过的优先。
- **被拒在哪一步**（桌面上用真的 mtcute、真的 Telegram、一组编出来的凭证量的，主线程和后台线程一样）：`connect()` 成功，`getMe` 回
  `AUTH_KEY_UNREGISTERED`（还没登录，正常），**扫码登录的第一个请求才回 `400 API_ID_INVALID`**。所以 boot 里只在 `login()` 出错时认它
  （`ApiKey.rejected`）：电视上填的 → 带着刚填的回填写页；包里带的 → 空的填写页，「不再接受这个安装包带的 API ID」。被**停用**的
  API ID 回什么没量过（手里没有这样一组），按同一个错认；已经登录着的会话在那种情况下还能不能用，也不知道。
- **填写页**（`#api`，照网页登录那一页做）：两栏 App api_id / App api_hash，右边一个去 my.telegram.org/apps 的码；输入框里方向键归屏幕
  键盘，「完成」（65376）/ 确认去下一栏或交；返回先收键盘，再按两次退出。格式不对当场说哪里不对（不是数字、几位、有 a–f 以外的字），
  hash 去空白、转小写。
- 测过的：`test/apikey.mjs` 全过（中英各一遍）；真的 Telegram（scratchpad 里的一次性脚本，不进仓库）：编出来的那组扫码时被拒、回填写页，
  项目那组、打乱过的那组都出了登录二维码；`ui-emu.mjs` 全过。电视上（10-21）：`--noapi` 装上，日志「包里没带 API ID / Hash，也没填过，
  等用户在电视上填」；装回正常构建，「API ID 是安装包里带的」、账号对上、2.6 秒到主页。**在电视上用遥控器和屏幕键盘真的填一遍还没做过**
  （搜索框、网页登录用的是同一套输入法，都在电视上用过）。
- 1.0.0 没有自动更新，1.1.0 起有（见下一节）；从 1.0.0 升上来要再装一次 `.wgt`。同一张三星证书签的包覆盖安装，会话和本地记录都留着。
