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

# First launch spends minutes in half a dozen distinct steps — materialising the
# runtime, installing guest images, booting the microVM, loading 58 MB of
# container images, initialising the database, loading 1265 maps. The boot
# window used to show one unchanging line for all of it, so a hang was
# indistinguishable from slow, and "it stalled" carried no information. Each
# step names itself here; the app polls this file and shows the last line.
phase() {
    mkdir -p "$STATE"
    printf '%s\n' "$1" > "$STATE/phase" 2>/dev/null || true
    echo "$1"
}
IMAGE="${RAGNAROKMAC_IMAGE:-ragnarokmac/rathena:20221005}"
# Pinned deliberately. MariaDB cannot open a data directory written by a newer
# major version, so floating on a tag like `noble` means a rebuild can silently
# upgrade the server and leave existing characters unreadable on any rollback.
DB_IMAGE="${RAGNAROKMAC_DB_IMAGE:-ragnarokmac/mariadb:11.4}"
NEBULA="${NEBULA_BIN:-$HOME/Projects/nebula/target/release/nebula}"

# The app runs its own engine, not the user's. Sharing ~/.nebula would mean
# installing our guest images over whatever they already had, showing our
# containers in their `nebula ps`, and letting either side's `nebula down` stop
# the other's. It also has to be a fixed path rather than one derived from
# STATE, because `nebula up` registers a launchd label derived from this.
export NEBULA_HOME="${NEBULA_HOME:-$HOME/Library/Application Support/Ragnarok Offline/nebula}"
mkdir -p "$NEBULA_HOME"

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
export DOCKER_HOST="${DOCKER_HOST:-unix://$NEBULA_HOME/run/docker.sock}"

docker_() { "$DOCKER_BIN" "$@"; }

# Only one up/down at a time. The app can start the stack from the boot page
# and from Settings, and tears it down on quit, so two invocations can overlap;
# when they do, both remove the containers and then both try to create them,
# and the loser fails with "container name is already in use". mkdir is atomic
# on every filesystem we care about, which flock(1) is not on macOS.
LOCK="${STATE:-/tmp}/.stack.lock"
acquire_lock() {
    local tries=120
    mkdir -p "$(dirname "$LOCK")" 2>/dev/null || true
    while ! mkdir "$LOCK" 2>/dev/null; do
        # A lock older than two minutes is a crashed run, not a live one.
        if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin -2 2>/dev/null)" ]; then
            rm -rf "$LOCK"
            continue
        fi
        tries=$((tries - 1))
        [ $tries -le 0 ] && { echo "timed out waiting for another start/stop to finish" >&2; exit 1; }
        sleep 1
    done
    trap 'rm -rf "$LOCK"' EXIT INT TERM
}

# Remove and wait: docker returns before the name is released, so creating the
# replacement immediately can still collide.
remove_container() {
    local name="$1" tries=30 ids
    # By id, not by name. A name is not reliably unique here: a container that
    # exited without being cleaned up keeps its name, and `rm -f <name>` then
    # fails with "multiple containers match" -- so the one call that could
    # clear the mess is the one that refuses to run. Removing every id that
    # answers to the name works whether there is one or five.
    ids=$(docker_ ps -aq --filter "name=$name" 2>/dev/null || true)
    for id in $ids; do
        docker_ rm -f "$id" >/dev/null 2>&1 || true
    done
    # Removal is asynchronous; the name stays taken for a moment afterwards and
    # creating the replacement inside that window is the "already in use" error.
    while [ $tries -gt 0 ]; do
        ids=$(docker_ ps -aq --filter "name=$name" 2>/dev/null || true)
        [ -z "$ids" ] && return 0
        sleep 0.5; tries=$((tries - 1))
    done
    return 0
}

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

    # Two edits make every Kafra service free:
    #  - warps: each town's prices are numbers on a `setarray @wrpP[0], ...`
    #    line, so zeroing those lines covers every destination.
    #  - storage: the fee is `.@fee = getarg(1)`, passed in per NPC, so pinning
    #    that single assignment to 0 covers every Kafra at once.
    if [ -f "$STATE/free_kafra_warp" ]; then
        sed -e '/setarray @wrpP\[0\]/ s/[0-9][0-9]*/0/g' \
            -e 's/^\([[:space:]]*\)\.@fee = getarg(1);/\1.@fee = 0;/' \
            "$dir/functions_kafras.orig" > "$dir/functions_kafras.txt"
    else
        cp "$dir/functions_kafras.orig" "$dir/functions_kafras.txt"
    fi
}

run_server() {
    local name="$1" port="$2" binary="$3"
    # remove_container, not a bare `rm -f`: removal is asynchronous, and the
    # name stays taken for a moment after the call returns. Creating the
    # replacement in that window fails with `Conflict. The container name
    # "/ragnarok-login" is already in use`, which reads like something else is
    # running when in fact it is our own container still going away. cmd_down
    # already waits; this path was the one that did not.
    remove_container "$name"
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

# The map-server listens on 5121 long before it is usable: it then reads its
# 1265 maps and the whole npc/re tree, and only afterwards registers those maps
# with the char-server. That read is quick — a few seconds on an idle machine,
# because db/map_cache.dat is a prebuilt binary cache baked into the image at
# build time rather than 987 .gnd/.gat files parsed at startup — but "quick" is
# not "instant", and the gap is a real window a fast player can land in. A character logging in during that
# window is told "Map is not available" and bounced, because the char-server
# genuinely has nowhere to send it yet. The container being Up is therefore not
# readiness; the char-server saying it has the maps is.
wait_for_maps() {
    local tries=90
    while [ $tries -gt 0 ]; do
        if docker_ logs ragnarok-char 2>&1 | grep -q "loading complete"; then
            return 0
        fi
        sleep 2; tries=$((tries - 1))
    done
    # Don't fail the launch over this — the stack is up and will finish loading
    # shortly. Say so, so a slow machine's first login is explicable.
    echo "map-server has not registered its maps yet; first login may need a retry" >&2
    return 0
}

# A fresh machine has no guest kernel or rootfs, and no running engine. Both
# ship with the app, so neither needs the network.
ensure_engine() {
    local home="$NEBULA_HOME"
    # Must be in place before the first `up`: nebula reads it when it creates
    # the instance, and the API/DNS/k8s ports in it are what keep this engine
    # from colliding with a standalone Nebula install on the same machine.
    if [ ! -f "$home/config.toml" ] && [ -f "$ROOT/config/nebula.toml" ]; then
        cp "$ROOT/config/nebula.toml" "$home/config.toml"
    fi
    if [ ! -f "$home/kernel/Image" ] || [ ! -f "$home/images/rootfs-pristine.img" ]; then
        if [ -f "$ROOT/guest/Image.gz" ] && [ -f "$ROOT/guest/rootfs.img.gz" ]; then
            phase "Installing the virtual machine image… (first run only)"
            "$NEBULA" install-image \
                --kernel "$ROOT/guest/Image.gz" \
                --rootfs "$ROOT/guest/rootfs.img.gz" >/dev/null || return 1
        fi
    fi
    # `nebula up` is a no-op when the engine is already healthy.
    "$NEBULA" up >/dev/null 2>&1 || true
    # The docker socket appears a moment after the VM reports healthy.
    local tries=45
    while [ $tries -gt 0 ]; do
        docker_ ps >/dev/null 2>&1 && return 0
        sleep 2; tries=$((tries - 1))
    done
    echo "the nebula engine did not come up" >&2
    return 1
}

cmd_up() {
    mkdir -p "$STATE/conf" "$STATE/sql" "$STATE/backups"
    # Clear the previous run's result immediately. Leaving "Ready" in place
    # while this run is still bringing containers up makes anything that polls
    # the file -- the boot window, or a person -- believe a stack that is not
    # there yet.
    phase "Starting…"
    acquire_lock
    phase "Starting the virtual machine…"
    ensure_engine || exit 1
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
    # Create it if absent, never truncate: save_settings writes the rates here
    # and then restarts the stack, so clobbering it would silently discard every
    # setting the moment it was applied.
    [ -f "$STATE/conf/battle_conf.txt" ] || : > "$STATE/conf/battle_conf.txt"
    [ -x "$NEBULA" ] || { echo "nebula engine not found at $NEBULA" >&2; exit 1; }
    # A fresh install has no images until the shipped bundle is unpacked.
    # Only announce the load when there is actually one to do: `ensure` is a
    # no-op once the images are present, and a phase that says "first run only"
    # on every run trains people to ignore it.
    if ! docker_ image inspect "$IMAGE" >/dev/null 2>&1; then
        phase "Loading the server images… (first run only)"
    fi
    # Not `|| true`. If the images do not load there is nothing to run, and
    # swallowing the reason meant the next `docker run` tried to pull
    # ragnarokmac/mariadb from a public registry and died with "too many
    # redirects" — an error about a network we should never have touched,
    # reported far from the thing that actually broke.
    if ! RAGNAROKMAC_DOCKER="$DOCKER_BIN" "$ROOT/scripts/precache.sh" ensure 2>&1; then
        echo "could not load the bundled server images" >&2
        exit 1
    fi
    docker_ network create "$NET" >/dev/null 2>&1 || true

    if [ "$(docker_ inspect -f '{{.State.Running}}' ragnarok-db 2>/dev/null)" != true ]; then
        docker_ rm -f ragnarok-db >/dev/null 2>&1 || true
        docker_ run -d --name ragnarok-db --network "$NET" \
            -e MARIADB_ROOT_PASSWORD=ragnarok -e MARIADB_DATABASE=ragnarok \
            -e MARIADB_USER=ragnarok -e MARIADB_PASSWORD=ragnarok \
            -v "$STATE/sql:/docker-entrypoint-initdb.d:ro" \
            -v "$STATE/backups:/backups" \
            -v ragnarokmac-db:/var/lib/mysql \
            "$DB_IMAGE" >/dev/null
    fi
    phase "Starting the database…"
    wait_for_db
    # Also applied here, not only in the seed SQL. MariaDB's entrypoint imports
    # docker-entrypoint-initdb.d exactly once, when it creates the data
    # directory -- so an install that predates this would never get the account
    # and its owner would have to know the _M registration trick or wipe their
    # database. INSERT IGNORE makes it a no-op once the row exists, including
    # when the player has since changed the password.
    # NOT EXISTS, not INSERT IGNORE: userid carries a plain KEY rather than a
    # UNIQUE one, so IGNORE suppresses nothing and adds a duplicate account on
    # every start. Two rows with the same userid is worse than none.
    docker_ exec ragnarok-db mariadb -uragnarok -pragnarok ragnarok -e \
        "INSERT INTO login (userid, user_pass, sex, email, group_id)
         SELECT 'ragnarok', 'ragnarok', 'M', 'ragnarok@localhost', 99 FROM DUAL
          WHERE NOT EXISTS (SELECT 1 FROM login WHERE userid = 'ragnarok');" \
        >/dev/null 2>&1 || true

    # char and map hand the client an address to reconnect to. Everything is
    # published on the host's loopback, so that address is simply 127.0.0.1.
    # rAthena drops a connection that has been idle for stall_time seconds
    # (default 60). After character select the client sits on the char socket
    # while it parses its databases - a 22 MB item table and the lua name
    # tables - and with a modern client that can exceed a minute. The socket is
    # then dropped, the client reports "Failed to connect to server", and the
    # account is left marked online, which is the "Someone has logged in with
    # this ID" that follows. Give it room.
    # Every client arrives through the WebSocket proxy, so every connection has
    # the same source address. rAthena's flood protection counts connections per
    # IP and blocks one that opens more than ddos_count (5) within ddos_interval
    # (3s) for ddos_autoreset - ten minutes, silently. A single player opens
    # login, char and map in a few seconds and trips it on sight, and any retry
    # digs deeper. There is nothing to defend here: one address is the only
    # address, so the rules are off.
    cat > "$STATE/conf/packet_conf.txt" <<'EOF'
stall_time: 300
enable_ip_rules: no
EOF

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
    # The greeting on entering a map. map_athena.conf points motd_txt at
    # conf/motd.txt by default; redirect it into the mounted import directory so
    # it can be changed without rebuilding the image.
    case "$(uname -s)" in
        Darwin)              PRODUCT=RagnarokMac ;;
        Linux)               PRODUCT=RagnarokLinux ;;
        MINGW*|MSYS*|CYGWIN*) PRODUCT=RagnarokWindows ;;
        *)                   PRODUCT=Ragnarok ;;
    esac
    printf 'Welcome to %s Offline! Please report any bugs on Github\n' "$PRODUCT" \
        > "$STATE/conf/motd.txt"
    printf 'char_ip: ragnarok-char\nmap_ip: 127.0.0.1\nmotd_txt: conf/import/motd.txt\n' \
        > "$STATE/conf/map_conf.txt"
    printf '{"host":"127.0.0.1","login":6900,"char":6121,"map":5121}\n' > "$STATE/endpoint.json"

    # The game page reads this from the asset server's static root. It exists so
    # LAN mode can later advertise a different address without touching the page.
    local web="$ROOT/vendor/roBrowserLegacy/dist/Web"
    [ -d "$web" ] && cp "$STATE/endpoint.json" "$web/endpoint.json"

    prepare_kafra_scripts
    phase "Starting the login, character and map servers…"
    run_server ragnarok-login 6900 /rathena/login-server
    run_server ragnarok-char  6121 /rathena/char-server
    run_server ragnarok-map   5121 /rathena/map-server
    phase "Loading maps and NPCs…"
    wait_for_maps
    phase "Ready"
    echo "stack up"
}

cmd_down() {
    acquire_lock
    # Game servers hold no state, so killing them is fine. The database does:
    # stop it gracefully first so InnoDB closes cleanly rather than recovering
    # on next boot.
    for c in ragnarok-map ragnarok-char ragnarok-login; do
        remove_container "$c"
    done
    docker_ stop -t 10 ragnarok-db >/dev/null 2>&1 || true
    remove_container ragnarok-db
    phase "Stopped"
    echo "stack down"
}

# Emitted as "<name><TAB>Up|<state>" rather than raw `docker ps` output: the
# name is the *last* column there, so anything matching "<name> ... Up" never
# matches. docker-slim has no --format, but it does have inspect.
cmd_status() {
    local c st
    for c in ragnarok-db ragnarok-login ragnarok-char ragnarok-map; do
        st=$(docker_ inspect -f '{{.State.Status}}' "$c" 2>/dev/null) || st=""
        [ -n "$st" ] || st="absent"
        if [ "$st" = running ]; then
            printf '%s\tUp\n' "$c"
        else
            printf '%s\t%s\n' "$c" "$st"
        fi
    done
}

# Backups go through a bind-mounted directory rather than a pipe. slim's
# `exec -i` never returns and its `cp` reports success while transferring
# nothing, so the only dependable channel between host and container is a mount
# both sides can see.
cmd_backup() {
    local dest="${1:?destination file required}"
    mkdir -p "$STATE/backups"
    local tmp="ragnarokmac-$$.sql"
    docker_ exec ragnarok-db sh -c \
        "mariadb-dump -uragnarok -pragnarok --single-transaction --routines \
         --databases ragnarok > /backups/$tmp" || {
        echo "the database did not produce a dump (is the server running?)" >&2
        return 1
    }
    # --single-transaction keeps the server writable during the dump, which
    # matters because the player may well be logged in while taking one.
    [ -s "$STATE/backups/$tmp" ] || { echo "the dump came out empty" >&2; rm -f "$STATE/backups/$tmp"; return 1; }
    mv "$STATE/backups/$tmp" "$dest"
    echo "wrote $dest ($(du -h "$dest" | cut -f1))"
}

cmd_restore() {
    local src="${1:?source file required}"
    [ -f "$src" ] || { echo "no such backup: $src" >&2; return 1; }
    mkdir -p "$STATE/backups"
    local tmp="restore-$$.sql"
    cp "$src" "$STATE/backups/$tmp"
    # The dump carries CREATE DATABASE + USE, so this replaces the schema
    # wholesale rather than merging into whatever is there now.
    if ! docker_ exec ragnarok-db sh -c \
        "mariadb -uragnarok -pragnarok < /backups/$tmp"; then
        rm -f "$STATE/backups/$tmp"
        echo "restore failed; the database is unchanged" >&2
        return 1
    fi
    rm -f "$STATE/backups/$tmp"
    echo "restored from $src"
}

# The escape hatch for a shipped user, who has no terminal and no docker CLI.
#
# Everything here is also done automatically by `up` -- containers are removed
# by id, duplicates and all. This exists for the case that automation cannot
# reach: an engine that is itself wedged, where nothing container-level can be
# cleaned because the daemon behind it is not answering. Tearing the VM down and
# bringing it back is the one recovery that does not need a person at a shell.
#
# Player data is untouched. Characters live in the ragnarokmac-db volume, which
# outlives its container, and generated conf is regenerated by `up`.
cmd_repair() {
    phase "Repairing…"
    # Break the lock rather than wait for it. The usual reason to reach for
    # repair is a previous run that died holding one, and acquire_lock only
    # reclaims a lock older than two minutes -- which is a long time to stare at
    # a window that will not start.
    rm -rf "$LOCK"
    # Restart the engine rather than trying to tidy containers through it: if
    # the daemon is what is stuck, no container-level command can work. The
    # containers go with it, and cmd_up recreates them.
    "$NEBULA" down >/dev/null 2>&1 || true
    sleep 2
    "$NEBULA" up >/dev/null 2>&1 || true
    # cmd_up takes the lock itself and removes leftovers by id, so this needs no
    # cleanup of its own.
    cmd_up
}

case "${1:-status}" in
    up) cmd_up ;;
    repair) cmd_repair ;;
    backup) cmd_backup "${2:-}" ;;
    restore) cmd_restore "${2:-}" ;;
    down) cmd_down ;;
    status) cmd_status ;;
    logs) docker_ logs --tail "${3:-40}" "ragnarok-${2:-map}" ;;
    *) echo "usage: $0 up|down|repair|status|logs|backup <file>|restore <file>" >&2; exit 2 ;;
esac
