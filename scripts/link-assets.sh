#!/usr/bin/env bash
# Wire a user-supplied Ragnarok client into the asset server.
#
#   scripts/link-assets.sh <data.grf> <rdata.grf> [official_data.grf]
#
# Nothing is copied: the GRFs stay wherever the user keeps them and are
# symlinked in, so a 3 GB client is not duplicated. Called by the app after the
# first-run setup window, and re-run whenever those paths change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RC="$ROOT/vendor/roBrowserLegacy-RemoteClient-JS"
EN="$ROOT/vendor/ROenglishRE/Translation/Renewal"
STATE="$ROOT/.ragnarokmac"

DATA_GRF="${1:?data.grf path required}"
RDATA_GRF="${2:?rdata.grf path required}"
OFFICIAL_GRF="${3:-}"

for f in "$DATA_GRF" "$RDATA_GRF"; do
    [ -f "$f" ] || { echo "not a file: $f" >&2; exit 1; }
done

mkdir -p "$RC/resources" "$RC/data"
rm -f "$RC/resources"/*.grf "$RC/resources/DATA.INI"

# Lower index wins, so overlays sit above the base client.
{
    echo "[Data]"
    i=0
    if [ -n "$OFFICIAL_GRF" ] && [ -f "$OFFICIAL_GRF" ]; then
        ln -sfn "$OFFICIAL_GRF" "$RC/resources/official_data.grf"
        echo "$i=official_data.grf"; i=$((i + 1))
    fi
    ln -sfn "$RDATA_GRF" "$RC/resources/rdata.grf"
    echo "$i=rdata.grf"; i=$((i + 1))
    ln -sfn "$DATA_GRF" "$RC/resources/data.grf"
    echo "$i=data.grf"
} > "$RC/resources/DATA.INI"

# Loose client files usually sit beside the GRFs; pick them up when they do.
CLIENT_DIR="$(cd "$(dirname "$DATA_GRF")" && pwd)"
for d in BGM AI; do
    for candidate in "$CLIENT_DIR/$d" "$CLIENT_DIR/dll_exe/$d"; do
        [ -d "$candidate" ] && ln -sfn "$candidate" "$RC/$d" && break
    done
done

# System/ is a merge: the English tables win, kRO backfills fonts and quest
# data. kRO's itemInfo*.lub is excluded because roBrowser resolves .lub before
# .lua and the 2012 Korean table would otherwise shadow the English one.
MERGED="$STATE/System"
rm -rf "$MERGED"; mkdir -p "$MERGED"
for f in "$EN/SystemEN"/*; do ln -sfn "$f" "$MERGED/$(basename "$f")"; done
for candidate in "$CLIENT_DIR/System" "$CLIENT_DIR/dll_exe/System"; do
    [ -d "$candidate" ] || continue
    for f in "$candidate"/*; do
        b=$(basename "$f")
        case "$b" in itemInfo*.lub|itemInfo*.lua) continue ;; esac
        [ -e "$MERGED/$b" ] || ln -sfn "$f" "$MERGED/$b"
    done
    break
done
# The stub in SystemEN require()s the real table; roBrowser mounts only the
# file it fetches, so point at the table itself.
ln -sfn "$EN/SystemEN/LuaFiles514/itemInfo.lua" "$MERGED/itemInfo.lua"
ln -sfn "$MERGED" "$RC/System"

echo "linked: $(grep -c '^[0-9]=' "$RC/resources/DATA.INI") GRFs"
