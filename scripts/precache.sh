#!/usr/bin/env bash
# Bake the container images into a bundle that ships inside the .app, so a fresh
# install needs no registry pull and no rAthena compile.
#
#   scripts/precache.sh save            # build the bundle (developer machine)
#   scripts/precache.sh load            # restore it (first launch)
#   scripts/precache.sh ensure          # load only if an image is missing
#
# Built with the real docker CLI against full nebula: slim implements `load`
# but not `save` (it stores layers unpacked, so the original tars are gone).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"
BUNDLE="${RAGNAROKMAC_BUNDLE:-$ROOT/dist/images.tar.gz}"
IMAGES=("${RAGNAROKMAC_IMAGE:-ragnarokmac/rathena:20221005}" "${RAGNAROKMAC_DB_IMAGE:-ragnarokmac/mariadb:11.4}")

# Resolve a docker client exactly as stack.sh does, and for the same reason: on
# a machine that has never had Docker installed there is no docker CLI to wrap.
# `nebula docker` shells out to the real one, so using it here made a clean
# install fall back to pulling ragnarokmac/mariadb from a registry that has
# never heard of it. The bundled docker-slim speaks the same API to the same
# socket and is always present.
DOCKER_BIN="${RAGNAROKMAC_DOCKER:-}"
if [ -z "$DOCKER_BIN" ]; then
    for candidate in \
        "$ROOT/bin/docker-slim" \
        "$HOME/Projects/nebula/slim/target/release/docker-slim" \
        "$HOME/.rd/bin/docker" \
        /opt/homebrew/bin/docker \
        /usr/local/bin/docker
    do
        [ -x "$candidate" ] && { DOCKER_BIN="$candidate"; break; }
    done
fi
[ -n "$DOCKER_BIN" ] || { echo "no docker client found (bundled or installed)" >&2; exit 1; }
export NEBULA_HOME="${NEBULA_HOME:-$HOME/Library/Application Support/Ragnarok Offline/nebula}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$NEBULA_HOME/run/docker.sock}"

docker_() { "$DOCKER_BIN" "$@"; }

# `save` is the one verb that must go to a real docker daemon: slim stores
# layers unpacked, so the original layer tars no longer exist for it to write
# out, and it rejects the command outright. That is a developer-machine path
# only -- the app never saves, it only loads -- so requiring a real docker CLI
# here costs shipped users nothing.
# Also pinned to the *full* nebula engine, not the app's. The app runs its own
# slim instance, and this script inherits NEBULA_HOME from stack.sh when it is
# called from there -- pointing `save` at slimd, which cannot do it. Images are
# built against the full engine, so that is where they are saved from.
docker_real_() {
    NEBULA_HOME="${RAGNAROKMAC_BUILD_HOME:-$HOME/.nebula}" "$NEBULA" docker "$@"
}

have_all() {
    for img in "${IMAGES[@]}"; do
        docker_ image inspect "$img" >/dev/null 2>&1 || return 1
    done
}

case "${1:-ensure}" in
    save)
        mkdir -p "$(dirname "$BUNDLE")"
        echo "saving ${IMAGES[*]}"
        docker_real_ save "${IMAGES[@]}" | gzip -9 > "$BUNDLE"
        # A slim client silently produces a non-archive here; catch it now
        # rather than at load time on someone else's machine.
        gunzip -c "$BUNDLE" | tar t 2>/dev/null | grep -q "manifest.json\|index.json" \
            || { echo "that is not a docker-save archive; is a real docker CLI available?" >&2; exit 1; }
        echo "wrote $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
        ;;
    load)
        [ -f "$BUNDLE" ] || { echo "no bundle at $BUNDLE" >&2; exit 1; }
        gunzip -c "$BUNDLE" | docker_ load
        ;;
    ensure)
        if have_all; then
            echo "images already present"
        elif [ -f "$BUNDLE" ]; then
            echo "loading images from $BUNDLE"
            gunzip -c "$BUNDLE" | docker_ load
            # Verify rather than trust the exit status. A partial load leaves
            # the caller to `docker run` an image that is not there, which then
            # tries a registry pull and fails with something unrelated to the
            # real problem.
            have_all || { echo "image load did not produce ${IMAGES[*]}" >&2; exit 1; }
        else
            echo "images missing and no bundle at $BUNDLE; run scripts/bootstrap.sh" >&2
            exit 1
        fi
        ;;
    *) echo "usage: $0 save|load|ensure" >&2; exit 2 ;;
esac
