// A test-only window into the client, for scripts/rotest (docs/AGENT_TESTING.md).
//
// Off unless the page opted in with localStorage.roAgent = '1', which only the
// harness sets. roClientDiagnostics stays the read-only surface mods and the
// e2e suite rely on; this one reaches the internals a test driver needs:
// projecting a map cell to the screen so a click lands on it, listing what is
// on screen, and starting a skill down the same path the skill window uses.
//
// Everything here is something the player could already do from devtools on
// their own client. The server authorises every action it causes.
import Session from 'Engine/SessionStorage.js';
import Camera from 'Renderer/Camera.js';
import Renderer from 'Renderer/Renderer.js';
import MapRenderer from 'Renderer/MapRenderer.js';
import EntityManager from 'Renderer/EntityManager.js';
import Entity from 'Renderer/Entity/Entity.js';
import Altitude from 'Renderer/Map/Altitude.js';
import Mouse from 'Controls/MouseEventHandler.js';
import DB from 'DB/DBManager.js';
import SkillInfo from 'DB/Skills/SkillInfo.js';
import Network from 'Network/NetworkManager.js';
import PACKET from 'Network/PacketStructure.js';
import PACKETVER from 'Network/PacketVerManager.js';
import UIManager from 'UI/UIManager.js';
import EffectManager from 'Renderer/EffectManager.js';
import EffectTable from 'DB/Effects/EffectTable.js';

function enabled() {
    try { return window.localStorage.getItem('roAgent') === '1'; } catch { return false; }
}

// World to CSS pixels, as EntityRender's renderGUI does for names and bars:
// GL space is (x + 0.5, -height, y + 0.5).
function project(x, y, z) {
    const height = z ?? (Altitude.getCellHeight?.(x, y) || 0);
    const v = [x + 0.5, -height, y + 0.5, 1];
    const mv = Camera.modelView, p = Camera.projection;
    const eye = [0, 1, 2, 3].map(r => mv[r] * v[0] + mv[4 + r] * v[1] + mv[8 + r] * v[2] + mv[12 + r] * v[3]);
    const clip = [0, 1, 2, 3].map(r => p[r] * eye[0] + p[4 + r] * eye[1] + p[8 + r] * eye[2] + p[12 + r] * eye[3]);
    if (!clip[3]) return null;
    const canvas = Renderer.canvas;
    const box = canvas.getBoundingClientRect();
    const sx = box.left + ((clip[0] / clip[3] + 1) / 2) * box.width;
    const sy = box.top + ((1 - clip[1] / clip[3]) / 2) * box.height;
    return { x: Math.round(sx), y: Math.round(sy), onScreen: sx >= box.left && sx < box.right && sy >= box.top && sy < box.bottom };
}

const TYPES = Object.fromEntries(Object.entries(Entity).filter(([k]) => k.startsWith('TYPE_')).map(([k, v]) => [v, k.slice(5)]));

function describe(entity) {
    const rect = entity.boundingRect;
    const sized = rect && isFinite(rect.x1) && isFinite(rect.x2) && isFinite(rect.y1) && isFinite(rect.y2);
    const cell = project(entity.position[0], entity.position[1], entity.position[2]);
    return {
        gid: entity.GID,
        type: TYPES[entity.objecttype] || entity.objecttype,
        name: entity.display?.name || '',
        job: entity._job ?? entity.job,
        position: [entity.position[0], entity.position[1]].map(n => Math.round(n * 10) / 10),
        height: Math.round((entity.position[2] || 0) * 100) / 100,
        dead: entity.action === entity.ACTION?.DIE,
        hp: entity.life ? { hp: entity.life.hp, max: entity.life.hp_max } : null,
        // Where a click selects this entity: the middle of the box picking
        // tests against (EntityManager.intersect), not the cell it stands on.
        click: sized ? { x: Math.round((rect.x1 + rect.x2) / 2), y: Math.round((rect.y1 + rect.y2) / 2) } : cell,
        pickRect: sized ? { left: Math.min(rect.x1, rect.x2), top: Math.min(rect.y1, rect.y2),
            right: Math.max(rect.x1, rect.x2), bottom: Math.max(rect.y1, rect.y2) } : null,
        cell,
    };
}

function entities({ type, radius = 20 } = {}) {
    const me = Session.Entity;
    const out = [];
    EntityManager.forEach?.(entity => {
        if (entity === me) return;
        if (type && (TYPES[entity.objecttype] || '').toLowerCase() !== type.toLowerCase()) return;
        if (me) {
            const dx = entity.position[0] - me.position[0], dy = entity.position[1] - me.position[1];
            if (dx * dx + dy * dy > radius * radius) return;
        }
        out.push(describe(entity));
    });
    if (me) out.sort((a, b) => Math.hypot(a.position[0] - me.position[0], a.position[1] - me.position[1]) -
        Math.hypot(b.position[0] - me.position[0], b.position[1] - me.position[1]));
    return out;
}

function skillList() {
    const list = UIManager.getComponent('SkillList');
    const rows = list?.getRoot?.()?.querySelectorAll('.skill[data-index]') || [];
    return Array.from(rows, row => {
        const id = Number(row.getAttribute('data-index'));
        const skill = list.getSkillById?.(id);
        return { id, name: SkillInfo[id]?.SkillName || skill?.name || '', level: skill?.level ?? null,
            sp: skill?.spcost ?? null, range: skill?.attackRange ?? null, type: skill?.type ?? null };
    });
}

function chat(count = 20) {
    const box = UIManager.getComponent('ChatBox')?.getRoot?.();
    const lines = box ? Array.from(box.querySelectorAll('.content div, .content span.msg, .content > *')) : [];
    return lines.map(line => line.textContent.trim()).filter(Boolean).slice(-count);
}

function player() {
    const me = Session.Entity;
    if (!me) return null;
    return { ...describe(me), map: MapRenderer.currentMap, packetver: PACKETVER.value,
        sp: me.life ? { sp: me.life.sp, max: me.life.sp_max } : null, mouseState: Mouse.state };
}

// What went over the wire, for telling "the client never sent the cast" from
// "the server answered and the client ignored it". Received packets are read
// from NetworkManager's own per-packet log line, which names the packet and
// says "(no callback)" when the client has no handler for it.
const net = { sent: [], recv: [] };
function trace() {
    const log = console.log;
    console.log = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('%c[Network] Recv:')) {
            net.recv.push({ at: Date.now(), name: args[2]?.constructor?.name || '?', handled: args[3] !== '(no callback)' });
            if (net.recv.length > 2000) net.recv.splice(0, 500);
        }
        return log.apply(this, args);
    };
    const send = Network.sendPacket;
    Network.sendPacket = function (packet) {
        net.sent.push({ at: Date.now(), name: packet?.constructor?.name || '?' });
        if (net.sent.length > 2000) net.sent.splice(0, 500);
        return send.apply(this, arguments);
    };
}
// Every effect the client asked to play, and whether the effect table knew
// it. A skill with a SkillEffect entry pointing at a missing EffectTable key
// fails silently in EffectManager.spam; this makes that visible.
const effects = [];
function traceEffects() {
    const spam = EffectManager.spam;
    EffectManager.spam = function (init) {
        if (init && init.effectId !== undefined) {
            effects.push({ at: Date.now(), id: init.effectId, known: init.effectId in EffectTable, owner: init.ownerAID ?? null });
            if (effects.length > 2000) effects.splice(0, 500);
        }
        return spam.apply(this, arguments);
    };
}
const IGNORED = /^PACKET_(CZ_REQUEST_TIME|ZC_NOTIFY_TIME|CZ_PING|ZC_PING|ZC_NOTIFY_MOVE|ZC_NOTIFY_PLAYERMOVE|CZ_REQUEST_MOVE2?|ZC_NOTIFY_MOVEENTRY\d*|ZC_NOTIFY_STANDENTRY\d*|ZC_NOTIFY_NEWENTRY\d*|ZC_NOTIFY_VANISH|ZC_STOPMOVE|ZC_PAR_CHANGE|ZC_LONGPAR_CHANGE\d*|ZC_STATUS_CHANGE|ZC_NOTIFY_CHAT|ZC_NOTIFY_PLAYERCHAT|CZ_REQUEST_CHAT)$/;

export function install() {
    if (!enabled() || window.roAgent) return;
    trace();
    traceEffects();
    Object.defineProperty(window, 'roAgent', { configurable: true, value: Object.freeze({
        version: 1,
        project, player, entities, skills: skillList, chat,
        // The skill window's own entry point: self skills fire, targeted ones
        // enter target selection and wait for the next click on the map.
        useSkill(id, level) {
            const list = UIManager.getComponent('SkillList');
            if (!list?.useSkillID) return { ok: false, reason: 'no skill window' };
            list.useSkillID(id, level);
            return { ok: true, targeting: Mouse.state === Mouse.MOUSE_STATE.USESKILL };
        },
        // Packets since `since` (ms epoch), without the steady chatter of
        // movement, time sync and stat updates unless `all`.
        net(since = 0, all = false) {
            const keep = p => p.at >= since && (all || !IGNORED.test(p.name));
            return { sent: net.sent.filter(keep).map(p => p.name), recv: net.recv.filter(keep).map(p => p.handled ? p.name : p.name + ' (no handler)') };
        },
        // Effects the client started since `since`: { id, known, owner }.
        effects(since = 0) { return effects.filter(e => e.at >= since).map(({ id, known, owner }) => ({ id, known, owner })); },
        mouse() { return { state: Mouse.state, intersect: Mouse.intersect, screen: { ...Mouse.screen }, world: { ...Mouse.world },
            over: EntityManager.getOverEntity() ? describe(EntityManager.getOverEntity()) : null }; },
        modules: { Session, Camera, Renderer, MapRenderer, EntityManager, Entity, Altitude, Mouse, DB, SkillInfo, Network, PACKET, PACKETVER, UIManager },
    }) });
}
