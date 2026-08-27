#!/usr/bin/env bash
# Assemble everything the app needs at runtime into payload/, which Tauri
# bundles into the app under Contents/Resources.
#
# Game assets are deliberately NOT included: they are Gravity's copyright and
# the user supplies their own client. Everything else ships.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe";; esac
PAYLOAD="$ROOT/payload"
NEBULA_SRC="${NEBULA_SRC:-$HOME/Projects/nebula}"
# CI has no nebula checkout — it unpacks a released embed kit and points here.
# Same code path either way, so a CI payload and a local one are assembled by
# the same lines rather than by a workflow that drifts from this script.
EMBED="${NEBULA_EMBED_KIT:-$NEBULA_SRC/dist-embed-slim}"
EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe";; esac

rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"/{bin,config,patches,dist}

echo "==> binaries"
# nebula/nebulad host the microVM; docker-slim is nebula-slim's docker client,
# so the app never depends on a docker CLI being installed. The asset server is
# a single static Rust binary, so there is no language runtime to ship either.
# nebula, nebulad and docker-slim come from nebula's slim embed kit, so the
# host binaries and the guest rootfs below are always the same build --
# except on kits predating nebula's stage-slim-clis.sh, where the Linux and
# Windows kits carried no docker client and it is supplied separately.
# kubectl-slim/helm-slim are in the kit too and deliberately left out: this
# app has no Kubernetes in it.
[ -d "$EMBED" ] || { echo "no slim embed kit at $EMBED (build it in the nebula repo, or set NEBULA_EMBED_KIT)" >&2; exit 1; }
# Copy the kit's bin/ wholesale and drop what this app has no use for, rather
# than naming each binary: the kit's contents vary by platform. The macOS kit
# is assembled by nebula's embed-kit.sh and carries the slim CLIs; the Linux
# and Windows kits are assembled inline by their own workflows and carry only
# nebula + nebulad, with docker-slim shipping as a separate release asset.
cp "$EMBED"/bin/* "$PAYLOAD/bin/"
rm -f "$PAYLOAD"/bin/kubectl-slim* "$PAYLOAD"/bin/helm-slim*
# docker-slim is nebula-slim's docker client and the app cannot start without
# it, so accept it from outside the kit when the kit does not carry it.
if [ ! -e "$PAYLOAD/bin/docker-slim$EXE" ]; then
    [ -n "${DOCKER_SLIM_BIN:-}" ] && [ -e "$DOCKER_SLIM_BIN" ] \
        || { echo "the embed kit has no docker-slim and DOCKER_SLIM_BIN is unset" >&2; exit 1; }
    cp "$DOCKER_SLIM_BIN" "$PAYLOAD/bin/docker-slim$EXE"
fi
# libkrun, which nebula loads from ../lib next to bin/. Only on Linux and
# Windows: macOS drives the microVM through Virtualization.framework instead,
# and the shipped app has never carried a libkrun. The macOS kit does contain
# one — 14 MB of dylibs — so this is an explicit exclusion, not an accident of
# the kit's contents.
if [ "$(uname -s)" != "Darwin" ] && [ -d "$EMBED/lib" ]; then
    mkdir -p "$PAYLOAD/lib"
    cp "$EMBED"/lib/* "$PAYLOAD/lib/"
fi
# The stack supervisor, built from stack/. It replaced stack.sh and
# link-assets.sh: the app ships to Windows, which has no POSIX shell, and one
# binary is one implementation rather than a shell copy and a PowerShell copy
# that must agree forever.
if [ -n "${RAGNAROK_STACK_BIN:-}" ] && [ -e "$RAGNAROK_STACK_BIN" ]; then
    cp "$RAGNAROK_STACK_BIN" "$PAYLOAD/bin/ragnarok-stack$EXE"
else
    ( cd "$ROOT/stack" && cargo build --release --quiet )
    cp "$ROOT/stack/target/release/ragnarok-stack$EXE" "$PAYLOAD/bin/"
fi
# A hash of what was copied, recorded beside it.
#
# The obvious check -- compare the bundled binary to the build output -- cannot
# work on macOS: electron-builder code-signs every binary it finds in
# extraResources, which rewrites the Mach-O, so the shipped copy is never
# byte-identical to an unsigned build. A text sidecar is not signed and travels
# into the bundle unchanged, so it still answers the question that matters:
# was this payload assembled from this build, or is it stale?
shasum -a 256 "$PAYLOAD/bin/ragnarok-stack$EXE" | awk '{print $1}' \
    > "$PAYLOAD/bin/ragnarok-stack.sha256"

# The asset server: one 1.7 MB static binary in place of a 106 MB Node runtime
# plus its dependency tree.
cp "${REMOTECLIENT_BIN:-${REMOTECLIENT_SRC:-$HOME/Projects/roBrowserLegacy-RemoteClient-Rust}/target/release/robrowser-remoteclient$EXE}" \
   "$PAYLOAD/bin/robrowser-remoteclient$EXE"

echo "==> config"
# No scripts. Everything the app does at runtime is in bin/ragnarok-stack now,
# and the rest of scripts/ is development tooling -- packaging, releasing, GRF
# inspection -- which has no business inside a player's app bundle.
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
