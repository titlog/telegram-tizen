# 三星电视（Tizen）上放 Telegram 里的视频

兄弟项目 `../bilibili-tizen`、`../douyin-tizen` 的平台结论（设备、证书、部署、日志通道、MSE、CSP 的坑）
这里全部适用，**先读那两份 CLAUDE.md**。这份只记 Telegram 自己的事。

**这份只放结论和指针**：每件事的前因后果、测量记录在 `docs/` 下按主题一份（见最后「专题」），有新发现就改那份、这里最多动一两行，
不在这里按日期记流水账（用户 2026-10-26）。

出发点（2026-10-01）：Telegram 的群和频道里有不少视频，手机上能直接放，电视上没有能用的客户端。现在也放群里的网页链接和音乐。

```
app/js/app.js     界面和遥控器：登录（扫码）、主页（左边来源、右边网格）、播放器浮层、长按确认的菜单（音轨 / 字幕）、下一集、搜索、音乐画面
app/js/tg.js      Telegram 这一层：来源（群/频道）、来源里的视频和歌（「视频」「文件」「音乐」几路合并）、搜索、群里的字幕文件、封面、给播放器的数据源
app/js/player.js  播放引擎：MediaSource + 音视频两个 SourceBuffer，按样本在文件里的位置顺序读、拼 ~1 秒一段；MKV 走 mkv.js 拆块
app/js/mp4.js     自己写的渐进式 MP4 → fMP4：样本表 TypedArray、二分找关键帧、拼 moof+mdat（替掉了 mp4box）；也认 tx3g 字幕轨
app/js/mkv.js     自己写的 MKV / WebM：读头和 Cues、按 Cluster 顺序拆块、算解码时间，交给 Mp4.fragmentFrames
app/js/music.js   放歌：整首下下来做成 blob 给 <audio>、队列、预先下下一首、放不起来跳过
app/js/flac.js    FLAC 软件解码（电视解不了 FLAC）：后台线程里边下边解成 16 位 PCM，拼 WAV
app/js/accounts.js  多账号：每个账号一个会话库（tg-session、tg-session-2…），每人一份的本地记录（scope），切换 = 重新加载
app/js/boot.js    这次跑哪份代码：安装包的，还是自动更新下载、验过签名的新版本；信任根（公钥），永远不随更新下发。index.html 只剩
                  config.js、boot.js 两个标签，**新加脚本加进 boot.js 的 SCRIPTS**
app/js/update.js  查新版本、下载、验签名、存进 localStorage；本身随更新下发
app/js/diag.js    诊断日志：每一行去掉身份记进一圈，出事或手动时传给开发者；接收地址在这里（config.js 不随更新下发）
app/js/selftest.js  deploy.sh --diag / --loginexpiry / --samples / --music 才跑的那一段（电视上的自动走查）
app/js/apikey.js  用哪组 API ID / Hash：电视上填过的 → 包里明文的（deploy.sh）→ 包里打乱过的（release.sh）；Telegram 拒了就回填写页
app/js/i18n.js    界面语言：中文原句当键查英文（T("…")），跟系统语言、来源栏最下面切换
app/js/subs.js    字幕：外挂文件（SRT/ASS/VTT，GBK/Big5 自动认）、tx3g、MKV 的文字和 PGS 图形字幕、画到屏幕上
app/js/web.js     网页链接：按站点规则解析出视频地址（XHR，不行就隐藏框）；HLS 给 hls.js（vendor/hls.min.js），MP4 给播放引擎（httpSource）；列表页当来源
app/js/sites.js   仓库里带的站点规则，只有 archive.org 一条（问公开接口挑 MP4），随更新下发
app/js/sites.local.js  站点规则（Web.register），本机自己写，不进仓库
app/js/store.js   本地：看到哪里（localStorage，按账号分开）、上次的来源、moov 缓存（IndexedDB，留 12 个，整台电视共用）
build/src/        mtcute 打包：worker.js（后台线程里的客户端）先打成文本，嵌进 entry.js（主线程的端口 + 二维码）
build/src/compat.js  mtcute 用到、Chromium 69 没有的 API，entry、worker 第一个 import 它
build/bundle.sh   打 mtcute 的包（deploy / release 共用）：正常那份 chrome69、wasm 用 binaryen 降成 MVP；再打老电视那份 tg.legacy.js
build/legacy/     老电视（没有 BigInt，Tizen 5.0 = Chromium 63）那份 mtcute：大数换 JSBI（jsbi-bigint.js 整个换、patches.mjs 按行改）、prelude63.js 补 API
tools/syntax-verify.mjs  包里每个脚本（含后台线程那份文本）对着 required_version 那代引擎查语法（deploy / release 卡着）
tools/deploy.sh   打包、写入上报地址和凭证、签名、安装、启动；打完包把凭证改回空值（--noapi 不写凭证，测填写页）
tools/update-*.mjs  自动更新：update-key（钥匙，只跑一次）、update-release（打包签名 → update/）、update-verify（离线验证，deploy / release 卡着）
tools/diag-verify.mjs  诊断日志离线验证：去隐私、什么时候传、源码里没包起来的名字（deploy / release 卡着）
tools/release.sh  给陌生人的发布包 → dist/：git archive HEAD + 现打 mtcute，凭证打乱后写进去，一次性作者证书，读回验证
tools/collect.mjs 日志收集，:8097（抖音 :8098、bilibili :8099）
test/check.mjs    mp4.js 离线校验（对照 ffprobe，拼出来的 fMP4 交给 ffmpeg 解码）
test/compat.mjs   compat.js 在没有那些 API 的假引擎上补得对不对（deploy / release 卡着）
test/check-mkv.mjs  mkv.js 离线校验（测试片 test/media/mkv/，生成命令在文件头；要 ffmpeg + mkvtoolnix）
test/check-flac.mjs flac.js 离线校验（13 种 FLAC，PCM 和 ffmpeg 逐字节比）
test/legacy-bigint.mjs  build/legacy/jsbi-bigint.js 对着原生 BigInt 随机对拍（deploy / release 卡着）
test/check-subs.mjs subs.js 校验（编码、格式、tx3g、MKV 块；PGS 和 ffmpeg 的渲染逐像素比）
test/i18n.mjs     界面每句话都有英文、占位符对得上；app.js 里往屏幕上写的地方没有漏套 T
test/apikey.mjs   API ID 从哪来、填写页：没带 / 带的被拒 / 打乱过的 / 能用，键盘真敲进输入框（假 Telegram 层，截图 logs/api-*.png）
test/run.mjs      播放引擎桌面测试（Playwright + test/serve.mjs 限速模拟电视）
test/web.mjs      网页链接那条路：真网站解析 → 放 → 跳转（NOXHR=1 走隐藏框）
test/weblist.mjs  网页列表：真网站取第一页再翻两页；要登录的列表应报 needLogin
test/ui-emu.mjs   桌面看界面：换掉 tg.js 用假数据，按键、截图到 logs/ui-*.png
test/readme-shots.mjs  README 的截图（docs/screenshots/）
docs/             专题：前因后果和测量记录（见最后）；docs/screenshots/ 是 README 的截图
spike/            探测版（mp4box）和引擎测量脚本，不进包
```

凭证：`~/.telegram-tizen.conf`（`TG_API_ID` / `TG_API_HASH`，在 my.telegram.org 申请），不进仓库。
电视、证书、签名档沿用 `~/.bilibili-tizen.conf`。

```bash
node tools/collect.mjs | tee -a logs/app.log     # 终端 1
zsh tools/deploy.sh                              # 终端 2
node test/check.mjs test/media/*.mp4             # 改 mp4.js 之后（测试片用 ffmpeg 生成，见 test/check.mjs 头）
node test/check-mkv.mjs test/media/mkv/*.mkv test/media/mkv/*.webm   # 改 mkv.js 之后
node test/check-flac.mjs                         # 改 flac.js 之后
node test/check-subs.mjs                         # 改 subs.js 之后
node test/i18n.mjs                               # 改了界面上的字之后
node test/compat.mjs                             # 改 build/src/compat.js 之后（deploy 也跑）
node test/apikey.mjs                             # 改 apikey.js、填写页、登录出错的处理之后（UILANG=en 英文）
zsh tools/deploy.sh --diag                       # 诊断日志在电视上走一遍（7 步，1 分钟）；先开 PORT=8096 node ../bilibili-tizen/tools/diag-local.mjs
zsh tools/deploy.sh --loginexpiry                # 扫码页上后台线程的连接作废，看是不是重连、换码（3 步，2 分钟；会添加一个账号再取消）
zsh tools/deploy.sh --samples                    # README「拿什么试」那几部片在电视上走一遍：archive.org 解析 + 1080p 连放 + 快进，Sintel MKV + 字幕（16 步，2 分钟）
zsh tools/deploy.sh --legacy                     # 在这台（有 BigInt 的）电视上强制用老电视那份 mtcute：正常那份、老那份各放同一部片子对照
zsh tools/deploy.sh --music                      # 音乐在电视上走一遍：MP3 → FLAC（软件解）→ M4A，换歌、快进、返回接着放（7 步）；先开 RATE=0 LAT=0 node test/serve.mjs
node ../bilibili-tizen/tools/diag-logs.mjs --app telegram-tizen   # 读别人电视传上来的（--device 编号 / <id>）
zsh tools/release.sh                             # 发布包 → dist/telegram-tizen-<版本>.wgt
node test/serve.mjs & node test/run.mjs media/a_h264_fast.mp4 "media/b_h264_moovend.mp4?start=30"   # 改 player.js 之后
node test/serve.mjs & node test/ui-emu.mjs       # 改界面之后，看 logs/ui-*.png（ONLY=mkv / acct / music / history / report 只跑那一段，UILANG=en 英文界面）
```
**自测构建（--diag / --loginexpiry / --samples / --music）测完马上 `zsh tools/deploy.sh` 装回正常构建。**

## 改代码之前要知道的

- **电视上的事只能看日志**（`tizen debug` 打不开）；桌面上测过不等于电视上好，用自测构建在电视上走一遍。
  **卸电视上的应用之前先列出来、对照各项目的 config.xml、问用户**（哔哩哔哩客户端的编号是 `BiliTvApp0.Bilibili`，被当成探测版卸过一次）。
  部署前 sdb 通道可能卡死，deploy.sh 会先试 `shell echo`。
- **最低 Tizen 5.0（Chromium 63）**：mtcute 两份，boot.js 看 `typeof BigInt` 挑 —— 正常的 `tg.bundle.js`（chrome69，wasm 降成 MVP，API 补在
  compat.js），没有 BigInt 的用 `tg.legacy.js`（大数换 JSBI，`build/legacy/`）。我们自己的代码按 63 写（syntax-verify 卡着；正则别用 `\p{}`、
  具名分组）。改了 mtcute 的版本，`build/legacy/patches.mjs` 会对不上、构建停下来，要重新对。→ [docs/老电视兼容.md](docs/老电视兼容.md)
- **mtcute 在后台线程**；给它 wasm 先 `WebAssembly.compile`；下载没背压，靠 `throttle` 钩子；起点按 512KB 对齐；挂到后台一分钟以上连接作废，
  要重连。→ [docs/播放引擎.md](docs/播放引擎.md)
- **播放引擎**：自己写的 MP4 / MKV 解析 + MSE；按秒背压；音视频隔得远就分两路读；**三星的 MSE 不跨空档**，起点要落在音视频都有的地方；
  open GOP 跳转丢前导帧、先清缓冲再挪播放头；H.264 级别写小了改够、avcC 的 profile 写成 0 照 SPS 改；MKV 结尾 `ended` 不一定来；
  **高过 1088 的 H.264 在 Tizen 5.5 / 6.0 上解不了**（说清楚、不当出事）。→ [docs/播放引擎.md](docs/播放引擎.md)
- **电视解不了的音频**：DTS、TrueHD、ALAC，还有**嘴上说认的 FLAC**（MSE、`<audio>` 都不解）。视频里的 FLAC 音轨当放不了；
  音乐里的 FLAC 用 flac.js 软件解成 WAV；音乐里的 ALAC 下的时候看 moov 认出来、说清楚、跳下一首。→ [docs/音乐.md](docs/音乐.md)
- **`video.src`（三星自己的播放器）放网上的 MP4 不可靠**：网页链接里的 MP4 走播放引擎（`Web.httpSource`）。音频做成 blob 给 `<audio>` 是好的。
  → [docs/网页链接.md](docs/网页链接.md)
- **遥控器**：长按确认 650ms 开菜单，按住时的自动重复不算新的一下；在卡片上按确认进播放器 / 音乐画面，那一下的重复和松开也落在里面，
  等松开过一次才认确认键（`S.enterArmed`）。**CSS 滤镜在电视上很贵**，模糊用小图拉伸。→ [docs/界面.md](docs/界面.md)
- **界面文字**：写中文、套 `T()`（app.js）/ `tx()`（别的文件），英文在 i18n.js；`test/i18n.mjs` 卡着。→ [docs/界面.md](docs/界面.md)
- **隐私**：往日志放群名、片名、文件名、搜索词、地址、账号名、ID 一律 `Diag.priv()`，diag-verify 卡着。**API ID / Hash 不进仓库、日志、
  issue、发布说明。** → [docs/自动更新与诊断日志.md](docs/自动更新与诊断日志.md)、[docs/发布包与API-ID.md](docs/发布包与API-ID.md)
- **自动更新**：mtcute（`build/` 下任何东西）、hls.js 不随更新下发，改了就是换壳、`SHELL` 加一；只换打包目标、补 API 的例外改 `update/shell.json`
  的指纹（1.1.3、1.2.0 都是这样）。→ [docs/自动更新与诊断日志.md](docs/自动更新与诊断日志.md)
- **多账号**：本地记录用 `Accounts.scope()`，认人看用户编号。→ [docs/多账号.md](docs/多账号.md)
- **README.md 是英文**（GitHub 默认展示），中文在 README.zh.md；截图两套。→ [docs/README截图.md](docs/README截图.md)
- **电视上还没验证**：Tizen 5.0 / 5.5 / 6.x 真机；AC-3 有没有声音；换音轨重开停在原处；真遥控器的长按；下一集倒计时；切换界面语言；
  添加 / 切换 / 退出账号；在电视上用遥控器填 API ID。看到这些的日志再划掉。

## 专题（docs/）

- [播放引擎.md](docs/播放引擎.md) — 探测版 → 正式版引擎、mtcute 的坑、分两路读、从别人电视的诊断日志查出来的引擎问题
- [MKV-字幕-音轨.md](docs/MKV-字幕-音轨.md) — 当文件发的视频、MKV、换音轨、字幕、长按菜单、下一集、搜索
- [网页链接.md](docs/网页链接.md) — 站点规则、隐藏框、Cloudflare、列表当来源、archive.org、`video.src` 放不了网上的 MP4
- [音乐.md](docs/音乐.md) — 音乐模式、电视能放哪些音频格式（实测表）、FLAC 软件解码
- [界面.md](docs/界面.md) — 用户在电视上边用边提的要求、封面、中英双语、播放记录
- [多账号.md](docs/多账号.md) — 每人一个会话库、切换、退出、扫码页上挂到后台
- [发布包与API-ID.md](docs/发布包与API-ID.md) — 发布包带哪组 API ID、打乱、被拒在哪一步、填写页
- [自动更新与诊断日志.md](docs/自动更新与诊断日志.md) — 签名更新包、壳、诊断日志传什么、什么时候传
- [老电视兼容.md](docs/老电视兼容.md) — Tizen 6.0 打不开（1.1.2）、Tizen 5.5 支持（1.2.0）、Tizen 5.0：没有 BigInt 的那份 mtcute（1.2.2）
- [README截图.md](docs/README截图.md) — README 截图怎么拍、片子的版权、截片段的坑

## 发一版

1. 改 `app/config.xml` 的版本号和 `app/js/boot.js` 的 `PACKAGED_FALLBACK`（要一致，update-verify 卡着），提交。改了 mtcute / hls.js 的话 `SHELL` 加一
   （`build/` 下的任何东西都算，包括 `bundle.sh` 的打包参数和 `compat.js`；只换打包目标、补 API 的例外见上）。
2. `node tools/update-release.mjs`（取自 `git archive HEAD`，`app/`、`build/` 有未提交改动就拒绝），
   `git add update && git commit -m "更新包 x.y.z" && git tag vx.y.z && git push origin master vx.y.z`
   —— tag 要一起推：manifest 从 master 取，bundle 从 tag 取。
3. `zsh tools/release.sh` 出 wgt，`gh release create`，说明先英文、`---`、再中文，最后 sha256（用户 10-26 要的，老的发布说明也都改成了这样）。
4. 装着 1.1.0 以后版本的电视会自己更新。
5. 不用管 Apps2Samsung 的社区目录（README 里推荐的装法）：它每天按 `releases/latest` 自己取新的 wgt
   （`Apps2Samsung/tizen-community-packages` 的 `packages/titlog__telegram-tizen.json`，按 `telegram-tizen-.*[.]wgt$` 挑资产），
   所以 wgt 要一直叫 `telegram-tizen-<版本>.wgt`。
