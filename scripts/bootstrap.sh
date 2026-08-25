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
PACKETVER=20200401
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"

clone() {
    local url="$1" dir="$VENDOR/$2"
    [ -d "$dir" ] || git clone --depth 1 "$url" "$dir"
}

mkdir -p "$VENDOR"
clone https://github.com/MrAntares/roBrowserLegacy.git                        roBrowserLegacy
clone https://github.com/FranciscoWallison/roBrowserLegacy-RemoteClient-JS.git roBrowserLegacy-RemoteClient-JS
clone https://github.com/rathena/rathena.git                                  rathena

echo "==> building the web client"
(cd "$VENDOR/roBrowserLegacy" && npm install --no-audit --no-fund && npm run build:all)
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
for d in System BGM AI; do
    [ -d "$CLIENT/dll_exe/$d" ] && ln -sfn "$CLIENT/dll_exe/$d" "$RC/$d"
    [ -d "$CLIENT/$d" ] && ln -sfn "$CLIENT/$d" "$RC/$d"
done
"$ROOT/scripts/grfls.py" "$RC"/resources/*.grf || true

echo "==> building rAthena (arm64, packetver $PACKETVER)"
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
