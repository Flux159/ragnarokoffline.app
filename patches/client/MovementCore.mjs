// Directional intent arbitration. Game adapters supply state, pathfinding and
// the existing move packet; this service owns no rendering or network globals.
export function createMovement({ read, destination, send, cancelled = () => {}, cadence = 180 }) {
    let active = false;
    let owner = null;
    let vector = [0, 0];
    let lastSent = -Infinity;
    let requests = 0;
    let lastDestination = null;
    const sources = new Set();
    const normalize = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
        const length = Math.max(1, Math.hypot(x, y));
        return [x / length, y / length];
    };
    function clear(reason = 'clear') {
        const previous = owner;
        owner = null;
        vector = [0, 0];
        lastSent = -Infinity;
        if (previous) {
            previous.cancel?.(reason);
            cancelled({ source: previous.name, reason });
        }
    }
    return Object.freeze({
        register(name, cancel) {
            const source = { name, cancel };
            sources.add(source);
            return Object.freeze({
                begin(x, y) {
                    if (!sources.has(source) || !active) return false;
                    if (owner !== source) { clear('another-input'); owner = source; }
                    vector = normalize(x, y);
                    return true;
                },
                update(x, y) {
                    if (owner !== source || !active) return false;
                    vector = normalize(x, y);
                    return true;
                },
                end() { if (owner === source) clear('released'); },
                dispose() { if (owner === source) clear('disposed'); sources.delete(source); },
            });
        },
        setActive(value) { if (!value) clear('map-left'); active = Boolean(value); },
        clear,
        tick(now) {
            if (!active || !owner) return;
            const game = read();
            if (!game?.canMove) { clear('input-blocked'); return; }
            if ((!vector[0] && !vector[1]) || now - lastSent < cadence) return;
            const angle = -game.cameraDirection * Math.PI / 4;
            const x = vector[0] * Math.cos(angle) - vector[1] * Math.sin(angle);
            const y = vector[0] * Math.sin(angle) + vector[1] * Math.cos(angle);
            const next = destination(game.position, [x, y]);
            // Bound attempts too: holding against a wall must not run A* at
            // the renderer's full frame rate.
            lastSent = now;
            if (!next || next.some(n => !Number.isFinite(n))) return;
            send(next);
            lastDestination = [...next];
            requests++;
        },
        snapshot() {
            return Object.freeze({ active, source: owner?.name || null, vector: Object.freeze([...vector]),
                requests, lastDestination: lastDestination && Object.freeze([...lastDestination]), registeredSources: sources.size });
        },
    });
}
