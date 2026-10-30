// Discord Rich Presence, the game page's half: tell the app where the
// character is, so it can show it on the player's own Discord
// (electron/discord-presence.js).
//
// Only the app's game window has `invoke`; in a browser tab this does nothing.
// It sends a report when something on it changes -- map, level, job, party --
// and never on a timer of its own beyond a slow look for those changes, so it
// costs nothing per frame. The app decides what of it is shown.
//
// No roBrowser imports, so tests can run it under plain node: ExtensionBridge
// hands in `read`, which reads Session and the map.

export function startPresence({ invoke, read, every = (fn, ms) => setInterval(fn, ms), intervalMs = 15000 } = {}) {
    if (typeof invoke !== 'function' || typeof read !== 'function') return { poke() {} };
    let last;
    let failed = false;
    function poke() {
        if (failed) return;
        let state;
        try { state = read() ?? null; } catch { return; }
        const json = JSON.stringify(state);
        if (json === last) return;
        last = json;
        // An app without the handler (an older build) says no once; stop asking.
        Promise.resolve(invoke('presence_update', { state })).catch(() => { failed = true; });
    }
    every(poke, intervalMs);
    poke();
    return { poke };
}
