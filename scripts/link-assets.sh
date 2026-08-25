#!/usr/bin/env bash
# Wire a user-supplied Ragnarok client into the asset server.
#
#   scripts/link-assets.sh <data.grf> <rdata.grf> [official_data.grf] [bgm-dir]
#
# Nothing is copied: the GRFs stay wherever the user keeps them and are
# symlinked in, so a 3 GB client is not duplicated. Called by the app after the
# first-run setup window, and re-run whenever those paths change.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RC="$ROOT/vendor/roBrowserLegacy-RemoteClient-JS"
EN="$ROOT/vendor/ROenglishRE/Translation/Renewal"
STATE="${RAGNAROKMAC_STATE:-$ROOT/.ragnarokmac}"

DATA_GRF="${1:?data.grf path required}"
RDATA_GRF="${2:?rdata.grf path required}"
OFFICIAL_GRF="${3:-}"
BGM_DIR="${4:-}"

for f in "$DATA_GRF" "$RDATA_GRF"; do
    [ -f "$f" ] || { echo "not a file: $f" >&2; exit 1; }
done

mkdir -p "$RC/resources" "$RC/data" "$STATE"
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
# BGM can be pointed at explicitly, because it is the one the user notices when
# it is missing -- the game is simply silent -- and it is often kept apart from
# the GRFs since it is a third of the client by size.
CLIENT_DIR="$(cd "$(dirname "$DATA_GRF")" && pwd)"
rm -f "$RC/BGM"
if [ -n "$BGM_DIR" ] && [ -d "$BGM_DIR" ]; then
    ln -sfn "$BGM_DIR" "$RC/BGM"
else
    for candidate in "$CLIENT_DIR/BGM" "$CLIENT_DIR/dll_exe/BGM"; do
        [ -d "$candidate" ] && ln -sfn "$candidate" "$RC/BGM" && break
    done
fi
for candidate in "$CLIENT_DIR/AI" "$CLIENT_DIR/dll_exe/AI"; do
    [ -d "$candidate" ] && ln -sfn "$candidate" "$RC/AI" && break
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
        # Excluded from the backfill because roBrowser reaches for these names
        # first and would get kRO's Korean copy:
        #  - itemInfo*: it resolves .lub before .lua, so the 2012 Korean table
        #    would shadow the English one.
        #  - OngoingQuestInfoList*: the English translation calls the same data
        #    OngoingQuests.lub, so the Korean file wins the first lookup and the
        #    quest tracker stays Korean.
        case "$b" in
            itemInfo*.lub|itemInfo*.lua) continue ;;
            OngoingQuestInfoList*) continue ;;
        esac
        [ -e "$MERGED/$b" ] || ln -sfn "$f" "$MERGED/$b"
    done
    break
done
# The stub in SystemEN require()s the real table; roBrowser mounts only the
# file it fetches, so point at the table itself.
ln -sfn "$EN/SystemEN/LuaFiles514/itemInfo.lua" "$MERGED/itemInfo.lua"
# roBrowser asks for System/OngoingQuestInfoList.lub; the translation ships the
# same table under a different name. Answer the name it asks for.
ln -sfn "$EN/SystemEN/OngoingQuests.lub" "$MERGED/OngoingQuestInfoList.lub"
ln -sfn "$MERGED" "$RC/System"
# Several loaders fall back to a SystemEN/ path when the System/ one is absent.
# Serve that prefix too so the fallback can actually resolve.
ln -sfn "$EN/SystemEN" "$RC/SystemEN"

# The asset server refuses to start without CLIENT_PUBLIC_URL, and a packaged
# app has no .env until we write one. Generated here so the override path is
# absolute and correct wherever the runtime was materialised.
{
    sed '/^DATA_OVERRIDE_PATH=/d' "$ROOT/config/remoteclient.env"
    echo "DATA_OVERRIDE_PATH=$EN/data"
} > "$RC/.env"

# roBrowser reads this over its baked-in defaults.
WEB="$ROOT/vendor/roBrowserLegacy/dist/Web"
[ -d "$WEB" ] && cp "$ROOT/config/Config.local.js" "$WEB/Config.local.js"

echo "linked: $(grep -c '^[0-9]=' "$RC/resources/DATA.INI") GRFs, BGM $([ -e "$RC/BGM" ] && echo yes || echo missing)"
