# 三星电视上放 Telegram 里的视频

**中文 · [English](README.en.md)**

给三星 Tizen 电视做的 Telegram 视频播放器：扫码登录，左边是有视频的群和频道，右边是视频网格，遥控器选了就放。
边下边播，几个 GB 的长片也是几秒出画面、随便跳。电视直连 Telegram：**没有服务器，会话只存在电视本机。**

> **与 Telegram、三星均无关联。** 个人项目，MIT 协议。
> 兄弟项目：[bilibili-tizen](https://github.com/titlog/bilibili-tizen)、[douyin-tizen](https://github.com/titlog/douyin-tizen)。

![视频网格](docs/screenshots/01-home.jpg)

*一个来源里的视频，三列；看过的带进度条。*

| | |
|---|---|
| ![来源栏](docs/screenshots/02-sources.jpg) | ![播放](docs/screenshots/03-player.jpg) |
| 按左键滑出来源栏：有视频的群和频道 | 边下边播，从上次看到的地方接着放 |

> 截图里的群名、日期和文件大小是编的（`test/readme-shots.mjs` 换掉了 Telegram 层）。视频都是 Blender 的开源电影：
> [Sintel](https://durian.blender.org/)（播放的是它的预告片）、Big Buck Bunny、Elephants Dream、Tears of Steel、Spring、
> Sprite Fright、Charge、Coffee Run、Caminandes 3，© Blender Foundation / Blender Studio，CC BY（2.5–4.0），
> 封面是片中的画面。各片的作者、出处和协议版本见 `test/readme-shots.mjs`。

## 能做的

- **扫码登录**（[mtcute](https://github.com/mtcute/mtcute)，客户端跑在后台线程，界面不卡），会话活得过重新安装。
- **来源栏**只列有视频的群和频道；视频网格三列，记得每部看到哪里，开机直接进上次的来源。
- **自己写的 MP4 / MKV 解析 + MSE 边下边播**：2.6GB 的电影 5.8 秒出画面，跳到没缓冲的地方 0.6 秒；
  音视频在文件里隔得很远的片子分两路读。当文件发的视频（MKV、不压缩发的 MP4）也在网格里。
  MKV 支持 H.264 / HEVC / VP9 / AV1，AAC / AC-3 / E-AC-3 / Opus / FLAC（DTS、TrueHD 电视放不了）。
- **多音轨、字幕**：播放时长按确认键开菜单，换音轨（国语 / 粤语 / 原声）、开字幕、调字幕时间。
  字幕可以是片子里带的（MP4 的 mov_text，MKV 的 SRT / ASS / PGS 图形字幕），也可以是和片子发在同一个群里的
  `.srt` / `.ass` 文件（GBK、Big5 编码也认）。对白不是中文时自动开中文字幕。
- **连续剧自动放下一集**（认「第 3 集」「S01E03」「EP03」「[03]」），放完倒计时 8 秒。
- **搜索**：来源栏最上面，在所有群和频道里找视频（片名、说明文字、文件名）。
- **封面**：缩略图太黑就从片子中间解一帧，电影去维基百科找海报。
- **网页链接**：群里发的 `.m3u8` / `.mp4` 链接直接放。别的网站要一条站点规则 —— 仓库里**一条都不带**，
  自己写在 `app/js/sites.local.js` 里（不进仓库），格式见 [`app/js/web.js`](app/js/web.js) 开头。
- 切到别的应用再回来，自动重连。
- **中英双语界面**：跟电视的系统语言走（系统是中文就中文，别的都英文），来源栏最下面可以切换。

## 我的电视能装吗

| | |
|---|---|
| **实测可用** | 三星 2023 年款 65 吋 **CU7090**，固件 Tizen 9.0（Chromium 120） |
| **其他机型** | 没人试过。装成功或者失败，都欢迎开 issue 说一声机型和固件版本 |

## 安装（从源码）

三星商店不收第三方客户端，只能侧载。

1. 电视、开发者模式、三星证书、签名档都沿用 [bilibili-tizen](https://github.com/titlog/bilibili-tizen) 的配置：
   先按它 README 里「从源码装」那一节跑一次 `zsh tools/setup.sh`。
2. 到 [my.telegram.org](https://my.telegram.org) 申请一个应用，拿到 API ID 和 API Hash，写进 `~/.telegram-tizen.conf`：
   ```bash
   TG_API_ID=1234567
   TG_API_HASH=0123456789abcdef0123456789abcdef
   ```
   这两个值只在打包时写进你自己的安装包，打完就从源码里改回空值，不会进仓库。
3. 装好 Node，然后：
   ```bash
   git clone https://github.com/titlog/telegram-tizen.git && cd telegram-tizen
   zsh tools/deploy.sh          # 打包 mtcute、签名、安装、启动
   ```

更新：`git pull` 之后再跑一次 `deploy.sh`。

## 账号与隐私

- 扫码登录，会话存在电视的 IndexedDB 里，不经过任何别的服务器。
- API ID / Hash 是你自己申请的，只打进你自己的安装包。
- 部署脚本会把**你这台电脑的局域网地址**写进包里，作为诊断日志的去处；只有你在电脑上开着收集器时才有东西被收到。
- 网页登录（有的站的列表要登录）：密码不存、不写日志，只记下网站回的账号编号。

## 调试

```bash
node tools/collect.mjs       # 终端 1：在 8097 端口收电视上报的日志
zsh tools/deploy.sh          # 终端 2
```

桌面上的测试在 `test/`：`check.mjs` 对照 ffprobe 校验 MP4 解析，`check-mkv.mjs` 逐帧校验 MKV 解析，`check-subs.mjs` 校验字幕
（PGS 和 ffmpeg 的渲染逐像素比），`run.mjs` 测播放引擎，`ui-emu.mjs` 用假数据把界面走一遍并截图，`readme-shots.mjs` 重拍 README 里的截图，`i18n.mjs` 检查界面上每句话都有英文（`ui-emu.mjs`、`readme-shots.mjs` 加 `UILANG=en` 跑英文界面）。
它们要 Playwright 和 ffmpeg（MKV 那套还要 mkvtoolnix），测试片自己生成（见各文件开头）。全部测量、坑和调试方法在 [`CLAUDE.md`](CLAUDE.md)。

## 目录

```
app/          客户端（ES5，没有构建步骤；mtcute 打成 js/tg.bundle.js，deploy.sh 现打）
  js/app.js      界面和遥控器：登录、网格、播放器、菜单、下一集、搜索
  js/i18n.js     界面语言：中文 / 英文
  js/tg.js       Telegram 这一层：来源、视频（当视频发的和当文件发的）、搜索、字幕文件、给播放器的数据源
  js/player.js   MSE 播放引擎
  js/mp4.js      渐进式 MP4 → fMP4
  js/mkv.js      MKV / WebM → fMP4
  js/subs.js     字幕：文件、片子里的文字字幕、PGS、画到屏幕上
  js/cover.js    封面：解一帧、维基百科海报
  js/web.js      网页链接（框架，站点规则另写）
build/        mtcute 的打包入口（后台线程 + 主线程两份）
spike/        可行性探测和引擎测量脚本，不进包
test/         桌面测试
tools/        部署、日志收集
CLAUDE.md     全部发现、坑，以及怎么在零售机上调试
```

## 协议

MIT。`app/js/vendor/hls.min.js`（hls.js）是 Apache-2.0；打包时进来的 mtcute、qrcode-generator 是 MIT。
见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Telegram 是其所有者的商标，本项目与之无关联。

