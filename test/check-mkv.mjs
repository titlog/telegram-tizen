/* mkv.js 离线校验：头部和 Cues 对照 ffprobe；整部片按 512KB 一块喂进 Win（照抄 player.js）拆块，帧数、关键帧、pts、每帧大小
 * 对照 ffprobe 的 packet；拼成 fMP4 交给 ffmpeg 解码；在中间几个 cue 上跳转（HEVC open GOP 的前导帧要丢掉）；没有 Cues 时按码率
 * 估偏移再找 Cluster；大小未知的 Cluster（把文件里的大小改成「未知」）；封面用的关键帧。
 *   node test/check-mkv.mjs test/media/mkv/*.mkv test/media/mkv/*.webm
 *
 * 测试片（cd test/media/mkv && M=..；subs.srt 是手写的 4 句，subs.ass 是 ffmpeg -i subs.srt subs.ass 转的）：
 *   ffmpeg -i $M/a_h264_fast.mp4 -c copy m_h264_aac.mkv                                   H.264 + AAC，ffmpeg 做的（Cues 在尾部）
 *   ffmpeg -i $M/c_hevc.mp4 -c copy m_hevc.mkv                                            HEVC open GOP（x265 默认）
 *   ffmpeg -i $M/d_ac3.mp4 -i subs.srt -i subs.ass -map 0:v -map 0:a -map 0:a -map 1 -map 2 -c:v copy -c:a:0 aac -b:a:0 128k \
 *     -c:a:1 copy -c:s:0 srt -c:s:1 ass -metadata:s:a:0 language=chi -metadata:s:a:0 title=国语 -metadata:s:a:1 language=eng \
 *     -metadata:s:a:1 title=English -metadata:s:s:0 language=chi -metadata:s:s:1 language=eng -disposition:a:0 default -disposition:a:1 0 m_multi.mkv
 *   ffmpeg -t 20 -i $M/a_h264_fast.mp4 -c:v libvpx-vp9 -b:v 800k -deadline realtime -cpu-used 8 -g 48 -c:a libopus -b:a 96k m_vp9_opus.webm
 *   ffmpeg -i $M/a_h264_fast.mp4 -c:v copy -c:a flac m_flac.mkv
 *   ffmpeg -i $M/a_h264_fast.mp4 -c:v copy -c:a libmp3lame -b:a 128k m_mp3.mkv
 *   ffmpeg -i $M/a_h264_fast.mp4 -c:v copy -c:a eac3 -b:a 192k m_eac3.mkv
 *   ffmpeg -i $M/e_long_2h.mp4 -c copy m_long.mkv                                          2 小时，量读头部和 Cues
 *   mkvmerge（brew install mkvtoolnix，v102）做的 —— 真实世界的 MKV 大多是它做的：
 *   mkvmerge -o k_mkvmerge.mkv $M/a_h264_fast.mp4                                          CueRelativePosition
 *   mkvmerge -o k_ac3_lace.mkv $M/d_ac3.mp4                                                AC-3 默认 lacing（8 帧一块）
 *   mkvmerge -o k_hevc.mkv $M/c_hevc.mp4
 *   mkvmerge -o k_multi.mkv --language 1:zh --track-name 1:国语 --default-track-flag 1:yes m_multi.mkv
 *   mkvmerge -o k_zlibsub.mkv --compression 3:zlib --compression 4:zlib m_multi.mkv          字幕 zlib 压缩
 *   ffmpeg -i m_h264_aac.mkv -i ../subs/pgs.sup -map 0 -map 1 -c copy -metadata:s:s:0 language=chi \
 *     -metadata:s:s:0 title=简体（图形） m_pgs.mkv                                             PGS 字幕（pgs.sup 是 test/check-subs.mjs 生成的）
 *   header stripping：mkvmerge v102 已经不真做了（analyze_header_removal 只写一个空的 ContentEncoding，ffmpeg 读它反而读坏），
 *   测试末尾自己合成一个（k_ac3_lace.mkv 的 AC-3 每帧去掉 0B 77、ContentCompAlgo 3），见 synthStripped。
 *   mkvmerge -o k_blockgroup.mkv --disable-lacing $M/a_h264_fast.mp4
 */
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = { TextDecoder };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/mp4.js', 'utf8') + '\nthis.Mp4 = Mp4;', ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/mkv.js', 'utf8') + '\nthis.Mkv = Mkv;', ctx);
const { Mp4, Mkv } = ctx;
const CH = 512 * 1024;
const TMP = process.env.TMPDIR || '/tmp/';

/* 照抄 player.js 的 Win */
function Win() { this.chunks = []; this.startOff = 0; this.endOff = 0; this.total = 0; }
Win.prototype.reset = function (at) { this.chunks = []; this.startOff = this.endOff = at; this.total = 0; };
Win.prototype.add = function (bytes) { this.chunks.push({ s: this.endOff, b: bytes }); this.endOff += bytes.length; this.total += bytes.length; };
Win.prototype.has = function (off, size) { return off >= this.startOff && off + size <= this.endOff; };
Win.prototype.copy = function (dst, o, off, size) {
  const cs = this.chunks;
  for (let i = 0; i < cs.length && size > 0; i++) {
    const c = cs[i], ce = c.s + c.b.length;
    if (ce <= off) continue;
    const from = off - c.s, n = Math.min(size, ce - off);
    dst.set(c.b.subarray(from, from + n), o);
    o += n; off += n; size -= n;
  }
};
Win.prototype.read = function (off, size) { const d = new Uint8Array(size); this.copy(d, 0, off, size); return d; };
Win.prototype.release = function (upTo) {
  const cs = this.chunks;
  while (cs.length && cs[0].s + cs[0].b.length <= upTo) { this.total -= cs[0].b.length; this.startOff = cs[0].s + cs[0].b.length; cs.shift(); }
};

function probe(args) { return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }); }
function packets(file, idx) {
  const t = probe(['-select_streams', String(idx), '-show_entries', 'packet=pts_time,flags,size', '-of', 'csv=p=0', file]).trim();
  return t ? t.split('\n').map(l => { const [pts, size, flags] = l.split(','); return { pts: +pts, size: +size, key: flags.includes('K') }; }) : [];
}
function streams(file) {
  return JSON.parse(probe(['-show_entries', 'stream=index,codec_type,codec_name,channels,sample_rate,width,height:format=duration', '-of', 'json', file]));
}
function decodeErrors(file) {
  try {
    const err = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return err.trim();
  } catch (e) { return String(e.stderr || e).trim() || 'ffmpeg 失败'; }
}
function writeParts(path, parts) { fs.writeFileSync(path, Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.length)))); }

let bad = 0;
const fail = (m) => { bad++; console.log('    ✗ ' + m); };

/* 按 ~1 秒一段拼 fMP4 */
function fmp4(track, timescale, frames, stsd, id) {
  const parts = [Mp4.initSegment({ kind: track.kind, timescale, stsd, width: track.width, height: track.height }, id)];
  let a = 0, seq = 1;
  while (a < frames.length) {
    let e = a + 1;
    while (e < frames.length && frames[e].dts - frames[a].dts < timescale) e++;
    parts.push(Mp4.fragmentFrames(id, frames.slice(a, e), seq++));
    a = e;
  }
  return parts;
}

/* 整段喂：从 offset（512KB 对齐往前取）开始，每次加一块、feed 一次，读到 untilSec（视频 pts）或者文件尾 */
function demuxRange(b, info, want, offset, startSec, resync, untilSec) {
  const d = Mkv.demuxer(info, want);
  d.reset(offset, startSec, resync);
  const win = new Win(), start = Math.floor(offset / CH) * CH;
  win.reset(start);
  const all = { video: [], audio: [], subs: [], audioStsd: null, feeds: 0, maxFeedMs: 0 };
  const take = (o) => {
    all.video.push(...o.video); all.audio.push(...o.audio); all.subs.push(...o.subs);
    if (o.audioStsd) all.audioStsd = o.audioStsd;
  };
  let pos = start, eof = false;
  while (true) {
    if (pos >= b.length) { eof = true; break; }
    win.add(b.subarray(pos, Math.min(b.length, pos + CH)));
    pos += CH;
    const t0 = performance.now();
    take(d.feed(win));
    all.maxFeedMs = Math.max(all.maxFeedMs, performance.now() - t0);
    all.feeds++;
    win.release(d.pos);
    if (d.done) { eof = true; break; }
    if (untilSec !== undefined && all.video.length && (all.video[all.video.length - 1].dts + all.video[all.video.length - 1].cto) / info.timescale > untilSec) break;
  }
  if (eof) take(d.flush());
  all.d = d;
  return all;
}

function checkMonotonic(name, frames) {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.dts < 0) { fail(`${name} dts 为负 @${i}`); return; }
    if (!(f.dur > 0)) { fail(`${name} dur=${f.dur} @${i}`); return; }
    if (i && f.dts <= frames[i - 1].dts) { fail(`${name} dts 不递增 @${i}`); return; }
    if (i && frames[i - 1].dts + frames[i - 1].dur !== f.dts) { fail(`${name} dts 不连续 @${i}`); return; }
  }
}

/* 文件里的 Cluster 和 Segment 的大小都改成「未知」（同样长度的全 1），模拟直播录的 */
function unknownSizes(b) {
  const c = new Uint8Array(b);
  const vlen = (x) => { for (let n = 1; n <= 8; n++) if (x & (0x100 >> n)) return n; return 0; };
  const hdr = (o) => { const il = vlen(c[o]); let id = 0; for (let i = 0; i < il; i++) id = id * 256 + c[o + i]; const sl = vlen(c[o + il]);
    let v = c[o + il] & (0xFF >> sl); for (let i = 1; i < sl; i++) v = v * 256 + c[o + il + i]; return { id, il, sl, size: v, hdr: il + sl }; };
  const mark = (o, il, sl) => { c[o + il] |= (0xFF >> sl); for (let i = 1; i < sl; i++) c[o + il + i] = 0xFF; };
  let o = hdr(0).hdr + hdr(0).size;
  const seg = hdr(o);
  mark(o, seg.il, seg.sl);
  let p = o + seg.hdr, n = 0;
  while (p + 12 < c.length) {
    const h = hdr(p);
    if (h.id === 0x1F43B675) { mark(p, h.il, h.sl); n++; }
    p += h.hdr + h.size;
  }
  return { bytes: c, clusters: n };
}

for (const file of process.argv.slice(2)) {
  console.log(file);
  const b = new Uint8Array(fs.readFileSync(file));
  if (!Mkv.sniff(b)) { fail('sniff 说不是 MKV'); continue; }
  let reads = 0, readBytes = 0;
  const read = async (off, len) => { reads++; readBytes += len; return b.slice(off, Math.min(b.length, off + len)); };
  let t0 = performance.now();
  const info = await Mkv.readHead(read, b.length);
  const headMs = performance.now() - t0;
  try { structuredClone(info); } catch (e) { fail('info 不能结构化克隆：' + e.message); }
  const st = streams(file);
  const fdur = +st.format.duration;
  console.log(`  readHead ${headMs.toFixed(1)}ms，read ${reads} 次 ${(readBytes / 1048576).toFixed(1)}MB；时长 ${info.duration.toFixed(2)}s（ffprobe ${fdur.toFixed(2)}），` +
    `timescale ${info.timescale}，第一个 Cluster @${info.firstCluster}，cues ${info.cues ? info.cues.t.length : '无'}` +
    (info.cues ? `（rel ${info.cues.rel[0] >= 0 ? '有' : '无'}）` : ''));
  if (Math.abs(info.duration - fdur) > 0.1) fail('时长对不上');
  const ss = st.streams.filter(s => s.codec_type !== 'attachment');
  if (ss.length !== info.tracks.length) fail(`轨数 ${info.tracks.length} ≠ ffprobe ${ss.length}`);
  info.tracks.forEach((t, i) => {
    const s = ss[i] || {};
    const kind = { video: 'video', audio: 'audio', sub: 'subtitle' }[t.kind];
    console.log(`  #${t.num} ${t.kind} ${t.codecId} → ${t.codec || '-'}${t.unsupported ? '（' + t.unsupported + '）' : ''} lang=${t.lang} name=${t.name || '-'} ` +
      `default=${t.isDefault ? 1 : 0}` + (t.kind === 'video' ? ` ${t.width}x${t.height}` : t.kind === 'audio' ? ` ${t.channels}ch ${t.rate}Hz` : '') +
      (t.stsd ? ` stsd ${t.stsd.length}B` : t.needFirstFrame ? ' stsd 等第一帧' : '') + (t.comp ? ` comp=${t.comp.algo}` : ''));
    if (s.codec_type !== kind) fail(`第 ${i} 条轨类型 ${t.kind} ≠ ffprobe ${s.codec_type}`);
    if (t.kind === 'audio' && s.channels && !t.unsupported && t.stsd) {
      /* stsd 里的声道数（AC-3 的从帧头来） */
      const ch = (t.stsd[16 + 8 + 16] << 8) | t.stsd[16 + 8 + 17];
      if (ch !== s.channels && t.codec !== 'opus') console.log(`    （stsd 声道 ${ch}，ffprobe ${s.channels}）`);
    }
  });
  if (/long/.test(file) && info.cues) {
    /* 只量 Cues：重新读一遍头部，读之前的部分已经量过 */
    console.log(`  （长片：cues ${info.cues.t.length} 个，首 ${info.cues.t[0]}s 末 ${info.cues.t[info.cues.t.length - 1].toFixed(1)}s）`);
  }

  const video = info.tracks.find(t => t.kind === 'video' && !t.unsupported);
  const audios = info.tracks.filter(t => t.kind === 'audio' && !t.unsupported);
  const subs = info.tracks.filter(t => t.kind === 'sub' && !t.unsupported).map(t => t.num);
  const idxOf = (t) => ss.indexOf(ss[info.tracks.indexOf(t)]);
  const runs = audios.length ? audios : [null];

  for (const at of runs) {
    const want = { video: video ? video.num : 0, audio: at ? at.num : 0, subs };
    t0 = performance.now();
    const r = demuxRange(b, info, want, info.firstCluster, 0, false);
    const ms = performance.now() - t0;
    console.log(`  拆块（视频 #${want.video} 音频 #${want.audio}）${ms.toFixed(0)}ms，feed ${r.feeds} 次、最长 ${r.maxFeedMs.toFixed(1)}ms；` +
      `视频 ${r.video.length} 帧 音频 ${r.audio.length} 帧 字幕 ${r.subs.length} 条，lacing 块 无/Xiph/固定/EBML = ${r.d.lacing.join('/')}` +
      (r.d.openGop ? '，open GOP' : '') + (r.audioStsd ? '，音频 stsd 来自第一帧' : ''));
    if (video) {
      const ref = packets(file, idxOf(video));
      if (ref.length !== r.video.length) fail(`视频帧数 ${r.video.length} ≠ ffprobe ${ref.length}`);
      const keys = r.video.filter(f => f.key).length, rk = ref.filter(p => p.key).length;
      if (keys !== rk) fail(`关键帧 ${keys} ≠ ffprobe ${rk}`);
      const mine = r.video.map(f => (f.dts + f.cto) / info.timescale).sort((x, y) => x - y), theirs = ref.map(p => p.pts).sort((x, y) => x - y);
      let maxd = 0;
      for (let i = 0; i < Math.min(mine.length, theirs.length); i++) maxd = Math.max(maxd, Math.abs(mine[i] - theirs[i]));
      if (maxd > 0.0006) fail(`视频 pts 最大偏差 ${(maxd * 1000).toFixed(2)}ms`);
      let sizeBad = 0;
      for (let i = 0; i < Math.min(ref.length, r.video.length); i++) if (ref[i].size !== r.video[i].data.length) sizeBad++;
      if (sizeBad) fail(`视频 ${sizeBad} 帧大小对不上`);
      checkMonotonic('视频', r.video);
      const ctoMin = r.video.reduce((m, f) => Math.min(m, f.cto), 0), ctoMax = r.video.reduce((m, f) => Math.max(m, f.cto), 0);
      console.log(`    视频 pts 偏差 ${(maxd * 1000).toFixed(2)}ms，cto ${ctoMin}…${ctoMax} tick，首帧 dts ${r.video[0] && r.video[0].dts}`);
    }
    if (at) {
      const ref = packets(file, idxOf(at));
      if (ref.length !== r.audio.length) fail(`音频帧数 ${r.audio.length} ≠ ffprobe ${ref.length}`);
      /* ffprobe 把 CodecDelay（ffmpeg 给 AAC 写的编码器预滚 21ms、Opus 的 6.5ms）从时间戳里减掉了；我们用块上的时间（和 MP4 那条路
       * 不管音频 edit list 一样）—— 只比相对时间 */
      const shift = ref.length && r.audio.length ? r.audio[0].dts / info.timescale - ref[0].pts : 0;
      let maxd = 0, sizeBad = 0;
      for (let i = 0; i < Math.min(ref.length, r.audio.length); i++) {
        maxd = Math.max(maxd, Math.abs(r.audio[i].dts / info.timescale - shift - ref[i].pts));
        if (ref[i].size !== r.audio[i].data.length) sizeBad++;
      }
      /* lacing 的块里后面几帧的时间：我们按块时间 + round(i × DefaultDuration)；ffmpeg 把 DefaultDuration 截成整毫秒（AAC 21.333 → 21）
       * 再累加，8 帧一块的最后一帧比我们早 2ms（k_mkvmerge.mkv 实测）。我们的才是准的 */
      if (maxd > 2.5 / info.timescale) fail(`音频 pts 最大偏差 ${(maxd * 1000).toFixed(2)}ms`);
      if (sizeBad) fail(`音频 ${sizeBad} 帧大小对不上`);
      checkMonotonic('音频', r.audio);
      console.log(`    音频 pts 偏差 ${(maxd * 1000).toFixed(2)}ms（ffprobe 整体差 ${(shift * 1000).toFixed(1)}ms，CodecDelay ${(at.codecDelay * 1000).toFixed(1)}ms）`);
    }
    if (subs.length && at === runs[0]) {
      for (const n of subs) {
        const t = info.tracks.find(x => x.num === n);
        const mine = r.subs.filter(s => s.num === n);
        const ref = packets(file, idxOf(t));
        if (ref.length !== mine.length) fail(`字幕 #${n} ${mine.length} 条 ≠ ffprobe ${ref.length}`);
        const s0 = mine[0];
        let text = s0 ? (s0.zlib ? zlib.inflateSync(Buffer.from(s0.data)).toString() : Buffer.from(s0.data).toString()) : '';
        console.log(`    字幕 #${n} ${t.codecId} ${mine.length} 条，第一条 ${s0 && s0.pts}s 长 ${s0 && s0.dur}s zlib=${s0 && s0.zlib}：${JSON.stringify(text.slice(0, 50))}`);
        /* PGS（m_pgs.mkv）：块是段，第一个段是 PCS（0x16）；内容对不对由 test/check-subs.mjs 和 ffmpeg 的渲染比 */
        if (/PGS/.test(t.codecId)) { if (!s0 || s0.data[0] !== 0x16) fail('PGS 第一块不是 PCS 段'); }
        else if (!/第一句/.test(text)) fail('字幕内容不对');
      }
    }

    /* 拼 fMP4 解码 */
    const parts = [];
    if (video) parts.push(['video', video, r.video, video.stsd, 1]);
    if (at) parts.push(['audio', at, r.audio, r.audioStsd || at.stsd, 2]);
    for (const [kind, t, frames, stsd, id] of parts) {
      if (!stsd) { fail(`${kind} 没有 stsd`); continue; }
      const out = `${TMP}tgmkv_${kind}.mp4`;
      writeParts(out, fmp4(t, info.timescale, frames, stsd, id));
      const err = decodeErrors(out);
      if (err) fail(`${kind} fMP4 解码报错：${err.slice(0, 200)}`);
      const got = packets(out, 0);
      if (got.length !== frames.length) fail(`${kind} fMP4 读出 ${got.length} 包 ≠ ${frames.length}`);
      const a = got.map(p => p.pts).sort((x, y) => x - y), m = frames.map(f => (f.dts + f.cto) / info.timescale).sort((x, y) => x - y);
      const off = a[0] - m[0];
      let maxd = 0;
      for (let i = 0; i < Math.min(a.length, m.length); i++) maxd = Math.max(maxd, Math.abs(m[i] + off - a[i]));
      if (maxd > 0.0011) fail(`${kind} fMP4 相对 pts 偏差 ${(maxd * 1000).toFixed(2)}ms`);
      console.log(`    fMP4 ${kind} ${t.codec}：解码${err ? '有错' : '无错'}，相对 pts 偏差 ${(maxd * 1000).toFixed(2)}ms`);
    }
    if (!video) continue;

    /* 跳转：中间几个 cue */
    if (info.cues && at === runs[0]) {
      const n = info.cues.t.length, lines = [];
      let lead = 0;
      for (const frac of [0.25, 0.5, 0.75]) {
        const cu = Mkv.cueAt(info, info.duration * frac);
        if (!cu || cu.i === 0) continue;
        const s = demuxRange(b, info, want, cu.pos, cu.t, false, cu.t + 6);
        const v0 = s.video[0];
        const p0 = v0 ? (v0.dts + v0.cto) / info.timescale : -1;
        lead += s.d.leadDropped;
        lines.push(`${cu.t.toFixed(2)}s→首帧 ${p0.toFixed(3)}（丢前导 ${s.d.leadDropped}）`);
        if (!v0 || !v0.key) fail(`跳到 ${cu.t} 首帧不是关键帧`);
        if (Math.abs(p0 - cu.t) > 1 / info.timescale + 1e-9) fail(`跳到 ${cu.t} 首帧 pts ${p0}`);
        if (s.video.some(f => (f.dts + f.cto) / info.timescale < cu.t - 1e-9)) fail(`跳到 ${cu.t} 后面有显示在关键帧之前的帧`);
        if (s.audio.length && s.audio[0].dts / info.timescale < cu.t - 0.1 - 0.05) fail(`跳到 ${cu.t} 音频从 ${s.audio[0].dts / info.timescale} 开始`);
        checkMonotonic('跳转后视频', s.video);
        const out = `${TMP}tgmkv_seek.mp4`;
        writeParts(out, fmp4(video, info.timescale, s.video, video.stsd, 1));
        const err = decodeErrors(out);
        if (err) fail(`跳到 ${cu.t} 解码报错：${err.slice(0, 200)}`);
      }
      console.log(`    跳转（cue ${n} 个）：${lines.join('，')}`);
      if (r.d.openGop && !lead) fail('open GOP 但跳转后一个前导帧都没丢');
      /* 快进快退的 cue */
      const fw = Mkv.cueNear(info, 10, 1, 10), bw = Mkv.cueNear(info, 10, -1, 10);
      if (fw && bw && info.duration > 20 && (!(fw.t > 10.5) || !(bw.t < 9.5))) fail(`cueNear 没动：${fw.t} ${bw.t}`);
    }

    /* 没有 Cues：按码率估偏移、往后找 Cluster */
    if (at === runs[0]) {
      const half = info.duration / 2, off = Mkv.guessOffset(info, half, b.length);
      const s = demuxRange(b, info, want, off, half, true, half + 6);
      const v0 = s.video[0], p0 = v0 ? (v0.dts + v0.cto) / info.timescale : -1;
      console.log(`    resync：估 ${(off / 1048576).toFixed(1)}MB → 首帧 ${p0.toFixed(2)}s 关键帧=${v0 && v0.key}（找了 ${s.d.resyncs} 次）`);
      if (!v0 || !v0.key || s.d.resyncs < 1) fail('resync 没找到关键帧');
      const out = `${TMP}tgmkv_resync.mp4`;
      writeParts(out, fmp4(video, info.timescale, s.video, video.stsd, 1));
      const err = decodeErrors(out);
      if (err) fail(`resync 之后解码报错：${err.slice(0, 200)}`);
    }

    /* 大小未知的 Cluster */
    if (at === runs[0] && b.length < 64 * 1048576) {
      const u = unknownSizes(b);
      const info2 = await Mkv.readHead(async (o, l) => u.bytes.slice(o, o + l), u.bytes.length);
      const s = demuxRange(u.bytes, info2, want, info2.firstCluster, 0, false);
      if (s.video.length !== r.video.length || s.audio.length !== r.audio.length) fail(`大小未知的 Cluster：视频 ${s.video.length}/${r.video.length} 音频 ${s.audio.length}/${r.audio.length}`);
      else console.log(`    大小未知的 Cluster（改了 ${u.clusters} 个）：帧数一致`);
    }

    /* 封面关键帧 */
    if (at === runs[0]) {
      let kr = 0;
      const kread = async (o, l) => { kr++; return b.slice(o, Math.min(b.length, o + l)); };
      t0 = performance.now();
      const k = await Mkv.keyframeAt(kread, info, info.duration * 0.3);
      const kms = performance.now() - t0;
      const out = `${TMP}tgmkv_key.mp4`;
      writeParts(out, [Mp4.initSegment({ kind: 'video', timescale: info.timescale, stsd: video.stsd, width: video.width, height: video.height }, 1),
        Mp4.fragmentFrames(1, [{ dts: 0, cto: 0, dur: 40, key: true, data: k.data }], 1)]);
      let frames = 0;
      try { frames = +probe(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).trim(); } catch (e) {}
      console.log(`    keyframeAt(30%)：${k.pts.toFixed(2)}s ${k.data.length}B，read ${kr} 次 ${kms.toFixed(0)}ms，ffmpeg 解出 ${frames} 帧`);
      if (frames !== 1) fail('封面关键帧解不出来');
    }
  }
}
/* ---------- 合成的 MKV：header stripping（ContentCompAlgo 3）+ EBML lacing + 大小未知的 Segment / Cluster + 没有 Cues ---------- */
function ebmlId(id) { const a = []; while (id > 0) { a.unshift(id & 255); id = Math.floor(id / 256); } return a; }
function el(id, ...parts) {
  const body = Buffer.concat(parts.map(p => Buffer.from(p)));
  const n = body.length, sz = [0x01, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 7, v = n; i >= 1; i--, v = Math.floor(v / 256)) sz[i] = v & 255;
  return Buffer.concat([Buffer.from(ebmlId(id)), Buffer.from(sz), body]);
}
const eu = (id, v) => { const a = []; do { a.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0); return el(id, a); };
const ef = (id, v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return el(id, b); };
const es = (id, s) => el(id, Buffer.from(s));
function unknownEl(id, ...parts) { return Buffer.concat([Buffer.from(ebmlId(id)), Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), ...parts]); }

async function synthStripped(src) {
  const b = new Uint8Array(fs.readFileSync(src));
  const info = await Mkv.readHead(async (o, l) => b.slice(o, o + l), b.length);
  const v = info.tracks.find(t => t.kind === 'video'), a = info.tracks.find(t => t.codecId === 'A_AC3');
  const r = demuxRange(b, info, { video: v.num, audio: a.num, subs: [] }, info.firstCluster, 0, false);
  const blocks = [];
  for (const f of r.video) blocks.push({ t: f.dts + f.cto, tn: 1, key: f.key, frames: [f.data] });
  for (let i = 0; i < r.audio.length; i += 4) {
    blocks.push({ t: r.audio[i].dts, tn: 2, key: true, frames: r.audio.slice(i, i + 4).map(f => f.data.subarray(2)) });     // 去掉 0B 77
  }
  /* 解码顺序：视频块按原顺序，音频插到时间合适的地方（同一时间点视频先） */
  const vb = blocks.filter(x => x.tn === 1), ab = blocks.filter(x => x.tn === 2), order = [];
  let j = 0;
  for (const x of vb) { while (j < ab.length && ab[j].t < x.t) order.push(ab[j++]); order.push(x); }
  while (j < ab.length) order.push(ab[j++]);
  return writeMkv(order, [
    el(0xAE, eu(0xD7, 1), eu(0x73C5, 1), eu(0x83, 1), es(0x86, 'V_MPEG4/ISO/AVC'), el(0x63A2, v.codecPrivate), el(0xE0, eu(0xB0, v.width), eu(0xBA, v.height))),
    el(0xAE, eu(0xD7, 2), eu(0x73C5, 2), eu(0x83, 2), es(0x86, 'A_AC3'), eu(0x23E383, 32000000), el(0xE1, ef(0xB5, 48000), eu(0x9F, 1)),
      el(0x6D80, el(0x6240, eu(0x5031, 0), eu(0x5032, 1), eu(0x5033, 0), el(0x5034, eu(0x4254, 3), el(0x4255, [0x0B, 0x77])))))
  ], info.duration, r);
}
/* blocks（解码顺序，{t 毫秒, tn, key, frames}）+ TrackEntry 们 → 一个大小未知的 Segment、大小未知的 Cluster、没有 Cues 的 MKV */
function writeMkv(order, entries, duration, extra) {
  const clusters = [];
  let cur = null;
  for (const x of order) {
    if (!cur || x.t - cur.ts > 2000 || (x.tn === 1 && x.key && x.t - cur.ts > 500)) { cur = { ts: x.t, items: [] }; clusters.push(cur); }
    const rel = x.t - cur.ts;
    let head;
    if (x.frames.length === 1) head = [0x80 | x.tn, (rel >> 8) & 255, rel & 255, x.key ? 0x80 : 0];
    else {
      /* EBML lacing：帧数 − 1、第一帧大小（2 字节 vint）、之后每帧和上一帧的差（2 字节有符号 vint，偏置 8191） */
      head = [0x80 | x.tn, (rel >> 8) & 255, rel & 255, 0x80 | 0x06, x.frames.length - 1, 0x40 | (x.frames[0].length >> 8), x.frames[0].length & 255];
      for (let k = 1; k < x.frames.length - 1; k++) { const raw = x.frames[k].length - x.frames[k - 1].length + 8191; head.push(0x40 | (raw >> 8), raw & 255); }
    }
    cur.items.push(el(0xA3, head, ...x.frames));
  }
  const out = Buffer.concat([el(0x1A45DFA3, eu(0x4286, 1), eu(0x42F7, 1), eu(0x42F2, 4), eu(0x42F3, 8), es(0x4282, 'matroska'), eu(0x4287, 4), eu(0x4285, 2)),
    unknownEl(0x18538067, el(0x1549A966, eu(0x2AD7B1, 1000000), ef(0x4489, duration * 1000)), el(0x1654AE6B, ...entries),
      ...clusters.map(c => unknownEl(0x1F43B675, eu(0xE7, c.ts), ...c.items)))]);
  return { bytes: new Uint8Array(out), video: extra.video, audio: extra.audio };
}
{
  const src = ROOT + 'test/media/mkv/k_ac3_lace.mkv';
  if (fs.existsSync(src)) {
    console.log('合成：header stripping + EBML lacing + 大小未知 + 没有 Cues（来自 k_ac3_lace.mkv）');
    const sy = await synthStripped(src);
    const path = `${TMP}tgmkv_synth.mkv`;
    fs.writeFileSync(path, sy.bytes);
    const info = await Mkv.readHead(async (o, l) => sy.bytes.slice(o, o + l), sy.bytes.length);
    const at = info.tracks.find(t => t.kind === 'audio');
    console.log(`  音频 comp=${JSON.stringify(at.comp && { algo: at.comp.algo, settings: Array.from(at.comp.settings) })} cues=${info.cues} stsd=${at.stsd ? at.stsd.length + 'B' : '等第一帧'}`);
    if (!at.comp || at.comp.algo !== 3) fail('没读出 header stripping');
    /* ffmpeg 读同一个文件：包数和我们合成时一样（说明合成的文件本身没问题） */
    const ref = packets(path, 1);
    if (ref.length !== sy.audio.length) fail(`ffprobe 读合成文件音频 ${ref.length} 包 ≠ ${sy.audio.length}`);
    /* 我们读：每帧补回 0B 77 之后和原来的字节完全一样 */
    const r = demuxRange(sy.bytes, info, { video: 1, audio: 2, subs: [] }, info.firstCluster, 0, false);
    let diff = 0;
    for (let i = 0; i < Math.min(r.audio.length, sy.audio.length); i++) if (Buffer.compare(Buffer.from(r.audio[i].data), Buffer.from(sy.audio[i].data))) diff++;
    console.log(`  拆出视频 ${r.video.length}/${sy.video.length} 音频 ${r.audio.length}/${sy.audio.length}，字节不同的音频帧 ${diff}，lacing ${r.d.lacing.join('/')}`);
    if (r.video.length !== sy.video.length || r.audio.length !== sy.audio.length || diff) fail('header stripping 拆出来不对');
    if (r.d.lacing[3] === 0) fail('没走到 EBML lacing');
    checkMonotonic('合成音频', r.audio);
    /* AC-3 的 stsd 留给 demuxer 从第一帧拼（头部扫描没赶上的情形）：audioStsd 要出来 */
    const info2 = structuredClone(info);
    info2.tracks.forEach(t => { if (t.kind === 'audio') { t.stsd = null; t.needFirstFrame = true; } });
    const r2 = demuxRange(sy.bytes, info2, { video: 1, audio: 2, subs: [] }, info2.firstCluster, 0, false, 3);
    if (!r2.audioStsd) fail('demuxer 没给出 audioStsd');
    const out = `${TMP}tgmkv_synth_a.mp4`;
    writeParts(out, fmp4(at, info.timescale, r.audio, r2.audioStsd, 2));
    const err = decodeErrors(out);
    console.log(`  demuxer 从第一帧拼的 stsd ${r2.audioStsd ? r2.audioStsd.length + 'B' : '无'}，fMP4 音频解码${err ? '报错 ' + err.slice(0, 100) : '无错'}`);
    if (err) fail('合成文件的 AC-3 fMP4 解码报错');
  }
}

/* 老的 CodecID（A_AAC/MPEG4/LC，没有 CodecPrivate）：自己拼的 AudioSpecificConfig 要和原片的一样 */
{
  const src = ROOT + 'test/media/mkv/m_h264_aac.mkv';
  if (fs.existsSync(src)) {
    const b = new Uint8Array(fs.readFileSync(src));
    const info = await Mkv.readHead(async (o, l) => b.slice(o, o + l), b.length);
    const a = info.tracks.find(t => t.kind === 'audio');
    const r = demuxRange(b, info, { video: 0, audio: a.num, subs: [] }, info.firstCluster, 0, false);
    const order = r.audio.map(f => ({ t: f.dts, tn: 1, key: true, frames: [f.data] }));
    const sy = writeMkv(order, [el(0xAE, eu(0xD7, 1), eu(0x73C5, 1), eu(0x83, 2), es(0x86, 'A_AAC/MPEG4/LC'), el(0xE1, ef(0xB5, a.rate), eu(0x9F, a.channels)))],
      info.duration, { video: [], audio: r.audio });
    const info2 = await Mkv.readHead(async (o, l) => sy.bytes.slice(o, o + l), sy.bytes.length);
    const a2 = info2.tracks[0];
    /* 原片的 ASC 后面还有 56 E5 00（同步扩展：明说「没有 SBR」），比前两个字节（aot / 采样率 / 声道）就够 */
    const same = Buffer.compare(Buffer.from(a2.codecPrivate || []).subarray(0, 2), Buffer.from(a.codecPrivate).subarray(0, 2)) === 0;
    const r2 = demuxRange(sy.bytes, info2, { video: 0, audio: 1, subs: [] }, info2.firstCluster, 0, false);
    const out = `${TMP}tgmkv_legacy_aac.mp4`;
    writeParts(out, fmp4(a2, info2.timescale, r2.audio, a2.stsd, 2));
    const err = decodeErrors(out);
    console.log(`老 CodecID A_AAC/MPEG4/LC：${a2.codec}，拼的 ASC ${Buffer.from(a2.codecPrivate || []).toString('hex')}（原片 ${Buffer.from(a.codecPrivate).toString('hex')}），` +
      `音频 ${r2.audio.length} 帧，fMP4 解码${err ? '报错 ' + err.slice(0, 100) : '无错'}`);
    if (!same || err || r2.audio.length !== r.audio.length) fail('老 CodecID 的 AAC 不对');
  }
}

console.log(bad ? `${bad} 处失败` : '全部通过');
process.exit(bad ? 1 : 0);
