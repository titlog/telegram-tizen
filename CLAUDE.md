# 三星电视（Tizen）上放 Telegram 里的视频

兄弟项目 `../bilibili-tizen`、`../douyin-tizen` 的平台结论（设备、证书、部署、日志通道、MSE、CSP 的坑）
这里全部适用，**先读那两份 CLAUDE.md**。这份只记 Telegram 自己的事。

出发点（2026-10-01）：Telegram 的群和频道里有不少视频，手机上能直接放，电视上没有能用的客户端。

```
app/js/app.js     界面和遥控器：登录（扫码）、主页（左边来源、右边视频网格）、播放器浮层、长按确认的菜单（音轨 / 字幕）、下一集、搜索
app/js/tg.js      Telegram 这一层：来源（群/频道）、来源里的视频（「视频」+「文件」两路合并）、搜索、群里的字幕文件、封面、给播放器的数据源
app/js/player.js  播放引擎：MediaSource + 音视频两个 SourceBuffer，按样本在文件里的位置顺序读、拼 ~1 秒一段；MKV 走 mkv.js 拆块
app/js/mp4.js     自己写的渐进式 MP4 → fMP4：样本表 TypedArray、二分找关键帧、拼 moof+mdat（替掉了 mp4box）；也认 tx3g 字幕轨
app/js/mkv.js     自己写的 MKV / WebM：读头和 Cues、按 Cluster 顺序拆块、算解码时间，交给 Mp4.fragmentFrames
app/js/accounts.js  多账号：每个账号一个会话库（tg-session、tg-session-2…），每人一份的本地记录（scope），切换 = 重新加载
app/js/boot.js    这次跑哪份代码：安装包的，还是自动更新下载、验过签名的新版本；信任根（公钥），永远不随更新下发。index.html 只剩
                  config.js、boot.js 两个标签，**新加脚本加进 boot.js 的 SCRIPTS**
app/js/update.js  查新版本、下载、验签名、存进 localStorage；本身随更新下发。见「自动更新和诊断日志」
app/js/diag.js    诊断日志：每一行去掉身份记进一圈，出事或手动时传给开发者；接收地址在这里（config.js 不随更新下发）
app/js/selftest.js  deploy.sh --diag 才跑的那一段（设置页里传一次、开关、造一次出事）
app/js/apikey.js  用哪组 API ID / Hash：电视上填过的 → 包里明文的（deploy.sh）→ 包里打乱过的（release.sh）；Telegram 拒了就回填写页
app/js/i18n.js    界面语言：中文原句当键查英文（T("…")），跟系统语言、来源栏最下面切换
app/js/subs.js    字幕：外挂文件（SRT/ASS/VTT，GBK/Big5 自动认）、tx3g、MKV 的文字和 PGS 图形字幕、画到屏幕上
app/js/web.js     网页链接：按站点规则解析出视频地址（XHR，不行就隐藏框）、hls.js 放（vendor/hls.min.js）；列表页当来源、翻页、登录查账号编号
app/js/sites.local.js  站点规则（Web.register），本机自己写，不进仓库
app/js/store.js   本地：看到哪里（localStorage，按账号分开）、上次的来源、moov 缓存（IndexedDB，留 12 个，整台电视共用）
build/src/        mtcute 打包：worker.js（后台线程里的客户端）先打成文本，嵌进 entry.js（主线程的端口 + 二维码）
build/src/compat.js  mtcute 用到、Chromium 76 没有的 API（AbortSignal 的 reason / throwIfAborted / any），entry、worker 第一个 import 它
build/bundle.sh   打 mtcute 的包（deploy / release 共用）：esbuild 的 target 跟着 required_version 走（Tizen 6.0 = chrome76）
tools/syntax-verify.mjs  包里每个脚本（含后台线程那份文本）对着 required_version 那代引擎查语法（deploy / release 卡着）
tools/deploy.sh   打包、写入上报地址和凭证、签名、安装、启动；打完包把凭证改回空值（--noapi 不写凭证，测填写页）
tools/update-*.mjs  自动更新：update-key（钥匙，只跑一次）、update-release（打包签名 → update/）、update-verify（离线验证，deploy / release 卡着）
tools/diag-verify.mjs  诊断日志离线验证：去隐私、什么时候传、源码里没包起来的名字（deploy / release 卡着）
tools/release.sh  给陌生人的发布包 → dist/：git archive HEAD + 现打 mtcute，凭证打乱后写进去，一次性作者证书，读回验证
tools/collect.mjs 日志收集，:8097（抖音 :8098、bilibili :8099）
test/check.mjs    mp4.js 离线校验（对照 ffprobe，拼出来的 fMP4 交给 ffmpeg 解码）
test/compat.mjs   compat.js 在没有那些 API 的假引擎上补得对不对（deploy / release 卡着）
test/check-mkv.mjs  mkv.js 离线校验（测试片 test/media/mkv/，生成命令在文件头；要 ffmpeg + mkvtoolnix）
test/check-subs.mjs subs.js 校验（编码、格式、tx3g、MKV 块；PGS 和 ffmpeg 的渲染逐像素比）
test/i18n.mjs     界面每句话都有英文、占位符对得上；app.js 里往屏幕上写的地方没有漏套 T
test/apikey.mjs   API ID 从哪来、填写页：没带 / 带的被拒 / 打乱过的 / 能用，键盘真敲进输入框（假 Telegram 层，截图 logs/api-*.png）
test/run.mjs      播放引擎桌面测试（Playwright + test/serve.mjs 限速模拟电视）
test/web.mjs      网页链接那条路：真网站解析 → hls.js 放 → 跳转（NOXHR=1 走隐藏框）
test/weblist.mjs  网页列表：真网站取第一页再翻两页；要登录的列表应报 needLogin
test/ui-emu.mjs   桌面看界面：换掉 tg.js 用假数据，按键、截图到 logs/ui-*.png
spike/            探测版（mp4box）和引擎测量脚本，不进包
```

凭证：`~/.telegram-tizen.conf`（`TG_API_ID` / `TG_API_HASH`，在 my.telegram.org 申请），不进仓库。
电视、证书、签名档沿用 `~/.bilibili-tizen.conf`。

```bash
node tools/collect.mjs | tee -a logs/app.log     # 终端 1
zsh tools/deploy.sh                              # 终端 2
node test/check.mjs test/media/*.mp4             # 改 mp4.js 之后（测试片用 ffmpeg 生成，见 test/check.mjs 头）
node test/check-mkv.mjs test/media/mkv/*.mkv test/media/mkv/*.webm   # 改 mkv.js 之后
node test/check-subs.mjs                         # 改 subs.js 之后
node test/i18n.mjs                               # 改了界面上的字之后
node test/compat.mjs                             # 改 build/src/compat.js 之后（deploy 也跑）
node test/apikey.mjs                             # 改 apikey.js、填写页、登录出错的处理之后（UILANG=en 英文）
zsh tools/deploy.sh --diag                       # 诊断日志在电视上走一遍（7 步，1 分钟）；先开 PORT=8096 node ../bilibili-tizen/tools/diag-local.mjs
node ../bilibili-tizen/tools/diag-logs.mjs --app telegram-tizen   # 读别人电视传上来的（--device 编号 / <id>）
zsh tools/release.sh                             # 发布包 → dist/telegram-tizen-<版本>.wgt
node test/serve.mjs & node test/run.mjs media/a_h264_fast.mp4 "media/b_h264_moovend.mp4?start=30"   # 改 player.js 之后
node test/serve.mjs & node test/ui-emu.mjs       # 改界面之后，看 logs/ui-*.png（ONLY=mkv / ONLY=acct 只跑那一段，UILANG=en 英文界面）
```

## 可行性探测的结果（2026-10-01 设备实测，参考机同 bilibili / 抖音那台）

**全链路通了**：扫码登录 → 全局搜索 → 边下边播 → 跳转，都在电视上跑起来了。

| 项 | 结果 |
|---|---|
| 环境 | `isSecureContext=true`、`crypto.subtle` 有、WebAssembly SIMD 有、IndexedDB 有 |
| MSE `isTypeSupported` | avc1、hvc1（Main / Main10）、av01、mp4a、**ac-3、ec-3**、opus、flac 全过（桌面 Chrome 反而不支持 ac-3/ec-3） |
| 连 Telegram（WebSocket，`wss://*.web.telegram.org/apiws`） | 226–384ms |
| 扫码登录 | 出码 0.6 秒，码 30 秒一换；扫码后 4 秒登录完成 |
| **会话活过重新安装** | 是（mtcute 默认存 IndexedDB，第二次装完直接「会话还在」） |
| `searchGlobal` | ~200ms |
| **下载速度（非会员）** | 持续 1.7–2.3 MB/s；文件在别的 DC（账号 DC1，文件 DC5）第一次 6.4 秒才到第一块（导出授权 + 建连），之后 1.9 秒；文件中间开始取第一块 0.4–0.9 秒 |
| 样片 | 《末代皇帝》219 分 MP4，2.6GB，`avc1.640028` 1920×680 + `mp4a.40.2` 48kHz 立体声，`supports_streaming`，平均 ~0.2 MB/s —— 下载速度是码率的十倍 |
| 起播 | 9.5 秒（第一块 0.7 + moov 6MB 下载 ~3 + **mp4box 解析 moov 4.15 秒**） |
| 跳转（修好之后） | 发出到画面动起来 1.1 秒；**但第一次跳转 `mp4box.seek` 卡主线程 9.5 秒**，第二次 87ms |

### 坑

- **mtcute 0.32.3 给它 wasm 字节会炸**：`loadWasmBinary` 走 `WebAssembly.instantiate(bytes)` 拿回 `{module, instance}`，
  `initSync` 当成 Instance 用，抛「WebAssembly.Module(): Argument 0 must be a buffer source」。要先 `await WebAssembly.compile()`
  再把 Module 交给它（不能同步编译：Chromium 主线程不许同步编译 4KB 以上的模块）。桌面冒烟测试抓到的。
- **mtcute 的下载没有背压**：`downloadAsIterable` 的下载线程拿完一块就拿下一块，不管消费者读没读，暂停读取等于把整个文件
  往内存里堆。它留了 `throttle` 钩子（每块请求之前 await），背压做在那里。`limit` 参数和 `offset` 一起用是错的（算块数时
  把 limit 当成终点），只传 `offset` + `fileSize`、够了就 abort。
- **起点按 512KB 对齐**：Telegram 每次最多 512KB，且一次请求不能跨 1MB 边界。
- **mp4box 跳转音视频不对齐**：`seek(t, true)` 把视频退到关键帧、音频却落在 t（每个音频样本都是关键帧），两条轨起点差几秒，
  `video.buffered` 取交集，播放头落在空档里永远不动。拿第一次返回的关键帧时间再 seek 一次。
- **mp4box 对长片太慢**：每个样本一个 JS 对象（这部 ~93 万个）。解析 moov 4 秒、第一次 seek 9.5 秒、之后每 append 512KB
  常要 200–300ms 生成分段 —— 全在主线程，界面跟着卡。开头那 2.2–2.6 秒的卡顿多半也是它。**正式版自己写 MP4 解析：样本表
  存成 TypedArray、二分找关键帧、自己拼 moof/mdat。** 抖音那边短视频用 mp4box 没事，是因为样本少。
- 背压按字节（8MB 在途）在片头低码率时会多缓冲到 240 秒，正式版按秒数控制。
- `tizen package` 按 `<name>` 命名包，「TG 视频.wgt」带空格，`tizen install` 一行输出都没有就失败。deploy.sh 打完包改名。

## 正式版的播放引擎（2026-10-01 电视实测，《末代皇帝》219 分 2.6GB）

| | 探测版（mp4box，mtcute 在主线程） | 正式版 |
|---|---|---|
| 起播 | 9.5 秒 | **5.8 秒**（第一块 2.1，moov 6.4MB 到手 4.0，解析 0.41） |
| 解析 moov | 4.15 秒 | **0.41 秒**（32.8 万帧 + 61.6 万个音频样本，全是 TypedArray） |
| 跳到没缓冲的地方 | 主线程卡 9.5 秒 + 1.1 秒 | **0.64–0.69 秒** |
| 缓冲内 ±10 秒 | — | **0.10–0.13 秒** |
| 关掉重开、续播 | — | 4.5 秒（其中 moov 2.4 秒 —— 正式版有 moov 缓存） |
| 主线程长卡 | 4–9 秒 | 只剩解析 moov 那一下 0.4–0.5 秒 |

- **切到别的应用一分钟以上再回来，Telegram 全挂（`Worker connection expired`）**（10-02 电视上切去哔哩哔哩 6 分钟）：mtcute 的
  主线程端每 10 秒给后台线程发心跳，后台线程 60 秒收不到就作废这条连接；电视把应用挂到后台时主线程整个停住（那 6 分钟一行日志都没有），
  后台线程照跑。修法：`TGLib.create` 多给一个 `reconnect`，在同一个后台线程上新开一条连接（它支持多条，不用重连 Telegram、不用重新登录），
  tg.js 碰到这个错就重连、重试一次；下载流里碰到就重连后抛出，播放器自己重试。`test/worker-expire.mjs` 让主线程忙等 70 秒复现，
  重连 1ms、之后请求正常。**电视上还没验证。**
- **mtcute 必须放后台线程**：它在主线程时，数据成批到达那几秒每隔一两秒卡 300–850ms。加计时分清了：卡的时候我们自己
  拼分段（produce）最多 11ms，moov 还没到、produce 一行没跑的时候也照样卡 —— 是 mtcute 的解密校验。挪进 Worker 之后下载期间
  一次都不卡，跳转也从 0.87 → 0.64 秒。Worker 用 `blob:` 地址起（`file://` 页面不能从文件起），凭证拼在脚本前面；
  后台线程里可以同步编译 wasm（主线程不行）。会话存 IndexedDB，主线程版存的会话后台线程直接读得到（换过去没重新扫码）。
  `performance.memory` 在这台电视上一直不变（10MB），不能拿来判断 GC。
- **open GOP 跳转**：关键帧后面、解码顺序在后显示在前的「前导帧」参考上一个 GOP，跳过来时解出来是错的。桌面 Chrome
  （macOS 硬件解码）直接 `PIPELINE_ERROR_DECODE`。两处：跳转后丢掉前导帧、关键帧的时长撑到下一个要放的帧（解码时间断开超过
  两帧 MSE 就当成不连续，丢到下一个关键帧）；**先清空旧缓冲、清完再挪播放头** —— 反过来 Chrome 会先在旧缓冲里跳，旧缓冲里前导帧
  都在。缓冲内跳转遇到带前导帧的关键帧也改走重新取。中间怀疑过「硬件解码不认 CRA 开头」，离线用 ffmpeg + VideoToolbox 解三种
  变体全过，排除了。
- **视频的 edit list 偏移并进 trun v1 的有符号合成偏移**，首帧显示时间 = 0，和音频对齐；音频的（编码器预滚 20–50ms）不管。
  ffmpeg 读负的合成偏移会把整条轨往后挪一个常数，所以 test/check.mjs 只比相对时间。
- 跳转测量要防「清旧缓冲那几十毫秒 currentTime 还停在原处」：往回跳时原处比目标大，会被误判成已经出画面（报过一次 57ms）。
  判据是播放头落在目标之后 5 秒内。
- 关键帧平均 6 秒一个，±10 秒落在最近的关键帧上，实际可能是 +15。

## 界面和用户的要求（2026-10-01，用户在电视上边用边提）

- 不要收藏夹，用户习惯用**自己建的一个群**（手机上找到视频转发进去，电视上点开就放）。启动直接进上次的来源。
- 左边来源栏只列有视频的会话（每个问一次 `searchMessages` 数量，结果存 `tg.srcCount.v1`）；浏览视频时收起来，按左键滑出来盖在网格上。
- 视频网格三列、占满全宽，没有顶栏（不显示群名）。选中描边比卡片大 5px，第一排要往下留 12px，不然被 `overflow:hidden` 切掉。
- **网格只在要选的那一排露不全时才滚，滚到刚好露全**（10-02）。第一版焦点那一排永远停在第二排的位置，用户：「眼睛里有 9 个视频，
  想选第一行中间那个，一按上键那一行就滑下来，眼睛还得跟着动」。一屏两排整的 + 第三排一截（卡片 450、行距 470、可视 1030）。
- 快进快退按住越来越快：←→ 15 秒起（10-02 从 10 秒改的）、↑↓ 1 分钟起，同一个键两次之间 < 0.4 秒算按住；停手 0.7 秒才真的跳。
- 标题：说明文字第一行，有《》取书名号里的；#标签只去掉 #（片名常写成标签：「《#黑鹰坠落 国语 高清》」）。

## 封面

顺序：本地缓存（IndexedDB `tg-moov` 库的 `cover` 表）→ 电影（≥40 分钟）找维基百科海报 → Telegram 缩略图 → 太暗（平均亮度 < 24）或没有就从片子中间解一帧 → 都不行显示片名卡片（按片名算底色）。
- **很多大文件的缩略图是开头那一帧，纯黑**（两部片亮度都是 0，手机上也是黑块）。第一版以为是缩略图没加载，其实是盖在上面的片名占位层挡住了 img（DOM 顺序）—— 用户拍照才发现。
- **取帧用 WebCodecs**：`<video>` 的帧画不到画布上（硬件视频层，抖音项目实测），WebCodecs 单独解一个关键帧可以。H.264 1080p：读 1.7 秒、解 0.5 秒。**4K HEVC Main10 解不了**：默认 / prefer-hardware 报 `Decoding error`、prefer-software 报 `Error during flush`，换三个位置都一样。解码器偶尔不出帧也不报错，所以每次解码 8 秒超时、每部片 40 秒超时。开始播放前 `Cover.cancel()`，别和播放抢唯一的硬件解码器。
- **海报用维基百科**：豆瓣对海外请求（带 bid cookie 也一样）回空数组；iTunes 搜索中英文、各地区都没结果；TMDB 要 key。维基 `generator=search` + `prop=pageimages&pilicense=any` 带海报（非自由图，~260×380）。搜「中文片名 年份 电影」，取前 3 条里「标题含片名且有图」的，没有就第一条有图的（「黑鹰坠落」对上台湾译名「黑鷹計劃」）。在 Mac 上试 6 部对 5 部（《流浪地球》搜到了《流浪地球3》、没图）。没找到的一周内不再找（`tg.noPoster.v1`）。

## 音视频在文件里隔得远的片子：分两路读

《黑鹰坠落》4K HEVC（3.9GB，moov 在尾部）的布局：1 分钟处视频在 30.7MB、音频在 2.2MB；10 分钟 381.5MB / 51.0MB；72 分钟 2031MB / 491.6MB —— 越往后隔得越远（最远 2.9GB）。一路顺序读的后果：
- 续播 6:35 要先读过 176MB，**60 秒才出画面**；
- 音频越跑越前：读到视频之前音频已经攒了 6 分钟，**电视的音频 SourceBuffer 只有 ~8MB**，撑满报 QuotaExceeded；第一版「满了就停下载」直接死锁（视频永远到不了），看门狗重开也是同一个死结。
修法（player.js 的「路」lane）：打开时在 21 个时间点上量同一时刻音视频的偏移差，超过 16MB 就音视频各一路、各读各的位置，背压各算各的。之后同一处续播 **3 秒出画面、只下了 3MB**。另外：拼好的段先攒在内存里、离播放头 90 秒以内才进 SourceBuffer；QuotaExceeded 时只缩这条轨的提前量，不再挡下载。
桌面上用 `test/skew.mjs` 把普通测试片重排成同样的布局来测。

## 网页链接：群里发网站的视频链接，电视解析出来放（2026-10-02）

用户的想法：「在 Telegram 群里发一个网站的视频链接，播放器自动解析出视频开始放，相当于浏览器」。`app/js/web.js`，
放 HLS 用 hls.js 1.7.3（`app/js/vendor/`，MSE）。群里带链接的消息（`inputMessagesFilterUrl`，最近 40 条）里，
有站点规则的、或者直接是 `.m3u8` / `.mp4` 的，和视频按时间混排在网格里；卡片写「网页 · 站名」。

**站点规则不进仓库**：`web.js` 只是框架，一条规则都不带。规则用 `Web.register({...})` 写在 `app/js/sites.local.js`
（`.gitignore` 里），`index.html` 在 `web.js` 后面加载它，没有这个文件时那一行什么都不做；`deploy.sh` 打包时照样带上。
规则的格式（片子页怎么找地址、列表页怎么解析、要不要登录、怎么登录）写在 `web.js` 开头。

**做法：先 XHR 取页面找地址，找不到再用隐藏 iframe 打开页面、读页面里的变量**（widget 能读跨域框，抖音项目实测；
框里有广告、可能自动放视频，找到就拆）。每次打开都重新解析（地址常带签名、几个小时就过期）；放着放着网络致命错误就重新解析、从原处接着放。

- **Cloudflare 挡 XHR 是时挡时不挡的**：桌面同一个页面一次 403 一次 200，电视上常常是前两次挡、第三次放；对 curl / Node 的 fetch
  一律 403，真 Chromium 打开网页 200。框打开一次过了检查，之后 XHR 就通了（同一个 cookie）。所以挡了隔 0.3 / 0.6 / 1.2 秒再试，
  第一页还挡就开一次框。**挡的时候框也不一定救得了**：电视上框落到过浏览器自己的错误页（`chromewebdata`），桌面上同一个框正常。
- **消息里原样写的地址优先**：Telegram 预览里的地址会把末尾的「/」规整掉，有的站没有「/」是 404 —— 第一次在电视上就栽在这。
- 桌面 Chrome 怎么开关（`--disable-web-security`、关站点隔离、独立用户目录）都不让 `file://` 页面读跨域框，电视上能读。
  `test/web.mjs` 走框那条路时，把测试页伪装成那个站自己的一个地址，框和它同源。
- 封面：Telegram 给链接生成的预览图 → 页面的 og:image（顺带 og:title）。
- 电视实测（一个 HLS 站，720p、AES-128 不是 DRM）：解析 226ms（XHR）、清单 629ms、第一段 1.3MB 190ms，**出画面 2.9 秒**；
  下载 8.1 MB/s（码率的 ~25 倍），前面缓冲稳在 30 秒（maxBufferLength）；跳到没缓冲的地方 0.53–0.91 秒。
- 做不了的：有 DRM 的正版平台；YouTube 签名常变，不在电视上做。

### 列表链接当来源（2026-10-02）

群里发一个列表页的链接（规则的 `list` 认得的地址），来源栏最上面多一项，右边是它的片子，往下翻一页一页取（规则的 `parseList`）。
来源按发在哪个群存（`tg.webSources.v1`），开机、打开来源栏、每 5 分钟跟着来源栏一起刷新那几个群 ——
第一版只在打开那个群时才读，用户发完链接电视上一直不出来。

- **登录状态多半用不上**：网站的会话 cookie 常常没设 SameSite（= Lax）。电视页面是 `file://`、对网站是跨站 —— 桌面实测从 `file://`
  页面 XHR 之后那个站的 cookie **一个都没存下来**。所以要登录的列表（`needLogin`）只登录一次，用登录接口回的账号编号改读公开地址
  （`publicUrl`），只存编号和名字（`tg.webAccount.v1`），不存密码。

- 开机进上次的来源、那个来源要登录时不自动弹登录框（用户：「从电视主页一进，一直出来让我登录」），网格里写「按确认登录」。
- 登录框是自己画的两个输入框：聚焦调出屏幕键盘，键盘上的「完成」（65376）跳下一格 / 提交；输入框里按返回先收键盘。
- `tizen debug`（Web Inspector）在这台电视上打不开（bilibili 项目早就实测过），电视上的事只能看日志。
- **哔哩哔哩客户端的应用编号是 `BiLiSpiKe0.BiliSpike`**（探测版直接长成正式版，名字没改）。2026-10-01 别的会话清理「spike」时把它当探测版卸了；
  用户 10-02 发现，装回之后按用户要求把编号改成了 **`BiliTvApp0.Bilibili`**（bilibili 仓库 c604fcf）。**卸电视上的应用之前先列出来、对照各项目的 config.xml、问用户。**
- **部署卡死**：Mac 上一个跑了 17 小时的旧 sdb 服务，`sdb devices` 显示 device，`sdb shell echo` 却不回，`tizen install`
  一声不吭等了 13 分钟。deploy.sh 现在装之前先试 `shell echo`，不通就 `sdb kill-server` 重连；安装超过 4 分钟算失败。

## MKV、多音轨、字幕、下一集、搜索（2026-10-18）

用户问「还需要什么新功能」，列了五样（MKV、换音轨、字幕、自动下一集、搜索），回答「全都做」。**以下全是桌面测出来的，电视上还没验证。**

**当文件发的视频**：MKV 几乎都是当文件发的，它们在 Telegram 的「文件」里，`inputMessagesFilterVideo` 筛不出来 —— 第一版网格里根本
看不到 MKV。现在 `TG.videos` 是「视频」「文件」两路按时间合并（文件那一路按扩展名 / mime 挑 mkv/webm/mp4/m4v/mov，顺手记下 .srt/.ass），
翻页的游标（`page.next`）是个对象，app 原样传回去。一个「视频」都没有的会话，再看最近 40 个文件里有没有当文件发的。
当文件发的没有时长（Telegram 不知道），放过一次记下来（`tg.dur.v1`）；片名从文件名里取（`The.Last.Emperor.1987.1080p…` →「The Last Emperor 1987」）。

**MKV（mkv.js）**：开头 4 字节 EBML 魔数认出来。`readHead` 读头和 Cues —— 一般 2 次请求（开头 512KB + 文件尾的 Cues），结果存进 moov 那个缓存。
之后从 Cue 指的 Cluster 顺序拆块，一路读（MKV 里同一时刻的音视频挨着放，不用分路）。
- MKV 只有显示时间。解码时间 = 「还没用掉的显示时间里最小的」，压几帧再定（排序窗口）。**窗口从 4 帧起、碰到更深的重排才加**：第一版固定 16 帧，
  跳转后第一段要多等 16 帧（4K 一帧几百 KB），桌面跳转 1.4 秒；x264 / x265 开 16 个 B 帧的金字塔，实际重排深度也只到 4，算出的解码时间和
  排好序的显示时间逐帧一致。
- 拼段也和 MP4 一样「窗口里拆出多少拼多少」，不等凑满一秒（不然跳转后第一段多下一秒的字节）。从头放时，认出 MKV 时下的那一块留着接着拆，省一次请求。
- 桌面（限速 2MB/s、每请求 400ms）：从头放 1.6 秒（moov 在开头的 MP4 0.8 秒，差在多读一次 Cues）、续播 1.9–2.4 秒、跳转 0.75 秒（和 MP4 一样）。
- AC-3 / E-AC-3 的 dac3 / dec3 要从第一帧的同步帧头解，多数在 readHead 那 512KB 里就解出来了。DTS、TrueHD、Vorbis、PCM 放不了（三星这代不解 DTS），
  有别的音轨就自动换一条，只有这一条就无声放、提示一下。**MP3 音轨桌面 Chrome 的 MSE 不认，电视上不知道。**
- 测试片 16 个（ffmpeg 和 mkvmerge 各做一批：lacing 三种、header stripping、大小未知的 Cluster、没有 Cues、BlockGroup、zlib 字幕），
  `test/check-mkv.mjs` 逐帧对 ffprobe、拼出来的 fMP4 交给 ffmpeg 解码。

**换音轨 = 在当前位置重开**，不在原来的 MediaSource 上换：换编码要 `SourceBuffer.changeType`，三星电视的 MSE 是自己的实现，没验证过，重开最稳。
重开时 `exact`：清完缓冲把播放头放在原来那一秒（关键帧和它之间的帧解码但不显示），桌面上换完接着原处放。每部片选过的音轨记在 `tg.prefs.v1`。
MP4 的默认音轨看 tkhd 的 enabled，MKV 看 FlagDefault；轨道名 MP4 读 hdlr 的名字（ffmpeg 的 `handler_name`），「SoundHandler」这类默认值不算。

**字幕**：三个来源 —— MP4 的 tx3g（读音视频时顺带从窗口里拿，不留住窗口；整条轨挤在一小段里的开头单独读一次）、MKV 的字幕块、
和片子发在同一个群里的 .srt/.ass（按文件名同前缀、片名、发的时间和消息编号打分，≥ 3 算「就是它」）。
默认开哪个：这部片子上次选过的 → 强制字幕 → **对白不是中文时**开中文字幕（片子里的优先，再看名字对得上的文件）→ 关。对白是中文不自动开（国产片多半硬字幕）。
PGS 一个显示集几 KB 到几十 KB、蓝光 remux 常带四五条：定下之后只存正在显示的那条；中途换到别的 PGS 轨时让播放器从当前位置重读（`player.refetch`）。
字幕时间可以 ±0.5 秒调（外挂字幕和片源版本不同常差几秒），按片子记。

**长按确认键开菜单**（650ms，和 bilibili 客户端卡片上的长按一样，松开时才判断短按）：音轨、字幕、字幕时间、下一集。
桌面测试抓到：**按住时遥控器的自动重复会在刚弹出的菜单里「按确认」**，菜单一闪就关了（bilibili 那边也专门挡过）—— 按住期间的确认键一律不算。
在卡片上按确认进播放器，那一下的自动重复和松开也落在播放器里，要等它松开过一次才认确认键。

**下一集**：标题和文件名里认集数（S01E02、第3集/第三话、EP02、[02]、「 - 02」），剧名 = 去掉集数和画质字样剩下的。放完在已加载的列表里找同一部剧
集数最小的下一集，没有就往后翻最多 3 页再找；右下角倒计时 8 秒，确认现在放、返回不放。

**搜索**：来源栏第 0 项。`searchGlobal` 搜「视频」和「文件」两路（文件名对得上的 MKV 也出来），结果当一个来源放在网格里（卡片上写群名）。
搜过的词留 12 个（遥控器打字慢）。搜索结果不记成「上次的来源」，开机还是进上次的群。

播放时提示条（toast）挪到屏幕上方：在下面会盖住字幕（截图看出来的）。

**电视上要验证的**：MKV 能不能放（尤其 AC-3、HEVC）、换音轨重开停在原处、字幕显示、长按确认（真遥控器的自动重复间隔）、
下一集倒计时；还有之前那条 —— 切到别的应用一分钟以上再回来、后台线程重连。10-18 13:32 装上，用户 13:46 说「都试了都没问题」；
但那段日志里只有一次 MP4 播放（3.7GB、6.6 秒出画面），MKV、换音轨、选字幕、搜索、下一集都会写日志，一条都没有 —— **当作还没验证**，
下次在电视上看到这几样的日志再划掉。

## 中英双语界面（2026-10-18）

开源之后用户说「Telegram 老外也用的很多」，先补了完整的 README.en.md，接着界面也做成双语。
- **写法**：界面上的字照旧写中文、套 `T("…")`（app.js）/ `tx("…")`（player / mkv / mp4 / tg / web —— player.js 和 mkv.js 里 `T` 已经是轨道变量名）。
  中文原句就是键，英文字典在 i18n.js；查不到就显示中文，不会空着。带变量用 `{0}`。日志（`R(...)`）不翻。index.html 里的静态文字标 `data-i18n`，
  启动时 `I18n.apply()` 换掉。`test/i18n.mjs` 卡住漏翻、占位符不一致、app.js 里直接往屏幕上写中文。
- **选哪种**：手动选过的（`tg.lang.v1`）→ 系统语言是 zh 开头就中文、别的英文。**升级前就在用的电视定成中文**（本地有看过的记录 / 上次的来源）：
  用户的电视系统语言不一定是中文，升级之后突然变英文不对。启动那行日志写着界面语言、为什么、系统语言是什么（电视上 `navigator.language` 跟不跟
  系统菜单语言走还没验证）。来源栏最下面一项切换（写成要换成的那种语言：英文界面上是「中文界面」），切完重新加载页面。
- **跟语言走的行为**：自动开字幕的规则换成「对白不是界面语言、又有界面语言的字幕才开」—— 英文界面上中文对白的片子自动开英文字幕。
- 桌面测试：`ui-emu.mjs` 中英各跑一遍（`UILANG=en`）。踩了一下：旧测试里有一步在来源栏按三下 ↓ 再确认，原来落在「退出登录」（只会提示「再按一次」），
  换语言那一项插在它前面之后，测试跑到一半把语言切了 —— 换语言放到「退出登录」下面、最后一项。
- README.en.md 的截图是英文界面（`UILANG=en node test/readme-shots.mjs` → `docs/screenshots/en-*.jpg`）。
- 电视上（10-18 14:17）：系统语言报的是 `en-GB`，按「升级前就在用」定成了中文 —— 没有这条，用户这台升级后就是英文界面。
  用户说切换试过没问题，但日志里没有「界面语言 zh → en」那一行，**切换这一步当作还没在电视上验证**。

## 多账号（2026-10-18，照 bilibili 客户端）

用户问「能做多用户登录吗？就像 bilibili」，按建议做：看到哪里按人分开、切换不要密码。
- **为什么比 bilibili 简单**：bilibili 那边浏览器只有一个全局 cookie 坑位，第二个人扫码之后请求还穿着第一个人的衣服（那边 CLAUDE.md「一台电视，好几个人」）。
  这边每个账号的会话是 mtcute 的一个 IndexedDB 库（库名就是 storage 名：第一个账号沿用原来的 `tg-session`，后加的 `tg-session-2`、`-3`…，编号不复用），
  各自一份授权密钥，没有共享的坑位。同一时间只开一个：切换 = 记下当前账号、`location.reload()`，用它的库起后台线程。
- **每人一份**（`Accounts.scope(key)`）：看到哪里、上次的来源、来源栏、搜过的词、每部片子的音轨字幕选择、网页登录查到的账号编号。
  **第一个账号（a1）沿用升级前的键名**，后加的带 `@a2`；升级不用搬数据。整台电视共用：封面、moov / MKV 头缓存、片子时长、界面语言、维基没找到海报的记录。
- **认人看用户编号**（bilibili 的教训：别只看「认不认得出一个人」）：每次启动 getMe，和这一行记的 userId 比，日志
  `账号：N 个，当前 a2（库 tg-session-2，… id=…），Telegram 答的是 id=… —— 对上了`。已有 userId 的行对不上就不改名字。
- **添加时扫的是已经在的账号**：新会话作废（logOut）、这一行拿掉、切回原来那一行，提示「这个账号已经在这台电视上了」。
- **扫码页按返回**：在添加账号 → 取消、切回原来的；是某个账号的会话没了要重扫 → 先换到别的账号；电视上只有这一个账号才退出应用。
- **退出一个账号**（账号页最后一项，按两下）：先 logOut（手机上「设备」里那条也没了），再删这个人的本地记录；他的库**下次启动才删**
  —— 退出那一刻后台线程还开着它，`deleteDatabase` 会被挡住。待删的库名记在 `tg.accounts.v1` 的 drop 里。
- 界面：来源栏倒数第二项「账号：名字」→ 账号页（各账号、+ 添加账号、退出 当前的）。切换之后的提示（「已切换到 …」）跨过重新加载，用 `Store.once`。
- 桌面测试（`ONLY=acct`）：假 Telegram 层按当前账号的库答「我是谁」（tg-session-3 故意答成第一个人），走一遍添加 → 切回 → 添加已经在的 → 扫码时按返回 →
  退出：进度按人分开（1 / 0 / 1），退出的人的进度键删了、库下次启动删了。踩了一下：按下确认就重新加载页面，测试里松开那一下没有页面可发，按键工具要容忍。
- 电视上（10-18 14:37）：升级上去原来的会话就是 a1，getMe 对上，不用重新扫码，启动到主页 2.4 秒。添加第二个账号、切换、退出：用户 14:38 说试过没问题，
  但日志里没有「添加账号」「切换账号」「账号：2 个」这些行 —— **当作还没在电视上验证**。

## 发布包和 API ID（2026-10-21，issue #1：「为什么不发 .wgt」）

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

## 自动更新和诊断日志（2026-10-21，用户要求，照搬 douyin / bilibili）

和那两个应用是同一份代码（来龙去脉在 bilibili 的 `docs/自动更新.md`、`docs/调试与日志.md`）：签名过的 `update/manifest.json` 从 master 取，
更新包按 tag 取，下载时验 ECDSA 签名和 sha256，存进 localStorage，**下次打开生效**；走不到首页的更新包下次启动标坏、退回安装包。
诊断日志出事（或手动）时把最近 600 行传到 bilibili 那边的接收端（`server/diag-worker.mjs`，三个应用共用，按 `app` 分开）。

**自动更新这里不一样的地方：**
- **mtcute（`js/tg.bundle.js`，2.8MB）、hls.js（`js/vendor/hls.min.js`，600KB）不随更新下发**，一直用安装包里的（`tools/update-lib.mjs` 的
  `PACKAGED`，`sites.local.js` 也是）。整份存进 localStorage 要 7–8MB（UTF-16），电视上的配额没量过；我们自己的代码只有 ~420KB。boot.js 跑
  更新包时，包里没有的脚本照样写 `js/<名字>` 从安装包读。**所以改了 mtcute（`build/`）或 hls.js，就是换了壳：boot.js 的 `SHELL` 加一**，
  SHELL 更老的电视跳过那一版、要重装。`update/shell.json` 记着每个 SHELL 发布时这两样的指纹，`update-release` 和 `update-verify` 都卡着。
- 钥匙是自己的：私钥 `~/.telegram-tizen-update-key.pem`、口令 `~/.telegram-tizen-update-password`（都 600、都在仓库外），公钥指纹
  `5ee2:90e1:9906:fe44:adf7:60f7:8988:4173`。不和 bilibili、抖音共用。丢了要所有人重装；泄露了谁都能往装着它的电视推代码，而这个应用开着
  登录好的 Telegram 会话。
- 不是「CSP 模式」（config.xml 刻意没有 allow-navigation 和 CSP），`blob:` 脚本照常跑；哪天加了 CSP，script-src、style-src 要加 `blob:`
  （update-verify 卡着）。
- 启动检查：脚本都跑完、之后两秒没有 `window.onerror` 才 `Boot.ok()`（`Log.errors()` 数着）。不等连上 Telegram：断网不是代码坏了。
- 第一次跑一个新下载的版本时提示「已更新到 x.y.z」；设置页（来源栏「设置」）写着正在运行哪一版、下载好了没有，能「检查更新」。

**诊断日志这里不一样的地方：**
- **往日志里放群名、片名、文件名、字幕文件名、搜索词、网页地址和主机名、账号名、Telegram 用户 ID、网站账号编号，一律包 `Diag.priv()`**。
  `diag-verify` 从源码里查 `R` / `Log.report` / `Diag.incident` 的参数，卡着 `.title`、`.fileName`、`.query`、`.url`、`.hostname`、`.userId`、
  账号名、`ps.info`、`host(`。`scrub()` 兜底：「」里的一律当名字（这个项目写日志的习惯）、任何 `http(s)://` 和 `tg://`、`id=<数字>`、
  「账号编号 …」、32 位以上的十六进制（API Hash）。
- 出事 = `Diag.incident`：连不上 Telegram、读不到来源里的视频 / 网页列表、搜索出错、放不了、字幕文件读不出 / 下不下来、启动出错、js 错误、
  安装包带的 API ID 被拒、更新包被标坏。电视上填错的 API ID 不算（那是这一台的事）。
- 开关、手动上传、这台电视的编号在设置页。开发构建（`REPORT_TO` 非空）不传，除非 `TG_DIAG_TO`（`--diag` 默认这台电脑的 :8096 ——
  :8097 是这里的收集器）。
- 桌面测试（`ui-emu` / `readme-shots` / `apikey`）里，接收端（地址从 diag.js 读）和 GitHub / jsDelivr 一律拦掉，测试不往线上传东西。

**测过的（同一天）：** `update-verify`、`diag-verify` 全过（diag-verify 故意弄坏 6 处都抓到）；`ui-emu` 全过（加了设置页那一段；来源栏底下多了
「设置」之后，旧测试按位置去「账号」落到了设置上 —— 改成按文字找）；电视 `--diag` 7 步全过，读回传上去的那份：账号名、用户 ID、群名
全是「…」。电视上的自动更新（装标成 1.0.0 的开发构建、更新源指到这台电脑上一个标成 1.0.1 的更新包）：上一个构建查 GitHub 404 记了一次
失败，这一个按退避 15 分钟后才查（这条规则是对的，没为测试改它）→ `已下载 1.0.1，下次打开生效（420KB …，145ms）`；重装即重启 →
`这次跑的是更新 1.0.1（安装包 1.0.0）`，mtcute 从安装包读、连上 Telegram、账号对上、2.4 秒到主页；再开还是 1.0.1（`Boot.ok()` 清掉了
booting）；装回 1.1.0 → `下载过的 1.0.1 不比安装包 1.1.0 新，删掉了`。

### 发一版

1. 改 `app/config.xml` 的版本号和 `app/js/boot.js` 的 `PACKAGED_FALLBACK`（要一致，update-verify 卡着），提交。改了 mtcute / hls.js 的话 `SHELL` 加一
   （`build/` 下的任何东西都算，包括 `bundle.sh` 的打包参数和 `compat.js`）。
2. `node tools/update-release.mjs`（取自 `git archive HEAD`，`app/`、`build/` 有未提交改动就拒绝），
   `git add update && git commit -m "更新包 x.y.z" && git tag vx.y.z && git push origin master vx.y.z`
   —— tag 要一起推：manifest 从 master 取，bundle 从 tag 取。
3. `zsh tools/release.sh` 出 wgt，`gh release create`，说明中英双份。
4. 装着 1.1.0 以后版本的电视会自己更新。
5. 不用管 Apps2Samsung 的社区目录（README 里推荐的装法）：它每天按 `releases/latest` 自己取新的 wgt
   （`Apps2Samsung/tizen-community-packages` 的 `packages/titlog__telegram-tizen.json`，按 `telegram-tizen-.*[.]wgt$` 挑资产），
   所以 wgt 要一直叫 `telegram-tizen-<版本>.wgt`。

## Tizen 6.0 上打不开（2026-10-23，别人电视的诊断日志）

两台 Tizen 6.0（Chromium 76）的电视装 1.1.2，每次启动都是「Uncaught SyntaxError: Unexpected token ( @tg.bundle.js:1」，接着
「TGLib is not defined」（其中一台一分钟里重开了十来次）。`config.xml` 从骨架起就是 `required_version="6.0"`，esbuild 却一直是 `--target=chrome120`。
- 1.1.2 的包里比 Chromium 76 新的写法：私有方法 `#m()` 11 处（84 起认；第一处是 @fuman/utils 的 `BufferPool` 的 `#realloc()`，报错的就是它
  后面那个 `(`）、`??` 458 处、`?.` 389 处（80 起）。`node --check` 看不出来，开发机的 node 什么都认。
- **语法**：`build/bundle.sh` 一处打包（deploy / release 共用），target chrome76，包大 1.5%（2.81 → 2.85MB）。`tools/syntax-verify.mjs` 用 acorn
  解析包里每个脚本和后台线程那份文本，对着「从哪个 Chromium 起认」的表查，比 required_version 那代新就拒绝 —— 对 1.1.2 的包报出上面三样，对新包通过。
- **API**（esbuild 降不了，`build/src/compat.js` 补；在打出来的包里一个个 grep 过）：`AbortSignal.prototype.throwIfAborted`（100 起）—— @fuman/net 连 WebSocket
  之前就调，没有它**连不上 Telegram、不报错、一直等**；`signal.reason`（98 起）—— 没有它被取消时抛出去的是 undefined；`AbortSignal.any`（116 起）——
  重试时合并信号。Tizen 6.5–7.0（Chromium 85–94）解析得了 1.1.2 的包，按这个推断卡在连 Telegram 那一步（没有那几代电视的日志）。
- **桌面 Chromium 76.0.3809 实测**（快照 665002，Rosetta）：1.1.2 的包报的就是电视上那句（`1:2406`）；新包解析得了、`TGLib` 在、二维码出得来，
  后台线程 1.5 秒连上 Telegram、回 `AUTH_KEY_UNREGISTERED`（还没登录，就是连上了）；同一份包去掉 throwIfAborted 那段补丁，`getMe` 20 秒没回。
  后台线程要从 localhost 起：桌面上从 `file://` 起的 blob worker 没有 `crypto.subtle`（电视上页面和线程都是安全上下文，没这个问题）。
  **Tizen 6.0 的电视上还没跑过** —— 那两台装上新版之后的诊断日志会说。
- **换了壳**：`tg.bundle.js` 不随更新下发，`SHELL` 1 → 2。打包参数原来不在 `vendorPrint()` 里（只改 `--target` 拦不住），现在 `bundle.sh`、`compat.js`
  都算进去。SHELL 1 的电视（装着 1.1.x 的）收不到 shell 2 的更新包，要重装一次 wgt；Tizen 6.0 上反正本来就打不开。
