#!/bin/zsh
# mtcute 打包，deploy.sh 和 release.sh 共用：zsh build/bundle.sh <输出的 tg.bundle.js>
# 两步：后台线程那份（src/worker.js）先打成文本 out/worker.bundle.txt，再作为字符串嵌进主线程那份（src/entry.js）。
#
# 这份（正常那份）只在有 BigInt 的引擎上用，TARGET 是 Tizen 5.5 = Chromium 69（1.1.3–1.1.7 是 6.0 = 76）；required_version 是 5.0，
# 没有 BigInt 的 5.0 用最后打的 tg.legacy.js（chrome63）。1.1.2 以前打的是 chrome120：
# 2026-10-22 两台 Tizen 6.0 的电视每次启动都是「Unexpected token (」（@fuman/utils 里的私有方法，Chromium 84 才认），
# TGLib 没定义，整个应用打不开。tools/syntax-verify.mjs 拿打出来的两份对着 required_version 那代引擎查，deploy / release 卡着。
#
# 这个文件算进 tools/update-lib.mjs 的 vendorPrint()：打包参数一变，tg.bundle.js 就变了，而它不随更新下发 ——
# 这就是换了壳，boot.js 的 SHELL 要加一（update-verify / update-release 卡着）。
set -e
OUT="${1:?用法：zsh build/bundle.sh <输出的 tg.bundle.js>}"
OUT="${OUT:A}"
cd "${0:A:h}"
TARGET=chrome69
[ -d node_modules ] || npm ci --no-audit --no-fund
mkdir -p out
# mtcute 不带 SIMD 的那份 wasm 用了 Chromium 74–75 才有的指令（非陷入的浮点转整数、符号扩展、memory.copy / fill）：
# 2026-10-25 一台 Tizen 5.5（Chromium 69）的电视卡在「Compiling wasm function … Invalid opcode (enable with
# --experimental-wasm-sat_f2i_conversions)」。用 binaryen 降成最早那版 WebAssembly（MVP），降不干净就不打包。带 SIMD 的那份只在
# 认 SIMD 的引擎（Chromium 91 起）上用，那些引擎什么都认，不动。降过的 sha256 / sha1 / IGE / CTR / 压缩 / 解压和原版逐项一致。
npx wasm-opt node_modules/@mtcute/wasm/mtcute.wasm \
  --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals \
  --llvm-nontrapping-fptoint-lowering --signext-lowering --llvm-memory-copy-fill-lowering -o out/mtcute-mvp.wasm
npx wasm-opt -q out/mtcute-mvp.wasm --mvp-features -o /dev/null || { echo "  wasm 没降成 MVP"; exit 1; }
npx esbuild src/worker.js --bundle --format=iife --target=$TARGET --loader:.wasm=binary \
  --minify --legal-comments=none --log-level=warning --outfile=out/worker.bundle.txt
npx esbuild src/entry.js --bundle --format=iife --target=$TARGET --loader:.wasm=binary --loader:.txt=text \
  --minify --legal-comments=none --log-level=warning --outfile="$OUT"
# 没有 BigInt 的引擎（Tizen 5.0 = Chromium 63）用的那份，放在旁边（boot.js 看 typeof BigInt 挑）：大数换成 JSBI，见 legacy/build-legacy.mjs
node legacy/build-legacy.mjs "${OUT:h}/tg.legacy.js"
