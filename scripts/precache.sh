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
IMAGES=("${RAGNAROKMAC_IMAGE:-ragnarokmac/rathena:20200401}" "${RAGNAROKMAC_DB_IMAGE:-ragnarokmac/mariadb:11.4}")

docker_() { "$NEBULA" docker "$@"; }

have_all() {
    for img in "${IMAGES[@]}"; do
        docker_ image inspect "$img" >/dev/null 2>&1 || return 1
    done
}

case "${1:-ensure}" in
    save)
        mkdir -p "$(dirname "$BUNDLE")"
        echo "saving ${IMAGES[*]}"
        docker_ save "${IMAGES[@]}" | gzip -9 > "$BUNDLE"
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
        else
            echo "images missing and no bundle at $BUNDLE; run scripts/bootstrap.sh" >&2
            exit 1
        fi
        ;;
    *) echo "usage: $0 save|load|ensure" >&2; exit 2 ;;
esac
