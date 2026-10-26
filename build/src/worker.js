/* 后台线程里的 mtcute：网络、MTProto 加解密、会话存储（IndexedDB）全在这里。
 * 主线程那边是 TelegramWorkerPort + TelegramClient，只转发请求、拿回解好的字节。
 * 为什么：主线程里跑 mtcute，每块 512KB 的解密 + 校验成批到达时一卡 300–850ms（2026-10-01 电视实测，
 * 同一时刻我们自己拼分段只用了 ≤11ms）。
 * 凭证由主线程拼在脚本前面：self.TG_CFG = {apiId, apiHash, storage}。 */
import './compat.js';   // 要在 mtcute 之前（required_version 那代引擎缺的 API）
import { BaseTelegramClient, TelegramWorker, WebCryptoProvider } from '@mtcute/web';
import wasmSimd from '../node_modules/@mtcute/wasm/mtcute-simd.wasm';
import wasmPlain from '../out/mtcute-mvp.wasm';   // 降成 MVP 的那份（bundle.sh），Tizen 5.5 认

const simd = WebAssembly.validate(new Uint8Array(
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
// 后台线程里可以同步编译（4KB 的限制只管主线程），这样 mount 之前什么都不用等，主线程发来的第一条消息不会丢
const module = new WebAssembly.Module(simd ? wasmSimd : wasmPlain);
const cfg = self.TG_CFG;

const client = new BaseTelegramClient({
  apiId: cfg.apiId,
  apiHash: cfg.apiHash,
  storage: cfg.storage || 'tg-session',      // 每个账号一个库（app/js/accounts.js）
  crypto: new WebCryptoProvider({ wasmInput: module }),
  initConnectionOptions: { deviceModel: 'Samsung TV', systemVersion: 'Tizen', appVersion: '0.1' },
  logLevel: 2,
});

new TelegramWorker({ client }).mount();
