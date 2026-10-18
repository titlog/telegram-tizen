/* subs.js 校验：外挂文件的编码和解析、MP4 的 tx3g / wvtt、MKV 的 ASS 块、PGS（对照 ffmpeg 的解码逐像素比）、画出来的样子。
 *   node test/check-subs.mjs
 * 测试文件生成到 test/media/subs/（每次重新生成）：
 *   base.srt（手写，中英双语、<i> <font> {\an8}）→ ffmpeg -i base.srt base.ass / base.vtt
 *   iconv -f UTF-8 -t GBK base.srt > gbk.srt；tc.srt（繁体）→ iconv -t BIG5 > big5.srt、-t GBK > tc_gbk.srt；
 *   BOM + iconv -t UTF-16LE → utf16le_bom.srt；不带 BOM 的 utf16le.srt；BOM + UTF-8 → utf8bom.srt
 *   styled.ass（手写：两个 Style、一个 Alignment 8；\an8、\pos、\N、\h、绘图 \p1、双语两条同时间、Comment）
 *   ffmpeg -i test/media/a_h264_fast.mp4 -i base.srt -map 0:v -map 1 -c:v copy -c:s mov_text -t 15 tx3g.mp4（wvtt.mp4 同理 -c:s webvtt）
 *   pgs.sup：这里自己写的 PGS 编码器生成；参照图 ffmpeg -f lavfi -i color=black -i pgs.sup -filter_complex "[0][1:s]overlay=format=rgb" …
 * 截图到 logs/subs-*.png。 */
import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = ROOT + 'test/media/subs/';
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(ROOT + 'logs', { recursive: true });

const ctx = { TextDecoder, Response, Blob, DecompressionStream, performance, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/mp4.js', 'utf8') + '\nthis.Mp4 = Mp4;', ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/subs.js', 'utf8') + '\nthis.Subs = Subs;', ctx);
const { Subs, Mp4 } = ctx;

let bad = 0;
const fail = (m) => { bad++; console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
const sh = (cmd) => execSync(cmd, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });

/* ---------- 生成文字字幕 ---------- */

const BASE = `1
00:00:01,000 --> 00:00:03,500
你好，这是第一条字幕
<i>Hello, this is the first line</i>

2
00:00:04,000 --> 00:00:06,000
<font color="#ffff00">第二条</font>：
两行中文

3
00:00:06,500 --> 00:00:09,250
{\\an8}顶部的说明文字

4
00:00:10,000 --> 00:00:12,000
我们来看看 & 测试 <b>粗体</b>
`;
const BASE_EXP = [
  { s: 1, e: 3.5, text: '你好，这是第一条字幕\nHello, this is the first line', top: false },
  { s: 4, e: 6, text: '第二条：\n两行中文', top: false },
  { s: 6.5, e: 9.25, text: '顶部的说明文字', top: true },
  { s: 10, e: 12, text: '我们来看看 & 测试 粗体', top: false },
];
const TC = `1
00:00:01,000 --> 00:00:02,000
這是繁體字幕，我們來說說

2
00:00:03,000 --> 00:00:04,000
還有這個樣子的對話
`;
const TC_EXP = [{ s: 1, e: 2, text: '這是繁體字幕，我們來說說' }, { s: 3, e: 4, text: '還有這個樣子的對話' }];

const STYLED = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,30,1
Style: Sign,Arial,50,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,中文字幕第一行\\N{\\fs40}English line one
Dialogue: 0,0:00:01.00,0:00:04.00,Sign,,0,0,0,,片头标牌：上面
Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\an8}这一条放上面（an8）
Dialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,{\\pos(960,100)}用 pos 放在上半屏
Dialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,{\\pos(960,1000)}用 pos 放在下半屏
Dialogue: 0,0:00:11.00,0:00:13.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}
Dialogue: 0,0:00:11.00,0:00:13.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0{\\p0}绘图后面的字
Dialogue: 0,0:00:14.00,0:00:16.00,Default,,0,0,0,,双语第二种：中文
Dialogue: 0,0:00:14.00,0:00:16.00,Default,,0,0,0,,Bilingual: English
Comment: 0,0:00:14.00,0:00:16.00,Default,,0,0,0,,注释不显示
Dialogue: 1,0:00:17.00,0:00:18.00,Default,,0,0,0,,带\\h空格,逗号,也在正文里
`;
const STYLED_EXP = [
  { s: 1, e: 4, text: '中文字幕第一行\nEnglish line one', top: false },
  { s: 1, e: 4, text: '片头标牌：上面', top: true },
  { s: 5, e: 7.5, text: '这一条放上面（an8）', top: true },
  { s: 8, e: 10, text: '用 pos 放在上半屏', top: true },
  { s: 8, e: 10, text: '用 pos 放在下半屏', top: false },
  { s: 11, e: 13, text: '绘图后面的字', top: false },
  { s: 14, e: 16, text: '双语第二种：中文', top: false },
  { s: 14, e: 16, text: 'Bilingual: English', top: false },
  { s: 17, e: 18, text: '带 空格,逗号,也在正文里', top: false },
];

fs.writeFileSync(DIR + 'base.srt', BASE);
fs.writeFileSync(DIR + 'tc.srt', TC);
fs.writeFileSync(DIR + 'styled.ass', STYLED);
ff(['-i', 'base.srt', 'base.ass']);
ff(['-i', 'base.srt', 'base.vtt']);
sh('iconv -f UTF-8 -t GBK base.srt > gbk.srt');
sh('iconv -f UTF-8 -t BIG5 tc.srt > big5.srt');
sh('iconv -f UTF-8 -t GBK tc.srt > tc_gbk.srt');
sh("printf '\\xff\\xfe' > utf16le_bom.srt && iconv -f UTF-8 -t UTF-16LE base.srt >> utf16le_bom.srt");
sh('iconv -f UTF-8 -t UTF-16LE base.srt > utf16le.srt');
sh("printf '\\xef\\xbb\\xbf' > utf8bom.srt && cat base.srt >> utf8bom.srt");

function same(got, exp, what, opts = {}) {
  if (got.length !== exp.length) { fail(`${what}：${got.length} 条，应为 ${exp.length}` + '\n      ' + JSON.stringify(got)); return; }
  for (let i = 0; i < exp.length; i++) {
    const g = got[i], x = exp[i];
    if (Math.abs(g.s - x.s) > 0.011 || (x.e !== undefined && Math.abs(g.e - x.e) > 0.011)) { fail(`${what} #${i} 时间 ${g.s}-${g.e}，应为 ${x.s}-${x.e}`); return; }
    if (g.text !== x.text) { fail(`${what} #${i} 文字 ${JSON.stringify(g.text)}，应为 ${JSON.stringify(x.text)}`); return; }
    if (!opts.noTop && x.top !== undefined && g.top !== x.top) { fail(`${what} #${i} top=${g.top}，应为 ${x.top}`); return; }
  }
  ok(`${what}：${got.length} 条全对`);
}

/* ---------- 1–2 外挂文件：编码 + 解析 ---------- */
console.log('外挂文件');
const file = (n) => new Uint8Array(fs.readFileSync(DIR + n));
for (const [name, exp, o] of [['base.srt', BASE_EXP], ['utf8bom.srt', BASE_EXP], ['gbk.srt', BASE_EXP], ['utf16le_bom.srt', BASE_EXP], ['utf16le.srt', BASE_EXP],
  ['big5.srt', TC_EXP, { noTop: true }], ['tc_gbk.srt', TC_EXP, { noTop: true }],
  /* ffmpeg 转 ASS 保留了 {\an8}；转 VTT 时丢了位置（webvttenc 不写 line:），只比文字 */
  ['base.ass', BASE_EXP], ['base.vtt', BASE_EXP, { noTop: true }], ['styled.ass', STYLED_EXP]]) {
  const text = Subs.decode(file(name));
  same(Subs.parse(text, name), exp, name, o || {});
}
if (!Subs.isSubFile('电影.CHS.SRT') || !Subs.isSubFile('a.ass') || Subs.isSubFile('a.mkv') || Subs.isSubFile('srt')) fail('isSubFile');
else ok('isSubFile');
/* 内容嗅探：扩展名是错的也认 */
same(Subs.parse(BASE, 'wrong.txt'), BASE_EXP, '扩展名不对的 SRT');
same(Subs.parse(STYLED, 'x.srt'), STYLED_EXP, '扩展名是 .srt 的 ASS');
/* 漏了空行的 SRT */
same(Subs.parse('1\n00:00:01,000 --> 00:00:02,000\n甲\n2\n00:00:03,000 --> 00:00:04,000\n乙\n', 'x.srt'),
  [{ s: 1, e: 2, text: '甲' }, { s: 3, e: 4, text: '乙' }], '漏了空行的 SRT');
same(Subs.parse('1\n00:00:01,000 --> 00:00:02,000\n&lt;b&gt; &amp; a < b\n', 'x.srt'), [{ s: 1, e: 2, text: '<b> & a < b' }], 'SRT 里的 HTML 实体');

/* ---------- 3 tx3g / wvtt ---------- */
console.log('MP4 里的字幕');
function mp4Subs(name, codec) {
  const b = file(name);
  const moov = Mp4.scanTop(b, 0).find(x => x.type === 'moov');
  const mv = Mp4.parseMoov(b.subarray(moov.start, moov.start + moov.size));
  const tr = mv.tracks.find(t => t.kind === 'sub');
  if (!tr) { fail(`${name} 里没认出字幕轨`); return null; }
  if (tr.codec !== codec) { fail(`${name} codec=${tr.codec}，应为 ${codec}`); }
  const st = Subs.track(tr.codec, null);
  for (let i = 0; i < tr.n; i++) {
    const pts = tr.dts[i] / tr.timescale;
    const dur = ((i + 1 < tr.n ? tr.dts[i + 1] : tr.end) - tr.dts[i]) / tr.timescale;
    st.add(pts, dur, b.subarray(tr.offset[i], tr.offset[i] + tr.size[i]));
  }
  console.log(`  ${name}：字幕轨 ${tr.codec} ${tr.n} 个样本 lang=${tr.lang || '-'} → ${st.count()} 条`);
  return st;
}
const evAll = (st) => st.ev.concat(st.long).sort((a, b) => a.s - b.s);
ff(['-i', ROOT + 'test/media/a_h264_fast.mp4', '-i', 'base.srt', '-map', '0:v', '-map', '1', '-c:v', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi', '-t', '15', 'tx3g.mp4']);
let st = mp4Subs('tx3g.mp4', 'tx3g');
if (st) same(evAll(st), BASE_EXP, 'tx3g', { noTop: true });
/* wvtt：ffmpeg 的 mp4 封装器写不了（「Could not find tag for codec webvtt」），按 ISO 14496-30 手拼样本：
 * vttc{sttg, payl}、两个 cue 同时在一个样本里、vtte = 空 */
{
  const bx = (t, ...parts) => { const body = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p)); const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(t, 4, 'ascii'); return Buffer.concat([h, body]); };
  const tw = Subs.track('wvtt', null);
  tw.add(0, 1, new Uint8Array(bx('vtte')));
  tw.add(1, 2, new Uint8Array(Buffer.concat([bx('vttc', bx('payl', '<i>第一句</i>')), bx('vttc', bx('sttg', 'line:0 align:center'), bx('payl', '上面的'))])));
  tw.add(3, 1, new Uint8Array(bx('vttc', bx('iden', '7'), bx('payl', 'a &amp; b'))));
  same(evAll(tw), [{ s: 1, e: 3, text: '第一句', top: false }, { s: 1, e: 3, text: '上面的', top: true }, { s: 3, e: 4, text: 'a & b', top: false }], 'wvtt（手拼样本）');
}

/* ---------- 4 MKV 的文字块 ---------- */
console.log('MKV 的块');
{
  const head = STYLED.split('[Events]')[0] + '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  const tr = Subs.track('S_TEXT/ASS', new TextEncoder().encode(head));
  const blk = (s) => new TextEncoder().encode(s);
  /* 乱序来：先来后面的，再跳回前面（跳转后重读），同一块来两次 */
  tr.add(14, 2, blk('8,0,Default,,0,0,0,,双语第二种：中文'));
  tr.add(14, 2, blk('7,0,Default,,0,0,0,,Bilingual: English'));     // ReadOrder 小 → 排前面
  tr.add(1, 3, blk('0,0,Default,,0,0,0,,中文字幕第一行\\N{\\fs40}English line one'));
  tr.add(1, 3, blk('1,0,Sign,,0,0,0,,片头标牌：上面'));
  tr.add(1, 3, blk('0,0,Default,,0,0,0,,中文字幕第一行\\N{\\fs40}English line one'));
  tr.add(5, 2.5, blk('2,1,Default,,0,0,0,,{\\an8}这一条放上面（an8）'));
  same(evAll(tr), [STYLED_EXP[0], STYLED_EXP[1], STYLED_EXP[2], { s: 14, e: 16, text: 'Bilingual: English' }, { s: 14, e: 16, text: '双语第二种：中文' }], 'S_TEXT/ASS 块（乱序、重复）');
  const at = tr.at(15).map(x => x.text).join(' / ');
  if (at !== 'Bilingual: English / 双语第二种：中文') fail('同时显示的两条按 ReadOrder 排：' + at); else ok('同时显示的两条按 ReadOrder 排');
  /* zlib（MKV 的 ContentCompression） */
  const tz = Subs.track('S_TEXT/UTF8', null);
  await tz.add(20, 1.5, zlib.deflateSync(Buffer.from('<i>压缩过的</i>字幕')), { zlib: true });
  same(evAll(tz), [{ s: 20, e: 21.5, text: '压缩过的字幕' }], 'S_TEXT/UTF8 + zlib');
  /* 没时长的：到下一条开始为止，最多 6 秒 */
  const to = Subs.track('S_TEXT/UTF8', null);
  to.add(1, 0, blk('一'));
  to.add(3, 0, blk('二'));
  const vis = [0.5, 1.5, 2.9, 3.1, 8.9, 9.1].map(t => to.at(t).map(x => x.text).join('') || '-').join(' ');
  if (vis !== '- 一 一 二 二 -') fail('没时长的事件：' + vis); else ok('没时长的事件显示到下一条 / 6 秒');
  const tw = Subs.track('S_TEXT/WEBVTT', null);
  tw.add(2, 1, blk('<v 张三>你好 <c.yellow>黄字</c></v>'));
  same(evAll(tw), [{ s: 2, e: 3, text: '你好 黄字' }], 'S_TEXT/WEBVTT');
}

/* ---------- 7 性能（node） ---------- */
console.log('性能');
{
  const tr = Subs.track('tx3g', null);
  const samples = [];
  for (let i = 0; i < 1500; i++) {
    const t = new TextEncoder().encode('第 ' + i + ' 条字幕，长度差不多这样\nSubtitle line number ' + i);
    const b = new Uint8Array(t.length + 2); b[0] = t.length >> 8; b[1] = t.length & 255; b.set(t, 2);
    samples.push(b);
  }
  let t0 = performance.now();
  for (let i = 0; i < 1500; i++) tr.add(i * 4.8, 3, samples[i]);
  const addMs = performance.now() - t0;
  const fake = () => ({ textContent: '' });
  const r = Subs.renderer(fake(), fake(), null);
  r.set(tr);
  t0 = performance.now();
  const N = 200000;
  for (let i = 0; i < N; i++) r.tick((i * 0.1) % 7200);
  const tickUs = (performance.now() - t0) / N * 1000;
  /* PGS：1500 个显示集（每个 ~10KB），add 只看 PCS */
  const ptr = Subs.track('S_HDMV/PGS', null);
  const ds = new Uint8Array(10000); ds.set([0x16, 0, 11, 7, 128, 4, 56, 0x10, 0, 1, 0x80, 0, 0, 1]);
  t0 = performance.now();
  for (let i = 0; i < 1500; i++) ptr.add(i * 4.8, 0, ds);
  const pAdd = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < N; i++) ptr.pgsAt((i * 0.1) % 7200);
  const pUs = (performance.now() - t0) / N * 1000;
  console.log(`  文字 1500 条 add ${addMs.toFixed(1)}ms，tick 平均 ${tickUs.toFixed(2)}µs；PGS 1500 个显示集 add ${pAdd.toFixed(1)}ms，找显示集平均 ${pUs.toFixed(2)}µs`);
}

/* ---------- 5 PGS：编码器 ---------- */

function seg(type, body) { const b = new Uint8Array(3 + body.length); b[0] = type; b[1] = body.length >> 8; b[2] = body.length & 255; b.set(body, 3); return b; }
const be16 = (v) => [v >> 8 & 255, v & 255];
function pcs({ w = 1920, h = 1080, num = 0, state = 0x80, palUpdate = 0, palId = 0, objs = [] }) {
  const a = [...be16(w), ...be16(h), 0x10, ...be16(num), state, palUpdate ? 0x80 : 0, palId, objs.length];
  for (const o of objs) {
    a.push(...be16(o.id), o.win || 0, o.crop ? 0x80 : 0, ...be16(o.x), ...be16(o.y));
    if (o.crop) a.push(...be16(o.crop.x), ...be16(o.crop.y), ...be16(o.crop.w), ...be16(o.crop.h));
  }
  return seg(0x16, a);
}
function wds(wins) { const a = [wins.length]; wins.forEach((w, i) => a.push(i, ...be16(w[0]), ...be16(w[1]), ...be16(w[2]), ...be16(w[3]))); return seg(0x17, a); }
function pds(id, ver, entries) { const a = [id, ver]; for (const e of entries) a.push(...e); return seg(0x14, a); }
function rleEncode(px, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = px[y * w + x]; let L = 1;
      while (x + L < w && px[y * w + x + L] === c && L < 16383) L++;
      if (c && L <= 2) { for (let k = 0; k < L; k++) out.push(c); }
      else if (!c) out.push(0, ...(L < 64 ? [L] : [0x40 | (L >> 8), L & 255]));
      else out.push(0, ...(L < 64 ? [0x80 | L] : [0xC0 | (L >> 8), L & 255]), c);
      x += L;
    }
    out.push(0, 0);
  }
  return Uint8Array.from(out);
}
/* 对象：大的切成好几个 ODS（段长 16 位，每段最多 65535） */
function ods(id, ver, w, h, px, maxSeg = 65000) {
  const r = rleEncode(px, w, h), segs = [];
  const first = Math.min(r.length, maxSeg - 11);
  const len = r.length + 4;
  segs.push(seg(0x15, [...be16(id), ver, 0x80 | (first === r.length ? 0x40 : 0), len >> 16 & 255, len >> 8 & 255, len & 255, ...be16(w), ...be16(h), ...r.subarray(0, first)]));
  for (let p = first; p < r.length;) {
    const n = Math.min(r.length - p, maxSeg - 4);
    segs.push(seg(0x15, [...be16(id), ver, p + n === r.length ? 0x40 : 0, ...r.subarray(p, p + n)]));
    p += n;
  }
  return segs;
}
const END = seg(0x80, []);

/* 位图：几条「字」样的横条带半透明的边，加一点伪随机的块（RLE 不会太整齐） */
function bitmap(w, h, seed, noisy) {
  const px = new Uint8Array(w * h);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const band = Math.floor(y / (h / 3)) % 2 === 0 && x % 37 > 6;
    const edge = Math.floor(y / (h / 3)) % 2 === 0 && (x % 37 === 5 || x % 37 === 6);
    let c = band ? 1 + ((x / 120 | 0) % 3 === 2 ? 2 : 0) : edge ? 4 : 0;
    if (y % 9 === 0 && band) c = 2;
    if (noisy && rnd() < 0.35) c = 1 + Math.floor(rnd() * 6);
    px[y * w + x] = c;
  }
  return px;
}
const PAL = [[0, 16, 128, 128, 0], [1, 235, 128, 128, 255], [2, 16, 128, 128, 255], [3, 210, 146, 16, 255], [4, 235, 128, 128, 128], [5, 81, 240, 90, 255], [6, 41, 110, 240, 200]];
const PAL2 = [[1, 210, 146, 16, 255], [3, 81, 240, 90, 255]];      // 只换调色板：白 → 黄，黄 → 红

const sets = [];
const add = (t, segs) => sets.push({ t, segs: segs.flat() });
let cn = 0;
const clear = (t) => add(t, [pcs({ num: cn++, state: 0, objs: [] }), wds([[0, 0, 10, 10]]), END]);
/* 1 单对象 */
add(1, [pcs({ num: cn++, objs: [{ id: 0, x: 300, y: 850 }] }), wds([[300, 850, 1300, 150]]), pds(0, 0, PAL), ...ods(0, 0, 1300, 150, bitmap(1300, 150, 1)), END]);
clear(2);
/* 3 双对象（上下各一） + 4 只换调色板 */
add(3, [pcs({ num: cn++, objs: [{ id: 0, x: 200, y: 80 }, { id: 1, win: 1, x: 400, y: 880 }] }), wds([[200, 80, 800, 100], [400, 880, 1100, 120]]),
  pds(0, 0, PAL), ...ods(0, 0, 800, 100, bitmap(800, 100, 2)), ...ods(1, 0, 1100, 120, bitmap(1100, 120, 3)), END]);
add(4, [pcs({ num: cn++, state: 0, palUpdate: 1, objs: [{ id: 0, x: 200, y: 80 }, { id: 1, win: 1, x: 400, y: 880 }] }), pds(0, 1, PAL2), END]);
clear(5);
/* 6 跨好几个 ODS 的大对象 */
const bigPx = bitmap(1800, 500, 4, true), bigOds = ods(0, 0, 1800, 500, bigPx);
add(6, [pcs({ num: cn++, objs: [{ id: 0, x: 60, y: 300 }] }), wds([[60, 300, 1800, 500]]), pds(0, 0, PAL), ...bigOds, END]);
clear(7);
/* 8 裁剪 */
add(8, [pcs({ num: cn++, objs: [{ id: 0, x: 700, y: 820, crop: { x: 100, y: 20, w: 300, h: 80 } }] }), wds([[700, 820, 300, 80]]), pds(0, 0, PAL), ...ods(0, 0, 500, 150, bitmap(500, 150, 5)), END]);
clear(9);
/* 10 epoch start → 11 acquisition point（整套重给，换了图）→ 12 清屏 */
add(10, [pcs({ num: cn++, objs: [{ id: 0, x: 300, y: 850 }] }), wds([[300, 850, 900, 120]]), pds(0, 0, PAL), ...ods(0, 0, 900, 120, bitmap(900, 120, 6)), END]);
add(11, [pcs({ num: cn++, state: 0x40, objs: [{ id: 0, x: 500, y: 700 }] }), wds([[500, 700, 700, 140]]), pds(0, 0, PAL), ...ods(0, 0, 700, 140, bitmap(700, 140, 7)), END]);
clear(12);
/* 13 epoch start → 14 normal：同一个对象换个位置，不重给 ODS */
add(13, [pcs({ num: cn++, objs: [{ id: 0, x: 100, y: 900 }] }), wds([[100, 900, 600, 100]]), pds(0, 0, PAL), ...ods(0, 0, 600, 100, bitmap(600, 100, 8)), END]);
add(14, [pcs({ num: cn++, state: 0, objs: [{ id: 0, x: 900, y: 600 }] }), wds([[900, 600, 600, 100]]), END]);
clear(15);
console.log(`PGS：${sets.length} 个显示集，大对象 ${bigOds.length} 个 ODS 分片`);

/* .sup：每个段前面「PG」+ PTS + DTS（90kHz） */
{
  const parts = [];
  for (const s of sets) for (const sg of segsOf(s)) {
    const h = new Uint8Array(10); h[0] = 0x50; h[1] = 0x47;
    const p = Math.round(s.t * 90000); h[2] = p >>> 24; h[3] = p >> 16 & 255; h[4] = p >> 8 & 255; h[5] = p & 255;
    parts.push(h, sg);
  }
  fs.writeFileSync(DIR + 'pgs.sup', Buffer.concat(parts.map(Buffer.from)));
}
function segsOf(s) { return s.segs; }
const checkT = [];
for (let i = 1; i <= 15; i++) checkT.push(i + 0.5);
/* 参照：ffmpeg 解 PGS、叠在黑底上（RGB 里叠，避免 yuv420 的色度下采样），10fps，按时间戳取每秒的 .5 那一帧，文件名是 pts（×0.1 秒）。
 * -copyts：不然 ffmpeg 把 .sup 的起点（第一个显示集 1.0 秒）挪到 0，参照整体早一秒 */
fs.readdirSync(DIR).filter(f => /^ref_\d+\.png$/.test(f)).forEach(f => fs.unlinkSync(DIR + f));
ff(['-copyts', '-f', 'lavfi', '-i', 'color=black:s=1920x1080:r=10:d=16', '-i', 'pgs.sup', '-filter_complex',
  `[0:v]format=rgb24[b];[b][1:s]overlay=format=rgb:eof_action=pass,select='eq(mod(round(t*10)\\,10)\\,5)'`, '-fps_mode', 'passthrough', '-frame_pts', '1', 'ref_%d.png']);

/* ---------- 浏览器：PGS 逐像素比 + renderer 截图 ---------- */
const require = createRequire(os.homedir() + '/code/tizen/douyin-tizen/spike/desktop-harness/package.json');
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: os.homedir() + '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', e => fail('pageerror ' + e.message));
ff(['-ss', '22', '-i', ROOT + 'test/media/sintel_trailer-1080p.mp4', '-frames:v', '1', '-q:v', '3', 'bg.jpg']);
const bg = 'data:image/jpeg;base64,' + fs.readFileSync(DIR + 'bg.jpg').toString('base64');
await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="player" class="on"><img id="bg" style="position:absolute;left:0;top:0;width:1920px;height:1080px">
<canvas id="subpic" width="1920" height="1080"></canvas><div id="sub"></div><div id="subtop"></div></div></body></html>`);
await page.addStyleTag({ path: ROOT + 'app/css/app.css' });
await page.addScriptTag({ path: ROOT + 'app/js/subs.js' });

console.log('PGS 对照 ffmpeg');
const setsB64 = sets.map(s => ({ t: s.t, d: Buffer.concat(s.segs.map(Buffer.from)).toString('base64') }));
const refs = checkT.map((t) => 'data:image/png;base64,' + fs.readFileSync(DIR + `ref_${Math.round(t * 10)}.png`).toString('base64'));
/* ffmpeg 的 pgssubdec 不管裁剪（整个对象画在 (x, y)）。按规范裁剪框是对象里的坐标、裁出来那块放在 (x, y)（libbluray 也这么做），
 * 所以那一张的参照 = ffmpeg 的图里 (x + crop.x, y + crop.y) 起的 crop.w × crop.h 挪到 (x, y)，别处是黑的 */
const CROP = { t: 8.5, x: 700, y: 820, cx: 100, cy: 20, w: 300, h: 80 };
const res = await page.evaluate(async ({ setsB64, refs, checkT, CROP }) => {
  const dec = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  const tr = Subs.track('S_HDMV/PGS', null);
  setsB64.forEach(s => tr.add(s.t, 0, dec(s.d)));
  const cv = document.getElementById('subpic');
  const r = Subs.renderer(document.getElementById('sub'), document.getElementById('subtop'), cv);
  r.set(tr);
  const comp = document.createElement('canvas'); comp.width = 1920; comp.height = 1080;
  const cg = comp.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (let i = 0; i < checkT.length; i++) {
    const t0 = performance.now();
    r.tick(checkT[i]);
    const ms = performance.now() - t0;
    cg.fillStyle = '#000'; cg.fillRect(0, 0, 1920, 1080); cg.drawImage(cv, 0, 0);
    const mine = cg.getImageData(0, 0, 1920, 1080).data;
    const img = new Image(); img.src = refs[i]; await img.decode();
    cg.drawImage(img, 0, 0);
    if (checkT[i] === CROP.t) {
      const full = cg.getImageData(CROP.x + CROP.cx, CROP.y + CROP.cy, CROP.w, CROP.h);
      cg.fillStyle = '#000'; cg.fillRect(0, 0, 1920, 1080); cg.putImageData(full, CROP.x, CROP.y);
    }
    const ref = cg.getImageData(0, 0, 1920, 1080).data;
    let maxd = 0, over = 0, lit = 0, refLit = 0;
    for (let k = 0; k < mine.length; k += 4) {
      const d = Math.max(Math.abs(mine[k] - ref[k]), Math.abs(mine[k + 1] - ref[k + 1]), Math.abs(mine[k + 2] - ref[k + 2]));
      if (d > maxd) maxd = d;
      if (d > 3) over++;
      if (mine[k] | mine[k + 1] | mine[k + 2]) lit++;
      if (ref[k] | ref[k + 1] | ref[k + 2]) refLit++;
    }
    out.push({ t: checkT[i], ms: +ms.toFixed(2), maxd, over, lit, refLit });
  }
  return out;
}, { setsB64, refs, checkT, CROP });
for (const x of res) {
  const line = `t=${x.t}：画了 ${x.ms}ms，亮点 ${x.lit}（ffmpeg ${x.refLit}），最大差 ${x.maxd}，差 >3 的点 ${x.over}`;
  if (x.over > 0) fail(line); else ok(line);
}


/* renderer 截图：双语两行 + 顶部标牌、浮层出来时抬高、SRT 的 {\an8}、PGS */
console.log('截图');
await page.evaluate(({ bg, styled, base, setsB64 }) => {
  document.getElementById('bg').src = bg;
  const dec = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
  const mk = (txt) => { const t = Subs.track('file', null); t.addEvents(Subs.parse(txt, 'x')); return t; };
  window.T = { styled: mk(styled), base: mk(base), pgs: Subs.track('S_HDMV/PGS', null) };
  setsB64.forEach(s => T.pgs.add(s.t, 0, dec(s.d)));
  window.R = Subs.renderer(document.getElementById('sub'), document.getElementById('subtop'), document.getElementById('subpic'));
}, { bg, styled: STYLED, base: BASE, setsB64 });
await page.waitForTimeout(200);
const shot = async (name, tr, t, ovon) => {
  await page.evaluate(({ tr, t, ovon }) => { R.set(T[tr]); R.tick(t); document.getElementById('player').classList.toggle('ovon', !!ovon); }, { tr, t, ovon });
  await page.screenshot({ path: `${ROOT}logs/subs-${name}.png` });
  console.log(`  logs/subs-${name}.png：` + await page.evaluate(() => JSON.stringify([document.getElementById('subtop').textContent, document.getElementById('sub').textContent])));
};
await shot('1-bilingual', 'styled', 2);
await shot('2-ovon', 'styled', 2, true);
await shot('3-two-events', 'styled', 15);
await shot('4-srt-top', 'base', 7);
await shot('5-srt-1', 'base', 2);
await shot('6-pgs', 'pgs', 3.5);
await shot('7-pgs-palette', 'pgs', 4.5);
/* offset：推迟 1 秒，t=2.2 → 实际 1.2，显示第一条；t=1.5 → 0.5，什么都没有 */
const off = await page.evaluate(() => { R.set(T.base); R.offset(1); R.tick(1.5); const a = document.getElementById('sub').textContent; R.tick(2.2); const b = document.getElementById('sub').textContent; R.offset(0); return [a, b]; });
if (off[0] !== '' || !off[1].startsWith('你好')) fail('offset：' + JSON.stringify(off)); else ok('offset 推迟 1 秒');
/* 只在内容变了才碰 DOM：同一条连着 tick 不该触发 DOM 变化 */
const muts = await page.evaluate(() => {
  R.set(T.base); R.tick(1.2);
  let n = 0; const mo = new MutationObserver(m => { n += m.length; });
  mo.observe(document.getElementById('sub'), { childList: true, characterData: true, subtree: true });
  for (let t = 1.2; t < 3.4; t += 0.1) R.tick(t);
  return new Promise(r => setTimeout(() => { mo.disconnect(); r(n); }, 50));
});
if (muts) fail(`同一条字幕 tick 22 次碰了 ${muts} 次 DOM`); else ok('同一条字幕连着 tick 不碰 DOM');
/* 一张典型的 PGS（1300×150）在浏览器里解 + 画的时间 */
const pgsMs = await page.evaluate(() => { R.set(T.pgs); const a = []; for (let i = 0; i < 20; i++) { R.tick(0.5); const t0 = performance.now(); R.tick(1.5); a.push(performance.now() - t0); } a.sort((x, y) => x - y); return a[10].toFixed(2); });
console.log(`  PGS 1300×150 解 + 画（中位数）${pgsMs}ms`);
await browser.close();

console.log(bad ? `✗ ${bad} 项不对` : '全部通过');
process.exit(bad ? 1 : 0);
