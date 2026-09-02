#!/usr/bin/env bash
# Fetch and build the upstream pieces into vendor/. Nothing here is committed.
#
#   scripts/bootstrap.sh [path-to-kRO-client]
#
# The client argument should be a folder holding data.grf, rdata.grf and the
# loose System/, BGM/ and AI/ directories. Assets are symlinked, never copied.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor"
CLIENT="${1:-$HOME/Downloads}"
PACKETVER=20221005
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"

clone() {
    local url="$1" dir="$VENDOR/$2"
    [ -d "$dir" ] || git clone --depth 1 "$url" "$dir"
}

mkdir -p "$VENDOR"
clone https://github.com/MrAntares/roBrowserLegacy.git                        roBrowserLegacy
clone https://github.com/FranciscoWallison/roBrowserLegacy-RemoteClient-JS.git roBrowserLegacy-RemoteClient-JS
clone https://github.com/rathena/rathena.git                                  rathena
clone https://github.com/llchrisll/ROenglishRE.git                            ROenglishRE

echo "==> applying client patches"
"$ROOT/scripts/patch-client.sh"

echo "==> building the web client"
# build:all emits seven 12 MB bundles when the game needs one, so prune after.
# It has to be the full build: api.html and api.js are only written on --all,
# and the online client is launched with ROBrowser.TYPE.FRAME, which loads
# api.html in an iframe. Skipping build targets yields a blank window.
(cd "$VENDOR/roBrowserLegacy" && npm install --no-audit --no-fund && npm run build:all)
(cd "$VENDOR/roBrowserLegacy/dist/Web" && rm -f \
    GrfViewer.js MapViewer.js ModelViewer.js StrViewer.js EffectViewer.js \
    GrannyModelViewer.js screenshotwide.png screenshotnarrow.png)
cp "$ROOT/config/play.html" "$VENDOR/roBrowserLegacy/dist/Web/play.html"

echo "==> installing the asset server"
(cd "$VENDOR/roBrowserLegacy-RemoteClient-JS" && npm install --no-audit --no-fund)

echo "==> linking client assets from $CLIENT"
RC="$VENDOR/roBrowserLegacy-RemoteClient-JS"
mkdir -p "$RC/resources" "$RC/data"
for grf in data.grf rdata.grf official_data.grf; do
    [ -f "$CLIENT/$grf" ] && ln -sf "$CLIENT/$grf" "$RC/resources/$grf"
done
# Lower index wins: overlays above the base client. See README.
{
    echo "[Data]"
    i=0
    for grf in official_data.grf rdata.grf data.grf; do
        [ -e "$RC/resources/$grf" ] && { echo "$i=$grf"; i=$((i + 1)); }
    done
} > "$RC/resources/DATA.INI"
for d in BGM AI; do
    [ -d "$CLIENT/dll_exe/$d" ] && ln -sfn "$CLIENT/dll_exe/$d" "$RC/$d"
    [ -d "$CLIENT/$d" ] && ln -sfn "$CLIENT/$d" "$RC/$d"
done
"$ROOT/scripts/grfls.py" "$RC"/resources/*.grf || true

echo "==> assembling the English client"
# Text overrides load through DATA_OVERRIDE_PATH, which the asset server checks
# ahead of every GRF -- no repacking a 2.4 GB archive to change a string.
EN="$VENDOR/ROenglishRE/Translation/Renewal"
if grep -q '^DATA_OVERRIDE_PATH=' "$RC/.env" 2>/dev/null; then
    sed -i '' 's|^DATA_OVERRIDE_PATH=.*|DATA_OVERRIDE_PATH=../ROenglishRE/Translation/Renewal/data|' "$RC/.env"
else
    echo 'DATA_OVERRIDE_PATH=../ROenglishRE/Translation/Renewal/data' >> "$RC/.env"
fi

# System/ is a merge: English wins, kRO fills the gaps (fonts, quest data).
MERGED="$ROOT/.ragnarokmac/System"
KRO_SYSTEM="$CLIENT/dll_exe/System"
rm -rf "$MERGED"; mkdir -p "$MERGED"
for f in "$EN/SystemEN"/*; do ln -sfn "$f" "$MERGED/$(basename "$f")"; done
if [ -d "$KRO_SYSTEM" ]; then
    for f in "$KRO_SYSTEM"/*; do
        b=$(basename "$f")
        # roBrowser resolves .lub before .lua, so kRO's 2012 itemInfo.lub would
        # otherwise shadow the English table. Keep it out entirely.
        case "$b" in itemInfo*.lub|itemInfo*.lua) continue ;; esac
        [ -e "$MERGED/$b" ] || ln -sfn "$f" "$MERGED/$b"
    done
fi
# SystemEN/itemInfo.lua is a require()/dofile() stub aimed at the real client.
# roBrowser mounts only the file it fetches, so point at the table itself --
# it defines the global `tbl` that roBrowser's loader iterates.
ln -sfn "$EN/SystemEN/LuaFiles514/itemInfo.lua" "$MERGED/itemInfo.lua"
ln -sfn "$MERGED" "$RC/System"

echo "==> building the database image"
(cd "$ROOT/containers/mariadb" && "$NEBULA" docker build -t ragnarokmac/mariadb:11.4 .)

echo "==> building rAthena (arm64, packetver $PACKETVER)"
"$ROOT/scripts/apply-server-mods.sh" "$VENDOR/rathena"
cp "$ROOT/containers/rathena/Dockerfile" "$VENDOR/rathena/Dockerfile.ragnarokmac"
(cd "$VENDOR/rathena" && "$NEBULA" docker build -f Dockerfile.ragnarokmac \
    --build-arg "PACKETVER=$PACKETVER" -t "ragnarokmac/rathena:$PACKETVER" .)

echo "==> seeding server state"
STATE="$ROOT/.ragnarokmac"
mkdir -p "$STATE/sql" "$STATE/conf"
CID=$("$NEBULA" docker create "ragnarokmac/rathena:$PACKETVER" true)
"$NEBULA" docker cp "$CID:/rathena/sql-files/main.sql" "$STATE/sql/01-main.sql"
"$NEBULA" docker cp "$CID:/rathena/sql-files/logs.sql" "$STATE/sql/02-logs.sql"
"$NEBULA" docker rm "$CID" >/dev/null
cat > "$STATE/conf/inter_conf.txt" <<'EOF'
login_server_ip: ragnarok-db
ipban_db_ip: ragnarok-db
char_server_ip: ragnarok-db
map_server_ip: ragnarok-db
web_server_ip: ragnarok-db
log_db_ip: ragnarok-db
EOF
: > "$STATE/conf/battle_conf.txt"
: > "$STATE/conf/char_conf.txt"
: > "$STATE/conf/map_conf.txt"

echo
echo "bootstrap complete. Next: scripts/stack.sh up"
