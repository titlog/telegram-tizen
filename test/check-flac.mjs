/* app/js/flac.js 的离线校验：各种参数的 FLAC（ffmpeg 生成），我们解出来的 16 位 PCM 和 ffmpeg 解的逐字节比；顺带量解码速度。
 * 测试片在 test/media/flac/（不进仓库），没有就现生成：一段不规则的「音乐」（几个音、噪声、静音、扫频混在一起，让编码器用上各种
 * 预测阶数、分区、escape、wasted bits、声道还原），再按下面 CASES 的参数编码。
 *   node test/check-flac.mjs
 * 24 位的：ffmpeg 解成 s16 是直接截掉低 8 位（swresample 默认不加抖动），和 flac.js 的右移一致。 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname, DIR = ROOT + 'test/media/flac/';
fs.mkdirSync(DIR, { recursive: true });
const ctx = { console, Math, Int16Array, Int32Array, Uint8Array, Array, Error, Blob: class {}, URL: {}, Worker: class {}, DataView, ArrayBuffer };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(ROOT + 'app/js/flac.js', 'utf8') + ';this.Flac = Flac;', ctx);
const Flac = ctx.Flac;

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
const src = DIR + 'src.wav';
if (!fs.existsSync(src)) {
  /* 30 秒：和弦 + 一段粉噪声 + 静音 + 扫频，立体声两边不一样 */
  ff(['-f', 'lavfi', '-i', 'sine=f=220:d=30', '-f', 'lavfi', '-i', 'sine=f=331:d=30', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink:a=0.25',
      '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*(200+300*t)*t)|0.3*sin(2*PI*(500-10*t)*t)':d=30:s=48000",
      '-filter_complex', "[0][1][2]amix=inputs=3,volume=1.5,aformat=channel_layouts=stereo,volume='if(between(t,10,12),0,1)':eval=frame[a];[a][3]amix=inputs=2[o]",
      '-map', '[o]', '-ar', '48000', '-c:a', 'pcm_s24le', src]);
}
const CASES = [
  ['l0_16.flac', ['-c:a', 'flac', '-compression_level', '0', '-sample_fmt', 's16']],
  ['l5_16.flac', ['-c:a', 'flac', '-compression_level', '5', '-sample_fmt', 's16']],
  ['l12_16.flac', ['-c:a', 'flac', '-compression_level', '12', '-sample_fmt', 's16']],
  ['l8_24.flac', ['-c:a', 'flac', '-compression_level', '8', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']],
  ['mono_16.flac', ['-c:a', 'flac', '-ac', '1', '-sample_fmt', 's16']],
  ['ind_16.flac', ['-c:a', 'flac', '-ch_mode', 'indep', '-sample_fmt', 's16']],
  ['ms_16.flac', ['-c:a', 'flac', '-ch_mode', 'mid_side', '-sample_fmt', 's16']],
  ['ls_16.flac', ['-c:a', 'flac', '-ch_mode', 'left_side', '-sample_fmt', 's16']],
  ['rs_16.flac', ['-c:a', 'flac', '-ch_mode', 'right_side', '-sample_fmt', 's16']],
  ['fixed_16.flac', ['-c:a', 'flac', '-lpc_type', 'fixed', '-sample_fmt', 's16']],
  ['bs1152_44k.flac', ['-c:a', 'flac', '-frame_size', '1152', '-ar', '44100', '-sample_fmt', 's16']],
  ['ch6_16.flac', ['-c:a', 'flac', '-ac', '6', '-sample_fmt', 's16']],
  ['quiet_16.flac', ['-af', 'volume=0.002', '-c:a', 'flac', '-sample_fmt', 's16']],
];
let bad = 0;
for (const [name, args] of CASES) {
  const f = DIR + name;
  if (!fs.existsSync(f)) ff(['-i', src, ...args, f]);
  const bytes = fs.readFileSync(f);
  const want = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 's16le', '-c:a', 'pcm_s16le', '-'], { maxBuffer: 1 << 30 });
  /* 按 512KB 一块喂（和 Telegram 下载一样），量解码用了多久 */
  const d = Flac.decoder(), parts = [];
  const t0 = performance.now();
  for (let i = 0; i < bytes.length; i += 524288) parts.push(d.push(new Uint8Array(bytes.subarray(i, i + 524288))));
  parts.push(d.end());
  const ms = performance.now() - t0;
  const got = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  const info = d.info, secs = info.samples / info.rate;
  let same = got.length === want.length && got.equals(want), at = -1;
  if (!same) { for (let i = 0; i < Math.min(got.length, want.length); i++) if (got[i] !== want[i]) { at = i; break; } }
  if (!same) bad++;
  console.log(`${same ? '✓' : '✗'} ${name}：${info.rate}Hz ${info.frameChannels}ch ${info.bits} 位 ${secs.toFixed(1)} 秒，解码 ${ms.toFixed(0)}ms（${(secs * 1000 / ms).toFixed(0)} 倍速）` +
    (same ? '' : `，长度 ${got.length} / ${want.length}，第一个不同在字节 ${at}`));
  /* WAV 头：数据长度、声道、采样率 */
  if (same && name === 'l5_16.flac') {
    const h = Buffer.from(Flac.wavHeader(info, got.length));
    const wav = DIR + '_check.wav';
    fs.writeFileSync(wav, Buffer.concat([h, got]));
    const back = execFileSync('ffmpeg', ['-v', 'error', '-i', wav, '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
    const ok = back.equals(want);
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 拼成 WAV 让 ffmpeg 读回来一样`);
    fs.unlinkSync(wav);
  }
}
console.log(bad ? `${bad} 处失败` : '全部通过');
process.exit(bad ? 1 : 0);
