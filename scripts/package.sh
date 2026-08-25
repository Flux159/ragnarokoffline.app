#!/usr/bin/env bash
# Assemble everything the app needs at runtime into payload/, which Tauri
# bundles into RagnarokMac.app/Contents/Resources.
#
# Game assets are deliberately NOT included: they are Gravity's copyright and
# the user supplies their own client. Everything else ships.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAYLOAD="$ROOT/payload"
NEBULA_SRC="${NEBULA_SRC:-$HOME/Projects/nebula}"

rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"/{bin,scripts,config,patches,dist}

echo "==> binaries"
# nebula/nebulad host the microVM; docker-slim is nebula-slim's docker client,
# so the app never depends on a docker CLI being installed; node runs the asset
# server. The official Node build links only system libraries, unlike Homebrew's.
cp "$NEBULA_SRC/target/release/nebula"                  "$PAYLOAD/bin/"
cp "$NEBULA_SRC/target/release/nebulad"                 "$PAYLOAD/bin/"
cp "$NEBULA_SRC/slim/target/release/docker-slim"        "$PAYLOAD/bin/"
cp "$ROOT/vendor/node/bin/node"                         "$PAYLOAD/bin/"

echo "==> scripts and config"
cp "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py "$PAYLOAD/scripts/"
cp "$ROOT"/config/*                          "$PAYLOAD/config/"
cp "$ROOT"/patches/*                         "$PAYLOAD/patches/"

echo "==> guest images"
# nebula downloads these from its GitHub releases on first `up`. Shipping them
# is what makes a fresh machine work with no network at all, and nebula's
# install-image accepts gzip artifacts precisely for app bundles.
mkdir -p "$PAYLOAD/guest"
if [ ! -f "$PAYLOAD/guest/Image.gz" ]; then
    gzip -1 -c "$HOME/.nebula/kernel/Image" > "$PAYLOAD/guest/Image.gz"
fi
if [ ! -f "$PAYLOAD/guest/rootfs.img.gz" ]; then
    gzip -1 -c "$HOME/.nebula/images/rootfs-pristine.img" > "$PAYLOAD/guest/rootfs.img.gz"
fi

echo "==> database schema"
# Extracted from the rAthena image by bootstrap; MariaDB's entrypoint imports
# it on first boot. Without this a packaged app starts with an empty database.
mkdir -p "$PAYLOAD/sql"
cp "$ROOT"/.ragnarokmac/sql/*.sql "$PAYLOAD/sql/"

echo "==> container images"
[ -f "$ROOT/dist/images.tar.gz" ] || "$ROOT/scripts/precache.sh" save
cp "$ROOT/dist/images.tar.gz" "$PAYLOAD/dist/"

echo "==> client runtime"
mkdir -p "$PAYLOAD/vendor/roBrowserLegacy/dist"
cp -R "$ROOT/vendor/roBrowserLegacy/dist/Web" "$PAYLOAD/vendor/roBrowserLegacy/dist/Web"

RC="$PAYLOAD/vendor/roBrowserLegacy-RemoteClient-JS"
mkdir -p "$RC"
for item in index.js start-prod.js prepare.js package.json src node_modules; do
    cp -R "$ROOT/vendor/roBrowserLegacy-RemoteClient-JS/$item" "$RC/"
done

# npm leaves dangling links for optional deps that were never installed; Tauri
# refuses to bundle a resource path that does not resolve.
find "$PAYLOAD" -type l ! -exec test -e {} \; -print -delete 2>/dev/null || true

echo "==> english translation"
EN="$PAYLOAD/vendor/ROenglishRE/Translation/Renewal"
mkdir -p "$EN"
cp -R "$ROOT/vendor/ROenglishRE/Translation/Renewal/data"     "$EN/data"
cp -R "$ROOT/vendor/ROenglishRE/Translation/Renewal/SystemEN" "$EN/SystemEN"

# A marker the app compares against, so a new build refreshes the copy it
# materialises into Application Support.
git -C "$ROOT" rev-parse --short HEAD 2>/dev/null > "$PAYLOAD/VERSION" || echo dev > "$PAYLOAD/VERSION"

echo
du -sh "$PAYLOAD"
du -sh "$PAYLOAD"/* | sort -rh
