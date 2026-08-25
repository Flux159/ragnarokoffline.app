#!/usr/bin/env bash
# Apply RagnarokMac's changes to the vendored roBrowserLegacy checkout.
#
# Done as idempotent in-place edits rather than `git apply`, so an upstream
# change to unrelated lines does not break the whole patch set. Each edit
# checks whether it has already been made. See patches/ for the rationale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RB="$ROOT/vendor/roBrowserLegacy"

python3 - "$ROOT" "$RB" <<'PY'
import shutil, sys
from pathlib import Path

root, rb = Path(sys.argv[1]), Path(sys.argv[2])

# 0001 - Renderer.render(fn) must be idempotent. Components register on every
# show/tab-change; without this a window opened N times renders N times per
# frame, interleaving clearRect with async sprite draws (flicker, ghost heads).
p = rb / "src/Renderer/Renderer.js"
s = p.read_text()
old = """	static render(fn) {
		if (fn) {
			this.renderCallbacks.push(fn);
		}"""
new = """	static render(fn) {
		// Idempotent: callers register on every show/tab-change and never
		// expect to be run more than once per frame.
		if (fn && this.renderCallbacks.indexOf(fn) === -1) {
			this.renderCallbacks.push(fn);
		}"""
if old in s:
    p.write_text(s.replace(old, new))
    print("patched Renderer.js (render callback dedupe)")
elif "indexOf(fn) === -1" in s:
    print("Renderer.js already patched")
else:
    sys.exit("Renderer.js: render() no longer matches; re-check the patch")

# 0003 - Equipment: reset the canvas context list on init.
# Component.init() pushed both canvas contexts onto a module-level array without
# clearing it, so every re-init added two more. The render loop then ran
# clear+draw once per entry, and because sprite draws complete asynchronously,
# the later draws land after every clear - the character renders twice, slightly
# offset, which is the two-headed ghosting.
p = rb / "src/UI/Components/Equipment/EquipmentCommon.js"
s = p.read_text()
old = """		const root = Component.getRoot();
		const canvases = root.querySelectorAll('canvas');
		if (canvases[0]) _ctx.push(canvases[0].getContext('2d'));"""
new = """		const root = Component.getRoot();
		const canvases = root.querySelectorAll('canvas');
		// init() can run more than once; without this the contexts accumulate
		// and the character is drawn once per stale entry.
		_ctx.length = 0;
		if (canvases[0]) _ctx.push(canvases[0].getContext('2d'));"""
if old in s:
    p.write_text(s.replace(old, new))
    print("patched EquipmentCommon.js (context list reset)")
elif "_ctx.length = 0;" in s:
    print("EquipmentCommon.js already patched")
else:
    sys.exit("EquipmentCommon.js: init() no longer matches; re-check the patch")

# 0002 - WASD / arrow-key movement.
shutil.copyfile(root / "patches/KeyboardMove.js", rb / "src/Controls/KeyboardMove.js")
p = rb / "src/Engine/MapEngine.js"
s = p.read_text()
if "KeyboardMove" not in s:
    s = s.replace(
        "import MapControl from 'Controls/MapControl.js';",
        "import MapControl from 'Controls/MapControl.js';\nimport KeyboardMove from 'Controls/KeyboardMove.js';",
    )
    s = s.replace("\t\t\tMapControl.init();", "\t\t\tMapControl.init();\n\t\t\tKeyboardMove.init();")
    p.write_text(s)
    print("patched MapEngine.js (keyboard movement)")
else:
    print("MapEngine.js already patched")
PY
