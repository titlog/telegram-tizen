/* build/legacy/jsbi-bigint.js（没有 BigInt 的引擎用的 JSBI 版大数函数）对着原来的（@fuman/utils 的 bigint、mtcute 的素数检验、
 * 分解质因数，原生 BigInt）随机对拍：确定的函数结果逐个一样；随机的（素数检验、分解）看结果对不对。
 *   node test/legacy-bigint.mjs */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const ROOT = new URL('..', import.meta.url).pathname;
const req = createRequire(ROOT + 'build/package.json');
globalThis.JSBI = (await import(req.resolve('jsbi'))).default;
const L = await import(ROOT + 'build/legacy/jsbi-bigint.js');
const { bigint: N } = await import(req.resolve('@fuman/utils'));
const { millerRabin } = await import(ROOT + 'build/node_modules/@mtcute/core/utils/crypto/miller-rabin.js');
const { factorizePQSync } = await import(ROOT + 'build/node_modules/@mtcute/core/utils/crypto/factorization.js');

const J = (b) => JSBI.BigInt(b.toString());
const S = (j) => j.toString();
const rnd = (bytes) => BigInt('0x' + (crypto.randomBytes(bytes).toString('hex') || '0'));
const cp = { randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)) };
let bad = 0, n = 0;
const eq = (what, a, b) => { n++; if (String(a) !== String(b)) { bad++; if (bad < 10) console.log(`  ✗ ${what}：${String(a).slice(0, 60)} ≠ ${String(b).slice(0, 60)}`); } };

for (let k = 0; k < 300; k++) {
  const size = [1, 4, 8, 9, 16, 32, 64, 128, 256][k % 9];
  const a = rnd(size), b = rnd(size) || 1n, m = rnd(size) | 1n, e = rnd(Math.min(size, 32));
  eq('bitLength', L.bitLength(J(a)), N.bitLength(a));
  eq('twoMultiplicity', S(L.twoMultiplicity(J(a))), N.twoMultiplicity(a));
  eq('euclideanGcd', S(L.euclideanGcd(J(a), J(b))), N.euclideanGcd(a, b));
  eq('min2 / max2', S(L.min2(J(a), J(b))) + S(L.max2(J(a), J(b))), String(N.min2(a, b)) + String(N.max2(a, b)));
  eq('abs', S(L.abs(J(-a))), N.abs(-a));
  eq('modPowBinary', S(L.modPowBinary(J(a), J(e), J(m))), N.modPowBinary(a, e, m));
  if (m > 1n && N.euclideanGcd(a % m, m) === 1n) eq('modInv', S(L.modInv(J(a), J(m))), N.modInv(a, m));
  const len = Math.ceil(N.bitLength(a) / 8) + (k % 3);
  eq('toBytes', Buffer.from(L.toBytes(J(a), k % 2 ? len : 0, k % 4 === 1)).toString('hex'), Buffer.from(N.toBytes(a, k % 2 ? len : 0, k % 4 === 1)).toString('hex'));
  const buf = new Uint8Array(crypto.randomBytes(size));
  eq('fromBytes', S(L.fromBytes(buf, k % 2 === 1)), N.fromBytes(buf, k % 2 === 1));
}
eq('toBytes(0)', L.toBytes(J(0n)).length, N.toBytes(0n).length);
/* 素数检验：已知的素数、合数（含 Telegram 的 DH 素数、Carmichael 数 561） */
const KNOWN = 0xC71CAEB9C6B1C9048E6C522F70F13F73980D40238E3E21C14934D037563D930F48198A0AA7C14058229493D22530F4DBFA336F6E0AC925139543AED44CCE7C3720FD51F69458705AC68CD4FE6B6B13ABDC9746512969328454F18FAF8C595F642477FE96BB2A941D5BCD1D4AC8CC49880708FA9B378E3C4F3A9060BEE67CF9A4A4A695811051907E162753B56B0F6B410DBA74D8A84B2A14B3144E0EF1284754FD17ED950D5965B4B9DD46582DB1178D169C6BC465B0D6FF9CA3928FEF5B9AE4E418FC15E83EBEA0F87FA9FF5EED70050DED2849F47BF959D956850CE929851F0D8115F635B105EE2E4E15D04B2454BF6F4FADF034B10403119CD8E3B92FCC5Bn;
for (const x of [2n, 3n, 5n, 7919n, 2147483647n, 1000000007n, 4n, 561n, 7917n, 1000000007n * 998244353n, KNOWN, KNOWN + 2n]) {
  eq('millerRabin ' + String(x).slice(0, 12), L.millerRabin(cp, J(x), 8), millerRabin(cp, x, 8));
}
/* 分解质因数：两个 ~31 位素数的乘积（Telegram 给的 pq 就是这样）；p * q = pq、p < q */
const primes = [2147483647n, 2147483629n, 1000000007n, 998244353n, 1500000001n, 1073741827n];
let fmax = 0;
for (let i = 0; i < primes.length; i++) for (let j = i + 1; j < primes.length; j++) {
  const pq = primes[i] * primes[j], t0 = performance.now();
  const [p, q] = L.factorizePQSync(cp, N.toBytes(pq));
  fmax = Math.max(fmax, performance.now() - t0);
  const pn = N.fromBytes(p), qn = N.fromBytes(q);
  eq('factorize ' + pq, `${pn * qn === pq && pn < qn && pn > 1n}`, 'true');
  const [p2, q2] = factorizePQSync(cp, N.toBytes(pq));
  eq('factorize 和原来的一样 ' + pq, Buffer.from(p).toString('hex') + Buffer.from(q).toString('hex'), Buffer.from(p2).toString('hex') + Buffer.from(q2).toString('hex'));
}
/* 速度：2048 位模幂（一次握手做两次） */
const m2048 = rnd(256) | 1n, t0 = performance.now();
L.modPowBinary(J(rnd(256)), J(rnd(256)), J(m2048));
console.log(`  2048 位模幂 ${(performance.now() - t0).toFixed(0)}ms，分解 pq 最慢 ${fmax.toFixed(0)}ms`);
console.log(bad ? `✗ ${bad}/${n} 处不一样` : `✓ ${n} 项全一样`);
process.exit(bad ? 1 : 0);
