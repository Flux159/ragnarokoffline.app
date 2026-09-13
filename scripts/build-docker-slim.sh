#!/usr/bin/env bash
# Build the exact docker-slim revision the private account stdin contract expects.
# Source pinning lets an app PR consume an unmerged dependency PR reproducibly.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$(tr -d '\r\n' < "$ROOT/config/DOCKER_SLIM_PIN")"
if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'config/DOCKER_SLIM_PIN must contain one full commit SHA' >&2
    exit 1
fi
EXE=''
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE='.exe';; esac
DEST="${1:-$ROOT/bin/docker-slim$EXE}"
SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT
git -C "$SRC" init -q
git -C "$SRC" fetch --quiet --depth 1 https://github.com/Flux159/nebula.git "$REF"
git -C "$SRC" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$SRC" rev-parse HEAD)" = "$REF"
export CARGO_TARGET_DIR="${DOCKER_SLIM_CARGO_TARGET_DIR:-$ROOT/target/docker-slim}"
cargo build --locked --release --manifest-path "$SRC/slim/Cargo.toml" -p docker-slim
mkdir -p "$(dirname "$DEST")"
cp "$CARGO_TARGET_DIR/release/docker-slim$EXE" "$DEST"
printf '%s\n' "$REF" > "$DEST.source-commit"
node - "$DEST" <<'JS'
const fs = require('node:fs');
const crypto = require('node:crypto');
const executable = process.argv[2];
const result = require('node:child_process').spawnSync(executable, ['capabilities'], { encoding: 'utf8', timeout: 10000 });
if (result.error || result.status !== 0 || !result.stdout.split(/\r?\n/).includes('exec-stdin-eof-v1')) {
    throw new Error('Built docker-slim does not support exec-stdin-eof-v1');
}
fs.writeFileSync(executable + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex') + '\n');
JS
cp "$SRC/LICENSE" "$DEST.LICENSE"
echo "Built pinned docker-slim $REF at $DEST"
