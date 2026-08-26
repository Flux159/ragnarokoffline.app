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

# 0004 - CharSelect: reset the canvas context list on init, same bug as 0003.
# _ctx is module-level and pushed to in Component.init without ever being
# cleared, so re-entering character select adds another context per slot. The
# render loop does clearRect + draw once per entry, and sprite draws land
# asynchronously, so the later ones arrive after the earlier clears - the
# character is drawn twice, slightly offset. That is the doubled head in the
# character select and creation screens (upstream #1350, reported there as a
# WebKit-only fault; WebKit is likely just slower to resolve the sprite loads,
# which widens the window rather than causing it).
p = rb / "src/UI/Components/CharSelect/CharSelectCommon.js"
s = p.read_text()
old = """	Component.init = function init() {
		const root = this.getRoot();
"""
new = """	Component.init = function init() {
		const root = this.getRoot();

		// init() runs again every time character select is re-entered; without
		// this the contexts accumulate and each character is drawn once per
		// stale entry.
		_ctx.length = 0;
"""
# Check "already applied" first: `old` is a prefix of `new`, so it still
# matches a patched file and testing it first re-applies on every run.
if "_ctx.length = 0;" in s:
    print("CharSelectCommon.js already patched")
elif old in s:
    p.write_text(s.replace(old, new, 1))
    print("patched CharSelectCommon.js (context list reset)")
else:
    sys.exit("CharSelectCommon.js: init() no longer matches; re-check the patch")

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
