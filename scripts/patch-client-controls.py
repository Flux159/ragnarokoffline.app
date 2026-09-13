#!/usr/bin/env python3
"""Versioned client API hooks; fail if a pinned upstream contract changes."""
from pathlib import Path
import shutil
import sys

root, rb = map(Path, sys.argv[1:])
destination = rb / 'src/Plugins/Ragnarok'
destination.mkdir(parents=True, exist_ok=True)
for source in (root / 'patches/client').glob('*.mjs'):
    shutil.copyfile(source, destination / source.name)
shutil.copyfile(root / 'patches/client/PluginManager.js', rb / 'src/Plugins/PluginManager.js')


def edit(file, old, new):
    path = rb / 'src' / file
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        sys.exit(f'{file}: expected one extension hook anchor, got {text.count(old)}: {old[:80]!r}')
    path.write_text(text.replace(old, new, 1))


def runtime(file):
    path = rb / 'src' / file
    text = path.read_text()
    line = "import ClientRuntime from 'Plugins/Ragnarok/ExtensionRuntime.mjs';\n"
    if line not in text:
        path.write_text(line + text)


# Older working checkouts have the previous unconditional WASD patch installed.
p = rb / 'src/Engine/MapEngine.js'
s = p.read_text().replace("import KeyboardMove from 'Controls/KeyboardMove.js';\n", '').replace('\t\t\tKeyboardMove.init();\n', '')
p.write_text(s)

edit('App/Online.js', "import Plugins from 'Plugins/PluginManager.js';",
     "import Plugins from 'Plugins/PluginManager.js';\nimport { init as initExtensions } from 'Plugins/Ragnarok/ExtensionBridge.mjs';")
edit('App/Online.js', 'export function init() {', 'export async function init() {')
edit('App/Online.js', '\tPlugins.init();\n\tGameEngine.init();', '\tinitExtensions();\n\tawait Plugins.init();\n\tGameEngine.init();')
edit('App/Online.js', "\twindow.addEventListener('pagehide', persistUI);",
     "\twindow.addEventListener('pagehide', () => { persistUI(); Plugins.dispose(); });\n"
     "\twindow.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });")

runtime('UI/GUIComponent.js')
edit('UI/GUIComponent.js', '\t\t// Scrollbars\n', '\t\tClientRuntime.appendComponent(this);\n\n\t\t// Scrollbars\n')
edit('UI/GUIComponent.js', '\tremove() {\n\t\tthis.__active = false;',
     '\tremove() {\n\t\tClientRuntime.removeComponent(this);\n\t\tthis.__active = false;')

runtime('Renderer/MapRenderer.js')
edit('Renderer/MapRenderer.js', '\t\t// Support for instance map',
     "\t\tClientRuntime.leaveMap('loading');\n\n\t\t// Support for instance map")
edit('Engine/MapEngine.js', "import MapControl from 'Controls/MapControl.js';",
     "import MapControl from 'Controls/MapControl.js';\nimport { enterMap as enterExtensionMap } from 'Plugins/Ragnarok/ExtensionBridge.mjs';")
edit('Engine/MapEngine.js', '\t\t// Reload plugins\n', '\t\tenterExtensionMap(MapRenderer.currentMap);\n\n\t\t// Reload plugins\n')
runtime('Engine/MapEngine/Main.js')
edit('Engine/MapEngine/Main.js', 'function onPlayerMove(pkt) {\n',
     'function onPlayerMove(pkt) {\n\tClientRuntime.recordMovement(pkt.MoveData);\n')

runtime('Network/NetworkManager.js')
edit('Network/NetworkManager.js', '\t\tcallback.call(this, success);',
     "\t\tClientRuntime.connection(success ? 'connected' : 'failed', isZone ? 'map' : 'account');\n\t\tcallback.call(this, success);")
edit('Network/NetworkManager.js', "\t\tconsole.warn('[Network] Disconnect from server');",
     "\t\tClientRuntime.connection('disconnected');\n\t\tconsole.warn('[Network] Disconnect from server');")
edit('Network/NetworkManager.js', 'function close() {\n', "function close() {\n\tClientRuntime.connection('disconnected');\n")

runtime('Controls/MapControl.js')
edit('Controls/MapControl.js', '\tconst entityOver = EntityManager.getOverEntity();',
     "\tif (action === 1) ClientRuntime.movement.clear('map-click');\n\tconst entityOver = EntityManager.getOverEntity();")

# Keep upstream action controls, replace only its independent movement timer.
runtime('UI/Components/MobileUI/MobileUI.js')
edit('UI/Components/MobileUI/MobileUI.js', "import Camera from 'Renderer/Camera.js';",
     "import Camera from 'Renderer/Camera.js';\nimport { attachJoystick } from 'Plugins/Ragnarok/PointerJoystick.mjs';")
p = rb / 'src/UI/Components/MobileUI/MobileUI.js'
s = p.read_text()
if '// RAGNAROK shared pointer movement' not in s:
    start = s.index('function setupJoystick() {')
    end = s.index('/**\n * Talk to NPC Button Function', start)
    s = s[:start] + '''// RAGNAROK shared pointer movement
let disposeJoystick = null;
let joystickScope = null;
function setupJoystick() {
    const root = MobileUI.getRoot();
    _joystickBase = root.querySelector('#joystickBase');
    _joystickThumb = root.querySelector('#joystickThumb');
}
function startJoystick() {
    stopJoystick();
    joystickScope = ClientRuntime.scope('engine:touch');
    disposeJoystick = attachJoystick(_joystickBase, _joystickThumb, joystickScope.api.movement);
}
function stopJoystick() {
    disposeJoystick?.(); disposeJoystick = null;
    joystickScope?.dispose(); joystickScope = null;
}

''' + s[end:]
    p.write_text(s)
edit('UI/Components/MobileUI/MobileUI.js', 'MobileUI.onAppend = function onAppend() {\n',
     'MobileUI.onAppend = function onAppend() {\n\tstartJoystick();\n')
edit('UI/Components/MobileUI/MobileUI.js', 'MobileUI.onRemove = function onRemove() {\n',
     'MobileUI.onRemove = function onRemove() {\n\tstopJoystick();\n')
print('installed client extension API and shared movement hooks')

# Character names shorter than four characters are refused by the char-server
# with the same generic code it uses for empty names, control characters and a
# leading '#', so the client can only say "Char creation denied". Say the actual
# rule before sending, since the server's answer cannot carry it.
#
# Length only. The permitted character set is server configuration
# (char_name_letters), and a mod may change it, so the client is not the place
# to assert it -- but char_name_min_length has been 4 since forever and is the
# client's own historical limit too.
edit('Engine/CharEngine.js', "function onCharCreationRequest(name, Str, Agi, Vit, Int, Dex, Luk, hair, color, job, sex) {\n\tlet pkt;",
     """function onCharCreationRequest(name, Str, Agi, Vit, Int, Dex, Luk, hair, color, job, sex) {
\tlet pkt;

\t// RAGNAROK: the server refuses these with a code that means only "denied".
\tif (String(name || '').trim().length < 4) {
\t\tUIManager.showMessageBox('Character names need at least 4 characters.', 'ok');
\t\treturn;
\t}""")

# /q1 and /q2 -- quickspell. The official client has them; roBrowser does not.
# Slot numbers (F9, F7, F8) are fixed in the official client, so they are fixed
# here. Both toggles default off, as they do there.
edit('Controls/ProcessCommand.js', "let aliases = {};",
     "import { QuickSpell, SLOT_RIGHT_CLICK, SLOT_WHEEL_UP, SLOT_WHEEL_DOWN } from "
     "'Plugins/Ragnarok/QuickSpell.mjs';\n\nlet aliases = {};")
edit('Controls/ProcessCommand.js', "const CommandStore = {\n",
     """const CommandStore = {
\tq1: {
\t\tdescription: 'Right click casts the F9 hotkey',
\t\taliases: ['quickspell'],
\t\tcallback: function (text) {
\t\t\tconst on = quickSpellArgument(text, QuickSpell.rightClick);
\t\t\tQuickSpell.set('rightClick', on);
\t\t\tthis.addText(`Mouse right click shortcut to F9 hotkey is ${on ? 'Enabled' : 'Disabled'}.[/q1 ${on ? 'ON' : 'OFF'}]`, this.TYPE.INFO, this.FILTER.PUBLIC_LOG);
\t\t}
\t},
\tq2: {
\t\tdescription: 'Mouse wheel casts the F7 and F8 hotkeys',
\t\taliases: ['quickspell2'],
\t\tcallback: function (text) {
\t\t\tconst on = quickSpellArgument(text, QuickSpell.wheel);
\t\t\tQuickSpell.set('wheel', on);
\t\t\tthis.addText(`Mouse wheel shortcuts to F7 and F8 hotkeys are ${on ? 'Enabled' : 'Disabled'}.[/q2 ${on ? 'ON' : 'OFF'}]`, this.TYPE.INFO, this.FILTER.PUBLIC_LOG);
\t\t}
\t},
\tq3: {
\t\tdescription: 'Both quickspell shortcuts at once',
\t\tcallback: function (text) {
\t\t\tconst on = quickSpellArgument(text, QuickSpell.rightClick && QuickSpell.wheel);
\t\t\tQuickSpell.set('rightClick', on);
\t\t\tQuickSpell.set('wheel', on);
\t\t\tthis.addText(`Quickspell shortcuts are ${on ? 'Enabled' : 'Disabled'}.[/q3 ${on ? 'ON' : 'OFF'}]`, this.TYPE.INFO, this.FILTER.PUBLIC_LOG);
\t\t}
\t},
""")

# The callback is handed the whole command line, not just its argument, so
# "q1 OFF" has to be split before it can be read. No argument toggles, which
# is what the official client does.
edit('Controls/ProcessCommand.js', "let aliases = {};\n",
     """let aliases = {};

function quickSpellArgument(text, current) {
\tconst argument = String(text || '').trim().split(/\\s+/)[1];
\tif (!argument) return !current;
\treturn !['off', '0', 'false'].includes(argument.toLowerCase());
}
""")

# Right click without a drag: cast instead of opening the context menu.
edit('Controls/MapControl.js', "import UIManager from 'UI/UIManager.js';",
     "import UIManager from 'UI/UIManager.js';\nimport { QuickSpell, SLOT_RIGHT_CLICK, SLOT_WHEEL_UP, SLOT_WHEEL_DOWN } from 'Plugins/Ragnarok/QuickSpell.mjs';")
edit('Controls/MapControl.js',
     """			if (_rightClickPosition[0] === Mouse.screen.x && _rightClickPosition[1] === Mouse.screen.y && !KEYS.SHIFT) {
				entity = EntityManager.getOverEntity();""",
     """			if (_rightClickPosition[0] === Mouse.screen.x && _rightClickPosition[1] === Mouse.screen.y && !KEYS.SHIFT) {
				// /q1: a right click that did not drag is a hotkey press, not a
				// context menu. A drag still rotates, so the camera is unaffected.
				if (QuickSpell.rightClick && QuickSpell.cast(SLOT_RIGHT_CLICK)) {
					break;
				}
				entity = EntityManager.getOverEntity();""")

# Wheel: cast instead of zooming, but never while choosing a skill level.
edit('Controls/MapControl.js',
     """	// Zooming on the scene
	const delta = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;""",
     """	// /q2: the wheel casts F7 and F8 instead of zooming. Checked after the
	// skill-level branch above, which owns the wheel while targeting.
	if (QuickSpell.wheel && event.deltaY !== 0) {
		if (QuickSpell.cast(event.deltaY < 0 ? SLOT_WHEEL_UP : SLOT_WHEEL_DOWN)) {
			return;
		}
	}

	// Zooming on the scene
	const delta = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;""")

# Phone windows keep their own geometry. Keep legacy desktop keys unchanged.
edit('Core/Preferences.js', 'const Storage = {',
     "import { geometryKey } from 'Plugins/Ragnarok/LayoutProfile.mjs';\n\nconst Storage = {")
edit('Core/Preferences.js', '\tstatic get(key, def, version) {\n',
     '\tstatic get(key, def, version) {\n\t\tkey = geometryKey(key, def);\n')

# The old first-touch detector can reveal the native HUD after a player opted
# out. Use the profile selected before login for app-hosted mobile-ui sessions.
edit('UI/Components/MobileUI/MobileUI.js', "import { attachJoystick } from 'Plugins/Ragnarok/PointerJoystick.mjs';",
     "import { attachJoystick } from 'Plugins/Ragnarok/PointerJoystick.mjs';\n"
     "import { phoneLayout, mobileModAvailable } from 'Plugins/Ragnarok/LayoutProfile.mjs';")
edit('UI/Components/MobileUI/MobileUI.js', '\tif (Session.isTouchDevice) {\n',
     '\tif (mobileModAvailable ? phoneLayout : Session.isTouchDevice) {\n')
edit('UI/Components/MobileUI/MobileUI.js', 'MobileUI.show = function show() {\n',
     'MobileUI.show = function show() {\n\tif (mobileModAvailable && !phoneLayout) return;\n')
edit('UI/Background.js', "const _container = document.createElement('div');",
     "const _container = document.createElement('div');\n_container.className = 'ro-background';")
edit('UI/Background.js', '\tstatic setImage(filename, callback) {\n',
     "\tstatic setImage(filename, callback) {\n\t\t_container.dataset.roTiled = String(Array.isArray(filename));\n")

# Phone Stats is opened separately from the menu. Desktop Equipment's extra
# embedded Stats host would otherwise cover the phone equipment controls.
edit('UI/Components/WinStats/WinStatsCommon.js', "import DB from 'DB/DBManager.js';",
     "import { phoneLayout } from 'Plugins/Ragnarok/LayoutProfile.mjs';\nimport DB from 'DB/DBManager.js';")
edit('UI/Components/WinStats/WinStatsCommon.js', '\tComponent.embed = function embed(anchorHost) {\n',
     '\tComponent.embed = function embed(anchorHost) {\n\t\tif (phoneLayout) return;\n')

# Phone CSS offsets native focus ordering above the HUD, without flattening all
# panels to the same layer or observing style mutations from a plugin.
edit('UI/GUIComponent.js', '\t\t\tcomp._host.style.zIndex = value;\n',
     "\t\t\tcomp._host.style.zIndex = value;\n\t\t\tcomp._host.style.setProperty('--ro-native-z', String(value));\n")

# Native data lookup for validated storage actions. The plugin API returns no
# mutable inventory/storage objects; the adapter alone uses this method.
edit('UI/Components/Storage/StorageCommon.js', '\tconst _list = [];\n',
     '\tconst _list = [];\n\tComponent.getItemByIndex = index => _list.find(item => item.index === index);\n')

# The app phone toolbar intentionally selects a shop item without requiring a
# preceding map touch to enable the upstream touch-device detector.
edit('UI/Components/NpcStore/NpcStore.js', "import DB from 'DB/DBManager.js';",
     "import { phoneLayout } from 'Plugins/Ragnarok/LayoutProfile.mjs';\nimport DB from 'DB/DBManager.js';")
edit('UI/Components/NpcStore/NpcStore.js', '&& !Session.isTouchDevice) {',
     '&& !Session.isTouchDevice && !phoneLayout) {')
edit('UI/Components/InputBox/InputBox.js', '\tthis.isPersistent = !!isPersistent;\n',
     "\tthis.isPersistent = !!isPersistent;\n\tconst entry = this.getRoot().querySelector('input');\n\tif (entry) entry.inputMode = ['number', 'price'].includes(type) ? 'numeric' : '';\n")

# The touch pickup action must wait for the same walk-end callback as map clicks.
edit('UI/Components/MobileUI/MobileUI.js', """function pickUpItem() {
	const player = Session.Entity;

	if (!player) {
		return;
	}

	const closestItem = EntityManager.getClosestEntity(player, Session.Entity.constructor.TYPE_ITEM);

	if (!closestItem) {
		return;
	}

	let dx = Math.abs(player.position[0] - closestItem.position[0]);
	let dy = Math.abs(player.position[1] - closestItem.position[1]);
	if (dx < 0) {
		dx = -dx;
	}
	if (dy < 0) {
		dy = -dy;
	}

	if ((dx < dy ? dy : dx) > 2) {
		const dest = [0, 0];

		if (checkFreeCell(Math.round(closestItem.position[0]), Math.round(closestItem.position[1]), 1, dest)) {
			let pkt;
			if (PACKETVER.value >= 20180307) {
				pkt = new PACKET.CZ.REQUEST_MOVE2();
			} else {
				pkt = new PACKET.CZ.REQUEST_MOVE();
			}
			pkt.dest = dest;
			Network.sendPacket(pkt);
		}
	}

	let pickUpPacket;

	if (PACKETVER.value >= 20180307) {
		pickUpPacket = new PACKET.CZ.ITEM_PICKUP2();
	} else {
		pickUpPacket = new PACKET.CZ.ITEM_PICKUP();
	}

	pickUpPacket.ITAID = closestItem.GID;

	Network.sendPacket(pickUpPacket);
}""",
     """function pickUpItem() {
	const player = Session.Entity;
	if (!player) return;
	const closestItem = EntityManager.getClosestEntity(player, Session.Entity.constructor.TYPE_ITEM);
	if (!closestItem) return;

	const pickup = PACKETVER.value >= 20180307 ? new PACKET.CZ.ITEM_PICKUP2() : new PACKET.CZ.ITEM_PICKUP();
	pickup.ITAID = closestItem.GID;
	Session.moveAction = null;
	const distance = Math.max(Math.abs(player.position[0] - closestItem.position[0]),
		Math.abs(player.position[1] - closestItem.position[1]));
	if (distance > 2) {
		const dest = [0, 0];
		if (checkFreeCell(Math.round(closestItem.position[0]), Math.round(closestItem.position[1]), 1, dest)) {
			// RAGNAROK: use the same deferred action as native map-item clicks.
			// The server rejects pickup while the approach walk is still pending.
			Session.moveAction = pickup;
			const move = PACKETVER.value >= 20180307 ? new PACKET.CZ.REQUEST_MOVE2() : new PACKET.CZ.REQUEST_MOVE();
			move.dest = dest;
			Network.sendPacket(move);
		}
		return;
	}
	Network.sendPacket(pickup);
}""")
