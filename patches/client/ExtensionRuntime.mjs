import { createMovement } from './MovementCore.mjs';

const EVENTS = new Set(['map:enter', 'map:leave', 'connection', 'ui:append', 'ui:remove', 'movement:clear', 'preferences:change']);
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
