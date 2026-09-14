#!/usr/bin/env bash
# Apply Ragnarok Offline's own additions to the vendored roBrowserLegacy checkout.
#
# Fixes to roBrowserLegacy itself are not here. They are commits on the
# `ragnarokoffline` branch of Flux159/roBrowserLegacy, which is what
# config/VENDOR_PINS fetches, so they can be offered upstream as they are -- see
# docs/FORKS.md. What stays is what is ours: the lockfile, the stylist window,
# the app's wording and window layout, and the extension hooks applied by
# patch-client-controls.py below.
#
# Done as idempotent in-place edits rather than `git apply`, so an upstream
# change to unrelated lines does not break the whole patch set. Each edit
# checks whether it has already been made.
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
