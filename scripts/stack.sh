#!/usr/bin/env bash
# Bring the Ragnarok Offline server stack up or down inside Nebula's microVM.
#
#   scripts/stack.sh up|down|status|logs [service]
#
# The Tauri supervisor shells out to this so the same code path works from the
# app and from a terminal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.ragnarokmac"
NET=ragnarokmac
IMAGE="${RAGNAROKMAC_IMAGE:-ragnarokmac/rathena:20200401}"
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"

docker_() { "$NEBULA" docker "$@"; }

# rAthena writes with printf(3), which block-buffers when stdout is not a tty.
# Without -t, errors sit in a 4 KiB buffer and never reach `docker logs`.
run_server() {
    local name="$1" port="$2" binary="$3"
    local -a mounts=(
        -v "$STATE/conf/inter_conf.txt:/rathena/conf/import/inter_conf.txt:ro"
        -v "$STATE/conf/char_conf.txt:/rathena/conf/import/char_conf.txt:ro"
        -v "$STATE/conf/map_conf.txt:/rathena/conf/import/map_conf.txt:ro"
        -v "$STATE/conf/battle_conf.txt:/rathena/conf/import/battle_conf.txt:ro"
    )
    docker_ rm -f "$name" >/dev/null 2>&1 || true
    docker_ run -d -t --name "$name" --network "$NET" \
        -p "127.0.0.1:$port:$port" "${mounts[@]}" "$IMAGE" "$binary" >/dev/null
}

wait_healthy() {
    local name="$1" tries=60
    while [ $tries -gt 0 ]; do
        [ "$(docker_ inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null)" = healthy ] && return 0
        sleep 2; tries=$((tries - 1))
    done
    echo "timed out waiting for $name" >&2; return 1
}

cmd_up() {
    docker_ network create "$NET" >/dev/null 2>&1 || true

    if [ "$(docker_ inspect -f '{{.State.Running}}' ragnarok-db 2>/dev/null)" != true ]; then
        docker_ rm -f ragnarok-db >/dev/null 2>&1 || true
        docker_ run -d --name ragnarok-db --network "$NET" \
            -e MARIADB_ROOT_PASSWORD=ragnarok -e MARIADB_DATABASE=ragnarok \
            -e MARIADB_USER=ragnarok -e MARIADB_PASSWORD=ragnarok \
            -v "$STATE/sql:/docker-entrypoint-initdb.d:ro" \
            -v ragnarokmac-db:/var/lib/mysql \
            --health-cmd='mariadb -uragnarok -pragnarok -e "SELECT 1" ragnarok' \
            --health-interval=5s --health-retries=40 \
            mariadb:noble >/dev/null
    fi
    wait_healthy ragnarok-db

    # char and map hand the client an address to reconnect to. Everything is
    # published on the host's loopback, so that address is simply 127.0.0.1.
    printf 'login_ip: ragnarok-login\nchar_ip: 127.0.0.1\n' > "$STATE/conf/char_conf.txt"
    printf 'char_ip: ragnarok-char\nmap_ip: 127.0.0.1\n'   > "$STATE/conf/map_conf.txt"
    printf '{"host":"127.0.0.1","login":6900,"char":6121,"map":5121}\n' > "$STATE/endpoint.json"

    # The game page reads this from the asset server's static root. It exists so
    # LAN mode can later advertise a different address without touching the page.
    local web="$ROOT/vendor/roBrowserLegacy/dist/Web"
    [ -d "$web" ] && cp "$STATE/endpoint.json" "$web/endpoint.json"

    run_server ragnarok-login 6900 /rathena/login-server
    run_server ragnarok-char  6121 /rathena/char-server
    run_server ragnarok-map   5121 /rathena/map-server
    echo "stack up"
}

cmd_down() {
    for c in ragnarok-map ragnarok-char ragnarok-login ragnarok-db; do
        docker_ rm -f "$c" >/dev/null 2>&1 || true
    done
    echo "stack down"
}

cmd_status() {
    docker_ ps -a --filter name=ragnarok --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
}

case "${1:-status}" in
    up) cmd_up ;;
    down) cmd_down ;;
    status) cmd_status ;;
    logs) docker_ logs --tail "${3:-40}" "ragnarok-${2:-map}" ;;
    *) echo "usage: $0 up|down|status|logs [service]" >&2; exit 2 ;;
esac
