/* 桌面测试用的静态服务器：支持 Range，可以限速、加延迟，模拟电视从 Telegram 取数据（实测 ~2MB/s、首块 0.4–0.9s）。
 *   node test/serve.mjs [端口=8768]   环境变量 RATE=字节/秒（默认 2MB/s，0 = 不限） LAT=每个请求的延迟毫秒（默认 400） */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[2] || 8768);
const RATE = process.env.RATE === undefined ? 2 * 1048576 : Number(process.env.RATE);
const LAT = Number(process.env.LAT ?? 400);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mp4': 'video/mp4', '.png': 'image/png', '.css': 'text/css' };
const sleep = (t) => new Promise(r => setTimeout(r, t));

http.createServer(async (req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = +m[1], end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  if (type === 'video/mp4' && LAT) await sleep(LAT);
  res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`,
    'accept-ranges': 'bytes', 'access-control-allow-origin': '*' });
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(end - start + 1);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  if (type === 'video/mp4' && RATE) await sleep(buf.length / RATE * 1000);
  res.end(buf);
}).listen(PORT, () => console.log(`serve :${PORT} RATE=${RATE} LAT=${LAT}`));
