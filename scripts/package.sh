#!/usr/bin/env bash
# Assemble everything the app needs at runtime into payload/, which Tauri
# bundles into the app under Contents/Resources.
#
# Game assets are deliberately NOT included: they are Gravity's copyright and
# the user supplies their own client. Everything else ships.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXE=""; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=".exe";; esac

# macOS ships `shasum` (a Perl script) and no `sha256sum`; Git Bash on Windows
# ships `sha256sum` and no `shasum`; most Linux images have both. Picking one
# breaks a third of the matrix, which is exactly how this was found.
sha256_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
    else echo "no sha256 tool found (shasum, sha256sum or openssl)" >&2; return 1
    fi
}
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

# Refuse a kit older than the one the app expects.
#
# The default path is a developer's own build directory, which goes stale the
# moment they stop rebuilding it -- and a stale kit is not a build error, it is
# a silent guest downgrade: the app replaces a newer kernel and agent with an
# older pair, pays a minute-long "updating the virtual machine image" on next
# start, and ships without the licences newer kits carry. Ask the kit what it
# is rather than trusting where it came from.
KIT_NEBULA=$("$EMBED/bin/nebula$EXE" --version 2>/dev/null | awk '{print $NF}')
# Keep this in step with NEBULA_VERSION in .github/workflows/build.yml:
# CI downloads that kit and then packages with this script, so a minimum
# above the pin fails every release build rather than catching anything.
MIN_NEBULA=$(cat "$ROOT/config/NEBULA_MIN_VERSION" 2>/dev/null || echo 0.2.0)
if [ -z "$KIT_NEBULA" ]; then
    echo "cannot read a version from the embed kit at $EMBED" >&2; exit 1
fi
# Sort the two and see which comes first: no version-compare in POSIX sh.
if [ "$KIT_NEBULA" != "$MIN_NEBULA" ] && \
   [ "$(printf '%s\n%s\n' "$KIT_NEBULA" "$MIN_NEBULA" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$KIT_NEBULA" ]; then
    echo "embed kit at $EMBED is nebula $KIT_NEBULA, but this app needs $MIN_NEBULA or newer." >&2
    echo "Rebuild it (nebula/scripts/embed-kit.sh) or point NEBULA_EMBED_KIT at a released kit:" >&2
    echo "  gh release download v$MIN_NEBULA --repo Flux159/nebula --pattern 'nebula-slim-embed-*'" >&2
    exit 1
fi
echo "    embed kit: nebula $KIT_NEBULA"
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
# The licences for what the kit contains, which we redistribute inside a signed
# app. On Linux and Windows that includes lib/: libkrun and MoltenVK are
# Apache-2.0, virglrenderer and libepoxy are MIT, and all four require their
# notice to travel with the binary. Copied on macOS too even though it ships no
# lib/ -- the notice is 18 KB, and a rule that exempts one platform is a rule
# that breaks quietly the day macOS gains a libkrun.
if [ -d "$EMBED/licenses" ]; then
    mkdir -p "$PAYLOAD/licenses"
    cp "$EMBED"/licenses/* "$PAYLOAD/licenses/"
else
    echo "warning: the embed kit has no licenses/ — nebula 0.1.7 or newer ships one" >&2
fi
# The stack supervisor, built from stack/. It replaced stack.sh and
# link-assets.sh: the app ships to Windows, which has no POSIX shell, and one
# binary is one implementation rather than a shell copy and a PowerShell copy
# that must agree forever.
if [ -n "${RAGNAROK_STACK_BIN:-}" ] && [ -e "$RAGNAROK_STACK_BIN" ]; then
    cp "$RAGNAROK_STACK_BIN" "$PAYLOAD/bin/ragnarok-stack$EXE"
else
    # Tested before it is built: the crate has no dependencies and three
    # tests, so this costs seconds, and what it guards is the one thing in
    # there that depends on another program's wording -- see port_holders() in
    # stack/src/cmds.rs.
    ( cd "$ROOT/stack" && cargo test --quiet && cargo build --release --quiet )
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
sha256_of "$PAYLOAD/bin/ragnarok-stack$EXE" > "$PAYLOAD/bin/ragnarok-stack.sha256"

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
# A bundle older than the server image it is supposed to contain means a
# rebuild failed somewhere upstream and left the last good tarball in place.
# That is invisible otherwise: packaging succeeds, the app starts, and the only
# symptom is that the change under test is missing. Three separate build
# failures hid behind this in one afternoon.
if command -v "${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}" >/dev/null 2>&1; then
    # `|| true` inside the substitution, not after it: with `set -o pipefail` a
    # stopped engine makes the pipeline fail, and a failed assignment under
    # `set -e` takes the whole script with it. Not being able to check for
    # staleness is not a reason to refuse to package.
    IMG_EPOCH=$({ "${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}" \
        docker image inspect "ragnarokmac/rathena:${PACKETVER:-20221005}" \
        --format '{{.Created}}' 2>/dev/null || true; } | cut -c1-19 | tr 'T' ' ')
    if [ -n "$IMG_EPOCH" ]; then
        # docker reports UTC; -u on both sides or every image looks hours newer
        # than the bundle that contains it, west of Greenwich.
        img_s=$(date -j -u -f '%Y-%m-%d %H:%M:%S' "$IMG_EPOCH" +%s 2>/dev/null \
             || date -u -d "$IMG_EPOCH UTC" +%s 2>/dev/null || echo 0)
        bun_s=$(stat -f %m "$ROOT/dist/images.tar.gz" 2>/dev/null \
             || stat -c %Y "$ROOT/dist/images.tar.gz" 2>/dev/null || echo 0)
        # A minute of slack: `precache.sh save` finishes writing the tarball a
        # little after the image it read, and that is not staleness.
        if [ "$img_s" -gt "$((bun_s + 60))" ] 2>/dev/null; then
            echo "dist/images.tar.gz is older than ragnarokmac/rathena -- run scripts/precache.sh save" >&2
            exit 1
        fi
    fi
fi
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

# rAthena's db/import stubs, so a mod that overrides one table does not hide the
# other fifty-nine. Staged here rather than lifted out of the image at runtime:
# the slim docker client cannot copy out of a created container, and fails at it
# silently.
echo "==> db import stubs"
if [ -d "$ROOT/vendor/rathena/db/import-tmpl" ]; then
    mkdir -p "$PAYLOAD/db-import"
    cp "$ROOT"/vendor/rathena/db/import-tmpl/* "$PAYLOAD/db-import/"
else
    echo "warning: no vendor/rathena/db/import-tmpl -- mods overriding a db table will warn" >&2
fi

echo "==> english translation"
EN="$PAYLOAD/vendor/ROenglishRE/Translation/Renewal"
mkdir -p "$EN"
# As a tar, not a directory tree.
#
# 21 of these files carry CP949 bytes read as Latin-1, and macOS filesystems
# disagree about how to normalise them: the DMG stores one byte sequence and
# APFS another, so the names change when the app is dragged to /Applications.
# A code signature records exact names, so the seal breaks on copy and the app
# is refused as "damaged" -- while verifying perfectly inside the .dmg, which
# is what made it look like a notarisation problem.
#
# Inside a tar the bytes are opaque payload rather than filesystem names, the
# archive's own name is plain ASCII and normalisation-stable, and what gets
# unpacked at runtime is never code-signed. Nothing else in the bundle has a
# name that changes under normalisation -- this one subtree is the whole
# problem.
tar -cf "$EN/data.tar" -C "$ROOT/vendor/ROenglishRE/Translation/Renewal" data
cp -R "$ROOT/vendor/ROenglishRE/Translation/Renewal/SystemEN" "$EN/SystemEN"

# The Visual C++ runtime, for the Windows installer to hand to Windows.
#
# Every binary in payload/bin imports VCRUNTIME140.dll; the Electron shell does
# not. So on a machine without the redistributable the app opens and then dies
# the moment it starts a server, with 0xC0000135 -- which is also what Smart
# App Control produces, and what a genuinely missing DLL produces. A player hit
# this and worked it out alone. electron/installer.nsh installs it during setup
# when Windows does not already have it.
#
# Fetched rather than committed: it is 25 MB of Microsoft's binary, and the URL
# is their evergreen one. Only on Windows, because that is the only packaging
# run that builds an NSIS installer.
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        VCREDIST="$ROOT/electron/vc_redist.x64.exe"
        VCREDIST_URL="https://aka.ms/vs/17/release/vc_redist.x64.exe"
        if [ ! -s "$VCREDIST" ]; then
            echo "fetching the Visual C++ redistributable"
            curl -fsSL --retry 3 -o "$VCREDIST.part" "$VCREDIST_URL"
            mv "$VCREDIST.part" "$VCREDIST"
        fi
        # No pinned hash -- Microsoft revises the file behind that URL, and a
        # pin would fail every release until someone updated it. Check instead
        # that what arrived is a Windows executable of a plausible size: the
        # failure this guards against is a truncated download or an error page
        # saved as a .exe, both of which would produce an installer that ships
        # a broken redistributable and fails only on a user's machine.
        vcsize=$(wc -c < "$VCREDIST")
        if [ "$vcsize" -lt 10000000 ]; then
            echo "vc_redist.x64.exe is only $vcsize bytes; refusing to ship it" >&2
            rm -f "$VCREDIST"
            exit 1
        fi
        if [ "$(head -c 2 "$VCREDIST")" != "MZ" ]; then
            echo "vc_redist.x64.exe is not a Windows executable; refusing to ship it" >&2
            rm -f "$VCREDIST"
            exit 1
        fi
        echo "vc_redist.x64.exe ready ($((vcsize / 1048576)) MB)"
        ;;
esac

# A marker the app compares against, so a new build refreshes the copy it
# materialises into Application Support.
git -C "$ROOT" rev-parse --short HEAD 2>/dev/null > "$PAYLOAD/VERSION" || echo dev > "$PAYLOAD/VERSION"

echo
du -sh "$PAYLOAD"
du -sh "$PAYLOAD"/* | sort -rh
