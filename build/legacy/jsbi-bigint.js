/* 没有 BigInt 的引擎（Tizen 5.0 = Chromium 63）用的 mtcute 包（build/legacy/build-legacy.mjs）里，下面这几个模块整个换成这里的
 * JSBI 版本：@fuman/utils 的 bigint（bundle / math / bytes）、mtcute 的 utils/bigint-utils、crypto/miller-rabin、crypto/factorization。
 * 函数名、参数、返回值和原来一样，只是数都是 JSBI（全局的 JSBI，包的最前面拼着）。原来的写法混着 BigInt 和普通数字比较
 * （`r >= i`、`i++`），babel-plugin-transform-bigint 改不对，所以手写；test/legacy-bigint.mjs 对着原生 BigInt 随机对拍。
 * 只在握手（建授权密钥）、两步验证时用，下载、看片子都不走这里。 */
/* global JSBI */
import BN from "bn.js";
var Z = JSBI.BigInt(0), ONE = JSBI.BigInt(1), TWO = JSBI.BigInt(2);
function big(x) { return typeof x === "number" || typeof x === "string" ? JSBI.BigInt(x) : x; }

/* ---------- @fuman/utils/bigint/math.js ---------- */
export function bitLength(n) {
    if (JSBI.equal(n, Z)) { return 0; }
    return (JSBI.lessThan(n, Z) ? JSBI.unaryMinus(n) : n).toString(2).length;
}
export function twoMultiplicity(n) {
    if (JSBI.equal(n, Z)) { return Z; }
    var s = n.toString(2), m = 0;
    for (var i = s.length - 1; i >= 0 && s.charCodeAt(i) === 48; i--) { m++; }
    return JSBI.BigInt(m);
}
export function min2(a, b) { return JSBI.lessThan(a, b) ? a : b; }
export function max2(a, b) { return JSBI.greaterThan(a, b) ? a : b; }
export function min() { var m = arguments[0]; for (var i = 1; i < arguments.length; i++) { if (JSBI.lessThan(arguments[i], m)) { m = arguments[i]; } } return m; }
export function max() { var m = arguments[0]; for (var i = 1; i < arguments.length; i++) { if (JSBI.greaterThan(arguments[i], m)) { m = arguments[i]; } } return m; }
export function abs(a) { return JSBI.lessThan(a, Z) ? JSBI.unaryMinus(a) : a; }
export function euclideanGcd(a, b) {
    while (!JSBI.equal(b, Z)) { var t = b; b = JSBI.remainder(a, b); a = t; }
    return a;
}
/* 模幂：奇数模（RSA、DH 素数、素数检验都是）用 bn.js 的 Montgomery 乘法，比 JSBI 平方乘快 2.4 倍（Node 上 2048 位：bn.js 63ms、
 * JSBI 160ms、原生 BigInt 8ms；握手要两次）。偶数模、负数底照原来的平方乘，指数按二进制串从高位走。 */
function bn(j) { return new BN(j.toString(16), 16); }
export function modPowBinary(base, exp, mod) {
    base = JSBI.remainder(big(base), mod);
    exp = big(exp);
    var r = ONE;
    if (JSBI.lessThanOrEqual(exp, Z)) { return r; }
    if (!JSBI.lessThan(base, Z) && JSBI.greaterThan(mod, TWO) && JSBI.equal(JSBI.remainder(mod, TWO), ONE)) {
        return JSBI.BigInt("0x" + bn(base).toRed(BN.mont(bn(mod))).redPow(bn(exp)).fromRed().toString(16));
    }
    var bits = exp.toString(2);
    for (var i = 0; i < bits.length; i++) {
        r = JSBI.remainder(JSBI.multiply(r, r), mod);
        if (bits.charCodeAt(i) === 49) { r = JSBI.remainder(JSBI.multiply(r, base), mod); }
    }
    return r;
}
function eGcd(a, b) {
    var x = Z, y = ONE, u = ONE, v = Z;
    while (!JSBI.equal(a, Z)) {
        var q = JSBI.divide(b, a), r = JSBI.remainder(b, a);
        var m = JSBI.subtract(x, JSBI.multiply(u, q)), n = JSBI.subtract(y, JSBI.multiply(v, q));
        b = a; a = r; x = u; y = v; u = m; v = n;
    }
    return [b, x, y];
}
function toZn(a, n) {
    a = big(a); n = big(n);
    if (JSBI.lessThanOrEqual(n, Z)) { throw new RangeError("n must be > 0"); }
    var aZn = JSBI.remainder(a, n);
    return JSBI.lessThan(aZn, Z) ? JSBI.add(aZn, n) : aZn;
}
export function modInv(a, n) {
    var r = eGcd(toZn(a, n), n);
    if (!JSBI.equal(r[0], ONE)) { throw new RangeError(a.toString() + " does not have inverse modulo " + n.toString()); }
    return toZn(r[1], n);
}

/* ---------- @fuman/utils/bigint/bytes.js ---------- */
export function toBytes(value, length, le) {
    length = length || 0;
    var hex = JSBI.equal(value, Z) ? "" : value.toString(16);
    if (hex.length % 2) { hex = "0" + hex; }
    var bytes = hex.length / 2;
    if (length !== 0 && bytes > length) { throw new Error("Value out of bounds"); }
    if (length === 0) { length = bytes; }
    var u8 = new Uint8Array(length), off = length - bytes;
    for (var i = 0; i < bytes; i++) { u8[off + i] = parseInt(hex.substr(i * 2, 2), 16); }
    if (le) { u8.reverse(); }
    return u8;
}
export function fromBytes(buffer, le) {
    var hex = "";
    for (var i = 0; i < buffer.length; i++) {
        var b = buffer[le ? buffer.length - 1 - i : i];
        hex += (b < 16 ? "0" : "") + b.toString(16);
    }
    return hex ? JSBI.BigInt("0x" + hex) : Z;
}

/* ---------- @mtcute/core/utils/bigint-utils.js ---------- */
export function randomBigInt(crypto, size) { return fromBytes(crypto.randomBytes(size)); }
export function randomBigIntBits(crypto, bits) {
    var num = randomBigInt(crypto, Math.ceil(bits / 8)), bl = bitLength(num);
    if (bl > bits) { num = JSBI.signedRightShift(num, JSBI.BigInt(bl - bits)); }
    return num;
}
export function randomBigIntInRange(crypto, max, min) {
    min = min === undefined ? ONE : min;
    var interval = JSBI.subtract(max, min);
    if (JSBI.lessThan(interval, Z)) { throw new Error("expected min < max"); }
    var result = randomBigInt(crypto, Math.ceil(bitLength(interval) / 8));
    while (JSBI.greaterThan(result, interval)) { result = JSBI.subtract(result, interval); }
    return JSBI.add(min, result);
}

/* ---------- @mtcute/core/utils/crypto/miller-rabin.js（逐行照原来的逻辑） ---------- */
export function millerRabin(crypto, n, rounds) {
    rounds = rounds === undefined ? 20 : rounds;
    if (JSBI.lessThan(n, JSBI.BigInt(4))) { return JSBI.greaterThan(n, ONE); }
    if (JSBI.equal(JSBI.remainder(n, TWO), Z) || JSBI.lessThan(n, Z)) { return false; }
    var nBits = bitLength(n), nSub = JSBI.subtract(n, ONE), r = twoMultiplicity(nSub), d = JSBI.signedRightShift(nSub, r);
    for (var i = 0; i < rounds; i++) {
        var base;
        do { base = randomBigIntBits(crypto, nBits); } while (JSBI.lessThanOrEqual(base, ONE) || JSBI.greaterThanOrEqual(base, nSub));
        var x = modPowBinary(base, d, n);
        if (JSBI.equal(x, ONE) || JSBI.equal(x, nSub)) { continue; }
        var i2 = Z, y;
        while (JSBI.lessThan(i2, r)) {
            y = modPowBinary(x, TWO, n);
            if (JSBI.equal(x, ONE)) { return false; }
            if (JSBI.equal(x, nSub)) { break; }
            i2 = JSBI.add(i2, ONE);
            x = y;
        }
        if (JSBI.equal(i2, r)) { return false; }
    }
    return true;
}

/* ---------- @mtcute/core/utils/crypto/factorization.js ----------
 * Pollard-rho（Brent）。原来 r、k 是 BigInt、m 是随机大数，只当循环次数用：这里 r、k 用普通数字（r 是 2 的幂，几十万以内），
 * m 取近似值（比 r 大得多，min(m, r - k) 就是 r - k）。 */
function pollardRhoBrent(crypto, n) {
    if (JSBI.equal(JSBI.remainder(n, TWO), Z)) { return TWO; }
    var nm1 = JSBI.subtract(n, ONE);
    var y = randomBigIntInRange(crypto, nm1), c = randomBigIntInRange(crypto, nm1), mNum = JSBI.toNumber(randomBigIntInRange(crypto, nm1));
    var f = function (v) { return JSBI.remainder(JSBI.add(JSBI.remainder(JSBI.multiply(v, v), n), c), n); };
    var g = ONE, r = 1, q = ONE, ys, x;
    while (JSBI.equal(g, ONE)) {
        x = y;
        for (var i = 0; r >= i; i++) { y = f(y); }
        var k = 0;
        while (k < r && JSBI.equal(g, ONE)) {
            ys = y;
            var lim = Math.min(mNum, r - k);
            for (var j = 0; j < lim; j++) { y = f(y); q = JSBI.remainder(JSBI.multiply(q, abs(JSBI.subtract(x, y))), n); }
            g = euclideanGcd(q, n);
            k = k + mNum;
        }
        r *= 2;
    }
    if (JSBI.equal(g, n)) {
        do { ys = f(ys); g = euclideanGcd(JSBI.subtract(x, ys), n); } while (JSBI.lessThanOrEqual(g, ONE));
    }
    return g;
}
export function factorizePQSync(crypto, pq) {
    var pq_ = fromBytes(pq), n = pollardRhoBrent(crypto, pq_), m = JSBI.divide(pq_, n);
    var p = JSBI.lessThan(n, m) ? n : m, q = JSBI.lessThan(n, m) ? m : n;
    return [toBytes(p), toBytes(q)];
}
