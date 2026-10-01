# 三星电视（Tizen）上放 Telegram 里的视频

兄弟项目 `../bilibili-tizen`、`../douyin-tizen` 的平台结论（设备、证书、部署、日志通道、MSE、CSP 的坑）
这里全部适用，**先读那两份 CLAUDE.md**。这份只记 Telegram 自己的事。

出发点（2026-10-01）：Telegram 的群和频道里有不少视频，手机上能直接放，电视上没有能用的客户端。

```
app/js/app.js     界面和遥控器：登录（扫码）、主页（左边来源、右边视频网格）、播放器浮层
app/js/tg.js      Telegram 这一层：来源（收藏夹 + 群/频道）、来源里的视频、封面、给播放器的数据源（文件引用过期自动刷新）
app/js/player.js  播放引擎：MediaSource + 音视频两个 SourceBuffer，按样本在文件里的位置顺序读、拼 ~1 秒一段
app/js/mp4.js     自己写的渐进式 MP4 → fMP4：样本表 TypedArray、二分找关键帧、拼 moof+mdat（替掉了 mp4box）
app/js/store.js   本地：看到哪里（localStorage）、上次的来源、moov 缓存（IndexedDB，留 12 个）
build/src/        mtcute 打包：worker.js（后台线程里的客户端）先打成文本，嵌进 entry.js（主线程的端口 + 二维码）
tools/deploy.sh   打包、写入上报地址和凭证、签名、安装、启动；打完包把凭证改回空值
tools/collect.mjs 日志收集，:8097（抖音 :8098、bilibili :8099）
test/check.mjs    mp4.js 离线校验（对照 ffprobe，拼出来的 fMP4 交给 ffmpeg 解码）
test/run.mjs      播放引擎桌面测试（Playwright + test/serve.mjs 限速模拟电视）
test/ui-emu.mjs   桌面看界面：换掉 tg.js 用假数据，按键、截图到 logs/ui-*.png
spike/            探测版（mp4box）和引擎测量脚本，不进包
```

凭证：`~/.telegram-tizen.conf`（`TG_API_ID` / `TG_API_HASH`，在 my.telegram.org 申请），不进仓库。
电视、证书、签名档沿用 `~/.bilibili-tizen.conf`。

```bash
node tools/collect.mjs | tee -a logs/app.log     # 终端 1
zsh tools/deploy.sh                              # 终端 2
node test/check.mjs test/media/*.mp4             # 改 mp4.js 之后（测试片用 ffmpeg 生成，见 test/check.mjs 头）
node test/serve.mjs & node test/run.mjs media/a_h264_fast.mp4 "media/b_h264_moovend.mp4?start=30"   # 改 player.js 之后
node test/serve.mjs & node test/ui-emu.mjs       # 改界面之后，看 logs/ui-*.png
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
- 快进快退按住越来越快：←→ 10 秒起、↑↓ 1 分钟起，同一个键两次之间 < 0.4 秒算按住；停手 0.7 秒才真的跳。
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
