#!/usr/bin/env bash
# Apply Ragnarok Offline's changes to the vendored roBrowserLegacy checkout.
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
# 0004 - A missing .lub must not strand the player at character select.
#
# loadLuaValue() calls Client.loadFile(file, onload) with no error callback.
# MemoryManager.get only registers an 'error' listener when one is passed, so a
# file the player's game data does not contain fails into nothing: onEnd never
# runs, DB.index never reaches DB.count, and DB.isLoaded stays false for the
# life of the session.
#
# CharEngine.onReceiveMapInfo gates the map-server connection on DB.isLoaded, so
# the client logs in, creates a character, selects it -- and then never opens a
# connection to the map server at all. Every server is healthy, the asset server
# is serving, and the player is simply stuck. It gets reported as "I can't
# connect", with nothing in any server log to say otherwise.
#
# Seven files reach this path today, all of them inside the player's GRFs
# under data/luafiles514/lua files/ -- which is the tree an older or trimmed
# asset pack is most likely to be missing entirely:
#   <lua>/skillinfoz/skillid.lub
#   <lua>/navigation/navi_{map,mob,npc,link,linkdistance,npcdistance}_krpri.lub
# System/achievement_list.lub goes through the same call but is gated on
# Configs.get('enableAchievements'), which nothing sets, so it never loads.
#
# loadTable and loadCSV already pass onEnd as their error callback, and
# loadLuaTable calls onEnd from an outer finally; loadLuaValue is the only one
# of the four that can hang. On error we hand the callback null, which is what
# the function's own inner catch already does, so callers see nothing new.
p = rb / "src/DB/DBManager.js"
s = p.read_text()
old = """			} finally {
				if (onEnd) {
					onEnd.call();
				}
			}
		});
	} catch (e) {
		console.error('error: ', e);
		if (onEnd) {
			onEnd.call();
		}
	}
}"""
new = """			} finally {
				if (onEnd) {
					onEnd.call();
				}
			}
		},
		// Without this the failure is dropped, onEnd never runs, and the whole
		// database stays "loading" forever -- stranding the player at character
		// select with no way to reach the map server.
		function () {
			console.error(`(${file_path}) could not be read; skipping`);
			callback.call(null, null);
			if (onEnd) {
				onEnd.call();
			}
		});
	} catch (e) {
		console.error('error: ', e);
		if (onEnd) {
			onEnd.call();
		}
	}
}"""
if "could not be read; skipping" in s:
    print("DBManager.js already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched DBManager.js (loadLuaValue error callback)")
else:
    sys.exit("DBManager.js: loadLuaValue no longer matches (%d hits); re-check the patch" % s.count(old))

# 0005 - Say what actually went wrong when the databases never finish loading.
# Restarting cannot help: the file is missing from the player's game data and it
# will still be missing on the next run.
p = rb / "src/Engine/CharEngine.js"
s = p.read_text()
old = "'Failed loading databases, please restart the game'"
new = ("'Some of your game data could not be read, so the game cannot start. "
       "Your Ragnarok folder is probably missing files.'")
if "Your Ragnarok folder is probably missing files" in s:
    print("CharEngine.js already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched CharEngine.js (database load failure message)")
else:
    sys.exit("CharEngine.js: load failure message no longer matches; re-check the patch")
# 0006 - loadHatEffectInfo must not return without calling onEnd.
#
# Same stall as 0004, reached a different way. The outer Client.loadFile does
# pass onEnd as its error callback, so a *missing* hateffectids.lub is handled
# -- and it is missing from the asset packs we tested, which is why this has
# not bitten yet. But if the file is present and lua.doFile throws on it, the
# catch returns without calling onEnd, DB.index never catches DB.count, and the
# player is stranded at character select exactly as in 0004.
p = rb / "src/DB/DBManager.js"
s = p.read_text()
old = """			} catch (e) {
				console.error('[HatEffect] ID load error', e);
				return;
			} finally {
				lua.unmountFile('hateffectids.lub');
			}"""
new = """			} catch (e) {
				console.error('[HatEffect] ID load error', e);
				// Returning without this leaves the database loading forever.
				if (typeof onEnd === 'function') {
					onEnd();
				}
				return;
			} finally {
				lua.unmountFile('hateffectids.lub');
			}"""
if "leaves the database loading forever" in s:
    print("DBManager.js hat-effect already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched DBManager.js (hat effect onEnd)")
else:
    sys.exit("DBManager.js: loadHatEffectInfo no longer matches; re-check the patch")
# 0007 - Say how far the database got while the map connection waits on it.
#
# onReceiveMapInfo will not connect to the map server until DB.isLoaded, and
# DB.isLoaded is DB.index === DB.count. When a load never calls its onEnd the
# counter never balances and the player waits at character select for a minute
# and is then told to restart, with nothing anywhere saying which load is
# outstanding -- the failure is an absence, so it logs nothing at all.
#
# 0004 and 0006 fixed the two routes we found. This makes the next one report
# itself: the console goes to client.log, which the diagnostics bundle
# collects, so a report arrives reading "stalled at 47 of 48" instead of "it
# just will not connect".
p = rb / "src/Engine/CharEngine.js"
s = p.read_text()
old = """		retryCount++;
		if (retryCount > 600) {"""
new = """		retryCount++;
		// Every five seconds, not every hundred milliseconds: this is a
		// breadcrumb for a bug report, not a progress bar.
		if (retryCount % 50 === 0) {
			console.warn(
				'waiting for the client database: ' + DB.index + ' of ' + DB.count +
				' loaded after ' + (retryCount / 10) + 's. If this does not move, a ' +
				'file the database asked for never came back.'
			);
		}
		if (retryCount > 600) {"""
if "waiting for the client database" in s:
    print("CharEngine.js stall log already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched CharEngine.js (database stall breadcrumb)")
else:
    sys.exit("CharEngine.js: onReceiveMapInfo retry no longer matches; re-check the patch")
PY
