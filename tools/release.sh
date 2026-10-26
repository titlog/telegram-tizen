#!/bin/zsh
# 给陌生人的 .wgt：zsh tools/release.sh → dist/telegram-tizen-<版本>.wgt
#
# 照搬 douyin-tizen 的 release.sh。不是部署：不碰电视，装的人（Apps2Samsung，或者自己的 tizen 签名档）会用他那台电视的三星证书
# 重新签。所以要紧的是包里有什么、不能有什么：
#
#   - 带着这个项目的 API ID / Hash（2026-10-21，issue #1；用户定的：像 Nicegram 那样内置一组，填写页兜底，见 app/js/apikey.js），
#     但不是明文（用户：「别泄露明文」）：取自 ~/.telegram-tizen.conf，打乱成 TG_API_PACKED，只写进临时目录里的 config.js，仓库里那份
#     保持空值。不是加密，解开它的代码就在包里；挡的是解压之后 grep 和扫十六进制串的工具。读回验证：包里每个文件都没有这个 hash，
#     config.js 里没有 ID 的数字，用 apikey.js 本身解开得到的就是这一组。
#   - 没有上报地址。deploy.sh 把这台电脑的局域网地址写进 config.js；带着它的包会让每台电视往别人网里的一台电脑报日志。
#   - 没有个人证书。SamsungBili 签名档的证书里有账号邮箱、真名和客厅那台电视的 DUID，签进去就在 signature1.xml /
#     author-signature.xml 里公开了。用 bilibili-tizen、douyin-tizen 的发布包同一个一次性签名档（BiliRelease，作者 CN=bilibili-tizen）
#     和 Tizen SDK 自带的分发证书，签完读回检查。
#   - 只有提交了的东西。app/ 取自 `git archive HEAD`；mtcute 的包（js/tg.bundle.js，不进仓库）用 HEAD 里的 build/ 现打。
#     本机的 js/sites.local.js（站点规则，不进仓库）不会进去。
set -e

ROOT="${0:A:h:h}"
cd "$ROOT"

export PATH="$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH"

PROFILES="$HOME/tizen-studio-data/profile/profiles.xml"
PROFILE="BiliRelease"
AUTHOR_NAME="bilibili-tizen"
AUTHOR_P12="$HOME/tizen-studio-data/keystore/author/bilibili-tizen-release.p12"
PW_FILE="$HOME/.bilibili-tizen-release-password"

VERSION=$(python3 -I -c '
import re, sys
s = open(sys.argv[1]).read()
m = re.search(r"<widget\b[^>]*?\bversion=\"([^\"]+)\"", s, re.S)
print(m.group(1) if m else "")
' app/config.xml)
[ -n "$VERSION" ] || { echo "config.xml 里读不到 <widget version>"; exit 1; }
OUT="$ROOT/dist/telegram-tizen-$VERSION.wgt"

echo "== release $VERSION =="

# 包取自 HEAD：没提交的改动不会进去，看起来就像「修好了却没发出去」。
if [ -n "$(git status --porcelain -- app build/src build/bundle.sh build/package.json build/package-lock.json)" ]; then
  echo "  app/ 或 build/ 有未提交的改动 —— 发布包取自 HEAD，这些改动不会进去。先提交或还原："
  git status --short -- app build | sed 's/^/    /'
  exit 1
fi

TG_CONF="$HOME/.telegram-tizen.conf"
[ -f "$TG_CONF" ] || { echo "没有 $TG_CONF（TG_API_ID / TG_API_HASH）—— 发布包要带这一组"; exit 1; }
API_ID=$(source "$TG_CONF"; echo "${TG_API_ID:-}")
API_HASH=$(source "$TG_CONF"; echo "${TG_API_HASH:-}")
[[ "$API_ID" =~ '^[1-9][0-9]*$' && "$API_HASH" =~ '^[0-9a-f]{32}$' ]] || { echo "  $TG_CONF 里的 TG_API_ID / TG_API_HASH 格式不对"; exit 1; }

# 提交了的源码必须已经是公开的样子。deploy.sh 每次打完包都改回去，但中途崩掉的一次会留下地址或凭证，那段时间里的提交就带着它。
git show HEAD:app/js/config.js | grep -q '^var REPORT_TO = "";' \
  || { echo "  HEAD 的 config.js 里 REPORT_TO 不是空的 —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var TG_API_ID = 0;' \
  || { echo "  HEAD 的 config.js 里 TG_API_ID 不是 0 —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var TG_API_HASH = "";' \
  || { echo "  HEAD 的 config.js 里 TG_API_HASH 不是空的 —— 拒绝发布"; exit 1; }
git show HEAD:app/js/config.js | grep -q '^var TG_API_PACKED = "";' \
  || { echo "  HEAD 的 config.js 里 TG_API_PACKED 不是空的 —— 拒绝发布"; exit 1; }
for v in UPDATE_MANIFEST DIAG_TO SELFTEST; do
  git show HEAD:app/js/config.js | grep -q "^var $v = \"\";" || { echo "  HEAD 的 config.js 里 $v 不是空的 —— 拒绝发布"; exit 1; }
done
# 没有接收地址，这一版要带回来的诊断日志就无处可去。
git show HEAD:app/js/diag.js | grep -q '^    var ENDPOINT = "https://[^"]*";' \
  || { echo "  HEAD 的 diag.js 里 ENDPOINT 不是 https 地址 —— 拒绝发布"; exit 1; }

echo "== checking =="
for f in app/js/*.js; do
  [ "${f:t}" = "tg.bundle.js" ] && continue
  node --check "$f" >/dev/null || { echo "  syntax error in $f"; exit 1; }
done
for t in test/i18n.mjs tools/update-verify.mjs tools/diag-verify.mjs; do
  node "$t" >/dev/null || { node "$t" | grep '✗'; echo "  refuse to release"; exit 1; }
done

echo "== signing profile =="
if [ ! -f "$PW_FILE" ]; then
  (umask 077; openssl rand -hex 16 > "$PW_FILE")
  echo "  generated $PW_FILE"
fi
PW=$(cat "$PW_FILE")
if [ ! -f "$AUTHOR_P12" ]; then
  # 只写名字：没有邮箱、组织、地点。这里填的东西会印在每一个发布包里。
  tizen certificate -a "$AUTHOR_NAME" -p "$PW" -n "$AUTHOR_NAME" \
    -f "${AUTHOR_P12:t:r}" >/dev/null
  [ -f "$AUTHOR_P12" ] || { echo "  tizen certificate did not produce $AUTHOR_P12"; exit 1; }
  echo "  author certificate created"
fi
if ! grep -q "profile name=\"$PROFILE\"" "$PROFILES" 2>/dev/null; then
  # 不加 -A（当前签名档保持开发者自己设的）、不加 -d（用 SDK 自带的分发证书，装的时候反正会被换掉）。见 douyin-tizen 的 release.sh。
  tizen security-profiles add -n "$PROFILE" -a "$AUTHOR_P12" -p "$PW" >/dev/null
  echo "  profile $PROFILE created"
else
  echo "  profile $PROFILE already present"
fi
tizen cli-config "profiles.path=$PROFILES" >/dev/null

echo "== bundling mtcute =="
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD app | tar -x -C "$STAGE"
# 打乱：base64(8 字节随机盐 + 「id:hash」逐字节异或 (盐[i%8]·31 + i·17 + 0x5a))。解法在 app/js/apikey.js 的 unpack()，两边要一起改。
PACKED=$(TG_ID="$API_ID" TG_HASH="$API_HASH" python3 -I -c '
import base64, os
data = (os.environ["TG_ID"] + ":" + os.environ["TG_HASH"]).encode()
salt = os.urandom(8)
out = bytes(b ^ ((salt[i % 8] * 31 + i * 17 + 0x5a) & 0xff) for i, b in enumerate(data))
print(base64.b64encode(salt + out).decode())')
sed -i '' -E "s#^var TG_API_PACKED = \"\";#var TG_API_PACKED = \"$PACKED\";#" "$STAGE/app/js/config.js"
# 用 apikey.js 本身解开，得到的必须正好是这一组（解不开的发布包，内置的那组等于没带，每个人都得去填）。
TG_ID="$API_ID" TG_HASH="$API_HASH" node -e '
const fs = require("fs"), vm = require("vm"), [cfg, key] = process.argv.slice(1);
const ctx = { localStorage: { getItem: () => null }, atob: (s) => Buffer.from(s, "base64").toString("latin1") };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(cfg, "utf8") + "\n" + fs.readFileSync(key, "utf8") + "\nthis.got = ApiKey.get();", ctx);
const g = ctx.got || {};
if (g.from !== "build" || String(g.id) !== process.env.TG_ID || g.hash !== process.env.TG_HASH) { console.error("  解开 TG_API_PACKED 得到的不是这一组"); process.exit(1); }
' "$STAGE/app/js/config.js" "$STAGE/app/js/apikey.js" || exit 1
# 和 deploy.sh 同一个脚本（build/ 上面已经确认和 HEAD 一致）
zsh "$ROOT/build/bundle.sh" "$STAGE/app/js/tg.bundle.js"
node --check "$STAGE/app/js/tg.bundle.js" >/dev/null || { echo "  tg.bundle.js 打出来不能解析"; exit 1; }
# 包里每个脚本，对着 required_version 那代电视的引擎查（Tizen 5.0 = Chromium 63；mtcute 正常那份只在有 BigInt 的引擎上用，按 5.5 = 69 查）
JS=("$STAGE"/app/js/**/*.js(N))
node "$ROOT/tools/syntax-verify.mjs" "${JS[@]}" "$ROOT/build/out/worker.bundle.txt" "$ROOT/build/out/worker.legacy.txt" || { echo "  refuse to release"; exit 1; }
node "$ROOT/test/compat.mjs" >/dev/null || { node "$ROOT/test/compat.mjs"; echo "  refuse to release"; exit 1; }
node "$ROOT/test/legacy-bigint.mjs" >/dev/null || { node "$ROOT/test/legacy-bigint.mjs"; echo "  refuse to release"; exit 1; }

echo "== packaging =="
tizen package -t wgt -s "$PROFILE" -- "$STAGE/app" 2>&1 | grep -E "Package File Location|error" || true
WGTS=("$STAGE"/app/*.wgt(N))
[ -n "${WGTS[1]}" ] || { echo "  packaging produced no wgt"; exit 1; }
mkdir -p "$ROOT/dist"
mv "${WGTS[1]}" "$OUT"

# 读回实际写进去的东西，不信上面的步骤。
echo "== verifying package =="
{ git ls-files app | sed 's|^app/||'; echo "js/tg.bundle.js"; } > "$STAGE/expected.txt"
TG_ID="$API_ID" TG_HASH="$API_HASH" python3 -I - "$OUT" "$STAGE/expected.txt" "$AUTHOR_NAME" <<'PY'
import base64, os, re, subprocess, sys, zipfile

wgt, expected_path, author_name = sys.argv[1:4]
z = zipfile.ZipFile(wgt)
names = set(z.namelist())
problems = []

# 正好是提交了的文件 + mtcute 的包 + 两个签名，多一个就是混进来的。
expected = set(open(expected_path).read().split("\n")) - {""}
signatures = {"author-signature.xml", "signature1.xml"}
for n in sorted(names - expected - signatures):
    if not n.endswith("/"):
        problems.append("unexpected file in package: " + n)
for n in sorted(expected - names):
    problems.append("missing from package: " + n)
for n in sorted(signatures - names):
    problems.append("package is not signed: no " + n)

cfg = z.read("js/config.js").decode("utf-8")
if not re.search(r'^var REPORT_TO = "";', cfg, re.M):
    problems.append("config.js: REPORT_TO is not empty")
if not re.search(r'^var TG_API_ID = 0;$', cfg, re.M):
    problems.append("config.js: TG_API_ID is not 0 (plaintext id)")
if not re.search(r'^var TG_API_HASH = "";$', cfg, re.M):
    problems.append("config.js: TG_API_HASH is not empty (plaintext hash)")
if not re.search(r'^var TG_API_PACKED = "[A-Za-z0-9+/=]{40,}";$', cfg, re.M):
    problems.append("config.js: TG_API_PACKED is missing")
for v in ("UPDATE_MANIFEST", "DIAG_TO", "SELFTEST"):
    if not re.search(r'^var %s = "";$' % v, cfg, re.M):
        problems.append("config.js: %s is not empty" % v)
if re.search(r'(?<!\d)%s(?!\d)' % re.escape(os.environ["TG_ID"]), cfg):
    problems.append("config.js: the API ID appears in plaintext")
# 明文的 hash 不许出现在任何一个文件里（不止 config.js：打包、改写出错时它可能落在别处）。
secret = os.environ["TG_HASH"].lower().encode()
for n in names:
    if secret in z.read(n).lower():
        problems.append("the API hash appears in plaintext in " + n)

def certs(xml):
    for b64 in re.findall(r"<X509Certificate>\s*(.*?)\s*</X509Certificate>", xml, re.S):
        der = base64.b64decode(re.sub(r"\s", "", b64))
        out = subprocess.run(
            ["openssl", "x509", "-inform", "DER", "-noout", "-subject", "-issuer", "-ext", "subjectAltName"],
            input=der, capture_output=True).stdout.decode()
        yield out

for sig in sorted(signatures & names):
    for i, text in enumerate(certs(z.read(sig).decode("utf-8"))):
        subject = re.search(r"^subject=(.*)$", text, re.M)
        subject = subject.group(1).strip() if subject else "?"
        print("  %s #%d %s" % (sig, i, subject))
        # 三星签发的证书是按人发的：写着账号、绑着一台电视的 DUID，哪一张都不该进公开的包。
        if "Samsung" in text or "deviceid=" in text or "emailAddress" in text:
            problems.append("%s carries a personal certificate: %s" % (sig, subject))
    if sig == "author-signature.xml":
        leaf = next(certs(z.read(sig).decode("utf-8")), "")
        if not re.search(r"^subject=\s*CN\s*=\s*%s\s*$" % re.escape(author_name), leaf, re.M):
            problems.append("author certificate is not the release one (CN=%s)" % author_name)

if problems:
    for p in problems:
        print("  !! " + p)
    sys.exit(1)
print("  %d files, REPORT_TO / UPDATE_MANIFEST / DIAG_TO / SELFTEST empty, the project's API ID / Hash packed (no plaintext in any file), no personal certificate" % len(names - signatures))
PY

echo "== done =="
echo "  $OUT"
echo "  $(wc -c < "$OUT" | tr -d ' ') bytes  sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
