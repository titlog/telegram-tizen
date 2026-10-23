#!/bin/zsh
# mtcute 打包，deploy.sh 和 release.sh 共用：zsh build/bundle.sh <输出的 tg.bundle.js>
# 两步：后台线程那份（src/worker.js）先打成文本 out/worker.bundle.txt，再作为字符串嵌进主线程那份（src/entry.js）。
#
# TARGET 要跟着 app/config.xml 的 required_version 走（Tizen 6.0 = Chromium 76）。1.1.2 以前打的是 chrome120：
# 2026-10-22 两台 Tizen 6.0 的电视每次启动都是「Unexpected token (」（@fuman/utils 里的私有方法，Chromium 84 才认），
# TGLib 没定义，整个应用打不开。tools/syntax-verify.mjs 拿打出来的两份对着 required_version 那代引擎查，deploy / release 卡着。
#
# 这个文件算进 tools/update-lib.mjs 的 vendorPrint()：打包参数一变，tg.bundle.js 就变了，而它不随更新下发 ——
# 这就是换了壳，boot.js 的 SHELL 要加一（update-verify / update-release 卡着）。
set -e
OUT="${1:?用法：zsh build/bundle.sh <输出的 tg.bundle.js>}"
OUT="${OUT:A}"
cd "${0:A:h}"
TARGET=chrome76
[ -d node_modules ] || npm ci --no-audit --no-fund
mkdir -p out
npx esbuild src/worker.js --bundle --format=iife --target=$TARGET --loader:.wasm=binary \
  --minify --legal-comments=none --log-level=warning --outfile=out/worker.bundle.txt
npx esbuild src/entry.js --bundle --format=iife --target=$TARGET --loader:.wasm=binary --loader:.txt=text \
  --minify --legal-comments=none --log-level=warning --outfile="$OUT"
