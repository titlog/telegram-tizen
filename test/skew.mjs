/* 做一个「音视频在文件里隔得远」的测试片：音频 chunk 按 时间/K 排、视频按时间排，于是时刻 t 的音频挨着时刻 t/K 的视频，
 * 越往后隔得越远 —— 和电视上那部 4K《黑鹰坠落》一样（10 分钟处视频在 381MB、音频在 51MB）。只重排 mdat、改 stco，moov 大小不变。
 *   node test/skew.mjs test/media/e_long_2h.mp4 test/media/f_skew.mp4 [K=6] */
import fs from 'node:fs';
import vm from 'node:vm';

const [src, dst, Karg] = process.argv.slice(2);
const K = Number(Karg || 6);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../app/js/mp4.js', import.meta.url), 'utf8') + '\nthis.Mp4 = Mp4;', ctx);
const Mp4 = ctx.Mp4;

const b = new Uint8Array(fs.readFileSync(src));
const top = Mp4.scanTop(b, 0);
const moovH = top.find(x => x.type === 'moov'), mdatH = top.find(x => x.type === 'mdat');
if (moovH.start > mdatH.start) throw new Error('要 moov 在开头的文件');
const moov = b.slice(moovH.start, moovH.start + moovH.size);
const movie = Mp4.parseMoov(moov);

/* 每条轨的 chunk：样本在文件里连续的一段 */
const chunks = [];
movie.tracks.forEach((tr, ti) => {
  let c = null;
  for (let i = 0; i < tr.n; i++) {
    if (!c || tr.offset[i] !== c.end) {
      c = { ti, idx: chunks.filter(x => x.ti === ti).length, off: tr.offset[i], end: tr.offset[i], key: tr.dts[i] / tr.timescale / (tr.kind === 'audio' ? K : 1) };
      chunks.push(c);
    }
    c.end += tr.size[i];
  }
});
const order = chunks.slice().sort((x, y) => x.key - y.key);
const dataStart = mdatH.start + 8;
let pos = dataStart;
const parts = [];
order.forEach(c => { c.newOff = pos; parts.push(b.subarray(c.off, c.end)); pos += c.end - c.off; });

/* 改 moov 里每条 trak 的 stco（按 trak 顺序；只认 stco，32 位） */
function* boxes(buf, s, e) { let o = s; while (o + 8 <= e) { const size = new DataView(buf.buffer, buf.byteOffset + o).getUint32(0); const t = String.fromCharCode(...buf.subarray(o + 4, o + 8)); yield { t, s: o, e: o + size }; o += size; } }
const dv = new DataView(moov.buffer, moov.byteOffset);
let ti = 0;
for (const trak of boxes(moov, 8, moov.length)) {
  if (trak.t !== 'trak') continue;
  const hdlrOk = true;
  const find = (s, e, path) => { for (const x of boxes(moov, s, e)) if (x.t === path[0]) return path.length === 1 ? x : find(x.s + 8, x.e, path.slice(1)); return null; };
  const stco = find(trak.s + 8, trak.e, ['mdia', 'minf', 'stbl', 'stco']);
  const mine = chunks.filter(c => c.ti === ti);
  const n = dv.getUint32(stco.s + 12);
  if (n !== mine.length) throw new Error(`trak ${ti}: stco ${n} 个，算出来 ${mine.length} 个 chunk`);
  mine.forEach((c, i) => dv.setUint32(stco.s + 16 + i * 4, c.newOff));
  ti++;
}
const head = b.subarray(0, mdatH.start + 8);
const out = Buffer.concat([Buffer.from(b.subarray(0, moovH.start)), Buffer.from(moov), Buffer.from(b.subarray(moovH.start + moovH.size, dataStart)), ...parts.map(p => Buffer.from(p))]);
fs.writeFileSync(dst, out);
const re = Mp4.parseMoov(moov), v = re.tracks.find(t => t.kind === 'video'), a = re.tracks.find(t => t.kind === 'audio');
for (const t of [0, 60, 600, movie.duration / 2]) console.log(`t=${Math.round(t)} 视频@${(v.offset[Mp4.sampleAt(v, t)] / 1048576).toFixed(1)}MB 音频@${(a.offset[Mp4.sampleAt(a, t)] / 1048576).toFixed(1)}MB`);
console.log('写好 ' + dst + ' ' + (out.length / 1048576).toFixed(0) + 'MB');
