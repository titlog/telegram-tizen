/* mp4.js 离线校验：解析结果对照 ffprobe；拼出来的 fMP4 交给 ffmpeg 解码，对照每个包的时间戳。
 *   node test/check.mjs test/media/*.mp4 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ctx = {};
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

for (const file of process.argv.slice(2)) {
  console.log(file);
  const b = new Uint8Array(fs.readFileSync(file));
  const top = Mp4.scanTop(b, 0);
  const moov = top.find(x => x.type === 'moov');
  console.log('  顶层: ' + top.map(x => `${x.type}@${x.start}+${x.size}`).join(' '));
  let t = performance.now();
  const movie = Mp4.parseMoov(b.subarray(moov.start, moov.start + moov.size));
  console.log(`  parseMoov ${(performance.now() - t).toFixed(0)}ms，moov ${(moov.size / 1048576).toFixed(2)}MB，时长 ${movie.duration.toFixed(2)}s`);

  for (const tr of movie.tracks) {
    const sel = tr.kind === 'video' ? 'v:0' : 'a:0';
    const ref = packets(file, sel);
    console.log(`  ${tr.kind} id=${tr.id} ${tr.codec} n=${tr.n} keys=${tr.keys ? tr.keys.length : '全部'} shift=${tr.shift} ts=${tr.timescale} ` +
      (tr.kind === 'video' ? `${tr.width}x${tr.height}` : `${tr.channels}ch ${tr.rate}Hz`) + ` dur=${tr.duration.toFixed(2)}s`);
    if (ref.length !== tr.n) fail(`样本数 ${tr.n} ≠ ffprobe ${ref.length}`);
    const refKeys = ref.filter(p => p.key).length;
    if (tr.keys && refKeys !== tr.keys.length) fail(`关键帧 ${tr.keys.length} ≠ ffprobe ${refKeys}`);

    /* 拼成 fMP4：init + 每 ~1 秒一段 */
    const copy = (dst, o, off, size) => dst.set(b.subarray(off, off + size), o);
    const parts = [Mp4.initSegment(tr)];
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
    const out = `/tmp/tgcheck_${tr.kind}.mp4`;
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
    if (tr.kind === 'video' && Math.abs(firstPts) > 0.001) fail('视频首帧不在 0');
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
