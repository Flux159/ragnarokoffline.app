// The screens before the game, drawn by a mod (api.screens).
//
// The roBrowser fork has the hook points -- UI/ScreenHooks.js, called by the
// login window, the server list, character select and character creation --
// and nothing else. Everything a mod is given lives here: a full-window layer
// of its own to draw in, a copy of the screen's data with checked actions
// (PregameViews.mjs), a stage to draw characters on, and the client's images.
//
// The client's dialogs ("wrong password", "delete this character?") are
// still its own windows, and are drawn above the layer.

import ScreenHooks from 'UI/ScreenHooks.js';
import Entity from 'Renderer/Entity/Entity.js';
import SpriteRenderer from 'Renderer/SpriteRenderer.js';
import Camera from 'Renderer/Camera.js';
import StatusConst from 'DB/Status/StatusState.js';
import MonsterTable from 'DB/Monsters/MonsterTable.js';
import DB from 'DB/DBManager.js';
import Client from 'Core/Client.js';
import { SCREENS, LOOK_KEYS, buildView } from './PregameViews.mjs';

// Above the 3D canvas and the login background, below every client window
// (GUIComponent hosts start at z-index 50).
const LAYER_Z = 40;

const lookups = {
    jobName: job => MonsterTable[job] || '',
    mapName: map => (map ? DB.getMapName(String(map), '') || '' : ''),
};

export function supported() {
    return typeof ScreenHooks?.register === 'function';
}

function makeLayer(screen) {
    const host = document.createElement('div');
    host.className = 'ro-plugin-screen';
    host.dataset.screen = screen;
    host.style.cssText = `position:fixed;inset:0;z-index:${LAYER_Z};`;
    const root = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    return { host, root };
}

/**
 * Hand a screen to a mod. `hook` is { show(view), update?(view), hide?() },
 * already wrapped by the runtime to report its errors; a throw here makes
 * ScreenHooks give the screen back to the client's window.
 */
export function replace(screen, hook) {
    if (!SCREENS.includes(screen)) throw new TypeError(`unknown screen ${screen}`);
    let layer = null;
    const drop = () => { layer?.host.remove(); layer = null; };
    const view = ctx => buildView(screen, ctx, { ...lookups, root: layer?.root ?? null });
    return ScreenHooks.register(screen, {
        name: hook.name,
        show(ctx) {
            drop();
            layer = makeLayer(screen);
            try { hook.show(view(ctx)); } catch (error) { drop(); throw error; }
        },
        // Without an update of its own, the mod draws the screen afresh.
        update(ctx) {
            if (!layer) return;
            if (typeof hook.update === 'function') hook.update(view(ctx));
            else { layer.root.replaceChildren(); hook.show(view(ctx)); }
        },
        hide() { try { hook.hide?.(); } finally { drop(); } },
    });
}

// --- Stage: characters drawn on a canvas of the mod's -------------------

const ACTIONS = { idle: 'IDLE', walk: 'WALK', sit: 'SIT', ready: 'READYFIGHT', attack: 'ATTACK1', hurt: 'HURT', die: 'DIE', pickup: 'PICKUP' };

function applyLook(entity, value, kind) {
    const unit = {};
    for (const key of LOOK_KEYS) {
        if (value?.[key] === undefined || !Number.isFinite(Number(value[key]))) continue;
        unit[key === 'robe' ? 'Robe' : key] = Number(value[key]);
    }
    if (kind === 'monster') unit.objecttype = Entity.TYPE_MOB;
    entity.set(unit);
    entity.effectState = entity._effectState & ~StatusConst.EffectState.INVISIBLE;
}

/**
 * A canvas the client draws sprites on, the way character select draws its
 * slots. options: { scale }. Returns { add(look, place), clear(), dispose() }.
 */
export function createStage(canvas, options = {}, report = console.error) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('stage needs a <canvas>');
    const ctx = canvas.getContext('2d');
    const actors = new Set();
    let scale = Number.isFinite(options.scale) ? Math.min(Math.max(options.scale, 0.25), 8) : 1;
    let frame = 0;
    let disposed = false;

    function draw() {
        frame = 0;
        if (disposed) return;
        if (canvas.isConnected) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = false;
            // bind2DContext points the sprite renderer at this canvas; put
            // back what it was drawing with (the map's GL renderer in game).
            const previous = { render: SpriteRenderer.render, xSize: SpriteRenderer.xSize, ySize: SpriteRenderer.ySize };
            const direction = Camera.direction;
            Camera.direction = 4;
            try {
                for (const actor of actors) {
                    ctx.setTransform(scale, 0, 0, scale, 0, 0);
                    SpriteRenderer.bind2DContext(ctx, (actor.x * canvas.width) / scale, (actor.y * canvas.height) / scale);
                    // 0 faces the viewer: the client's own convention, with the camera at 4.
                    actor.entity.direction = (actor.direction + 4) % 8;
                    try { actor.entity.renderEntity(); } catch (error) { actors.delete(actor); report('[Client API] stage', error); }
                }
            } finally {
                Camera.direction = direction;
                Object.assign(SpriteRenderer, previous);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
            }
        }
        if (actors.size) frame = requestAnimationFrame(draw);
    }
    const run = () => { if (!frame && !disposed && actors.size) frame = requestAnimationFrame(draw); };

    const stage = {
        // look: a character's `look` from api.screens, or any of job, sex,
        // head, headpalette, bodypalette, weapon, shield, accessory..3,
        // robe, effectState (mounts are effectState bits). place: { x, y }
        // as fractions of the canvas (feet), direction 0..7, action, kind
        // ('character' or 'monster', for a pet beside the character).
        add(value, place = {}) {
            if (disposed) throw new Error('stage is disposed');
            const entity = new Entity();
            const kind = place.kind === 'monster' ? 'monster' : 'character';
            applyLook(entity, value, kind);
            entity.hideShadow = place.shadow !== true;
            const actor = { entity, x: 0.5, y: 0.85, direction: 0 };
            const handle = {
                set(next) { applyLook(entity, next, kind); return handle; },
                place(next = {}) {
                    if (Number.isFinite(next.x)) actor.x = next.x;
                    if (Number.isFinite(next.y)) actor.y = next.y;
                    if (Number.isInteger(next.direction)) actor.direction = ((next.direction % 8) + 8) % 8;
                    return handle;
                },
                action(name = 'idle') {
                    const key = ACTIONS[name];
                    if (!key) throw new RangeError(`action must be one of ${Object.keys(ACTIONS).join(', ')}`);
                    const id = entity.ACTION[key];
                    entity.setAction({ action: id >= 0 ? id : entity.ACTION.IDLE, frame: 0, play: true, repeat: true });
                    return handle;
                },
                remove() { actors.delete(actor); },
            };
            handle.place({ direction: 0, ...place });
            handle.action(place.action || 'idle');
            actors.add(actor);
            run();
            return Object.freeze(handle);
        },
        scale(value) { if (Number.isFinite(value)) scale = Math.min(Math.max(value, 0.25), 8); },
        clear() { actors.clear(); },
        dispose() {
            disposed = true;
            actors.clear();
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
        },
    };
    return stage;
}

/**
 * A file from the game data as a URL an <img> or CSS can use: BMPs come back
 * with their magenta made transparent, as the client draws them. A bare name
 * is looked up in the interface folder (data/texture/유저인터페이스/).
 */
export function image(path) {
    const file = /^data[\\/]/i.test(path) ? path : DB.INTERFACE_PATH + path.replace(/^[\\/]+/, '');
    return new Promise(resolve => {
        try {
            Client.loadFile(file, url => resolve(typeof url === 'string' ? url : null), () => resolve(null));
        } catch {
            resolve(null);
        }
    });
}
