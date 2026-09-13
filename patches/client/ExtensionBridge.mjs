// The only adapter between the versioned plugin API and roBrowser internals.
// Imported by Online, never by GUIComponent or NetworkManager (avoids cycles).
import Runtime from './ExtensionRuntime.mjs';
import Session from 'Engine/SessionStorage.js';
import Camera from 'Renderer/Camera.js';
import Renderer from 'Renderer/Renderer.js';
import EntityManager from 'Renderer/EntityManager.js';
import Altitude from 'Renderer/Map/Altitude.js';
import PathFinding from 'Utils/PathFinding.js';
import MapControl from 'Controls/MapControl.js';
import DB from 'DB/DBManager.js';
import KEYS from 'Controls/KeyEventHandler.js';
import BattleMode from 'Controls/BattleMode.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import UIManager from 'UI/UIManager.js';

const visible = component => Boolean(component?.__active && component._host?.getClientRects().length &&
    getComputedStyle(component._host).display !== 'none' && getComputedStyle(component._host).visibility !== 'hidden');
let composing = false;
let installed = false;

function inputState() {
    const player = Session.Entity;
    const focused = KEYS.getDeepActiveElement();
    const editing = Boolean(focused && (/^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) || focused.isContentEditable));
    // captureKeyEvents only selects DOM capture phase; ChatBox sets it even
    // while idle. It is not a declaration that the component is a modal.
    const capturing = Object.values(UIManager.components).some(component =>
        (component.isCapturing || component.mouseMode === 2 ||
            ['Escape', 'ShortCuts', 'WorldMap', 'SkillTargetSelection', 'CaptchaAnswer', 'CaptchaSelector', 'CaptchaUpload',
            // An open NPC dialogue owns space and enter -- they advance and
            // close it. Neither sets FreezeUI, so without naming them here a
            // capture-phase key handler silently takes those keys away from
            // the conversation. The server will not move a talking player
            // either, so treating a dialogue as blocking matches the game.
            'NpcBox', 'NpcMenu'].includes(component.name)) && visible(component));
    const battle = UIManager.components.ChatBox?.getRoot()?.querySelector('.battlemode');
    return {
        canMove: Boolean(player && Runtime.movement.snapshot().active && !document.hidden && !composing && !editing &&
            !capturing && !Runtime.inputBlocked() && !Session.FreezeUI && player.action !== player.ACTION.DIE &&
            player.action !== player.ACTION.SIT),
        editing, composing, capturing,
        battleMode: Boolean(battle && battle.style.display !== 'none'),
    };
}

function destination(position, vector) {
    const start = position.map(Math.round);
    const path = new Int16Array(64);
    // PathFinding.search includes the starting cell. Limit to three accepted
    // steps; releasing a key stops new requests, not the server's current path.
    for (let distance = 3; distance >= 1; distance--) {
        const x = Math.round(position[0] + vector[0] * distance);
        const y = Math.round(position[1] + vector[1] * distance);
        if (x < 0 || y < 0 || x >= Altitude.width || y >= Altitude.height ||
            !(Altitude.getCellType(x, y) & Altitude.TYPE.WALKABLE)) continue;
        const count = PathFinding.search(start[0], start[1], x, y, 0, path);
        if (count >= 2 && count <= 4) return [x, y];
    }
    return null;
}

const WINDOWS = new Set(['Inventory', 'Equipment', 'SkillList', 'Quest', 'WorldMap', 'PartyFriends', 'WinStats', 'Storage']);
function component(name) {
    // UIManager resolves version aliases (Inventory -> InventoryV3, etc.).
    try { return UIManager.getComponent(name); } catch { return null; }
}
function action(name, value) {
    if (!Runtime.movement.snapshot().active || Session.FreezeUI) return false;
    if (name === 'menu') {
        const menu = component('Escape');
        if (!menu?.onKeyDown) return false;
        Runtime.movement.clear('menu');
        menu.onKeyDown({ key: 'Escape', which: KEYS.ESCAPE });
        return true;
    }
    if (name === 'window' && WINDOWS.has(value?.name)) {
        const windowUI = component(value.name);
        if (value.open && visible(windowUI)) {
            Runtime.movement.clear('window');
            windowUI.focus();
            return true;
        }
        if (!windowUI?.onShortCut) return false;
        Runtime.movement.clear('window');
        windowUI.onShortCut({ cmd: 'TOGGLE' });
        return true;
    }
    if (name === 'storage:transfer' && Number.isInteger(value?.index)) {
        const storage = component('Storage');
        if (!visible(storage)) return false;
        const deposit = value.direction === 'deposit';
        if (!deposit && value.direction !== 'withdraw') return false;
        const item = (deposit ? component('Inventory') : storage)?.getItemByIndex(value.index);
        if (!item || (deposit && item.WearState)) return false;
        const maximum = item.count || 1;
        const count = value.count === 'all' ? maximum : value.count;
        if (!Number.isInteger(count) || count < 1 || count > maximum) return false;
        // These are the same callbacks used after the native drag quantity
        // dialog; the server still authorizes and acknowledges the transfer.
        if (deposit) storage.reqAddItem(item.index, count);
        else storage.reqRemoveItem(item.index, count);
        return true;
    }
    if (name === 'shortcut' && Number.isInteger(value?.index) && value.index >= 0 && value.index < 36) {
        const shortcuts = component('ShortCut');
        if (!shortcuts?.onShortCut) return false;
        shortcuts.onShortCut({ cmd: `EXECUTE${value.index}` });
        return true;
    }
    if (name === 'shortcut:assign' && Number.isInteger(value?.slot) && value.slot >= 0 && value.slot < 36 && Number.isInteger(value?.id)) {
        const shortcuts = component('ShortCut');
        if (!shortcuts) return false;
        const row = Math.floor(value.slot / 9);
        if (value.kind === 'item') {
            const item = component('Inventory')?.getItemByIndex(value.id);
            if (!item) return false;
            shortcuts.removeElement(false, item.ITID, row);
            shortcuts.addElement(value.slot, false, item.ITID, 0);
            shortcuts.onChange(value.slot, false, item.ITID, 0);
            return true;
        }
        if (value.kind === 'skill') {
            const skill = shortcuts.getSkillById(value.id);
            if (!skill || skill.level < 1) return false;
            const level = Math.max(1, Math.min(skill.level, skill.selectedLevel || skill.level));
            shortcuts.removeElement(true, skill.SKID, row, level);
            shortcuts.addElement(value.slot, true, skill.SKID, level);
            shortcuts.onChange(value.slot, true, skill.SKID, level);
            return true;
        }
    }
    const buttons = { attack: '#attackButton', target: '#toggleAutoTargetButton', interact: '#talktonpcButton', pickup: '#pickupButton' };
    if (Object.hasOwn(buttons, name)) {
        const button = UIManager.components.MobileUI?.getRoot()?.querySelector(buttons[name]);
        if (!button) return false;
        button.click();
        return true;
    }
    return false;
}

export function init() {
    if (installed) return;
    installed = true;
    Runtime.configure({
        inputState,
        shortcutConflict(keyCode) { return inputState().battleMode && Boolean(BattleMode.match(keyCode)); },
        movementState() { return { ...inputState(), position: Array.from(Session.Entity?.position || []).slice(0, 2), cameraDirection: Camera.direction, cameraAngle: Camera.angle?.[1] }; },
        destination,
        sendMove(position) {
            MapControl.onRequestStopWalk();
            Session.autoFollow = false;
            Session.moveAction = null;
            const packet = PACKETVER.value >= 20180307 ? new PACKET.CZ.REQUEST_MOVE2() : new PACKET.CZ.REQUEST_MOVE();
            packet.dest[0] = position[0]; packet.dest[1] = position[1];
            Network.sendPacket(packet);
        },
        snapshot() {
            const player = Session.Entity;
            const target = EntityManager.getFocusEntity();
            return { packetVersion: PACKETVER.value, input: inputState(),
                player: player ? { id: player.GID, position: Array.from(player.position).slice(0, 2), action: player.action,
                    hp: player.life.hp, maxHp: player.life.hp_max, sp: player.life.sp, maxSp: player.life.sp_max } : null,
                camera: { direction: Camera.direction },
                target: target ? { id: target.GID, name: target.display?.name || '', hp: target.life?.hp, maxHp: target.life?.hp_max } : null };
        },
        // Turn the camera by a step, honouring the same limits the mouse obeys.
        // Indoor maps clamp yaw to a narrow window (-60..-25 for prt_in), so a
        // key press there moves as far as it can and then stops, rather than
        // silently building an angle the renderer will never adopt.
        rotateCamera(degrees) {
            if (!Number.isFinite(degrees) || !Camera.angleFinal) return false;
            const indoor = DB.isIndoor(Camera.currentMap);
            const low = indoor ? Camera.indoorRotationFrom : Camera.rotationFrom;
            const high = indoor ? Camera.indoorRotationTo : Camera.rotationTo;
            const wanted = Camera.angleFinal[1] + degrees;
            const next = Math.min(high, Math.max(low, wanted));
            const moved = next !== Camera.angleFinal[1];
            Camera.angleFinal[1] = next;
            return moved;
        },
        // Attack the nearest living monster, keeping the current target while
        // it lives. Action 7 is RO's *continuous* attack: the server keeps
        // swinging until the target dies or the player does something else, so
        // there is no loop here and nothing that hunts on the player's behalf.
        // Out of reach, this walks into range and lets the queued action fire,
        // exactly as a click on the monster does.
        attackNearest() {
            const player = Session.Entity;
            if (!player || !inputState().canMove) return false;
            const MOB = player.constructor.TYPE_MOB;
            let target = EntityManager.getFocusEntity();
            if (!target || target.objecttype !== MOB || target.action === target.ACTION.DIE) {
                target = EntityManager.getClosestEntity(player, MOB);
            }
            if (!target) return false;
            const path = [];
            const count = PathFinding.search(
                player.position[0] | 0, player.position[1] | 0,
                target.position[0] | 0, target.position[1] | 0,
                player.attack_range + 1, path);
            if (!count) return false;
            // Held movement keys would otherwise send a destination on the next
            // tick and cancel the attack before the first swing lands.
            Runtime.movement.clear('attack');
            EntityManager.setFocusEntity(target);
            const attack = PACKETVER.value >= 20180307
                ? new PACKET.CZ.REQUEST_ACT2() : new PACKET.CZ.REQUEST_ACT();
            attack.action = 7;
            attack.targetGID = target.GID;
            if (count < 2) { Network.sendPacket(attack); return true; }
            Session.moveAction = attack;
            const move = PACKETVER.value >= 20180307
                ? new PACKET.CZ.REQUEST_MOVE2() : new PACKET.CZ.REQUEST_MOVE();
            move.dest[0] = path[(count - 1) * 2 + 0];
            move.dest[1] = path[(count - 1) * 2 + 1];
            Network.sendPacket(move);
            return true;
        },
        action,
    });
    const clear = () => Runtime.movement.clear('focus-lost');
    const compose = () => { composing = true; clear(); };
    const composed = () => { composing = false; };
    const visibility = () => { if (document.hidden) clear(); };
    window.addEventListener('blur', clear);
    window.addEventListener('compositionstart', compose, true);
    window.addEventListener('compositionend', composed, true);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', () => { if (!inputState().canMove) clear(); });
    // Read-only diagnostics for browser/gameplay evidence. No account data,
    // state mutation or raw network access is exposed.
    Object.defineProperty(window, 'roClientDiagnostics', { configurable: true, value: Object.freeze({
        snapshot: Runtime.snapshot, lifecycle: Runtime.diagnostics,
    }) });
}

const tick = now => Runtime.movement.tick(now);
export function enterMap(name) {
    Runtime.enterMap(name);
    // Renderer.stop() clears all callbacks during a warp; register on each map.
    Renderer.render(tick);
}
