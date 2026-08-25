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

# Nebula's host->guest port forwarder tears every forward down whenever its
# 2-second Docker poll fails (net.rs conflates "query failed" with "no
# containers"), which kills long-lived sockets like the game connection. On
# macOS the VZ NAT subnet is host-routable, so we skip the forwarder entirely
# and talk to the guest address directly. Containers therefore publish on
# 0.0.0.0 inside the guest, not on guest-loopback.
guest_ip() {
    local candidate
    # The daemon's reported agent IP is authoritative when it answers.
    candidate=$(curl -s -m 2 http://127.0.0.1:7440/v1alpha1/status 2>/dev/null \
        | sed -n 's/.*"ip":"\([0-9.]*\)".*/\1/p')
    if [ -n "$candidate" ] && nc -z -G 1 "$candidate" 6900 2>/dev/null; then
        echo "$candidate"; return 0
    fi
    # Otherwise trust the address the forwarder last dialled.
    candidate=$(grep -o 'port forward added ([0-9.]*:[0-9]* -> [0-9.]*' \
        "$HOME/.nebula/logs/nebulad.log" 2>/dev/null | tail -1 | awk '{print $NF}')
    if [ -n "$candidate" ]; then echo "$candidate"; return 0; fi
    return 1
}

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
        -p "$port:$port" "${mounts[@]}" "$IMAGE" "$binary" >/dev/null
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

    # The char and map servers hand the client an address to reconnect to, so
    # they must advertise the guest IP the browser can actually reach.
    run_server ragnarok-login 6900 /rathena/login-server
    local ip
    ip=$(guest_ip) || { echo "could not determine guest IP" >&2; exit 1; }
    printf 'login_ip: ragnarok-login\nchar_ip: %s\n' "$ip" > "$STATE/conf/char_conf.txt"
    printf 'char_ip: ragnarok-char\nmap_ip: %s\n' "$ip" > "$STATE/conf/map_conf.txt"
    printf '{"guest_ip":"%s","login":6900,"char":6121,"map":5121}\n' "$ip" > "$STATE/endpoint.json"

    run_server ragnarok-char  6121 /rathena/char-server
    run_server ragnarok-map   5121 /rathena/map-server
    echo "stack up (guest $ip)"
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
