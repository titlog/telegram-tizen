# Telegram videos on a Samsung TV

**[中文](README.md) · English**

A player for the videos in your Telegram groups and channels, on Samsung Tizen TVs. Sign in by scanning a QR
code with your phone; the groups and channels that contain videos are on the left, a grid of their videos on the
right, and the remote plays them. It streams while it downloads, so a multi-gigabyte film starts in seconds and
you can seek anywhere. The TV talks to Telegram directly: **there is no server, and your session never leaves
the set.**

The everyday use it was built for: find a film on your phone, forward it to a group of your own, and play it on
the TV. Everything Telegram can play on a phone — MP4s sent as videos, MKVs and MP4s sent as files, links to
`.m3u8` streams — plays here.

> **The interface is in English or Chinese.** It follows the TV's system language — Chinese if the TV is set to
> Chinese, English otherwise — and the last entry of the source list switches it.

> **Not affiliated with Telegram or Samsung.** A personal project, MIT licence.
> Sister projects: [bilibili-tizen](https://github.com/titlog/bilibili-tizen),
> [douyin-tizen](https://github.com/titlog/douyin-tizen).

![The video grid](docs/screenshots/en-01-home.jpg)

*The videos of one group, three to a row; ones you have started show a progress bar.*

| | |
|---|---|
| ![Source list](docs/screenshots/en-02-sources.jpg) | ![Player](docs/screenshots/en-03-player.jpg) |
| Press Left to slide out the source list: the groups and channels that have videos | Streams while downloading, and resumes where you stopped |

> The group names, dates and file sizes in the screenshots are made up (`test/readme-shots.mjs` replaces the
> Telegram layer). The videos are Blender open movies — [Sintel](https://durian.blender.org/) (its trailer is the one
> playing), Big Buck Bunny, Elephants Dream, Tears of Steel, Spring, Sprite Fright, Charge, Coffee Run and
> Caminandes 3 — © Blender Foundation / Blender Studio, CC BY 2.5–4.0, with frames from the films as covers.
> Per-film credits and licence versions are in `test/readme-shots.mjs`.

## What it does

- **QR sign-in** with [mtcute](https://github.com/mtcute/mtcute), which runs in a worker so the interface never
  stutters while data arrives. The session survives reinstalling the app. Two-step verification passwords are
  supported.
- **Source list** of only the chats that actually contain videos. It opens straight into the chat you used last and
  remembers how far you got in every video.
- **Hand-written MP4 and MKV parsers feeding Media Source Extensions.** Measured on the TV: a 2.6 GB, 3 h 39 min
  film shows its first frame in 5.8 s, and a jump to a part that is not downloaded yet plays in 0.6 s. Files whose
  audio and video are stored far apart (some 4K releases) are read along two paths so resuming does not have to
  download hundreds of megabytes first.
- **Videos sent as files show up too** — most MKVs are posted that way, and Telegram's own "videos" filter does not
  list them. MKV/WebM support: H.264, HEVC, VP9 and AV1 video; AAC, AC-3, E-AC-3, Opus and FLAC
  audio. These TVs cannot decode DTS or TrueHD; when a file has another audio track the player switches to it,
  otherwise it plays without sound and says so.
- **Audio tracks and subtitles.** Hold OK while a video plays to open a menu: switch audio tracks (dubs, original,
  commentary), turn subtitles on, or shift their timing in 0.5 s steps. Subtitles can come from inside the file
  (mov_text in MP4; SRT, ASS and PGS image subtitles in MKV) or from an `.srt` / `.ass` / `.vtt` file posted in
  the same group — it matches the file to the video by name and posting time, and detects UTF-8, UTF-16, GBK and
  Big5. Your choice is remembered per video.
- **Series play the next episode** when one ends, with an 8-second countdown. Episode numbers are read from the
  title or file name: `S01E03`, `EP03`, `E03`, `[03]`, `Show - 03`, and Chinese `第3集`.
- **Search** every group and channel you are in, from the top of the source list — titles, captions and file
  names. Recent searches are kept, since typing with a remote is slow.
- **Covers**: when the thumbnail is a black first frame (common with large files), a frame from the middle of the
  film is decoded instead; films get a poster from Wikipedia.
- **Web links**: `.m3u8` and `.mp4` links posted in a group play directly. Other sites need a site rule, which you
  write yourself in `app/js/sites.local.js` (it is not in the repository); the format is at the top of
  [`app/js/web.js`](app/js/web.js). The repository ships no site rules.
- Switch to another app and back, and it reconnects on its own.

Subtitles turn on by themselves only when the dialogue is not in the interface language **and** a subtitle track or
file in that language exists — with the English interface, an English subtitle for a film in another language;
otherwise they start off and the menu has them. Captions written the way Chinese channels do, `《Title》`, use the
part inside the brackets as the title.

## The remote

| Where | Button | Does |
|---|---|---|
| Grid | arrows, OK | move, play |
| Grid | Left on the first column | open the source list (Search is its first entry; Sign out and the language switch are at the bottom) |
| Grid | Back, twice | quit |
| Player | OK, or Play/Pause | pause / resume |
| Player | **hold OK** (about 1 s) | menu: audio track, subtitles, subtitle timing, next episode |
| Player | Left / Right | −/+ 15 s; keep holding and the steps grow to 30 s, 1 min, 2 min, 5 min |
| Player | Up / Down, or Fast-forward / Rewind | +/− 1 min; holding grows to 2, 5, 10, 15 min |
| Player | Back | back to the grid (your position is saved) |

Seeks are applied 0.7 s after you stop pressing, so you can press several times and only download once.

## Will it run on my TV

| | |
|---|---|
| **Tested** | Samsung 2023 65" **CU7090**, firmware Tizen 9.0 (Chromium 120) |
| **Other models** | Untested. Whether it works or not, please open an issue with your model and firmware version |

Download speed is Telegram's, not your connection's: without Premium the TV measured a steady 1.7–2.3 MB/s, about
ten times the bitrate of the 1080p film it was measured with. High-bitrate 4K remuxes can be faster than that and will pause to
buffer. The TV connects to Telegram over WebSocket (`*.web.telegram.org`); there is no proxy setting.

## Install (from source)

Samsung's store does not accept third-party clients, so this is sideloaded. There is no prebuilt package: the
Telegram API ID it signs in with is baked into the package at build time, and it has to be your own.

You need **macOS**, Node, and the [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
command-line tools (not the IDE).

1. **TV, developer mode and the Samsung certificate.** These are shared with
   [bilibili-tizen](https://github.com/titlog/bilibili-tizen) — the same TV and certificate work for both. Follow its
   [From source](https://github.com/titlog/bilibili-tizen/blob/master/README.en.md#from-source) section once: enable
   Developer Mode on the TV (on the Apps screen type `12345`, switch it on, set Host PC IP to your computer, then
   power-cycle the set), and run its `zsh tools/setup.sh`, which finds the TV, reads its DUID and obtains the
   Samsung-issued certificate (2023+ sets reject the certificates that come with Tizen Studio). The settings end up
   in `~/.bilibili-tizen.conf`, which this project reads.
2. **Your Telegram API ID.** Create an application at [my.telegram.org](https://my.telegram.org) → API development
   tools, and put the two values in `~/.telegram-tizen.conf`:
   ```bash
   TG_API_ID=1234567
   TG_API_HASH=0123456789abcdef0123456789abcdef
   ```
   They are written into your package only while it is being built and put back to empty values in the source
   straight after, so they never end up in the repository.
3. **Build and install:**
   ```bash
   git clone https://github.com/titlog/telegram-tizen.git && cd telegram-tizen
   zsh tools/deploy.sh          # bundles mtcute, signs, installs and launches
   ```
4. On the TV, open Telegram on your phone → **Settings → Devices → Link Desktop Device**, and scan the code.

To update: `git pull`, then run `deploy.sh` again. Your session and watch history are kept.

## Accounts and privacy

- You sign in by QR code; the session is stored in the TV's IndexedDB and goes through no other server.
- The API ID and hash are your own and only go into your own package.
- The deploy script writes **your computer's LAN address** into the package as the destination for diagnostic
  logs; nothing is received unless you are running the collector on that computer.
- Web sign-in (some site lists need it): the password is not stored or logged; only the account number the site
  returns is kept.

## Debugging and tests

```bash
node tools/collect.mjs       # terminal 1: receives the TV's logs on port 8097
zsh tools/deploy.sh          # terminal 2
```

Web Inspector does not open on retail sets, so the app reports what it does to the collector — start-up times,
codecs, track lists, every seek and stall.

Desktop tests live in `test/` and need Playwright and ffmpeg; the test files are generated with ffmpeg (and
mkvtoolnix for the MKV set), with the commands at the top of each script:

| | |
|---|---|
| `check.mjs` | MP4 parser against ffprobe; the rebuilt fragments decoded by ffmpeg |
| `check-mkv.mjs` | MKV parser frame by frame against ffprobe, including lacing, header stripping, missing Cues |
| `check-subs.mjs` | subtitle encodings and formats; PGS rendering compared pixel by pixel with ffmpeg |
| `i18n.mjs` | every interface string has an English translation |
| `run.mjs` | the playback engine in Chromium over a throttled server that imitates Telegram |
| `ui-emu.mjs` | the whole interface with fake data, driven by key presses, with screenshots (`UILANG=en` for English) |
| `readme-shots.mjs` | retakes the screenshots above (`UILANG=en` for these, without it the Chinese set) |

Every measurement, pitfall and design decision is in [`CLAUDE.md`](CLAUDE.md) (Chinese).

## Layout

```
app/              the client (no build step; mtcute is bundled into js/tg.bundle.js by deploy.sh)
  js/app.js         screens and remote keys: sign-in, grid, player, menu, next episode, search
  js/i18n.js        interface language: English / Chinese
  js/tg.js          the Telegram layer: chats, videos (sent as videos and as files), search, subtitle files
  js/player.js      MSE playback engine
  js/mp4.js         progressive MP4 → fragmented MP4
  js/mkv.js         MKV / WebM demuxer → fragmented MP4
  js/subs.js        subtitles: files, embedded text, PGS, rendering
  js/cover.js       covers: a decoded frame, Wikipedia posters
  js/web.js         web links (the framework; site rules are written separately)
build/            mtcute's bundle entry points (worker and main thread)
spike/            feasibility probes and engine measurements, not packaged
test/             desktop tests
tools/            deploy and log collector
CLAUDE.md         findings, pitfalls, and how to debug on a retail set
```

## Licence

MIT. `app/js/vendor/hls.min.js` (hls.js) is Apache-2.0; mtcute and qrcode-generator, bundled at build time, are
MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Telegram is a trademark of its owner; this project is not
affiliated with it.
