#!/bin/sh
# Apply our server-side rAthena modifications to a checkout, in place.
#
# rAthena itself is never forked: the Dockerfile builds from a clean upstream
# clone, and everything we add lives in third-party/ so that "what we changed"
# is one directory rather than a diff against a moving target. Run this after
# cloning rAthena and before `docker build`.
#
# Idempotent, because bootstrap.sh reuses its vendor/ checkout across runs and
# the second run must not fail on an already-patched tree. See patches/ for the
# rationale behind each patch, and the client-side equivalent in
# scripts/patch-client.sh.
#
# usage: apply-server-mods.sh <path-to-rathena-checkout>
set -eu

TARGET=${1:?path to a rAthena checkout required}
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MOD="$ROOT/third-party/population-engine"

[ -f "$TARGET/src/map/map.cpp" ] || { echo "not a rAthena checkout: $TARGET" >&2; exit 1; }
[ -d "$MOD" ] || { echo "missing $MOD" >&2; exit 1; }

echo "==> population engine: files"
# Copied every time: these are ours alone, nothing upstream writes here, so
# re-copying is how a third-party/ update reaches an existing checkout.
(cd "$MOD/files" && find . -type f -print) | while read -r f; do
    mkdir -p "$TARGET/$(dirname "$f")"
    cp "$MOD/files/$f" "$TARGET/$f"
done

echo "==> population engine: patches"
# Applying is a one-shot: once 0002 has inserted a guard inside a function that
# 0001 added, neither patch can be forward- or reverse-detected cleanly, so a
# stamp is more honest than probing the tree. Re-running with a changed patch
# set therefore needs a fresh checkout, which is what CI does anyway.
STAMP="$TARGET/.ragnarokmac-server-mods"
WANT=$(cat "$MOD"/patches/*.patch | shasum -a 256 | cut -d' ' -f1)

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
    echo "    already applied"
    exit 0
fi
if [ -f "$STAMP" ]; then
    echo "    patches changed since this checkout was built -- delete it and re-clone" >&2
    exit 1
fi

for p in "$MOD"/patches/*.patch; do
    if ! patch -d "$TARGET" -p1 --forward < "$p"; then
        # Upstream moved under a hunk. Better to stop than to ship a server
        # whose bot engine is half-wired.
        echo "    FAILED $(basename "$p") -- rAthena has changed under this patch" >&2
        exit 1
    fi
    echo "    applied $(basename "$p")"
done
echo "$WANT" > "$STAMP"
