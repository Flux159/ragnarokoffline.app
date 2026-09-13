#!/usr/bin/env bash
# Build the exact RemoteClient revision the shell's managed protocol expects.
# Source pinning lets an app PR consume an unmerged dependency PR reproducibly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$(tr -d '\r\n' < "$ROOT/config/REMOTECLIENT_PIN")"
if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'config/REMOTECLIENT_PIN must contain one full commit SHA' >&2
    exit 1
fi
EXE=''
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE='.exe';; esac
DEST="${1:-$ROOT/bin/robrowser-remoteclient$EXE}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
git -C "$SRC" init -q
git -C "$SRC" fetch --quiet --depth 1 https://github.com/Flux159/roBrowserLegacy-RemoteClient-Rust.git "$REF"
git -C "$SRC" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$SRC" rev-parse HEAD)" = "$REF"
export CARGO_TARGET_DIR="${REMOTECLIENT_CARGO_TARGET_DIR:-$ROOT/target/remoteclient}"
cargo build --locked --release --manifest-path "$SRC/Cargo.toml"
mkdir -p "$(dirname "$DEST")"
cp "$CARGO_TARGET_DIR/release/robrowser-remoteclient$EXE" "$DEST"
printf '%s\n' "$REF" > "$DEST.source-commit"
node - "$DEST" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const executable = process.argv[2];
const result = require('node:child_process').spawnSync(executable, ['--capabilities'], { encoding: 'utf8', timeout: 10000 });
if (result.error || result.status !== 0 || JSON.parse(result.stdout).managedProtocol !== 1) {
    throw new Error('Built RemoteClient does not support managed protocol 1');
}
fs.writeFileSync(executable + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') + '\n');
JS
echo "Built pinned RemoteClient $REF at $DEST"
