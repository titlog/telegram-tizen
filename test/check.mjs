/* mp4.js 离线校验：解析结果对照 ffprobe；拼出来的 fMP4 交给 ffmpeg 解码，对照每个包的时间戳。
 *   node test/check.mjs test/media/*.mp4 test/media/*.mov
 * 音频的 init 段必须是 ISO 写法（条目 version 0、没有 wave）：电视只认这一种（mp4.js 的 isoAudio）。QuickTime 写法的测试片：
 *   ffmpeg -f lavfi -i testsrc=duration=12:size=640x360:rate=25 -f lavfi -i sine=frequency=440:duration=12 \
 *     -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -f mov test/media/g_qt_wave.mov   （mp4a v1 + wave、chan）
 * 分段 MP4：同样的输入 -c:v libx264 -g 25 -pix_fmt yuv420p -c:a aac -movflags frag_keyframe+empty_moov+default_base_moof test/media/l_frag.mp4
 *   （再来一份 -movflags frag_keyframe+empty_moov 不带 default_base_moof 的 l_frag_old.mp4：基准偏移按老写法）
 * Opus 条目的声道数和 dOps 对不上的：同样的命令换 -c:a libopus -b:a 96k -movflags +faststart，输出 h_opus_chmismatch.mp4，
 *   再把 Opus 条目里的 channelcount（条目开头往后第 24 字节，两字节）改成 1 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = { TextDecoder };       // 轨道名（hdlr / udta 里的 UTF-8）
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/mp4.js', 'utf8') + '\nthis.Mp4 = Mp4;', ctx);
const Mp4 = ctx.Mp4;

function probe(args) { return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 30 }); }
function packets(file, sel) {
  return probe(['-select_streams', sel, '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file])
    .trim().split('\n').map(l => { const [pts, flags] = l.split(','); return { pts: +pts, key: flags.includes('K') }; });
}

let bad = 0;
const fail = (m) => { bad++; console.log('  ✗ ' + m); };
/* init 段里第一个样本条目的子盒子（stsd 正文：4 字节版本 + 4 字节条数，条目头 8 字节，视觉条目固定部分 78 字节） */
function entryKids(init) {
  const st = init.indexOf('stsd') - 4, ent = st + 16, end = ent + init.readUInt32BE(ent), out = [];
  for (let o = ent + 8 + 78; o + 8 <= end; o += init.readUInt32BE(o)) { if (init.readUInt32BE(o) < 8) break; out.push(init.toString('latin1', o + 4, o + 8)); }
  return out;
}

for (const file of process.argv.slice(2)) {
  console.log(file);
  const b = new Uint8Array(fs.readFileSync(file));
  const top = Mp4.scanTop(b, 0);
  const moov = top.find(x => x.type === 'moov');
  console.log('  顶层: ' + top.map(x => `${x.type}@${x.start}+${x.size}`).join(' '));
  let t = performance.now();
  const moovBytes = b.subarray(moov.start, moov.start + moov.size);
  /* 分段 MP4：整份交给它，从 moof 拼样本表（player.js 也是整份读进来） */
  const movie = Mp4.isFragmented(moovBytes) ? Mp4.parseMoov(moovBytes, b) : Mp4.parseMoov(moovBytes);
  if (movie.fragmented) console.log(`  分段 MP4：${movie.fragmented} 个 moof`);
  console.log(`  parseMoov ${(performance.now() - t).toFixed(0)}ms，moov ${(moov.size / 1048576).toFixed(2)}MB，时长 ${movie.duration.toFixed(2)}s`);

  for (const tr of movie.tracks) {
    /* 字幕轨（tx3g）：只对样本数，拼段、解码那套不适用（test/check-subs.mjs 管内容） */
    if (tr.kind === 'sub') {
      /* 比容器里记的样本数（nb_frames）：ffprobe 的 packet 会略过空样本（tx3g 用空样本表示「这段没字」） */
      const n = +probe(['-select_streams', 's:' + tr.index, '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]).trim();
      console.log(`  sub id=${tr.id} ${tr.codec} lang=${tr.lang} n=${tr.n}（ffprobe ${n}）`);
      if (n !== tr.n) fail(`字幕样本数 ${tr.n} ≠ ffprobe ${n}`);
      continue;
    }
    const sel = (tr.kind === 'video' ? 'v:' : 'a:') + tr.index;      // 多音轨：第几条
    const ref = packets(file, sel);
    console.log(`  ${tr.kind} id=${tr.id} ${tr.codec}${tr.lang ? ' lang=' + tr.lang : ''}${tr.name ? ' name=' + tr.name : ''}${tr.kind === 'audio' ? ' enabled=' + tr.enabled : ''} n=${tr.n} keys=${tr.keys ? tr.keys.length : '全部'} shift=${tr.shift} ts=${tr.timescale} ` +
      (tr.kind === 'video' ? `${tr.width}x${tr.height}` : `${tr.channels}ch ${tr.rate}Hz`) + ` dur=${tr.duration.toFixed(2)}s`);
    if (ref.length !== tr.n) fail(`样本数 ${tr.n} ≠ ffprobe ${ref.length}`);
    const refKeys = ref.filter(p => p.key).length;
    if (tr.keys && refKeys !== tr.keys.length) fail(`关键帧 ${tr.keys.length} ≠ ffprobe ${refKeys}`);

    /* 拼成 fMP4：init + 每 ~1 秒一段 */
    const copy = (dst, o, off, size) => dst.set(b.subarray(off, off + size), o);
    const parts = [Mp4.initSegment(tr)];
    if (tr.kind === 'audio') {
      const init = Buffer.from(parts[0]), at = init.indexOf(tr.format, 8);
      const ver = at > 0 ? init.readUInt16BE(at + 4 + 8) : -1;
      if (ver !== 0 || init.indexOf('wave') >= 0) fail(`音频 init 段不是 ISO 写法（条目 version ${ver}${init.indexOf('wave') >= 0 ? '，还有 wave' : ''}）`);
      if (tr.stsdNote) console.log('    ' + tr.stsdNote);
    }
    /* 视频条目里 QuickTime 才有的 fiel / chrm 不进 init 段（mp4.js 的 isoVideo；11-14 一台 Tizen 5.5 的 init 段带着它们进不去）。
     * 还拿同一份 moov 把 fiel 改名成 chrm 再来一遍（ffmpeg 不写 chrm） */
    if (tr.kind === 'video') {
      const qt = (init) => entryKids(Buffer.from(init)).filter(k => k === 'fiel' || k === 'chrm');
      if (qt(parts[0]).length) fail(`视频 init 段里还有 ${qt(parts[0]).join('、')}`);
      if (tr.stsdNote) console.log('    ' + tr.stsdNote);
      const copy2 = Buffer.from(moovBytes);
      let at = -1;      // fiel 盒子本身（10 字节），hvcC 的数据里也可能碰巧有这四个字母
      for (let i = copy2.indexOf('fiel'); i > 0; i = copy2.indexOf('fiel', i + 1)) if (copy2.readUInt32BE(i - 4) === 10) { at = i; break; }
      if (/fiel/.test(tr.stsdNote || '') && at > 0) {
        copy2.write('chrm', at);
        const tr2 = Mp4.parseMoov(new Uint8Array(copy2)).tracks.find(x => x.kind === 'video');
        const left = qt(Mp4.initSegment(tr2));
        console.log('    fiel 改名成 chrm：' + tr2.stsdNote);
        if (left.length || !/chrm/.test(tr2.stsdNote)) fail('chrm 没去掉：' + tr2.stsdNote);
      }
    }
    let a = 0, seq = 1;
    t = performance.now();
    while (a < tr.n) {
      let e = a + 1;
      while (e < tr.n && tr.dts[e] - tr.dts[a] < tr.timescale) e++;
      const list = [];
      for (let i = a; i < e; i++) list.push(i);
      parts.push(Mp4.fragment(tr, list, seq++, copy));
      a = e;
    }
    const ms = performance.now() - t;
    const out = `/tmp/tgcheck_${tr.kind}${tr.index}.mp4`;
    fs.writeFileSync(out, Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.length))));
    console.log(`    拼 ${seq - 1} 段 ${ms.toFixed(0)}ms`);

    /* 时间戳：拼出来的每个包的 pts 要等于原文件（ffmpeg 已经按 edit list 挪过）的 pts */
    const got = packets(out, '0');
    if (got.length !== ref.length) fail(`拼完 ${got.length} 个包 ≠ 原 ${ref.length}`);
    const sortedRef = ref.map(p => p.pts).sort((x, y) => x - y), sortedGot = got.map(p => p.pts).sort((x, y) => x - y);
    /* ffmpeg 读 trun v1 的负合成偏移时会把整条轨往后挪一个常数（dts_shift），所以只比相对时间：
     * 去掉首个差值之后的最大偏差。绝对起点（视频首帧 = 0）在 Chrome 里看 SourceBuffer.buffered。 */
    const off = sortedGot[0] - sortedRef[0];
    let maxd = 0;
    for (let i = 0; i < Math.min(sortedRef.length, sortedGot.length); i++) maxd = Math.max(maxd, Math.abs(sortedRef[i] + off - sortedGot[i]));
    const firstPts = Mp4.pts(tr, tr.cto ? Array.from(tr.cto.keys()).reduce((m, i) => Mp4.pts(tr, i) < Mp4.pts(tr, m) ? i : m, 0) : 0);
    console.log(`    相对 pts 最大偏差 ${(maxd * 1000).toFixed(2)}ms（ffmpeg 整体挪了 ${(off * 1000).toFixed(1)}ms），按我们的时间戳首帧 ${firstPts.toFixed(4)}s`);
    if (maxd > 0.002) fail('pts 对不上');
    /* 首帧落在 0 靠的是 edit list；分段 MP4 常没有（ffmpeg 的 empty_moov 就没写），那就照文件说的（ffmpeg 读出来也一样），开头空档播放器会跳 */
    if (tr.kind === 'video' && Math.abs(firstPts) > 0.001 && !(movie.fragmented && !tr.shift)) fail('视频首帧不在 0');
    const gotKeys = got.filter(p => p.key).length;
    if (gotKeys !== (tr.keys ? tr.keys.length : tr.n)) fail(`拼完关键帧 ${gotKeys}`);

    /* 解码一遍 */
    try {
      const err = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (err.trim()) fail('ffmpeg 解码报错: ' + err.slice(0, 200));
    } catch (e) { fail('ffmpeg 解码失败: ' + String(e.stderr || e).slice(0, 300)); }

    /* 查找 */
    if (tr.keys) {
      const mid = movie.duration / 2;
      const k = Mp4.keyNear(tr, mid, 0);
      const kb = Mp4.keyAtOrBefore(tr, Mp4.sampleAt(tr, mid));
      const fwd = Mp4.keyNear(tr, 10, 1, 10);
      const back = Mp4.keyNear(tr, 10, -1, 10);
      console.log(`    关键帧：离 ${mid.toFixed(1)}s 最近 ${Mp4.pts(tr, k).toFixed(2)}，之前 ${Mp4.pts(tr, kb).toFixed(2)}；从 10s 往后 ${Mp4.pts(tr, fwd).toFixed(2)}，往前 ${Mp4.pts(tr, back).toFixed(2)}`);
      if (!(Mp4.pts(tr, fwd) > 10.5) || !(Mp4.pts(tr, back) < 9.5)) fail('快进快退没动');
      if (!ref[k] || !tr.keys.includes(k)) fail('keyNear 返回的不是关键帧');
    }
  }
}
console.log(bad ? `${bad} 处失败` : '全部通过');
process.exit(bad ? 1 : 0);
