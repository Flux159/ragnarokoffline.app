import { createMovement } from './MovementCore.mjs';

const EVENTS = new Set(['map:enter', 'map:leave', 'connection', 'ui:append', 'ui:remove', 'movement:clear', 'preferences:change', 'item:use']);
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

export function createRuntime({ storage, report = (...args) => console.error(...args) } = {}) {
    const listeners = new Map();
    const components = new Map();
    const scopes = new Map();
    const inputBlocks = new Set();
    let bridge = {};
    let map = null;
    let serverMovement = { acknowledgements: 0, last: null };
    let connection = Object.freeze({ status: 'disconnected' });
    function emit(event, value) {
        for (const listener of [...(listeners.get(event) || [])]) {
            try { listener(value); } catch (error) { report(`[Client API] ${event}`, error); }
        }
    }
    const movement = createMovement({
        read: () => bridge.movementState?.(),
        destination: (...args) => bridge.destination?.(...args),
        send: position => bridge.sendMove?.(position),
        cancelled: value => emit('movement:clear', Object.freeze(value)),
    });
    function snapshot() {
        return freeze({ map, connection: { ...connection }, ...(copy(bridge.snapshot?.()) || {}),
            movement: movement.snapshot(), serverMovement: copy(serverMovement) });
    }
    function scope(name) {
        if (typeof name !== 'string' || !name.length || name.length > 512 || name.includes('\0')) throw new Error('Invalid plugin name');
        scopes.get(name)?.dispose();
        const cleanups = new Set();
        let disposed = false;
        const cleanup = fn => {
            if (typeof fn !== 'function') throw new TypeError('Cleanup must be a function');
            let done = false;
            const once = () => {
                if (done) return;
                done = true; cleanups.delete(once);
                try { Promise.resolve(fn()).catch(error => report(`[Plugin ${name}] cleanup`, error)); }
                catch (error) { report(`[Plugin ${name}] cleanup`, error); }
            };
            if (disposed) once(); else cleanups.add(once);
            return once;
        };
        const on = (event, listener, { replay = true } = {}) => {
            if (disposed) throw new Error(`Plugin ${name} is disposed`);
            if (!EVENTS.has(event) || typeof listener !== 'function') throw new TypeError('Unsupported client event');
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(listener);
            const off = cleanup(() => listeners.get(event)?.delete(listener));
            if (replay) queueMicrotask(() => {
                if (disposed || !listeners.get(event)?.has(listener)) return;
                const values = event === 'ui:append' ? [...components.values()] :
                    event === 'map:enter' && map ? [{ name: map }] : event === 'connection' ? [connection] : [];
                for (const value of values) { try { listener(value); } catch (error) { report(`[Plugin ${name}] replay`, error); } }
            });
            return off;
        };
        const api = Object.freeze({
            version: 1, name, cleanup, on, snapshot,
            input: Object.freeze({
                state: () => freeze(copy(bridge.inputState?.()) || { canMove: false }),
                shortcutConflict: code => Number.isInteger(code) && Boolean(bridge.shortcutConflict?.(code)),
                suspend() {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    const block = {};
                    inputBlocks.add(block); movement.clear('plugin-dialog');
                    return cleanup(() => inputBlocks.delete(block));
                },
            }),
            components: Object.freeze({ current: () => Object.freeze([...components.values()]) }),
            preferences: Object.freeze({
                get(key, fallback) {
                    try { const value = storage?.getItem(`ragnarok:plugin:${encodeURIComponent(name)}:${encodeURIComponent(key)}`); return value === null || value === undefined ? copy(fallback) : JSON.parse(value); }
                    catch { return copy(fallback); }
                },
                set(key, value) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    const serialized = JSON.stringify(value);
                    if (!serialized || serialized.length > 65536) throw new Error('Preference is too large or not JSON');
                    if (!storage) throw new Error('Browser preference storage is unavailable');
                    storage.setItem(`ragnarok:plugin:${encodeURIComponent(name)}:${encodeURIComponent(key)}`, serialized);
                    emit('preferences:change', freeze({ plugin: name, key, value: copy(value) }));
                },
            }),
            movement: Object.freeze({
                register(sourceName, onCancel) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    const source = movement.register(`${name}:${sourceName}`, reason => {
                        try { onCancel?.(reason); } catch (error) { report(`[Plugin ${name}] movement cancellation`, error); }
                    });
                    cleanup(() => source.dispose());
                    return source;
                },
            }),
            actions: Object.freeze({
                perform(action, payload) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    return bridge.action?.(action, copy(payload)) ?? false;
                },
                // Turn the camera by a step, clamped to the limits the map
                // allows. Returns false when it is already against one.
                rotateCamera(degrees) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    return bridge.rotateCamera?.(Number(degrees)) ?? false;
                },
                // Attack the nearest living monster, walking into range first
                // if needed. The server continues the attack on its own.
                attackNearest() {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    return bridge.attackNearest?.() ?? false;
                },
            }),
            // Raise the client's native target cursor -- the same one taming
            // items use -- and let the player click an entity. options.type picks
            // what is selectable: 'mob' (default), 'player' or 'any'. Resolves
            // with the clicked { classId, gid, name, kind }, or null if they
            // cancelled with ESC or a click on empty ground. One selection runs
            // at a time, and disposing the plugin (or a second pick) cancels a
            // pending one. The server stays authoritative: this reads what was
            // clicked, it does not act on it.
            targeting: Object.freeze({
                pick(options) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (typeof bridge.beginTargeting !== 'function') return Promise.resolve(null);
                    const release = cleanup(() => bridge.cancelTargeting?.());
                    return Promise.resolve(bridge.beginTargeting(copy(options)))
                        .then(result => result ? freeze(copy(result)) : null)
                        .finally(() => release());
                },
            }),
            // Send an @command to the server, exactly as if the player had typed
            // it in the chat box. Restricted to atcommands (@ or #) so a plugin
            // cannot speak in the player's voice, and gated server-side by the
            // player's own group like any command they could type themselves.
            // Returns whether it was sent, not whether the server accepted it.
            // Graphics passes: a full-screen GLSL fragment shader run on each
            // frame (GraphicsPasses.mjs supplies the frame, its depth, the
            // sun and the map's lights). Removed when the plugin is.
            graphics: Object.freeze({
                registerPass(spec) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (!spec || typeof spec !== 'object') throw new TypeError('registerPass takes { name, fragment, uniforms?, enabled? }');
                    const pass = {
                        name: typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 80) : 'pass',
                        fragment: spec.fragment,
                        uniforms: typeof spec.uniforms === 'function' ? spec.uniforms : undefined,
                        enabled: typeof spec.enabled === 'function' ? spec.enabled : undefined,
                    };
                    if (typeof pass.fragment !== 'string' || !pass.fragment.includes('main') || pass.fragment.length > 65536)
                        throw new TypeError('registerPass: fragment must be GLSL with a main(), under 64 KB');
                    if (typeof bridge.registerPass !== 'function') return () => {};
                    const remove = bridge.registerPass(pass, error => report(`[Plugin ${name}] ${pass.name}`, error));
                    return cleanup(() => remove?.());
                },
                // Code that draws in the map renderer (MapHooks.js in the
                // fork): { name, init(gl, map), render(stage, ctx),
                // free(gl), light(light), replaces: ['water'] }. Taken out
                // and freed with the plugin, and by the renderer if it throws.
                hook(spec) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (!spec || typeof spec !== 'object') throw new TypeError('hook takes { name, init?, render?, free?, light?, replaces? }');
                    const fn = key => (typeof spec[key] === 'function' ? spec[key].bind(spec) : undefined);
                    const replaces = Array.isArray(spec.replaces) ? spec.replaces.filter(stage => stage === 'water') : [];
                    const checked = {
                        name: `${name}: ${typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 80) : 'hook'}`,
                        init: fn('init'), render: fn('render'), free: fn('free'), light: fn('light'), replaces,
                    };
                    if (typeof bridge.graphicsHook !== 'function') return () => {};
                    const remove = bridge.graphicsHook(checked);
                    return cleanup(() => remove?.());
                },
                supported: () => Boolean(bridge.graphicsSupported?.()),
                lights: () => freeze(copy(bridge.mapLights?.() || [])),
            }),
            // A window of the plugin's own: a titled, draggable frame whose
            // body (in its own shadow root) the plugin fills. Remembered where
            // the player left it; typing in it doesn't move the character.
            ui: Object.freeze({
                window(spec) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (!spec || typeof spec.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(spec.id)) throw new TypeError('window needs an id of letters, digits, - or _');
                    const size = (value, fallback) => Number.isFinite(value) ? Math.min(Math.max(value, 120), 2000) : fallback;
                    const checked = {
                        id: spec.id,
                        title: typeof spec.title === 'string' ? spec.title.slice(0, 80) : spec.id,
                        width: size(spec.width, 360),
                        height: size(spec.height, 280),
                        resizable: spec.resizable !== false,
                    };
                    if (typeof bridge.createWindow !== 'function') throw new Error('this client cannot open plugin windows');
                    const handle = bridge.createWindow(name, checked, {
                        suspendInput: () => api.input.suspend(),
                        load: key => api.preferences.get(key, null),
                        save: (key, value) => { try { api.preferences.set(key, value); } catch { /* storage full or off: forget the position */ } },
                    });
                    cleanup(() => handle.destroy());
                    return Object.freeze({
                        body: handle.body,
                        show: () => handle.show(), hide: () => handle.hide(), toggle: () => handle.toggle(),
                        isOpen: () => handle.isOpen(), setTitle: text => handle.setTitle(text),
                        onClose: fn => typeof fn === 'function' ? handle.onClose(fn) : () => {},
                    });
                },
            }),
            // The client's item tables: what the game itself shows.
            items: Object.freeze({
                search: (text, limit = 50) => freeze(copy(bridge.searchItems?.(String(text ?? ''), Math.min(Math.max(Number(limit) || 50, 1), 200)) || [])),
                get: id => { const item = Number.isInteger(id) ? bridge.item?.(id) : null; return item ? freeze(copy(item)) : null; },
                icon: id => Promise.resolve(Number.isInteger(id) ? bridge.itemIcon?.(id) ?? null : null),
            }),
            server: Object.freeze({
                // Ask the mod's server script for something: it answers an
                // @command (bindatcmd) with @@reply lines (dispbottom).
                // Resolves with their text; see docs/MODDING.md.
                request(command, text = '', options = {}) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (typeof command !== 'string' || !/^[a-z][a-z0-9_]{1,23}$/.test(command)) throw new TypeError('request: command must be a lowercase @command name');
                    if (typeof text !== 'string' || text.length > 200 || /[\r\n]/.test(text)) throw new TypeError('request: text must be one line of at most 200 characters');
                    if (typeof bridge.serverRequest !== 'function') return Promise.reject(new Error('this client cannot make server requests'));
                    const timeout = Math.min(Math.max(Number(options.timeout) || 5000, 500), 30000);
                    return bridge.serverRequest(command, text, timeout);
                },
                command(text) {
                    if (disposed) throw new Error(`Plugin ${name} is disposed`);
                    if (typeof text !== 'string') return false;
                    return bridge.serverCommand?.(text) ?? false;
                },
            }),
        });
        const instance = { api, dispose() {
            if (disposed) return;
            disposed = true;
            for (const dispose of [...cleanups].reverse()) dispose();
            if (scopes.get(name) === instance) scopes.delete(name);
        } };
        scopes.set(name, instance);
        return instance;
    }
    return Object.freeze({
        configure(value) { bridge = value; }, scope, snapshot, movement,
        inputBlocked: () => inputBlocks.size > 0,
        recordMovement(move) {
            serverMovement = { acknowledgements: serverMovement.acknowledgements + 1, last: Array.from(move).slice(0, 4) };
        },
        enterMap(name) { map = name; movement.setActive(true); emit('map:enter', Object.freeze({ name })); },
        leaveMap(reason = 'loading') { const old = map; map = null; movement.setActive(false); if (old) emit('map:leave', Object.freeze({ name: old, reason })); },
        // The player used an inventory item. Fired from the packet the client
        // sends, so it carries the item's type id (ITID), resolved from the live
        // inventory before the server consumes the stack.
        useItem(itemId) { if (Number.isInteger(itemId)) emit('item:use', Object.freeze({ itemId })); },
        connection(status, kind) {
            connection = Object.freeze({ status, kind });
            if (status !== 'connected') {
                const old = map; map = null; movement.setActive(false);
                if (old) emit('map:leave', Object.freeze({ name: old, reason: 'disconnected' }));
            }
            emit('connection', connection);
        },
        appendComponent(component) {
            const item = Object.freeze({ name: component.name, root: component.getRoot(), host: component._host });
            components.set(component, item); emit('ui:append', item);
        },
        removeComponent(component) {
            const item = components.get(component);
            if (item) { components.delete(component); emit('ui:remove', item); }
        },
        dispose() { for (const item of [...scopes.values()]) item.dispose(); movement.clear('teardown'); },
        diagnostics() { return Object.freeze({ scopes: scopes.size, listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0), components: components.size }); },
    });
}

let storage;
try { storage = globalThis.localStorage; } catch { /* sandboxed browser storage */ }
export default createRuntime({ storage });
