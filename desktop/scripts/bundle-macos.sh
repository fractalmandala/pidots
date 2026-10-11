#!/usr/bin/env bash
# Builds Pidots.app (GPUI Kit shell + bundled Node server) and packs it into a .dmg.
#
#   npm run desktop:dmg            # or: bash desktop/scripts/bundle-macos.sh
#
# Output: desktop/target/dist/Pidots-<version>-<arch>.dmg
# Every build bumps the patch version (package.json, package-lock.json and
# desktop/Cargo.toml), so each .dmg is distinguishable. Options (environment):
# BUMP=minor|major to bump further, BUMP=none to rebuild the same version,
# NODE_VERSION=24.x.y to pin the bundled runtime,
# SIGN_IDENTITY="Developer ID Application: …" to sign for distribution
# (default "-" is an ad-hoc signature, fine for your own Macs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP="$ROOT/desktop"
OUT="$DESKTOP/target/dist"
WORK="$DESKTOP/target/bundle"
APP="$OUT/Pidots.app"
BUMP="${BUMP:-patch}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"

case "$(uname -m)" in
  arm64) NODE_ARCH=arm64; RUST_TARGET=aarch64-apple-darwin ;;
  x86_64) NODE_ARCH=x64; RUST_TARGET=x86_64-apple-darwin ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

cd "$ROOT"
if [[ "$BUMP" != "none" ]]; then
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi
VERSION="$(node -p "require('$ROOT/package.json').version")"
sed -i '' -E "1,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" "$DESKTOP/Cargo.toml"
printf '\033[1mPidots %s\033[0m\n' "$VERSION"

step "Building the web app and server"
[[ -d node_modules ]] || npm ci
npm run build

step "Bundling the server"
rm -rf "$WORK" && mkdir -p "$WORK/app/dist"
cp -R "$ROOT/dist/client" "$WORK/app/dist/client"
node "$DESKTOP/scripts/bundle-server.mjs" "$WORK/app/server.mjs"

step "Fetching the official Node.js runtime"
# Homebrew's node links against Homebrew dylibs, so ship the self-contained nodejs.org build.
if [[ -z "${NODE_VERSION:-}" ]]; then
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).find(r=>r.version.startsWith("v24."));process.stdout.write(v.version.slice(1))})')"
fi
NODE_DIST="node-v$NODE_VERSION-darwin-$NODE_ARCH"
NODE_CACHE="$DESKTOP/target/node-cache"
mkdir -p "$NODE_CACHE"
if [[ ! -f "$NODE_CACHE/$NODE_DIST.tar.gz" ]]; then
  curl -fL --progress-bar -o "$NODE_CACHE/$NODE_DIST.tar.gz" \
    "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIST.tar.gz"
fi
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" |
  grep " $NODE_DIST.tar.gz\$" > "$NODE_CACHE/$NODE_DIST.sha256"
(cd "$NODE_CACHE" && shasum -a 256 -c "$NODE_DIST.sha256")
tar -xzf "$NODE_CACHE/$NODE_DIST.tar.gz" -C "$WORK" "$NODE_DIST/bin/node"

step "Building the computer helper (release)"
swift build -c release --package-path "$DESKTOP/computers"

step "Building the speech helper (release)"
swift build -c release --package-path "$DESKTOP/speech"

step "Fetching the pinned Linux kernel"
# Kata Containers 3.26.0 arm64, the kernel Apple's Containerization examples use.
KATA_URL="https://github.com/kata-containers/kata-containers/releases/download/3.26.0/kata-static-3.26.0-arm64.tar.zst"
KATA_SHA256="83cf59d06ef66565338f78eb47c34a4885d8d79312178650efb5b2cdad357922"
KERNEL_SHA256="63e2f3ba1904c0f944183516e31b4deac09c2042ce9bedf1f55d7c5e9440ff56"
KERNEL="$DESKTOP/target/kernel-cache/vmlinux"
if ! echo "$KERNEL_SHA256  $KERNEL" | shasum -a 256 -c --status 2>/dev/null; then
  command -v zstd >/dev/null || { echo "zstd is required to unpack the kernel (brew install zstd)" >&2; exit 1; }
  mkdir -p "$(dirname "$KERNEL")"
  TARBALL="$(dirname "$KERNEL")/kata.tar.zst"
  curl -fL --progress-bar -o "$TARBALL" "$KATA_URL"
  echo "$KATA_SHA256  $TARBALL" | shasum -a 256 -c
  zstd -dc "$TARBALL" | tar -xOf - ./opt/kata/share/kata-containers/vmlinux-6.18.5-177 > "$KERNEL"
  rm -f "$TARBALL"
fi
echo "$KERNEL_SHA256  $KERNEL" | shasum -a 256 -c

step "Building the GPUI Kit shell (release)"
cargo build --release --manifest-path "$DESKTOP/Cargo.toml" --target "$RUST_TARGET"

step "Assembling Pidots.app"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$DESKTOP/target/$RUST_TARGET/release/pidots" "$APP/Contents/MacOS/pidots"
cp "$WORK/$NODE_DIST/bin/node" "$APP/Contents/Resources/node"
cp -R "$WORK/app" "$APP/Contents/Resources/app"
mkdir -p "$APP/Contents/Resources/computers"
cp "$DESKTOP/computers/.build/release/pidots-computers" "$APP/Contents/Resources/computers/"
mkdir -p "$APP/Contents/Resources/speech"
cp "$DESKTOP/speech/.build/release/pidots-speech" "$APP/Contents/Resources/speech/"
cp "$KERNEL" "$APP/Contents/Resources/computers/vmlinux"
cp -R "$ROOT/dist/computer-agent" "$APP/Contents/Resources/computers/agent"
sed "s/__VERSION__/$VERSION/g" "$DESKTOP/macos/Info.plist" > "$APP/Contents/Info.plist"

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/public/dots/blue.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  if [[ $double -le 512 ]]; then
    sips -z "$double" "$double" "$ROOT/public/dots/blue.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

step "Signing ($SIGN_IDENTITY)"
codesign --force --sign "$SIGN_IDENTITY" --options runtime \
  --entitlements "$DESKTOP/macos/node.entitlements" "$APP/Contents/Resources/node"
codesign --force --sign "$SIGN_IDENTITY" --options runtime \
  --entitlements "$DESKTOP/macos/computers.entitlements" "$APP/Contents/Resources/computers/pidots-computers"
codesign --force --sign "$SIGN_IDENTITY" --options runtime \
  --entitlements "$DESKTOP/macos/speech.entitlements" "$APP/Contents/Resources/speech/pidots-speech"
codesign --force --sign "$SIGN_IDENTITY" --options runtime \
  --entitlements "$DESKTOP/macos/app.entitlements" "$APP"
codesign --verify --strict "$APP"

step "Creating the disk image"
DMG="$OUT/Pidots-$VERSION-$NODE_ARCH.dmg"
STAGE="$WORK/dmg"
rm -rf "$STAGE" "$DMG" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Pidots" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo
echo "Built $DMG"
