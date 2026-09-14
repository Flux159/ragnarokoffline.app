#!/usr/bin/env bash
# Move a pin in config/VENDOR_PINS to a new commit.
#
#   scripts/vendor-bump.sh <name>          # to the tip of the row's branch
#   scripts/vendor-bump.sh <name> <sha>    # to an exact commit
#
# The fourth column of a row names the branch it follows -- `ragnarokoffline`
# on our forks. Builds never read it: vendor-fetch.sh fetches the commit, so
# a tag still says exactly what was built. This script is the one place a
# branch is resolved, and it only ever writes a commit.
#
# It does not build anything. Bump in its own commit, having built it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINS="$ROOT/config/VENDOR_PINS"
NAME="${1:?usage: vendor-bump.sh <name> [<sha>]}"
WANT="${2:-}"

read -r _ URL OLD BRANCH < <(grep -E "^${NAME}[[:space:]]" "$PINS" || true)
[ -n "${URL:-}" ] && [ -n "${OLD:-}" ] || { echo "no pin for '$NAME' in $PINS" >&2; exit 1; }

if [ -z "$WANT" ]; then
    [ -n "${BRANCH:-}" ] || { echo "'$NAME' follows no branch; pass a commit" >&2; exit 1; }
    WANT=$(git ls-remote "$URL" "refs/heads/$BRANCH" | cut -f1)
    [ -n "$WANT" ] || { echo "no branch '$BRANCH' at $URL" >&2; exit 1; }
fi
# A full hash only. A short one is ambiguous as the history grows, and the pin
# is read by things that compare it byte for byte.
[[ "$WANT" =~ ^[0-9a-f]{40}$ ]] || { echo "not a full commit hash: $WANT" >&2; exit 1; }

if [ "$WANT" = "$OLD" ]; then
    echo "$NAME: already at ${OLD:0:12}"
    exit 0
fi

# -i.bak rather than -i: GNU and BSD sed disagree about a bare -i.
sed -i.bak "/^${NAME}[[:space:]]/s/${OLD}/${WANT}/" "$PINS"
rm -f "$PINS.bak"
grep -q "^${NAME}[[:space:]].*${WANT}" "$PINS" || { echo "failed to rewrite $PINS" >&2; exit 1; }

echo "$NAME: ${OLD:0:12} -> ${WANT:0:12}"
REPO="${URL%.git}"
case "$REPO" in https://github.com/*) echo "    review: $REPO/compare/$OLD...$WANT" ;; esac
