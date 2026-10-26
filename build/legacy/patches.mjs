/* 给没有 BigInt 的引擎打的 mtcute 包里，这两个文件按行改成 JSBI（build-legacy.mjs 用）。每一条 [原文, 改成] 的原文必须在文件里正好出现
 * 一次：mtcute 升级、这两个文件变了，构建就停下来，要人重新对一遍（不会悄悄带着改错的握手出去）。
 * 为什么不交给 babel-plugin-transform-bigint：`KNOWN_DH_PRIME === dhPrime` 这种比较换成 JSBI 对象就成了比身份（永远不等，每次握手都去跑
 * 40 次 2048 位的素性检验，桌面都要 5 秒），`g <= 1` 是 BigInt 和数字混着比，插件都改不对。 */
const J = (s) => `JSBI.BigInt(${s})`;
export const PATCHES = {
  'node_modules/@mtcute/core/network/authorization.js': [
    ['import { typed, bigint, u8 } from "@fuman/utils";', 'import { typed, u8 } from "@fuman/utils";\nimport * as bigint from "../../../../legacy/jsbi-bigint.js";'],
    ['import { millerRabin } from "../utils/crypto/miller-rabin.js";', 'import { millerRabin } from "../../../../legacy/jsbi-bigint.js";'],
    ['const DH_SAFETY_RANGE = 2n ** (2048n - 64n);', `const DH_SAFETY_RANGE = JSBI.exponentiate(${J(2)}, ${J(2048 - 64)});`],
    [/const KNOWN_DH_PRIME = (0x[0-9A-F]+)n;/, (m, hex) => `const KNOWN_DH_PRIME = ${J(`"${hex}"`)};`],
    ['const TWO_POW_2047 = 2n ** 2047n;', `const TWO_POW_2047 = JSBI.exponentiate(${J(2)}, ${J(2047)});`],
    ['const TWO_POW_2048 = 2n ** 2048n;', `const TWO_POW_2048 = JSBI.exponentiate(${J(2)}, ${J(2048)});`],
    ['if (KNOWN_DH_PRIME === dhPrime) {', 'if (JSBI.equal(KNOWN_DH_PRIME, dhPrime)) {'],
    ['checkedPrimesCache.find((x) => x.prime === dhPrime)', 'checkedPrimesCache.find((x) => JSBI.equal(x.prime, dhPrime))'],
    ['if (dhPrime <= TWO_POW_2047 || dhPrime >= TWO_POW_2048) {', 'if (JSBI.lessThanOrEqual(dhPrime, TWO_POW_2047) || JSBI.greaterThanOrEqual(dhPrime, TWO_POW_2048)) {'],
    ['if (!millerRabin(crypto, (dhPrime - 1n) / 2n)) {', `if (!millerRabin(crypto, JSBI.divide(JSBI.subtract(dhPrime, ${J(1)}), ${J(2)}))) {`],
    ['if (dhPrime % 8n !== 7n) {', `if (!JSBI.equal(JSBI.remainder(dhPrime, ${J(8)}), ${J(7)})) {`],
    ['if (dhPrime % 3n !== 2n) {', `if (!JSBI.equal(JSBI.remainder(dhPrime, ${J(3)}), ${J(2)})) {`],
    ['const mod = dhPrime % 5n;\n      if (mod !== 1n && mod !== 4n) {', `const mod = JSBI.toNumber(JSBI.remainder(dhPrime, ${J(5)}));\n      if (mod !== 1 && mod !== 4) {`],
    ['const mod = dhPrime % 24n;\n      if (mod !== 19n && mod !== 23n) {', `const mod = JSBI.toNumber(JSBI.remainder(dhPrime, ${J(24)}));\n      if (mod !== 19 && mod !== 23) {`],
    ['const mod = dhPrime % 7n;\n      if (mod !== 3n && mod !== 5n && mod !== 6n) {', `const mod = JSBI.toNumber(JSBI.remainder(dhPrime, ${J(7)}));\n      if (mod !== 3 && mod !== 5 && mod !== 6) {`],
    ['const keyModulus = BigInt(`0x${key.modulus}`);\n  const keyExponent = BigInt(`0x${key.exponent}`);', 'const keyModulus = JSBI.BigInt(`0x${key.modulus}`);\n  const keyExponent = JSBI.BigInt(`0x${key.exponent}`);'],
    ['if (decryptedDataBigint >= keyModulus) {', 'if (JSBI.greaterThanOrEqual(decryptedDataBigint, keyModulus)) {'],
    ['BigInt(`0x${key.exponent}`),\n    BigInt(`0x${key.modulus}`)', 'JSBI.BigInt(`0x${key.exponent}`),\n    JSBI.BigInt(`0x${key.modulus}`)'],
    ['const g = BigInt(serverDhInner.g);', 'const g = JSBI.BigInt(serverDhInner.g);'],
    ['if (g <= 1 || g >= dhPrime - 1n) {', `if (JSBI.lessThanOrEqual(g, ${J(1)}) || JSBI.greaterThanOrEqual(g, JSBI.subtract(dhPrime, ${J(1)}))) {`],
    ['if (gA <= 1 || gA >= dhPrime - 1n) {', `if (JSBI.lessThanOrEqual(gA, ${J(1)}) || JSBI.greaterThanOrEqual(gA, JSBI.subtract(dhPrime, ${J(1)}))) {`],
    ['if (gB <= 1 || gB >= dhPrime - 1n) {', `if (JSBI.lessThanOrEqual(gB, ${J(1)}) || JSBI.greaterThanOrEqual(gB, JSBI.subtract(dhPrime, ${J(1)}))) {`],
    ['if (gA <= DH_SAFETY_RANGE || gA >= dhPrime - DH_SAFETY_RANGE) {', 'if (JSBI.lessThanOrEqual(gA, DH_SAFETY_RANGE) || JSBI.greaterThanOrEqual(gA, JSBI.subtract(dhPrime, DH_SAFETY_RANGE))) {'],
    ['if (gB <= DH_SAFETY_RANGE || gB >= dhPrime - DH_SAFETY_RANGE) {', 'if (JSBI.lessThanOrEqual(gB, DH_SAFETY_RANGE) || JSBI.greaterThanOrEqual(gB, JSBI.subtract(dhPrime, DH_SAFETY_RANGE))) {'],
  ],
  'node_modules/@mtcute/core/utils/crypto/password.js': [
    ['import { u8, utf8, bigint } from "@fuman/utils";', 'import { u8, utf8 } from "@fuman/utils";\nimport * as bigint from "../../../../../legacy/jsbi-bigint.js";'],
    ['const g = BigInt(algo.g);\n  const p = bigint.fromBytes(algo.p);\n  const x = bigint.fromBytes(_x);', 'const g = JSBI.BigInt(algo.g);\n  const p = bigint.fromBytes(algo.p);\n  const x = bigint.fromBytes(_x);'],
    ['const g = BigInt(algo.g);\n  const _g = bigint.toBytes(g, 256);', 'const g = JSBI.BigInt(algo.g);\n  const _g = bigint.toBytes(g, 256);'],
    ['const kV = k * v % p;\n  let t = gB - kV;\n  if (t < 0n) t += p;\n  const sA = bigint.modPowBinary(t, a + u * x, p);',
     'const kV = JSBI.remainder(JSBI.multiply(k, v), p);\n  let t = JSBI.subtract(gB, kV);\n  if (JSBI.lessThan(t, JSBI.BigInt(0))) t = JSBI.add(t, p);\n  const sA = bigint.modPowBinary(t, JSBI.add(a, JSBI.multiply(u, x)), p);'],
  ],
};
/* 整个换成 jsbi-bigint.js 的模块（导出名一样） */
export const REPLACE = [
  /node_modules[\/\\]@fuman[\/\\]utils[\/\\]bigint[\/\\](bundle|math|bytes)\.js$/,
  /node_modules[\/\\]@mtcute[\/\\]core[\/\\]utils[\/\\]bigint-utils\.js$/,
  /node_modules[\/\\]@mtcute[\/\\]core[\/\\]utils[\/\\]crypto[\/\\](miller-rabin|factorization)\.js$/,
];
/* 用到 BigInt、可下载和看片子用不到的（64 位数读写、比特读取、MTProxy 的伪装 TLS、速率计）：交给 babel-plugin-transform-bigint 做语法
 * 转换，保证在 Chromium 63 上解析得了、模块加载时不出错 */
export const TRANSFORM = /node_modules[\/\\](@fuman[\/\\]io[\/\\](read|write)[\/\\]numbers|@fuman[\/\\]io[\/\\]bits[\/\\][a-z-]+|@mtcute[\/\\]core[\/\\](network[\/\\]mtproxy[\/\\]_fake-tls|highlevel[\/\\]utils[\/\\]rps-meter))\.js$/;
