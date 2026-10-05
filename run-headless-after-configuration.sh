#!/usr/bin/env bash
# Run the unmodified Ragnarok Offline app on a Linux machine with no screen, so
# it hosts its server exactly as it does on a desktop. See README_HEADLESS.md.
#
#   ./run-headless-after-configuration.sh /path/to/Ragnarok\ Offline-x64.AppImage
#   RAGNAROK_APP=/path/to/app ./run-headless-after-configuration.sh
#
# The app starts its server by itself as soon as its game window opens; nobody
# has to log in. This script only gives it a window to open: a virtual display
# (Xvfb). It checks the configuration first, then runs the app until it is
# stopped -- Ctrl-C, or SIGTERM from systemd -- and passes that stop on to the
# app, which shuts the server down cleanly before exiting.
#
# Nothing here changes the app or its settings. Configure first (see the
# README), then run this.
set -euo pipefail

die() { printf 'run-headless: %s\n' "$*" >&2; exit 1; }
warn() { printf 'run-headless: warning: %s\n' "$*" >&2; }

APP="${1:-${RAGNAROK_APP:-}}"
[ -n "$APP" ] || die "give the app's path: $0 /path/to/Ragnarok-Offline.AppImage (or set RAGNAROK_APP)"
[ -x "$APP" ] || die "$APP is not an executable file (chmod +x it?)"
[ "$(uname -s)" = Linux ] || die "this script is for Linux; on macOS and Windows just open the app"
[ "$(id -u)" != 0 ] || die "do not run as root: Chromium refuses to start as root without disabling its sandbox. Use a normal account in the kvm group."

# --- the machine ---------------------------------------------------------------
[ -e /dev/kvm ] || die "/dev/kvm does not exist: enable virtualisation (VT-x/AMD-V) in the BIOS, or use a VM/host with nested virtualisation"
[ -r /dev/kvm ] && [ -w /dev/kvm ] || die "$(id -un) cannot open /dev/kvm: sudo usermod -aG kvm $(id -un), then log in again"
command -v Xvfb >/dev/null 2>&1 || die "Xvfb is not installed (Debian/Ubuntu: sudo apt install xvfb)"

# --- the configuration the app saved -----------------------------------------------
# The app's data folder: the same rule the app itself uses.
DATA="${RAGNAROK_OFFLINE_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/Ragnarok Offline}"
CLIENT="$DATA/client.json"
SETTINGS="$DATA/state/settings.json"
[ -f "$CLIENT" ] || die "no $CLIENT: the app has not been set up for this account yet. See README_HEADLESS.md, \"Configure it\"."
grep -Eq '"data_grf"[[:space:]]*:[[:space:]]*"[^"]+' "$CLIENT" \
    || die "$CLIENT names no data.grf: finish the app's setup first"
grf=$(sed -nE 's/.*"data_grf"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$CLIENT" | head -1)
[ -f "$grf" ] || die "data.grf is not at $grf (from $CLIENT): fix the path for this machine"
if grep -Eq '"mode"[[:space:]]*:[[:space:]]*"join"' "$CLIENT"; then
    die "the app is set to join someone else's server, so it would host nothing. Set Settings -> Multiplayer -> Mode to \"Host a server\", or set \"mode\": \"host\" in $CLIENT."
fi
if [ -f "$SETTINGS" ]; then
    if grep -Eq '"open_settings_first"[[:space:]]*:[[:space:]]*true' "$SETTINGS"; then
        die "Settings -> Startup -> \"open Settings instead of the game\" is on, so the app would never start the server. Untick it, or set \"open_settings_first\": false in $SETTINGS."
    fi
    grep -Eq '"hosting_scope"[[:space:]]*:[[:space:]]*"lan"' "$SETTINGS" \
        || warn "hosting is not set to LAN, so only this machine can connect. For other machines: Settings -> Multiplayer -> Allow LAN connections (\"hosting_scope\": \"lan\" in settings.json)."
else
    warn "no $SETTINGS: the server will run with default settings and serve this machine only."
fi

# --- a virtual display ----------------------------------------------------------
# The first free display number from :90 up.
n=90
while [ -e "/tmp/.X11-unix/X$n" ] || [ -e "/tmp/.X$n-lock" ]; do n=$((n + 1)); done
Xvfb ":$n" -nolisten tcp -screen 0 1280x720x24 >/dev/null 2>&1 &
XVFB=$!
for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X$n" ] && break; sleep 0.2; done
[ -e "/tmp/.X11-unix/X$n" ] || { kill "$XVFB" 2>/dev/null; die "Xvfb did not start on :$n"; }
export DISPLAY=":$n"

# An AppImage normally mounts itself with FUSE, which servers often lack.
# Extracting to a temporary folder instead works everywhere.
case "$APP" in *.AppImage|*.appimage)
    command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1 || export APPIMAGE_EXTRACT_AND_RUN=1 ;;
esac

# --- run it, and pass a stop on -------------------------------------------------
# The app is a child rather than exec'd, so the display outlives it: the app
# needs its window's connection while it shuts the server down, and only once
# it has exited is the display stopped.
APP_PID=""
stop() {
    if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
        echo "run-headless: stopping; the app is shutting the server down (up to a few minutes)..."
        kill -TERM "$APP_PID" 2>/dev/null || true
    fi
}
trap stop TERM INT HUP

echo "run-headless: starting $APP on display :$n (data: $DATA)"
# --quiet mutes the game window: there is no one to hear it.
"$APP" --quiet &
APP_PID=$!

# `wait` returns early when a trapped signal arrives; keep waiting until the
# app has really gone, so its teardown is never cut short.
while kill -0 "$APP_PID" 2>/dev/null; do
    wait "$APP_PID" || true
done
# bash remembers a reaped child's exit status, so this is the app's own.
if wait "$APP_PID" 2>/dev/null; then status=0; else status=$?; fi
kill "$XVFB" 2>/dev/null || true
wait "$XVFB" 2>/dev/null || true
exit "$status"
