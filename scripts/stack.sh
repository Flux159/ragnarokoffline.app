#!/usr/bin/env bash
# Bring the Ragnarok Offline server stack up or down inside Nebula's microVM.
#
#   scripts/stack.sh up|down|status|logs [service]
#
# The Tauri supervisor shells out to this so the same code path works from the
# app and from a terminal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# State is deliberately outside the runtime tree: a new app version replaces
# runtime/ wholesale, and generated conf plus the imported schema must survive
# that. Falls back to the repo directory when run from a checkout.
STATE="${RAGNAROKMAC_STATE:-$ROOT/.ragnarokmac}"
NET=ragnarokmac
IMAGE="${RAGNAROKMAC_IMAGE:-ragnarokmac/rathena:20200401}"
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"

# A GUI app launched from Finder inherits launchd's minimal PATH
# (/usr/bin:/bin:/usr/sbin:/sbin), so none of the tools installed by Homebrew,
# Rancher Desktop or Docker Desktop are visible. `nebula docker` wraps the real
# docker CLI and fails with "not on your PATH" unless we widen it here.
export PATH="$HOME/.rd/bin:/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:$PATH"

require_tool() {
    command -v "$1" >/dev/null 2>&1 && return 0
    echo "$1 not found. Looked on PATH and in the usual install locations." >&2
    return 1
}

# Resolve a docker CLI without relying on PATH: a Finder-launched app inherits
# launchd's minimal PATH and sees nothing installed by Homebrew or Rancher
# Desktop. nebula-slim's docker-slim shim is bundled with the app and speaks the
# same API to the same socket, so it is the default; a real docker CLI is used
# when one is present.
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
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.nebula/run/docker.sock}"

docker_() { "$DOCKER_BIN" "$@"; }

# rAthena writes with printf(3), which block-buffers when stdout is not a tty.
# Without -t, errors sit in a 4 KiB buffer and never reach `docker logs`.
# The Kafra teleport prices are hardcoded in npc/kafras/functions_kafras.txt,
# with no config knob. Rather than rebuild the image to change them, keep an
# editable copy of that script directory in state and mount it over the image's
# — the same directory-mount approach used for conf/import.
prepare_kafra_scripts() {
    local dir="$STATE/npc/kafras"
    if [ ! -f "$dir/functions_kafras.txt" ]; then
        mkdir -p "$STATE/npc"
        local cid
        cid=$(docker_ create "$IMAGE" true 2>/dev/null) || return 0
        # Copy into the parent: docker cp nests when the target already exists.
        rm -rf "$dir"
        docker_ cp "$cid:/rathena/npc/kafras" "$STATE/npc/" >/dev/null 2>&1 || true
        docker_ rm "$cid" >/dev/null 2>&1 || true
        [ -f "$dir/functions_kafras.txt" ] || return 0
        cp "$dir/functions_kafras.txt" "$dir/functions_kafras.orig"
    fi

    # Every warp price is a number on a `setarray @wrpP[0], ...` line, one per
    # town, so zeroing those lines makes every destination free everywhere.
    if [ -f "$STATE/free_kafra_warp" ]; then
        sed 's/^\(\s*setarray @wrpP\[0\].*\)$/\1/; /setarray @wrpP\[0\]/ s/[0-9][0-9]*/0/g' \
            "$dir/functions_kafras.orig" > "$dir/functions_kafras.txt"
    else
        cp "$dir/functions_kafras.orig" "$dir/functions_kafras.txt"
    fi
}

run_server() {
    local name="$1" port="$2" binary="$3"
    docker_ rm -f "$name" >/dev/null 2>&1 || true
    # One directory mount, not five file mounts. Docker mis-handles a
    # single-file bind whose host path contains a space, and the standard macOS
    # location -- ~/Library/Application Support/<bundle id> -- always does. The
    # same mount from a space-free path works, and a directory mount works from
    # either, so mounting conf/import wholesale sidesteps it entirely. rAthena
    # reads whichever of these files exist and ignores the rest.
    local -a extra=()
    # Only the map server runs NPC scripts.
    if [ "$name" = ragnarok-map ] && [ -f "$STATE/npc/kafras/functions_kafras.txt" ]; then
        extra+=(-v "$STATE/npc/kafras:/rathena/npc/kafras:ro")
    fi
    docker_ run -d -t --name "$name" --network "$NET" \
        -p "127.0.0.1:$port:$port" \
        -v "$STATE/conf:/rathena/conf/import:ro" \
        ${extra[@]+"${extra[@]}"} \
        "$IMAGE" "$binary" >/dev/null
}

# Poll for the thing we actually depend on -- the database answering queries --
# rather than a container healthcheck. docker-slim has no --health-* flags, and
# this is a more direct statement of the dependency regardless.
wait_for_db() {
    local tries=90
    while [ $tries -gt 0 ]; do
        if docker_ exec ragnarok-db mariadb -uragnarok -pragnarok -e 'SELECT 1' ragnarok \
             >/dev/null 2>&1; then
            return 0
        fi
        sleep 2; tries=$((tries - 1))
    done
    echo "timed out waiting for the database" >&2; return 1
}

cmd_up() {
    mkdir -p "$STATE/conf" "$STATE/sql"
    # A failed single-file bind leaves a *directory* behind at the source path.
    # Clear anything in conf/ that is not a regular file so a stale one cannot
    # shadow the config we are about to write.
    find "$STATE/conf" -mindepth 1 -maxdepth 1 ! -type f -exec rm -rf {} + 2>/dev/null || true
    # The schema ships with the app; seed it on first run so MariaDB's
    # entrypoint imports it instead of coming up with an empty database.
    if [ -d "$ROOT/sql" ]; then
        for f in "$ROOT/sql"/*.sql; do
            [ -f "$f" ] && [ ! -f "$STATE/sql/$(basename "$f")" ] && cp "$f" "$STATE/sql/"
        done
    fi
    : > "$STATE/conf/battle_conf.txt" 2>/dev/null || true
    [ -f "$STATE/conf/battle_conf.txt" ] || touch "$STATE/conf/battle_conf.txt"
    [ -x "$NEBULA" ] || { echo "nebula engine not found at $NEBULA" >&2; exit 1; }
    # A fresh install has no images until the shipped bundle is unpacked.
    "$ROOT/scripts/precache.sh" ensure >/dev/null 2>&1 || true
    docker_ network create "$NET" >/dev/null 2>&1 || true

    if [ "$(docker_ inspect -f '{{.State.Running}}' ragnarok-db 2>/dev/null)" != true ]; then
        docker_ rm -f ragnarok-db >/dev/null 2>&1 || true
        docker_ run -d --name ragnarok-db --network "$NET" \
            -e MARIADB_ROOT_PASSWORD=ragnarok -e MARIADB_DATABASE=ragnarok \
            -e MARIADB_USER=ragnarok -e MARIADB_PASSWORD=ragnarok \
            -v "$STATE/sql:/docker-entrypoint-initdb.d:ro" \
            -v ragnarokmac-db:/var/lib/mysql \
            mariadb:noble >/dev/null
    fi
    wait_for_db

    # char and map hand the client an address to reconnect to. Everything is
    # published on the host's loopback, so that address is simply 127.0.0.1.
    # rAthena ships new_account: no, so roBrowser's "simplified registration"
    # (a Name_M / Name_F username on the login screen) has nothing to talk to.
    # This is a single-player server on loopback, so allow it. The name and
    # password minimums default to 6 in code and reject shorter attempts
    # silently, which reads as "registration is broken".
    # Written here rather than by bootstrap: a packaged app never runs bootstrap,
    # and these are part of bringing the stack up, not of installing it.
    cat > "$STATE/conf/inter_conf.txt" <<'EOF'
login_server_ip: ragnarok-db
ipban_db_ip: ragnarok-db
char_server_ip: ragnarok-db
map_server_ip: ragnarok-db
web_server_ip: ragnarok-db
log_db_ip: ragnarok-db
EOF
    cat > "$STATE/conf/login_conf.txt" <<'EOF'
new_account: yes
acc_name_min_length: 4
password_min_length: 4
EOF
    # PIN codes are a live-service anti-theft feature. On a single-player
    # offline server they are just a second password screen after login.
    cat > "$STATE/conf/char_conf.txt" <<'EOF'
login_ip: ragnarok-login
char_ip: 127.0.0.1
pincode_enabled: no
EOF
    printf 'char_ip: ragnarok-char\nmap_ip: 127.0.0.1\n'   > "$STATE/conf/map_conf.txt"
    printf '{"host":"127.0.0.1","login":6900,"char":6121,"map":5121}\n' > "$STATE/endpoint.json"

    # The game page reads this from the asset server's static root. It exists so
    # LAN mode can later advertise a different address without touching the page.
    local web="$ROOT/vendor/roBrowserLegacy/dist/Web"
    [ -d "$web" ] && cp "$STATE/endpoint.json" "$web/endpoint.json"

    prepare_kafra_scripts
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
    docker_ ps -a 2>/dev/null | awk 'NR==1 || /ragnarok-(db|login|char|map)/'
}

case "${1:-status}" in
    up) cmd_up ;;
    down) cmd_down ;;
    status) cmd_status ;;
    logs) docker_ logs --tail "${3:-40}" "ragnarok-${2:-map}" ;;
    *) echo "usage: $0 up|down|status|logs [service]" >&2; exit 2 ;;
esac
