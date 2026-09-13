/**
 * UI/Components/Stylist/Stylist.js
 *
 * The stylist window (ZC_UI_OPEN, ui_type 1).
 *
 * roBrowser implements three of the eleven ui_types the server can ask for,
 * and the stylist is not one of them -- `onUIOpen` logged "not implemented"
 * and returned. rAthena does not know that, so every stylist NPC in renewal
 * closes its dialogue, asks for this window and leaves the player facing
 * nothing at all. This is that window.
 *
 * Two decisions worth knowing about:
 *
 * **The preview is the character itself.** Every other approach means a second
 * canvas, a second Entity and the sprite-loading dance CharCreate does in a
 * hundred lines. Setting the look on the player's own entity is a true preview
 * -- it is the same code path a server-sent look change uses -- and the
 * original values are put back if the window is cancelled or closed. Nothing
 * is sent until Apply.
 *
 * **An index is not a look value, but here it is.** The packet carries indices
 * into the server's stylist table, not hair numbers, and rAthena resolves them
 * through `db/re/stylist.yml`. In the table rAthena ships, `Index` and `Value`
 * are the same number for every entry, so sending the look value works. A
 * server with a rewritten stylist table could map them differently; the server
 * validates every index and answers ZC_STYLE_CHANGE_RES with a failure flag,
 * which is reported rather than swallowed.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Preferences from 'Core/Preferences.js';
import Renderer from 'Renderer/Renderer.js';
import Session from 'Engine/SessionStorage.js';
import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import htmlText from './Stylist.html?raw';
import cssText from './Stylist.css?raw';

/**
 * Create component
 */
const Stylist = new GUIComponent('Stylist', cssText);

Stylist.render = () => htmlText;

/**
 * What the player may cycle through.
 *
 * The ranges mirror the stylist table rAthena ships (`db/re/stylist.yml`:
 * 42 hair styles, 8 hair colours, 7 clothes colours). They are a courtesy,
 * not a rule -- the server is the authority and rejects anything outside its
 * own table, which is reported in chat rather than silently ignored.
 *
 * `field` is the name of the field in CZ_REQ_STYLE_CHANGE2; `prop` is the
 * Entity property that shows it.
 */
const LOOKS = [
	{ prop: 'head', field: 'HeadStyle', min: 1, max: 42 },
	{ prop: 'headpalette', field: 'HeadPalette', min: 1, max: 8 },
	{ prop: 'bodypalette', field: 'BodyPalette', min: 1, max: 7 }
];

/**
 * @var {Preferences} window position
 */
const _preferences = Preferences.get(
	'Stylist',
	{
		x: 300,
		y: 200
	},
	1.0
);

/**
 * What the character looked like when the window opened, so Cancel means
 * something.
 */
let _original = null;

/**
 * Initialize the component
 */
Stylist.init = function init() {
	const root = this.getRoot();

	this.draggable('.titlebar');

	root.querySelector('.titlebar .close').addEventListener('click', () => {
		revert();
		Stylist.remove();
	});

	root.querySelector('.cancel').addEventListener('click', () => {
		revert();
		Stylist.remove();
	});

	root.querySelector('.apply').addEventListener('click', () => {
		apply();
	});

	root.querySelectorAll('.row').forEach((row) => {
		const look = LOOKS.find((l) => l.prop === row.getAttribute('data-look'));
		if (!look) {
			return;
		}
		row.querySelector('.prev').addEventListener('click', () => step(look, -1));
		row.querySelector('.next').addEventListener('click', () => step(look, +1));
	});
};

/**
 * Remember the character, and show what it currently is
 */
Stylist.onAppend = function onAppend() {
	const entity = Session.Entity;

	_original = {};
	LOOKS.forEach((look) => {
		_original[look.prop] = entity ? entity[look.prop] | 0 : 0;
	});

	// `_host`, not `getRoot()`: getRoot() hands back the ShadowRoot, which has
	// no style of its own. Setting `.style.left` on it throws inside append(),
	// which leaves the component half-attached and -- because onKeyDown was
	// then live -- eating the Escape that would have got the player out.
	const host = this._host;
	host.style.left =
		Math.min(Math.max(0, _preferences.x), Renderer.width - host.offsetWidth) + 'px';
	host.style.top =
		Math.min(Math.max(0, _preferences.y), Renderer.height - host.offsetHeight) + 'px';

	refresh();
};

/**
 * Keep the position, and never leave the player wearing an unpaid preview
 */
Stylist.onRemove = function onRemove() {
	revert();

	_preferences.x = parseInt(this._host.style.left, 10) || 0;
	_preferences.y = parseInt(this._host.style.top, 10) || 0;
	_preferences.save();

	// Tell the server the window is gone, so it stops considering the stylist
	// open. Without this `sd->state.stylist_open` stays true until the next
	// map change and a second visit to the NPC is refused.
	if (PACKETVER.value >= 20151104) {
		Network.sendPacket(new PACKET.CZ.REQ_STYLE_CLOSE());
	}
};

/**
 * Escape closes it, like every other window
 */
Stylist.onKeyDown = function onKeyDown(event) {
	// A component that failed to append must not hold the keyboard hostage.
	// Escape is how a stuck player gets back to character select, and that is
	// exactly the moment it has to work.
	if (!this._host || this._host.style.display === 'none') {
		return true;
	}
	if (event.which === 27 || event.key === 'Escape') {
		revert();
		this.remove();
		event.stopImmediatePropagation();
		return false;
	}
	return true;
};

/**
 * Move one look up or down, wrapping at both ends
 */
function step(look, direction) {
	const entity = Session.Entity;
	if (!entity) {
		return;
	}

	let value = (entity[look.prop] | 0) + direction;
	if (value > look.max) {
		value = look.min;
	}
	if (value < look.min) {
		value = look.max;
	}

	entity[look.prop] = value;
	refresh();
}

/**
 * Put the numbers in the window back in step with the character
 */
function refresh() {
	const entity = Session.Entity;
	const root = Stylist.getRoot();

	root.querySelectorAll('.row').forEach((row) => {
		const look = LOOKS.find((l) => l.prop === row.getAttribute('data-look'));
		if (look) {
			row.querySelector('.value').textContent = entity ? entity[look.prop] | 0 : 0;
		}
	});
}

/**
 * Undo the preview
 */
function revert() {
	const entity = Session.Entity;
	if (!entity || !_original) {
		return;
	}

	LOOKS.forEach((look) => {
		if (entity[look.prop] !== _original[look.prop]) {
			entity[look.prop] = _original[look.prop];
		}
	});
	_original = null;
}

/**
 * Buy it
 */
function apply() {
	const entity = Session.Entity;
	if (!entity || !_original) {
		return;
	}

	const pkt = new PACKET.CZ.REQ_STYLE_CHANGE2();
	let changed = false;

	LOOKS.forEach((look) => {
		const value = entity[look.prop] | 0;
		// Zero means "leave this one alone" to the server, which is exactly
		// what an untouched row means here.
		if (value !== _original[look.prop]) {
			pkt[look.field] = value;
			changed = true;
		}
	});

	if (!changed) {
		Stylist.remove();
		return;
	}

	Network.sendPacket(pkt);
}

/**
 * The server's answer.
 *
 * On success it has already sent the look changes as ordinary sprite updates,
 * so the preview simply becomes the truth -- there is nothing to apply here,
 * only the original to forget so Cancel cannot undo a paid-for haircut.
 *
 * @param {object} pkt - PACKET.ZC.STYLE_CHANGE_RES
 */
function onStyleChangeResult(pkt) {
	if (pkt.flag) {
		ChatBox.addText(
			'The stylist cannot do that one.',
			ChatBox.TYPE.ERROR
		);
		revert();
		refresh();
		return;
	}

	_original = null;
	Stylist.remove();
}

/**
 * Hook the answer
 */
Network.hookPacket(PACKET.ZC.STYLE_CHANGE_RES, onStyleChangeResult);

/**
 * Export
 */
export default UIManager.addComponent(Stylist);
