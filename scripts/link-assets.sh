#!/usr/bin/env bash
# Wire a user-supplied Ragnarok client into the asset server.
#
#   scripts/link-assets.sh <data.grf> <rdata.grf> [official_data.grf] [bgm-dir]
#
# Builds a server root under state: resources/ with the GRFs and a generated
# DATA.INI, plus the loose directories the client reads. Nothing is copied — the
# GRFs stay wherever the user keeps them, so a 3.5 GB client is not duplicated.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${RAGNAROKMAC_STATE:-$ROOT/.ragnarokmac}"
EN="$ROOT/vendor/ROenglishRE/Translation/Renewal"
SERVER_ROOT="$STATE/assets"

DATA_GRF="${1:?data.grf path required}"
RDATA_GRF="${2:?rdata.grf path required}"
OFFICIAL_GRF="${3:-}"
BGM_DIR="${4:-}"

for f in "$DATA_GRF" "$RDATA_GRF"; do
    [ -f "$f" ] || { echo "not a file: $f" >&2; exit 1; }
done

rm -rf "$SERVER_ROOT"
mkdir -p "$SERVER_ROOT/resources" "$SERVER_ROOT/data"

# Lower index wins, so overlays sit above the base client.
{
    echo "[Data]"
    i=0
    if [ -n "$OFFICIAL_GRF" ] && [ -f "$OFFICIAL_GRF" ]; then
        ln -sfn "$OFFICIAL_GRF" "$SERVER_ROOT/resources/official_data.grf"
        echo "$i=official_data.grf"; i=$((i + 1))
    fi
    ln -sfn "$RDATA_GRF" "$SERVER_ROOT/resources/rdata.grf"
    echo "$i=rdata.grf"; i=$((i + 1))
    ln -sfn "$DATA_GRF" "$SERVER_ROOT/resources/data.grf"
    echo "$i=data.grf"
} > "$SERVER_ROOT/resources/DATA.INI"

# Loose client files usually sit beside the GRFs. BGM can be given explicitly,
# because it is the one whose absence is noticed — the game is simply silent.
CLIENT_DIR="$(cd "$(dirname "$DATA_GRF")" && pwd)"
if [ -n "$BGM_DIR" ] && [ -d "$BGM_DIR" ]; then
    ln -sfn "$BGM_DIR" "$SERVER_ROOT/BGM"
else
    for c in "$CLIENT_DIR/BGM" "$CLIENT_DIR/dll_exe/BGM"; do
        [ -d "$c" ] && ln -sfn "$c" "$SERVER_ROOT/BGM" && break
    done
fi
for c in "$CLIENT_DIR/AI" "$CLIENT_DIR/dll_exe/AI"; do
    [ -d "$c" ] && ln -sfn "$c" "$SERVER_ROOT/AI" && break
done

# System/ is a merge: the English tables win, the client backfills fonts and
# quest data. Two names are excluded from the backfill because roBrowser reaches
# for them first and would otherwise get the Korean copy:
#   itemInfo*             — .lub resolves before .lua
#   OngoingQuestInfoList* — the translation calls the same table OngoingQuests
MERGED="$STATE/System"
rm -rf "$MERGED"; mkdir -p "$MERGED"
for f in "$EN/SystemEN"/*; do ln -sfn "$f" "$MERGED/$(basename "$f")"; done
for c in "$CLIENT_DIR/System" "$CLIENT_DIR/dll_exe/System"; do
    [ -d "$c" ] || continue
    for f in "$c"/*; do
        b=$(basename "$f")
        case "$b" in itemInfo*|OngoingQuestInfoList*) continue ;; esac
        [ -e "$MERGED/$b" ] || ln -sfn "$f" "$MERGED/$b"
    done
    break
done
# The translation's itemInfo.lua is a require()/dofile() stub; point at the table.
ln -sfn "$EN/SystemEN/LuaFiles514/itemInfo.lua" "$MERGED/itemInfo.lua"
ln -sfn "$EN/SystemEN/OngoingQuests.lub" "$MERGED/OngoingQuestInfoList.lub"
ln -sfn "$MERGED" "$SERVER_ROOT/System"
# Several loaders fall back to a SystemEN/ path when the System/ one is absent.
ln -sfn "$EN/SystemEN" "$SERVER_ROOT/SystemEN"

# roBrowser reads this over its baked-in defaults.
WEB="$ROOT/vendor/roBrowserLegacy/dist/Web"
[ -d "$WEB" ] && cp "$ROOT/config/Config.local.js" "$WEB/Config.local.js"

echo "linked: $(grep -c '^[0-9]=' "$SERVER_ROOT/resources/DATA.INI") GRFs, BGM $([ -e "$SERVER_ROOT/BGM" ] && echo yes || echo missing)"
