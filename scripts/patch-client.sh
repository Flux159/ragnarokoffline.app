#!/usr/bin/env bash
# Apply Ragnarok Offline's changes to the vendored roBrowserLegacy checkout.
#
# Done as idempotent in-place edits rather than `git apply`, so an upstream
# change to unrelated lines does not break the whole patch set. Each edit
# checks whether it has already been made. See patches/ for the rationale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RB="${RAGNAROK_ROBROWSER_DIR:-$ROOT/vendor/roBrowserLegacy}"

python3 - "$ROOT" "$RB" <<'PY'
import shutil, sys
from pathlib import Path

root, rb = Path(sys.argv[1]), Path(sys.argv[2])

# 0000 - A lockfile upstream does not have.
#
# roBrowserLegacy ships package.json with no lock of any kind, so `npm install`
# re-resolves ~430 packages from the registry on every build. That is not
# theoretical: it broke the first v1.0.5 build hours after the identical inputs
# had built v1.0.4, when a transitive dependency published a version npm 10
# could not resolve. Since config/VENDOR_PINS fixes the commit, package.json is
# fixed too, so the resolution can be settled once and kept here. Callers use
# `npm ci` against it. Regenerate with `npm install --package-lock-only` in a
# checkout of the pinned commit whenever the pin moves.
shutil.copyfile(root / "patches/package-lock.json", rb / "package-lock.json")
print("installed package-lock.json (pinned dependency tree)")

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

# 0002 is now the optional wasd-movement mod using the client extension API.
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

# 0005 - The stylist window (ZC_UI_OPEN, ui_type 1).
#
# roBrowser implements three of the eleven ui_types a server can ask for.
# The stylist is not one of them: onUIOpen logged "not implemented" and
# returned, so every renewal stylist NPC closed its dialogue and opened
# nothing, leaving the player facing an NPC that does not answer. rAthena has
# no fallback for it either -- unlike the refine window there is no server
# flag that offers the old menu instead.
#
# Three packets and a window. The packets are ours to add because roBrowser
# never defined them: CZ_REQ_STYLE_CHANGE2 (0xafc, the one a 2018+ client
# sends), CZ_REQ_STYLE_CLOSE (0xa48) and ZC_STYLE_CHANGE_RES (0xa47).
comp = rb / "src/UI/Components/Stylist"
comp.mkdir(parents=True, exist_ok=True)
for name in ("Stylist.js", "Stylist.html", "Stylist.css"):
    shutil.copyfile(root / "patches" / name, comp / name)
print("installed the Stylist component")

p = rb / "src/Network/PacketStructure.js"
s = p.read_text()
if "CZ_REQ_STYLE_CHANGE2" in s:
    print("PacketStructure.js already patched")
else:
    anchor = "export default PACKET;"
    if anchor not in s:
        sys.exit("PacketStructure.js: no `export default PACKET;` to append before")
    block = """
// 0xafc - the stylist's "buy this look".
//
// Every field is an index into the server's stylist table, not a look value,
// and a zero means "leave this one alone". CHANGE2 rather than CHANGE: a
// client of 2018-05-16 or newer sends the longer one, which carries BodyStyle.
PACKET.CZ.REQ_STYLE_CHANGE2 = function PACKET_CZ_REQ_STYLE_CHANGE2() {
	this.HeadPalette = 0;
	this.HeadStyle = 0;
	this.BodyPalette = 0;
	this.TopAccessory = 0;
	this.MidAccessory = 0;
	this.BottomAccessory = 0;
	this.BodyStyle = 0;
};
PACKET.CZ.REQ_STYLE_CHANGE2.prototype.build = function () {
	const pkt_buf = new BinaryWriter(16);

	pkt_buf.writeShort(0xafc);
	pkt_buf.writeShort(this.HeadPalette);
	pkt_buf.writeShort(this.HeadStyle);
	pkt_buf.writeShort(this.BodyPalette);
	pkt_buf.writeShort(this.TopAccessory);
	pkt_buf.writeShort(this.MidAccessory);
	pkt_buf.writeShort(this.BottomAccessory);
	pkt_buf.writeShort(this.BodyStyle);

	return pkt_buf;
};

// 0xa48 - the window is gone. Without it the server leaves stylist_open set
// and refuses to open it a second time until the next map change.
PACKET.CZ.REQ_STYLE_CLOSE = function PACKET_CZ_REQ_STYLE_CLOSE() {};
PACKET.CZ.REQ_STYLE_CLOSE.prototype.build = function () {
	const pkt_buf = new BinaryWriter(2);

	pkt_buf.writeShort(0xa48);

	return pkt_buf;
};

// 0xa47 - flag is non-zero when the server refused the look.
PACKET.ZC.STYLE_CHANGE_RES = function PACKET_ZC_STYLE_CHANGE_RES(fp, end) {
	this.flag = fp.readUChar();
};
PACKET.ZC.STYLE_CHANGE_RES.size = 3;

"""
    p.write_text(s.replace(anchor, block + anchor, 1))
    print("patched PacketStructure.js (stylist packets)")

p = rb / "src/Network/PacketRegister.js"
s = p.read_text()
if "STYLE_CHANGE_RES" in s:
    print("PacketRegister.js already patched")
else:
    anchor = "\t0xa4e: PACKET.ZC.RANDOM_COMBINE_ITEM_UI_OPEN,"
    if anchor not in s:
        sys.exit("PacketRegister.js: no 0xa4e line to hang the stylist response off")
    p.write_text(s.replace(anchor, "\t0xa47: PACKET.ZC.STYLE_CHANGE_RES,\n" + anchor, 1))
    print("patched PacketRegister.js (0xa47)")

p = rb / "src/Engine/MapEngine/UIOpen.js"
s = p.read_text()
if "Stylist" in s:
    print("UIOpen.js already patched")
else:
    s = s.replace(
        "import EnchantUI from 'UI/Components/Enchant/Enchant.js';",
        "import EnchantUI from 'UI/Components/Enchant/Enchant.js';\nimport Stylist from 'UI/Components/Stylist/Stylist.js';",
        1,
    )
    old = "\tswitch (pkt.ui_type) {\n\t\tcase 7:"
    new = (
        "\tswitch (pkt.ui_type) {\n"
        "\t\tcase 1:\n"
        "\t\t\t// The stylist. rAthena sets sd->state.stylist_open when it sends\n"
        "\t\t\t// this, and only clears it on a successful buy or on our close\n"
        "\t\t\t// packet -- so the window has to answer either way.\n"
        "\t\t\tif (PACKETVER.value >= 20151104) {\n"
        "\t\t\t\t// Guarded: a window that throws while appending leaves the\n"
        "\t\t\t\t// component half-attached and holding the keyboard, and the\n"
        "\t\t\t\t// player has no way back to character select but to quit.\n"
        "\t\t\t\ttry {\n"
        "\t\t\t\t\tStylist.append();\n"
        "\t\t\t\t} catch (e) {\n"
        "\t\t\t\t\tconsole.error('[Stylist] could not open:', e);\n"
        "\t\t\t\t\tStylist.remove();\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t\tbreak;\n"
        "\t\tcase 7:"
    )
    if old not in s:
        sys.exit("UIOpen.js: the ui_type switch no longer matches; re-check the patch")
    p.write_text(s.replace(old, new, 1))
    print("patched UIOpen.js (ui_type 1 opens the stylist)")

# 0006 - A component that asks for `height: 100%` must get it.
#
# GUIComponent builds: host div -> shadow root -> div.ui-component-root ->
# the component's own markup. That container is never given a size, so a
# percentage height inside a component resolves against `auto` and collapses
# to the height of whatever is in normal flow -- for the refine window, its
# 17px title bar. `.panel { height: 100%; overflow: hidden }` then clipped
# the 301px of window behind it, which is why Refine opened as a sliver with
# the title bar and nothing else. Measured in a running client: the host was
# a correct 261x350 while the markup inside it was 261x17.
#
# Width was never affected -- the container is a block inside a host of
# definite width, so `width: 100%` already had something to resolve against.
# Only height needs saying, and saying it is inert for the many components
# whose host has no definite height: a percentage of an indefinite height is
# still auto.
p = rb / "src/UI/Common.css"
s = p.read_text()
if "ui-component-root" in s:
    print("Common.css already patched")
else:
    p.write_text(s + """
/* The shadow container every component's markup sits in.

   It had no size of its own, so a component asking for `height: 100%`
   resolved it against `auto` and collapsed to its content -- a title bar and
   nothing else, with the rest clipped by any `overflow: hidden` beneath it.
   Inert where the host has no definite height, which is most components. */
.ui-component-root {
\theight: 100%;
}
""")
    print("patched Common.css (.ui-component-root fills its host)")

# 0007 - The quest window showed nothing, on every tab.
#
# Quest.css defaults all four lists to `display: none`:
#
#     #active-quest-list, #feature-quest-list,
#     #inactive-quest-list, #cooldown-quest-list { display: none; }
#
# and the code that means "show this one" writes `style.display = ''`. That
# does not show anything: it clears the *inline* override and lets the
# stylesheet rule apply again, so the list falls straight back to none. Every
# tab was empty for every character, which is what made it look like a packet
# problem -- the quest list arrives and parses correctly, the rows are built
# and appended, and then nothing is ever displayed.
#
# `block` rather than removing the CSS rule: the rule is what hides the other
# three lists, and a <ul> is display:block anyway, so this is what the eight
# call sites already meant.
# Two spellings of the same mistake: the tab handler names the list inline,
# while the code that shows ACTIVE when the window first opens goes through a
# local. Missing the second is why the window still came up empty and only
# filled in after clicking away to another tab and back.
p = rb / "src/UI/Components/Quest/QuestCommon.js"
s = p.read_text()
subs = [
    ("-quest-list').style.display = '';", "-quest-list').style.display = 'block';"),
    ("activeList.style.display = '';", "activeList.style.display = 'block';"),
]
n = sum(s.count(a) for a, _ in subs)
if n == 0:
    print("QuestCommon.js already patched")
else:
    for a, b in subs:
        s = s.replace(a, b)
    p.write_text(s)
    print(f"patched QuestCommon.js ({n} quest lists now actually shown)")

# 0008 - Hats and garments stop rendering once their name comes from a lua
# name table.
#
# Every sprite request 404s with a path whose directory is EUC-KR
# ("data/sprite/\xbe\xc7\xbc\xbc\xbb\xe7\xb8\xae/...") but whose item-name tail is
# Unicode Hangul, so the two halves cannot both be right and the file is never
# found. The asset server does exactly what it should -- it has no such file --
# and missing-files.log names it.
#
# loadLuaTable() decodes every value with the user charpage. That is correct
# for display tables (job names, skill descriptions), but accname.lub and
# spriterobename.lub do not hold display text: their values are GRF filenames.
# getHatPath()/getRobePath() concatenate them onto an EUC-KR byte-string
# prefix, so they have to stay bytes -- which is exactly what itemInfo's
# AddItem already does for identifiedResourceName, decoding it without a
# charpage.
#
# The tables are module singletons that outlive a relogin without a page
# reload, which is why the headgear vanished only after relogging and came
# back on F5 -- and why the symptom reads as "hats not appearing until server
# restart".
p = rb / "src/DB/DBManager.js"
s = p.read_text()
if "isResourceTable" in s:
    print("DBManager.js resource names already patched")
else:
    subs = [
        (
"""function loadLuaTable(file_list, table_name, callback, onEnd, contextFunc) {""",
"""function loadLuaTable(file_list, table_name, callback, onEnd, contextFunc, isResourceTable = false) {""",
        ),
        (
"""			ctx.addKeyAndValueToTable = (key, value) => {
				table[key] = userStringDecoder.decode(value, userCharpage);
				return 1;
			};""",
"""			ctx.addKeyAndValueToTable = (key, value) => {
				// Resource-name tables (accname, robename) hold GRF sprite filenames, not
				// display text. They must stay as raw EUC-KR byte-strings so the paths built
				// in getHatPath/getRobePath match the files -- decoding with the charpage
				// turns them into Unicode Hangul and every sprite request 404s. Display
				// tables (job names, skill descriptions...) still decode with the charpage.
				table[key] = userStringDecoder.decode(value, isResourceTable ? null : userCharpage);
				return 1;
			};""",
        ),
        (
"""			loadLuaTable(
				[DB.LUA_PATH + 'datainfo/accessoryid.lub', DB.LUA_PATH + 'datainfo/accname.lub'],
				'AccNameTable',
				function (json) {
					Object.assign(HatTable, json);
				},
				onLoad()
			);
			loadLuaTable(
				[DB.LUA_PATH + 'datainfo/spriterobeid.lub', DB.LUA_PATH + 'datainfo/spriterobename.lub'],
				'RobeNameTable',
				function (json) {
					Object.assign(RobeTable, json);
				},
				onLoad()
			);""",
"""			loadLuaTable(
				[DB.LUA_PATH + 'datainfo/accessoryid.lub', DB.LUA_PATH + 'datainfo/accname.lub'],
				'AccNameTable',
				function (json) {
					Object.assign(HatTable, json);
				},
				onLoad(),
				null,
				true
			);
			loadLuaTable(
				[DB.LUA_PATH + 'datainfo/spriterobeid.lub', DB.LUA_PATH + 'datainfo/spriterobename.lub'],
				'RobeNameTable',
				function (json) {
					Object.assign(RobeTable, json);
				},
				onLoad(),
				null,
				true
			);""",
        ),
    ]
    for old, new in subs:
        if s.count(old) != 1:
            sys.exit("DBManager.js: resource-name anchor no longer matches (%d hits); re-check the patch" % s.count(old))
        s = s.replace(old, new, 1)
    p.write_text(s)
    print("patched DBManager.js (accessory/robe names stay EUC-KR bytes)")

# 0011 - The window layout is never written unless something removes the
# windows first.
#
# Every component saves its position, size and open/closed state in its
# onRemove hook -- InventoryCommon, EquipmentCommon and the rest all do it
# there, and nowhere else. onRemove runs when UIManager tears the components
# down, which happens on a return to character select and on nothing else.
#
# So quitting from inside the game never wrote the layout at all: the process
# ends, the renderer goes with it, and the values were still only in the
# components. It reads as "it forgot where I put my windows", and it is not a
# flushing problem -- there was nothing in localStorage to flush. Volume
# survives the same quit because Audio preferences are saved as they change.
#
# pagehide covers a browser tab and any normal navigation. The desktop shell
# exits the process outright, which fires no page event at all, so the same
# work is exposed for it to call before it starts tearing the stack down.
p = rb / "src/App/Online.js"
s = p.read_text()
if "roPersistUI" in s:
    print("Online.js already patched")
else:
    old = """import GameEngine from 'Engine/GameEngine.js';
import Plugins from 'Plugins/PluginManager.js';"""
    new = """import GameEngine from 'Engine/GameEngine.js';
import Plugins from 'Plugins/PluginManager.js';
import UIManager from 'UI/UIManager.js';"""
    if s.count(old) != 1:
        sys.exit("Online.js: imports no longer match; re-check the patch")
    s = s.replace(old, new, 1)

    old = """	window.onbeforeunload = function () {
		return 'Are you sure to exit roBrowser ?';
	};"""
    new = """	window.onbeforeunload = function () {
		return 'Are you sure to exit roBrowser ?';
	};

	// Components write their layout in onRemove and nowhere else, so the
	// layout only survives if something removes them. Nothing does when the
	// page simply goes away.
	const persistUI = function () {
		try {
			UIManager.removeComponents();
		} catch (e) {
			console.warn('could not save the window layout', e);
		}
	};
	window.addEventListener('pagehide', persistUI);
	// For a host that ends the process without a page event of any kind.
	window.roPersistUI = persistUI;"""
    if s.count(old) != 1:
        sys.exit("Online.js: onbeforeunload no longer matches; re-check the patch")
    s = s.replace(old, new, 1)
    p.write_text(s)
    print("patched Online.js (save the window layout when the page goes away)")

# 0010 - Drag and drop onto the equipment window did nothing.
#
# Dragging a hat from the inventory onto the character never equipped it. The
# drag started, the slot highlighted, and the drop was silently ignored --
# double-clicking the item worked, which is what made it look like a quirk of
# the equipment window rather than a bug.
#
# onDragOver ends with `event.stopImmediatePropagation(); return false;` and
# never calls preventDefault(). Under the HTML5 drag-and-drop model an element
# is only a drop target if its dragover handler *cancels* the event, so without
# it the browser never fires `drop` and onDrop is dead code. `return false`
# would have done exactly that under jQuery, which treats it as preventDefault
# plus stopPropagation -- but this is an addEventListener callback, where a
# falsy return means nothing at all. The handler was correct once and quietly
# stopped being correct when the binding changed.
#
# Every other named dragover handler in roBrowser's component tree calls
# preventDefault, including SwitchEquip's own onDragOver, which is the same
# window family. This one is the only one that does not.
#
# Anchored on the tail of onDragOver rather than on the two lines themselves:
# onDragLeave ends identically, and patching that one instead would leave the
# real bug in place while looking applied.
p = rb / "src/UI/Components/Equipment/EquipmentCommon.js"
s = p.read_text()
if "// preventDefault, not `return false`" in s:
    print("EquipmentCommon.js drag-and-drop already patched")
else:
    old = """					Client.loadFile(DB.INTERFACE_PATH + 'basic_interface/item_invert.bmp', _data => {
						cells.forEach(c => {
							c.style.backgroundImage = `url(${_data})`;
						});
					});
				}
			}
		}
		event.stopImmediatePropagation();
		return false;
	}"""
    new = """					Client.loadFile(DB.INTERFACE_PATH + 'basic_interface/item_invert.bmp', _data => {
						cells.forEach(c => {
							c.style.backgroundImage = `url(${_data})`;
						});
					});
				}
			}
		}
		// preventDefault, not `return false`: a drop only fires on a target
		// whose dragover cancelled the event, and a falsy return from an
		// addEventListener callback cancels nothing. Without this the window
		// is never a drop target and onDrop below never runs.
		event.preventDefault();
		event.stopImmediatePropagation();
		return false;
	}"""
    if s.count(old) != 1:
        sys.exit("EquipmentCommon.js: onDragOver no longer matches (%d hits); re-check the patch" % s.count(old))
    p.write_text(s.replace(old, new, 1))
    print("patched EquipmentCommon.js (drag and drop onto the equipment window)")

# 0012 - Put the cart/mount controls below the equipment grid and actually
# show them when their state is active.
#
# roBrowser ships both controls in every equipment layout, positioned over the
# character preview. Their stylesheet default is `display: none`, while the
# state updater tries to reveal them with `style.display = ''`. Clearing the
# inline value merely exposes the stylesheet's `display: none` again, so the
# controls can never appear. V4 is the layout selected by our 20221005 packet
# version. Give that layout the cleaner native control bar used by the client
# UI the assets came from; older layouts retain their upstream geometry.
# `allRidingState` is deliberately not included: Halter Lead Box class mounts
# use that separate state and cannot be removed by this REQ_CARTOFF control.
p = rb / "src/UI/Components/Equipment/EquipmentCommon.js"
s = p.read_text()
old = """\t\t\t\tif (_lastState & HasAttachmentState || _hasCart) {
\t\t\t\t\tif (removeOpt) removeOpt.style.display = '';
\t\t\t\t} else {
\t\t\t\t\tif (removeOpt) removeOpt.style.display = 'none';
\t\t\t\t}

\t\t\t\tif (_lastState & HasCartState || _hasCart) {
\t\t\t\t\tif (cartBtn) cartBtn.style.display = '';
\t\t\t\t} else {
\t\t\t\t\tif (cartBtn) cartBtn.style.display = 'none';
\t\t\t\t}"""
new = """\t\t\t\tconst hasAttachment = Boolean(_lastState & HasAttachmentState || _hasCart);
\t\t\t\tconst hasCart = Boolean(_lastState & HasCartState || _hasCart);

\t\t\t\tif (hasAttachment) {
\t\t\t\t\t// The stylesheet default is none; clearing the inline value does
\t\t\t\t\t// not override it and left the button permanently invisible.
\t\t\t\t\tif (removeOpt) removeOpt.style.display = 'block';
\t\t\t\t} else {
\t\t\t\t\tif (removeOpt) removeOpt.style.display = 'none';
\t\t\t\t}
\t\t\t\tconst removeControl = removeOpt && removeOpt.closest('.attachment-control');
\t\t\t\tif (removeControl) removeControl.style.display = hasAttachment ? 'flex' : 'none';

\t\t\t\tif (hasCart) {
\t\t\t\t\tif (cartBtn) cartBtn.style.display = 'block';
\t\t\t\t} else {
\t\t\t\t\tif (cartBtn) cartBtn.style.display = 'none';
\t\t\t\t}
\t\t\t\tconst cartControl = cartBtn && cartBtn.closest('.attachment-control');
\t\t\t\tif (cartControl) cartControl.style.display = hasCart ? 'flex' : 'none';

\t\t\t\tconst attachmentControls = root.querySelector('.attachment-controls');
\t\t\t\tif (attachmentControls) {
\t\t\t\t\tconst showAttachmentControls =
\t\t\t\t\t\tcurrentTabId === 'general' && (hasAttachment || hasCart);
\t\t\t\t\tattachmentControls.style.display = showAttachmentControls ? 'flex' : 'none';
\t\t\t\t\tconst panel = root.querySelector('.panel');
\t\t\t\t\tif (panel) panel.classList.toggle('has-attachment-controls', showAttachmentControls);
\t\t\t\t}"""
if "left the button permanently invisible" in s:
    print("EquipmentCommon.js attachment controls already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched EquipmentCommon.js (attachment controls become visible)")
else:
    sys.exit("EquipmentCommon.js: attachment visibility no longer matches (%d hits); re-check the patch" % s.count(old))

# The V4 controls sit outside the tab tables, so switching away from General
# must hide their strip explicitly. Restore it only when one of its state-
# controlled buttons is active.
p = rb / "src/UI/Components/Equipment/EquipmentCommon.js"
s = p.read_text()
old = """\t\tcurrentTabId = selectedId;

\t\tif (switchEquip) {"""
new = """\t\tcurrentTabId = selectedId;

\t\tconst attachmentControls = root.querySelector('.attachment-controls');
\t\tif (attachmentControls) {
\t\t\tconst hasVisibleControl = Array.from(attachmentControls.querySelectorAll('button')).some(
\t\t\t\tbutton => button.style.display === 'block'
\t\t\t);
\t\t\tconst showAttachmentControls = currentTabId === 'general' && hasVisibleControl;
\t\t\tattachmentControls.style.display = showAttachmentControls ? 'flex' : 'none';
\t\t\tconst panel = root.querySelector('.panel');
\t\t\tif (panel) panel.classList.toggle('has-attachment-controls', showAttachmentControls);
\t\t}

\t\tif (switchEquip) {"""
if "const hasVisibleControl" in s:
    print("EquipmentCommon.js attachment tab visibility already patched")
elif s.count(old) == 1:
    p.write_text(s.replace(old, new, 1))
    print("patched EquipmentCommon.js (attachment controls follow General tab)")
else:
    sys.exit("EquipmentCommon.js: tab-switch anchor no longer matches (%d hits); re-check the patch" % s.count(old))

p = rb / "src/UI/Components/Equipment/EquipmentV4/EquipmentV4.html"
s = p.read_text()
old_controls = """\t\t\t\t\t\t<button
\t\t\t\t\t\t\tclass="cartitems"
\t\t\t\t\t\t\tdata-background="basic_interface/btn_items_off.bmp"
\t\t\t\t\t\t\tdata-hover="basic_interface/btn_items_on.bmp"
\t\t\t\t\t\t></button>
\t\t\t\t\t\t<button class="removeOption" data-background="basic_interface/btn_off.bmp"></button>
"""
new_controls = ""
old_footer = """\t\t<div class="footer" id="equipment_footer" data-background="basic_interface/equipwin_bg2.bmp">
\t\t\t<div class="left">"""
new_footer = """\t\t<div class="attachment-controls" data-background="basic_interface/equipwin_bg3.bmp">
\t\t\t<div class="attachment-control mount-control">
\t\t\t\t<span>Mount/Cart</span>
\t\t\t\t<button
\t\t\t\t\tclass="removeOption"
\t\t\t\t\tdata-background="basic_interface/grp_online.bmp"
\t\t\t\t\tdata-hover="basic_interface/grp_offline.bmp"
\t\t\t\t></button>
\t\t\t</div>
\t\t\t<div class="attachment-control cart-control">
\t\t\t\t<span>Cart</span>
\t\t\t\t<button
\t\t\t\t\tclass="cartitems"
\t\t\t\t\tdata-background="basic_interface/btn_items_off.bmp"
\t\t\t\t\tdata-hover="basic_interface/btn_items_on.bmp"
\t\t\t\t></button>
\t\t\t</div>
\t\t</div>
\t\t<div class="footer" id="equipment_footer" data-background="basic_interface/equipwin_bg2.bmp">
\t\t\t<div class="left">"""
if "class=\"attachment-controls\"" in s:
    print("EquipmentV4.html attachment controls already moved")
elif s.count(old_controls) == 1 and s.count(old_footer) == 1:
    s = s.replace(old_controls, new_controls, 1)
    s = s.replace(old_footer, new_footer, 1)
    p.write_text(s)
    print("patched EquipmentV4.html (attachment controls below equipment grid)")
else:
    sys.exit("EquipmentV4.html: attachment control anchors no longer match; re-check the patch")

p = rb / "src/UI/Components/Equipment/EquipmentV4/EquipmentV4.css"
s = p.read_text()
anchor = """#EquipmentV4 .removeOption {
\tposition: absolute;
\ttop: 90px;
\tleft: 12px;
\twidth: 36px;
\theight: 36px;
\tbackground-repeat: no-repeat;
\tbackground-color: transparent;
\tborder: none;
\tdisplay: none;
}
"""
replacement = """#EquipmentV4 .attachment-controls {
\tdisplay: none;
\tposition: relative;
\theight: 23px;
\tbackground-repeat: no-repeat;
}
#EquipmentV4 .panel.has-attachment-controls {
\theight: 173px;
}
#EquipmentV4 .attachment-control {
\tposition: absolute;
\ttop: -4px;
\tdisplay: none;
\talign-items: center;
\theight: 23px;
\twhite-space: nowrap;
\ttext-shadow: 1px 1px white;
}
#EquipmentV4 .mount-control {
\tleft: 108px;
}
#EquipmentV4 .cart-control {
\tleft: 207px;
}
#EquipmentV4 .attachment-control button {
\tposition: static;
\tmargin-left: 6px;
\tbackground-repeat: no-repeat;
\tbackground-color: transparent;
\tborder: none;
\tdisplay: none;
}
#EquipmentV4 .mount-control .removeOption {
\twidth: 14px;
\theight: 14px;
}
#EquipmentV4 .cart-control .cartitems {
\twidth: 30px;
\theight: 20px;
}
"""
if "#EquipmentV4 .attachment-controls" in s:
    print("EquipmentV4.css attachment controls already styled")
elif s.count(anchor) == 1:
    # The cart rule immediately before this block is superseded by the more
    # specific descendant rule, so only the second legacy-position block has
    # to be replaced.
    p.write_text(s.replace(anchor, replacement, 1))
    print("patched EquipmentV4.css (bottom attachment-control layout)")
else:
    sys.exit("EquipmentV4.css: removeOption block no longer matches (%d hits); re-check the patch" % s.count(anchor))

PY

python3 "$ROOT/scripts/patch-client-controls.py" "$ROOT" "$RB"
