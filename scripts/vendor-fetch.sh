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
# An existing dest on the right commit is left alone, so repeated runs are
# cheap and a developer poking at vendor/ is not silently reset. One on the
# wrong commit -- because the pin moved -- is reset first, loudly: see below.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$ROOT/config/VENDOR_PINS"
NAME="${1:?usage: vendor-fetch.sh <name> <dest>}"
DEST="${2:?usage: vendor-fetch.sh <name> <dest>}"

# The fourth column, the branch a row follows, is for vendor-bump.sh. Read it
# into a throwaway so it cannot run on into SHA.
read -r _ URL SHA _ < <(grep -E "^${NAME}[[:space:]]" "$PINS" || true)
[ -n "${URL:-}" ] && [ -n "${SHA:-}" ] || { echo "no pin for '$NAME' in $PINS" >&2; exit 1; }

moved=0
if [ -d "$DEST/.git" ]; then
    have=$(git -C "$DEST" rev-parse HEAD 2>/dev/null || echo none)
    if [ "$have" = "$SHA" ]; then
        echo "    $NAME: already at ${SHA:0:12}"
        exit 0
    fi
    echo "    $NAME: $have -> ${SHA:0:12}"
    moved=1
else
    mkdir -p "$DEST"
    git init -q "$DEST"
    git -C "$DEST" remote add origin "$URL"
fi

git -C "$DEST" remote set-url origin "$URL"
# Fetch the one commit rather than the branch: GitHub serves an arbitrary SHA,
# and this stays shallow even when the pin is far behind the tip. Fetched before
# anything is discarded below, so a failed fetch leaves the old tree as it was.
git -C "$DEST" fetch -q --depth 1 origin "$SHA"

# The pin moved under an existing checkout. vendor/ is not a working copy: the
# build patches it in place (patch-client.sh, apply-server-mods.sh), so it is
# dirty by design, and git refuses to check a new commit out over those edits
# with a message that says nothing about why. Anything it did carry across would
# be the old build's changes on the new source -- including apply-server-mods.sh's
# stamp, which would then report the new tree as already patched. So start the
# tree again. -x takes ignored build output too; node_modules is kept, because
# `npm ci` replaces it anyway and it is slow to fetch.
if [ "$moved" = 1 ] && [ -n "$(git -C "$DEST" status --porcelain --ignored)" ]; then
    echo "    $NAME: discarding the previous build's changes to this checkout"
    git -C "$DEST" reset -q --hard
    git -C "$DEST" clean -q -fdx -e node_modules
fi

git -C "$DEST" checkout -q --detach FETCH_HEAD
echo "    $NAME: ${SHA:0:12}"
