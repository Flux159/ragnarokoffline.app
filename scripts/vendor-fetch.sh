#!/usr/bin/env bash
# Fetch a pinned upstream source into a directory.
#
#   scripts/vendor-fetch.sh <name> <dest>
#
# <name> is a row in config/VENDOR_PINS, which holds the URL and the exact
# commit. Nothing here resolves a branch: a clone of a moving branch means the
# tag we ship does not say what was built, and it has already broken a release
# build once.
#
# An existing dest is left alone unless it is on the wrong commit, so repeated
# runs are cheap and a developer poking at vendor/ is not silently reset.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$ROOT/config/VENDOR_PINS"
NAME="${1:?usage: vendor-fetch.sh <name> <dest>}"
DEST="${2:?usage: vendor-fetch.sh <name> <dest>}"

read -r _ URL SHA < <(grep -E "^${NAME}[[:space:]]" "$PINS" || true)
[ -n "${URL:-}" ] && [ -n "${SHA:-}" ] || { echo "no pin for '$NAME' in $PINS" >&2; exit 1; }

if [ -d "$DEST/.git" ]; then
    have=$(git -C "$DEST" rev-parse HEAD 2>/dev/null || echo none)
    if [ "$have" = "$SHA" ]; then
        echo "    $NAME: already at ${SHA:0:12}"
        exit 0
    fi
    echo "    $NAME: $have -> ${SHA:0:12}"
else
    mkdir -p "$DEST"
    git init -q "$DEST"
    git -C "$DEST" remote add origin "$URL"
fi

git -C "$DEST" remote set-url origin "$URL"
# Fetch the one commit rather than the branch: GitHub serves an arbitrary SHA,
# and this stays shallow even when the pin is far behind the tip.
git -C "$DEST" fetch -q --depth 1 origin "$SHA"
git -C "$DEST" checkout -q --detach FETCH_HEAD
echo "    $NAME: ${SHA:0:12}"
