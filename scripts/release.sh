#!/usr/bin/env bash
# Build, sign and package a distributable app in one step.
#
#   scripts/release.sh [--install] [--dmg <dir>]
#
# This exists because the steps have to happen in order and skipping one fails
# silently. package.sh refreshes payload/, but `cargo tauri build` is what copies
# payload/ into the bundle -- so packaging without rebuilding leaves the .app
# carrying whatever it was built with, and sign/install/dmg then faithfully
# distribute a stale build. That happened twice while working on this, both
# times caught only by mounting the finished .dmg and reading the scripts inside
# it. A person sequencing these by hand will eventually get it wrong; the fix is
# to not sequence them by hand.
#
# Every stage verifies rather than trusts: the bundle is diffed against the
# source tree, and the .dmg is mounted and checked before it is called done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/RagnarokMac.app"
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

echo "==> app"
# Output goes to a file rather than /dev/null. Swallowing it means a failure
# here reports "the app did not build" and nothing else, which is precisely as
# useful as the silent `|| true` this script exists to replace.
BUILD_LOG="${TMPDIR:-/tmp}/ragnarokmac-build.log"
# --bundles app, not the default. Tauri also builds its own .dmg, which this
# script does not use -- it makes a signed one below from the signed .app,
# whereas Tauri's is produced before signing. Worse, its bundle_dmg.sh fails
# whenever a RagnarokMac volume is already mounted (which verifying a previous
# release leaves behind), and that failure marks the whole build failed even
# though the .app came out perfectly.
if ! (cd "$ROOT/src-tauri" && cargo tauri build --bundles app) >"$BUILD_LOG" 2>&1; then
    echo "the app did not build:" >&2
    grep -E "^(error|warning: unused)" -A5 "$BUILD_LOG" | head -30 >&2 || tail -20 "$BUILD_LOG" >&2
    echo "(full log: $BUILD_LOG)" >&2
    exit 1
fi

# The check that would have caught both stale releases. Shell scripts are the
# part that changes most and the part that is copied rather than compiled, so a
# byte comparison against source is exactly the right signal.
echo "==> verifying the bundle matches the source tree"
for f in stack.sh precache.sh link-assets.sh; do
    src="$ROOT/scripts/$f"
    got="$APP/Contents/Resources/payload/scripts/$f"
    [ -f "$src" ] || continue
    if ! cmp -s "$src" "$got"; then
        echo "  $f in the bundle differs from scripts/$f -- the build did not pick up the payload" >&2
        exit 1
    fi
    echo "  $f matches"
done

echo "==> signing"
"$ROOT/scripts/sign.sh" "$APP"

if [ "$INSTALL" = 1 ]; then
    echo "==> installing to /Applications"
    pkill -f "RagnarokMac.app" 2>/dev/null || true
    sleep 2
    rm -rf /Applications/RagnarokMac.app
    cp -R "$APP" /Applications/RagnarokMac.app
    codesign -v /Applications/RagnarokMac.app
    echo "  installed and signature verified"
fi

[ -n "$DMG_DIR" ] || { echo "==> done (no --dmg requested)"; exit 0; }

echo "==> disk image"
mkdir -p "$DMG_DIR"
DMG="$DMG_DIR/RagnarokMac_0.1.0_aarch64.dmg"
STAGE="$(mktemp -d)/stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/RagnarokMac.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname RagnarokMac -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$(dirname "$STAGE")"

IDENTITY="${RAGNAROKMAC_IDENTITY:-}"
[ -n "$IDENTITY" ] || IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/') || true
if [ -n "$IDENTITY" ]; then
    codesign --force --sign "$IDENTITY" --timestamp "$DMG"
fi

# Mount and read what is actually inside, because that is the artifact people
# receive -- not the tree it was built from.
echo "==> verifying the disk image"
MP=$(hdiutil attach -nobrowse -readonly "$DMG" | awk '/\/Volumes\//{ $1=$2=""; sub(/^ +/,""); print; exit }')
trap '[ -n "${MP:-}" ] && hdiutil detach "$MP" >/dev/null 2>&1 || true' EXIT
cmp -s "$ROOT/scripts/stack.sh" "$MP/RagnarokMac.app/Contents/Resources/payload/scripts/stack.sh" \
    || { echo "  the .dmg carries a different stack.sh than the source" >&2; exit 1; }
codesign -v "$MP/RagnarokMac.app" || { echo "  the app inside the .dmg is not validly signed" >&2; exit 1; }
echo "  contents match source, signature valid"

echo
echo "wrote $DMG ($(du -h "$DMG" | cut -f1))"
