/**
 * Controls/KeyboardMove.js
 *
 * WASD / arrow-key movement.
 *
 * Ragnarok is a click-to-move game: there is no "walk north" packet, only
 * "walk to this cell". Holding a key therefore has to be translated into a
 * repeated destination a few cells ahead, which is the same trick the on-screen
 * joystick uses. The destination is rotated by the camera so that "up" means
 * up the screen rather than up the map, matching what the player sees.
 *
 * Added by RagnarokMac.
 */

import Session from 'Engine/SessionStorage.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import Camera from 'Renderer/Camera.js';
import Renderer from 'Renderer/Renderer.js';
import KEYS from 'Controls/KeyEventHandler.js';
import glMatrix from 'Vendors/gl-matrix.js';

/** How far ahead to aim, in cells. Far enough to keep walking, near enough to steer. */
const STEP = 3;

/** Re-issue the destination at this cadence while a key is held (ms). */
const REPEAT_MS = 180;

const direction = glMatrix.vec2.create();
const rotate = glMatrix.mat2.create();
const held = new Set();
let lastSent = 0;

const BINDINGS = {
	[KEYS.W]: [0, 1],
	[KEYS.UP]: [0, 1],
	[KEYS.S]: [0, -1],
	[KEYS.DOWN]: [0, -1],
	[KEYS.A]: [-1, 0],
	[KEYS.LEFT]: [-1, 0],
	[KEYS.D]: [1, 0],
	[KEYS.RIGHT]: [1, 0]
};

/**
 * Typing in chat, a whisper box or any input must never walk the character.
 */
function isTyping() {
	const el = KEYS.getDeepActiveElement();
	if (!el) {
		return false;
	}
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onKeyDown(event) {
	if (!(event.which in BINDINGS)) {
		return;
	}
	// Leave shortcuts alone: Cmd/Ctrl/Alt combinations are not movement.
	if (event.ctrlKey || event.altKey || event.metaKey || isTyping()) {
		return;
	}
	held.add(event.which);
	event.preventDefault();
}

function onKeyUp(event) {
	held.delete(event.which);
}

/**
 * Held keys are re-evaluated every frame rather than on key repeat, so
 * diagonals work (W+A) and releasing one key of a pair steers immediately.
 */
function tick(tick_) {
	if (!held.size) {
		return;
	}
	const player = Session.Entity;
	if (!player || isTyping()) {
		held.clear();
		return;
	}
	if (tick_ - lastSent < REPEAT_MS) {
		return;
	}

	let x = 0;
	let y = 0;
	for (const key of held) {
		const vec = BINDINGS[key];
		x += vec[0];
		y += vec[1];
	}
	// Opposite keys held together cancel out; nothing to do.
	if (!x && !y) {
		return;
	}

	direction[0] = x;
	direction[1] = y;
	glMatrix.mat2.identity(rotate);
	glMatrix.mat2.rotate(rotate, rotate, ((-Camera.direction * 45) / 180) * Math.PI);
	glMatrix.vec2.transformMat2(direction, direction, rotate);

	const packet =
		PACKETVER.value >= 20180307 ? new PACKET.CZ.REQUEST_MOVE2() : new PACKET.CZ.REQUEST_MOVE();
	packet.dest[0] = Math.round(player.position[0] + direction[0] * STEP);
	packet.dest[1] = Math.round(player.position[1] + direction[1] * STEP);
	Network.sendPacket(packet);

	lastSent = tick_;
}

let started = false;

export default {
	/** Idempotent: the map engine may re-enter on a warp or reconnect. */
	init() {
		if (started) {
			return;
		}
		started = true;
		window.addEventListener('keydown', onKeyDown);
		window.addEventListener('keyup', onKeyUp);
		// Held keys are lost when the window loses focus; otherwise the
		// character keeps walking after a Cmd-Tab.
		window.addEventListener('blur', () => held.clear());
		Renderer.render(tick);
	}
};
