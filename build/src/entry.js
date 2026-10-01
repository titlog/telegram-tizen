/* 打包入口：mtcute（Telegram 协议）+ 二维码生成，打成一个经典脚本，只往全局放 TGLib 一个名字。
 * - mtcute 默认放在后台线程（src/worker.js，先单独打包成文本再嵌进来）；建不起来就退回主线程直连。
 * - 电视上页面是 file://，Worker 不能从文件起，所以用 blob: 地址；fetch 也拿不到包里的 .wasm，
 *   所以 wasm 以字节形式打进脚本（esbuild binary loader）。
 * - 不用 <script type=module>：file:// 页面的模块脚本在 Chromium 里按跨域处理。 */
import { TelegramClient, TelegramWorkerPort, WebCryptoProvider } from '@mtcute/web';
import wasmSimd from '../node_modules/@mtcute/wasm/mtcute-simd.wasm';
import wasmPlain from '../node_modules/@mtcute/wasm/mtcute.wasm';
import workerSrc from '../out/worker.bundle.txt';
import qrcode from 'qrcode-generator';

// 和 @mtcute/wasm 自己判断 SIMD 的那段字节码一样
const simd = WebAssembly.validate(new Uint8Array(
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

const INIT = { deviceModel: 'Samsung TV', systemVersion: 'Tizen', appVersion: '0.1' };

function createInWorker(apiId, apiHash) {
  const url = URL.createObjectURL(new Blob(
    ['self.TG_CFG=' + JSON.stringify({ apiId, apiHash }) + ';\n', workerSrc], { type: 'text/javascript' }));
  const worker = new Worker(url);
  const port = new TelegramWorkerPort({ worker });
  return new TelegramClient({ client: port });
}

/* 退路：主线程直连。交给 mtcute 的必须是编译好的 WebAssembly.Module：给它字节的话，它的 loadWasmBinary 走
 * WebAssembly.instantiate(bytes)，拿回的是 {module, instance}，initSync 却当成 Instance 用，
 * 抛「WebAssembly.Module(): Argument 0 must be a buffer source」（mtcute 0.32.3）。
 * 主线程也不能 new WebAssembly.Module 同步编译：Chromium 不许在主线程同步编译 4KB 以上的模块。 */
async function createDirect(apiId, apiHash) {
  const module = await WebAssembly.compile(simd ? wasmSimd : wasmPlain);
  return new TelegramClient({
    apiId, apiHash, storage: 'tg-session',
    crypto: new WebCryptoProvider({ wasmInput: module }),
    initConnectionOptions: INIT, logLevel: 2,
  });
}

async function create(apiId, apiHash, mode) {
  if (mode !== 'direct') {
    try { return { client: createInWorker(apiId, apiHash), mode: 'worker' }; }
    catch (e) { return { client: await createDirect(apiId, apiHash), mode: 'direct（后台线程建不起来：' + (e && e.message) + '）' }; }
  }
  return { client: await createDirect(apiId, apiHash), mode: 'direct' };
}

function qrSvg(text, cell) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: cell || 10, margin: 4, scalable: true });
}

window.TGLib = { create, qrSvg, simd };
