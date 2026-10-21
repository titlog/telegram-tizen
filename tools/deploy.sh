#!/bin/zsh
# 打包 mtcute → 写入上报地址和凭证 → 签名 → 安装 → 启动。
# 电视、证书、签名档沿用 bilibili-tizen 的（~/.bilibili-tizen.conf、签名档 SamsungBili）——同一台电视、
# 同一张分发证书，证书按设备签，不按应用签。Telegram 凭证在 ~/.telegram-tizen.conf（不进仓库）。
#   zsh tools/deploy.sh
#   zsh tools/deploy.sh --noapi    不写凭证：和发布包一样，第一次打开要在电视上填 API ID / Hash（apikey.js）；测完装回正常构建
set -e
NOAPI=""
for a in "$@"; do
  case "$a" in
    --noapi) NOAPI=1 ;;
  esac
done

ROOT="${0:A:h:h}"
APP="$ROOT/app"
APP_ID=$(sed -n 's/.*<tizen:application id="\([^"]*\)".*/\1/p' "$APP/config.xml")
[ -n "$APP_ID" ] || { echo "config.xml 里读不到应用 id"; exit 1; }
PORT="${TG_REPORT_PORT:-8097}"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"
CONF="${BILI_TIZEN_CONF:-$HOME/.bilibili-tizen.conf}"
[ -f "$CONF" ] || { echo "没有 $CONF —— 先在 bilibili-tizen 里跑 zsh tools/setup.sh"; exit 1; }
source "$CONF"
TG_CONF="$HOME/.telegram-tizen.conf"
[ -f "$TG_CONF" ] || { echo "没有 $TG_CONF（TG_API_ID / TG_API_HASH，从 my.telegram.org 拿）"; exit 1; }
source "$TG_CONF"
: "${TG_API_ID:?}" "${TG_API_HASH:?}"
PROFILE="${BILI_PROFILE:-SamsungBili}"
TV_IP="${BILI_TV_IP:?}"
TARGET="${BILI_TV_TARGET:?}"
NET_IF="${BILI_NET_IF:-en0}"
TV="$TV_IP:26101"
tizen cli-config "profiles.path=$HOME/tizen-studio-data/profile/profiles.xml" >/dev/null

HOST_IP=$(ipconfig getifaddr "$NET_IF")
[ -n "$HOST_IP" ] || { echo "拿不到 $NET_IF 的地址"; exit 1; }

echo "== bundling =="
[ -d "$ROOT/build/node_modules" ] || (cd "$ROOT/build" && npm ci --no-audit --no-fund)
# 两步：后台线程那份（src/worker.js）先打成文本，再作为字符串嵌进主线程那份
(cd "$ROOT/build" && mkdir -p out && \
  npx esbuild src/worker.js --bundle --format=iife --target=chrome120 --loader:.wasm=binary \
    --minify --legal-comments=none --log-level=warning --outfile=out/worker.bundle.txt && \
  npx esbuild src/entry.js --bundle --format=iife --target=chrome120 --loader:.wasm=binary --loader:.txt=text \
    --minify --legal-comments=none --log-level=warning --outfile="$APP/js/tg.bundle.js")
for f in "$APP"/js/*.js; do node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }; done

echo "== report -> http://$HOST_IP:$PORT =="
CFG="$APP/js/config.js"
restore() {
  sed -i '' -E -e 's#^var REPORT_TO = "[^"]*";#var REPORT_TO = "";#' \
    -e 's#^var TG_API_ID = [0-9]+;#var TG_API_ID = 0;#' \
    -e 's#^var TG_API_HASH = "[^"]*";#var TG_API_HASH = "";#' "$CFG"
}
trap restore EXIT
sed -i '' -E -e "s#^var REPORT_TO = \"[^\"]*\";#var REPORT_TO = \"http://$HOST_IP:$PORT\";#" "$CFG"
if [ -n "$NOAPI" ]; then
  echo "  --noapi：包里不带 API ID / Hash，电视上第一次打开要填（已经填过的话用填过的）"
else
  sed -i '' -E -e "s#^var TG_API_ID = [0-9]+;#var TG_API_ID = $TG_API_ID;#" \
    -e "s#^var TG_API_HASH = \"[^\"]*\";#var TG_API_HASH = \"$TG_API_HASH\";#" "$CFG"
fi

echo "== packaging =="
cd "$APP"
rm -f ./*.wgt(N)
tizen package -t wgt -s "$PROFILE" -- . 2>&1 | grep -E "Package File Location|error" || true
# 凭证已经在包里了，源码马上改回空值：仓库里不存（trap 兜底，中途失败也会改回）。
restore
WGTS=(./*.wgt(N)); WGT=${WGTS[1]}
[ -n "$WGT" ] || { echo "packaging produced no wgt"; exit 1; }
# 包按 <name> 命名（「TG 视频.wgt」），带空格的名字 tizen install 装不上，一行输出都没有。
mv "$WGT" ./TgVideo.wgt; WGT=./TgVideo.wgt
echo "  built $WGT"

# sdb 的后台服务活不过一次命令：连接和安装必须在同一个脚本里。
echo "== connecting =="
for i in $(seq 1 20); do
  sdb connect "$TV" >/dev/null 2>&1 || true
  if sdb devices 2>/dev/null | grep -q "$TV_IP.*device"; then echo "  connected"; break; fi
  sleep 5
done
sdb devices | grep -q "$TV_IP" || { echo "TV not reachable at $TV_IP（醒着吗？开发者模式登记的还是这台电脑吗？）"; exit 1; }
# 设备列表里是 device，通道却可能早就卡死了：2026-10-02 一个跑了 17 小时的旧 sdb 服务，连 shell echo 都不回，
# tizen install 一声不吭地等了 13 分钟。先试一下，不通就重启服务再连。
if ! perl -e 'alarm 15; exec @ARGV' sdb -s "$TV" shell echo ok >/dev/null 2>&1; then
  echo "  sdb 通道不通，重启 sdb 服务"
  sdb kill-server >/dev/null 2>&1 || true
  sdb connect "$TV" >/dev/null 2>&1 || true
  perl -e 'alarm 15; exec @ARGV' sdb -s "$TV" shell echo ok >/dev/null 2>&1 || { echo "重启 sdb 之后还是不通"; exit 1; }
fi

echo "== installing =="
perl -e 'alarm 240; exec @ARGV' tizen install -n "$(basename "$WGT")" -t "$TARGET" 2>&1 | grep -E "install completed|successfully|failed|error" \
  || { echo "  install produced no recognisable result"; exit 1; }

echo "== launching =="
tizen run -p "$APP_ID" -t "$TARGET" 2>&1 | grep -E "successfully|failed" || true
echo "== done =="
