#!/usr/bin/env bash
# Build, sign and package a distributable app in one step.
#
#   scripts/release.sh [--install] [--dmg <dir>]
#
# electron-builder does the building and signing (see electron/afterSign.js for
# the sidecar entitlements). What it does not do is check that what came out
# matches what went in, and that is the failure this script exists to catch:
# package.sh refreshes payload/, but the payload is copied into the bundle at
# *build* time, so packaging without rebuilding silently ships whatever the
# bundle was built with. That happened twice during the Tauri era, both times
# caught only by mounting the finished .dmg and reading the scripts inside it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/dist/electron/mac-arm64/RagnarokMac.app"
DMG="$ROOT/dist/electron/RagnarokMac-0.1.0-arm64.dmg"
INSTALL=0
DMG_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --install) INSTALL=1; shift ;;
        --dmg) DMG_DIR="${2:?--dmg needs a directory}"; shift 2 ;;
        *) echo "usage: $0 [--install] [--dmg <dir>]" >&2; exit 2 ;;
    esac
done

echo "==> payload"
"$ROOT/scripts/package.sh" >/dev/null

echo "==> app (electron-builder: package, sign, dmg)"
BUILD_LOG="${TMPDIR:-/tmp}/ragnarokmac-build.log"
if ! (cd "$ROOT" && npx electron-builder --mac) >"$BUILD_LOG" 2>&1; then
    echo "the app did not build:" >&2
    tail -25 "$BUILD_LOG" >&2
    echo "(full log: $BUILD_LOG)" >&2
    exit 1
fi
grep -q "afterSign: sidecars signed" "$BUILD_LOG" \
    || { echo "afterSign did not run — the VZ entitlements are not guaranteed" >&2; exit 1; }

# Shell scripts are the part that changes most and the part that is copied
# rather than compiled, so a byte comparison against source is the right signal.
echo "==> verifying the bundle matches the source tree"
for f in stack.sh precache.sh link-assets.sh; do
    [ -f "$ROOT/scripts/$f" ] || continue
    cmp -s "$ROOT/scripts/$f" "$APP/Contents/Resources/payload/scripts/$f" \
        || { echo "  $f in the bundle differs from scripts/$f" >&2; exit 1; }
    echo "  $f matches"
done
codesign --verify --strict "$APP"
codesign -d --entitlements - "$APP/Contents/Resources/payload/bin/nebulad" 2>&1 \
    | grep -qi virtualization \
    || { echo "  nebulad lost its virtualization entitlement" >&2; exit 1; }
echo "  signature valid, entitlements present"

if [ "$INSTALL" = 1 ]; then
    echo "==> installing to /Applications"
    pkill -f "RagnarokMac" 2>/dev/null || true
    sleep 2
    rm -rf /Applications/RagnarokMac.app
    cp -R "$APP" /Applications/RagnarokMac.app
    codesign -v /Applications/RagnarokMac.app
    echo "  installed and signature verified"
fi

[ -n "$DMG_DIR" ] || { echo "==> done"; exit 0; }

# Mount and read what is actually inside, because that is the artifact people
# receive — not the tree it was built from.
echo "==> verifying the disk image"
MP=$(hdiutil attach -nobrowse -readonly "$DMG" | awk '/\/Volumes\//{ $1=$2=""; sub(/^ +/,""); print; exit }')
trap '[ -n "${MP:-}" ] && hdiutil detach "$MP" >/dev/null 2>&1 || true' EXIT
cmp -s "$ROOT/scripts/stack.sh" "$MP/RagnarokMac.app/Contents/Resources/payload/scripts/stack.sh" \
    || { echo "  the .dmg carries a different stack.sh than the source" >&2; exit 1; }
codesign -v "$MP/RagnarokMac.app" || { echo "  the app inside the .dmg is not validly signed" >&2; exit 1; }
echo "  contents match source, signature valid"

mkdir -p "$DMG_DIR"
cp "$DMG" "$DMG_DIR/"
echo
echo "wrote $DMG_DIR/$(basename "$DMG") ($(du -h "$DMG" | cut -f1))"
