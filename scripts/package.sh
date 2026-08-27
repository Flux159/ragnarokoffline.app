#!/usr/bin/env bash
# Assemble everything the app needs at runtime into payload/, which Tauri
# bundles into the app under Contents/Resources.
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
# so the app never depends on a docker CLI being installed. The asset server is
# a single static Rust binary, so there is no language runtime to ship either.
# All three come from nebula's slim embed kit so the host binaries and the guest
# rootfs below are always the same build. kubectl-slim/helm-slim are in the kit
# too and deliberately left out: this app has no Kubernetes in it.
EMBED="$NEBULA_SRC/dist-embed-slim"
[ -d "$EMBED" ] || { echo "no slim embed kit at $EMBED (build it in the nebula repo)" >&2; exit 1; }
cp "$EMBED/bin/nebula" "$EMBED/bin/nebulad" "$EMBED/bin/docker-slim" "$PAYLOAD/bin/"
# The asset server: one 1.7 MB static binary in place of a 106 MB Node runtime
# plus its dependency tree.
cp "${REMOTECLIENT_SRC:-$HOME/Projects/roBrowserLegacy-RemoteClient-Rust}/target/release/robrowser-remoteclient" \
   "$PAYLOAD/bin/"

echo "==> scripts and config"
cp "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py "$PAYLOAD/scripts/"
cp "$ROOT"/config/*                          "$PAYLOAD/config/"
cp "$ROOT"/patches/*                         "$PAYLOAD/patches/"

echo "==> guest images"
# nebula downloads these from its GitHub releases on first `up`. Shipping them
# is what makes a fresh machine work with no network at all, and nebula's
# install-image accepts gzip artifacts precisely for app bundles.
#
# The slim rootfs, not the full one: the guest runs slimd (Rust) rather than
# dockerd + containerd + runc, which is 9 MB instead of 130 MB compressed. The
# app used a fraction of the Go stack's surface — run, exec, logs, load, binds,
# published ports — and slim covers all of it (nebula PR #17).
mkdir -p "$PAYLOAD/guest"
cp "$EMBED/images/kernel-Image.gz" "$PAYLOAD/guest/Image.gz"
cp "$EMBED/images/rootfs.img.gz"   "$PAYLOAD/guest/rootfs.img.gz"

echo "==> database schema"
# Extracted from the rAthena image by bootstrap; MariaDB's entrypoint imports
# it on first boot. Without this a packaged app starts with an empty database.
mkdir -p "$PAYLOAD/sql"
cp "$ROOT"/.ragnarokmac/sql/*.sql "$PAYLOAD/sql/"
# Anything checked into sql/ ships too, and wins on name collision. The rAthena
# schema is extracted by bootstrap into .ragnarokmac/sql, but our own additions
# -- 03-account.sql, which gives a fresh install a login -- live in the repo,
# and copying only the extracted set silently dropped them from the bundle.
if compgen -G "$ROOT/sql/*.sql" >/dev/null; then
    cp "$ROOT"/sql/*.sql "$PAYLOAD/sql/"
fi

echo "==> container images"
[ -f "$ROOT/dist/images.tar.gz" ] || "$ROOT/scripts/precache.sh" save
cp "$ROOT/dist/images.tar.gz" "$PAYLOAD/dist/"

echo "==> client runtime"
mkdir -p "$PAYLOAD/vendor/roBrowserLegacy/dist"
cp -R "$ROOT/vendor/roBrowserLegacy/dist/Web" "$PAYLOAD/vendor/roBrowserLegacy/dist/Web"
# `npm run build:all` emits seven ~12 MB bundles and the game loads exactly one.
# bootstrap.sh prunes the rest, but anyone who rebuilds the client directly
# skips that and silently adds 24 MB per unpruned viewer to the download. Prune
# here too, where it is on the path every build takes.
(cd "$PAYLOAD/vendor/roBrowserLegacy/dist/Web" && rm -f \
    GrfViewer.js MapViewer.js ModelViewer.js StrViewer.js EffectViewer.js \
    GrannyModelViewer.js screenshotwide.png screenshotnarrow.png)

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
