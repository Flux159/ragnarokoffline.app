#!/usr/bin/env bash
# Patches that edit the *built* client bundle, rather than its source.
#
#   scripts/patch-bundle.sh <dist/Web directory>
#
# patch-client.sh runs before `npm run build:all` and edits src/. Anything that
# has to see the bundled output runs here, after it.
#
# One entry point on purpose. These used to be invoked from bootstrap.sh alone,
# which is the developer path — the release workflow builds the client itself
# and never calls bootstrap.sh, so a bundle patch added there shipped to nobody
# and the feature was missing from every release while working locally. Both
# callers now run this script, so neither can quietly drift from the other.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="${1:?usage: patch-bundle.sh <dist/Web directory>}"
ONLINE="$WEB/Online.js"

[ -f "$ONLINE" ] || { echo "patch-bundle: no bundle at $ONLINE" >&2; exit 1; }

# Written to a temporary file first: every edit in the navigation patch requires
# an exact signature, so a pinned client that no longer matches aborts before
# anything is written, leaving the freshly built bundle untouched rather than
# half-edited.
TMP="$WEB/Online.patching.js"
trap 'rm -f "$TMP"' EXIT
node "$ROOT/scripts/patch-navigation-client.cjs" "$ONLINE" "$TMP"
mv "$TMP" "$ONLINE"
echo "patched Online.js (legacy navigation)"
