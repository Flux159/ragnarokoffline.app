const DEFAULTS = Object.freeze({ enabled: true, arrows: true, policy: 'movement',
    rotate: true, attack: true,
    bindings: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD' } });
// Held keys that are not movement. Rotation repeats while held, which is what
// makes it feel like the mouse drag it replaces; attack does not, because the
// server continues an attack on its own and a repeat would only re-issue it.
const TURN_STEP = 6;
const TURN_INTERVAL = 16;
const DIRECTIONS = { up: [0, 1], left: [-1, 0], down: [0, -1], right: [1, 0] };
const ARROWS = { ArrowUp: [0, 1], ArrowLeft: [-1, 0], ArrowDown: [0, -1], ArrowRight: [1, 0] };
const validCode = code => typeof code === 'string' && /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Left|Down|Right))$/.test(code);

export function settings(value = {}) {
    const bindings = { ...DEFAULTS.bindings };
    if (Object.keys(bindings).every(key => validCode(value.bindings?.[key])) && new Set(Object.values(value.bindings)).size === 4) {
        for (const key of Object.keys(bindings)) bindings[key] = value.bindings[key];
    }
    return { enabled: value.enabled !== false, arrows: value.arrows !== false,
        rotate: value.rotate !== false, attack: value.attack !== false,
        policy: value.policy === 'shortcuts' ? 'shortcuts' : 'movement', bindings };
}

export function keyboard(api, initial, target = window) {
    let preferences = settings(initial);
    const held = new Set();
    const pressed = new Set();
    const abort = new AbortController();
    const source = api.movement.register('keyboard', () => held.clear());
    const binding = code => {
        for (const [name, value] of Object.entries(preferences.bindings)) if (code === value) return DIRECTIONS[name];
        return preferences.arrows ? ARROWS[code] : null;
    };
    const vector = () => [...held].reduce((sum, code) => {
        const v = binding(code); return v ? [sum[0] + v[0], sum[1] + v[1]] : sum;
    }, [0, 0]);
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const clear = () => { source.end(); held.clear(); stopTurning(); };
    // Turning is its own held-key loop rather than part of the movement vector:
    // it changes the camera, not a destination, and the two are independent --
    // holding W while turning should curve, not stop.
    const turning = new Set();
    let turnTimer = null;
    const stopTurning = () => { turning.clear(); if (turnTimer) { clearInterval(turnTimer); turnTimer = null; } };
    const turnStep = () => {
        let degrees = 0;
        for (const code of turning) degrees += code === 'KeyQ' ? TURN_STEP : -TURN_STEP;
        if (degrees) api.actions.rotateCamera(degrees);
    };
    const startTurning = code => {
        turning.add(code);
        if (!turnTimer) { turnStep(); turnTimer = setInterval(turnStep, TURN_INTERVAL); }
    };
    target.addEventListener('keydown', event => {
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.isComposing) {
            clear(); return;
        }
        if (!preferences.enabled) return;
        // Turning and attacking are separate from the movement vector, and are
        // still subject to the same text-field and modal rules above.
        // Q, E and space are shortcut slots too -- Q and E are row three, slots
        // one and three -- so they answer to the same priority setting the
        // movement keys do. Without this, choosing "battle shortcuts take
        // priority" would still lose Q, E and space to this mod.
        const yields = code => preferences.policy === 'shortcuts'
            && api.input.shortcutConflict(event.keyCode || event.which)
            && Boolean(code);
        if (preferences.rotate && (event.code === 'KeyQ' || event.code === 'KeyE')) {
            if (!api.input.state().canMove) { clear(); return; }
            if (yields(event.code)) { stopTurning(); return; }
            if (!event.repeat) startTurning(event.code);
            consume(event); return;
        }
        if (preferences.attack && event.code === 'Space') {
            if (!api.input.state().canMove) { clear(); return; }
            if (yields(event.code)) return;
            // No repeat: action 7 keeps the server swinging on its own, so a
            // held space would only re-issue the same order.
            if (!event.repeat) api.actions.attackNearest();
            consume(event); return;
        }
        if (!binding(event.code)) return;
        if (!api.input.state().canMove) {
            clear(); return;
        }
        if (preferences.policy === 'shortcuts' && api.input.shortcutConflict(event.keyCode || event.which)) { clear(); return; }
        // A canceled source must wait for a fresh physical press. OS repeat
        // cannot restart it after a click, touch, warp or text-field focus.
        if (event.repeat && !held.has(event.code)) {
            if (pressed.has(event.code)) consume(event);
            return;
        }
        pressed.add(event.code);
        const starting = held.size === 0;
        held.add(event.code);
        const accepted = starting ? source.begin(...vector()) : source.update(...vector());
        if (accepted) consume(event); else held.clear();
    }, { capture: true, signal: abort.signal });
    target.addEventListener('keyup', event => {
        pressed.delete(event.code);
        if (turning.delete(event.code)) {
            if (!turning.size && turnTimer) { clearInterval(turnTimer); turnTimer = null; }
            consume(event); return;
        }
        if (!held.delete(event.code)) return;
        if (held.size) source.update(...vector()); else source.end();
        consume(event);
    }, { capture: true, signal: abort.signal });
    target.addEventListener('blur', () => { clear(); pressed.clear(); }, { signal: abort.signal });
    const dispose = () => { clear(); stopTurning(); pressed.clear(); source.dispose(); abort.abort(); };
    api.cleanup(dispose);
    return { configure(value) { clear(); preferences = settings(value); }, dispose };
}

export default function init(parameters, api) {
    if (api?.version !== 1) throw new Error('wasd-movement requires client API 1');
    let preferences = settings(api.preferences.get('controls', DEFAULTS));
    const driver = keyboard(api, preferences);
    // Declared in mod.json and set in Settings > Mods, so the mod can stay on
    // while its on-screen launcher stays out of the way. Movement, rebinding
    // and every other behaviour are unaffected.
    const showLauncher = parameters?.show_controls_button !== false;
    const host = document.createElement('div');
    host.id = 'ragnarok-controls';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
        :host { position:fixed; top:calc(env(safe-area-inset-top) + 8px); right:calc(env(safe-area-inset-right) + 8px); z-index:10001; font:14px system-ui; }
        button, select { min-height:44px; font:inherit; cursor:pointer; }
        button { border:1px solid #a09276; border-radius:6px; background:#f6f0df; color:#322b1d; padding:8px 12px; }
        dialog { color:#29271f; background:#fff9ec; border:1px solid #8a795a; border-radius:10px; padding:20px; width:min(360px,calc(100vw - 64px)); max-height:calc(100dvh - 70px); overflow:auto; }
        dialog::backdrop { background:#0008; } h2 { margin:0 0 12px; } label { display:flex; align-items:center; gap:8px; min-height:44px; } input { width:20px; height:20px; }
        .bindings { display:grid; grid-template-columns:1fr 1fr; gap:8px; } p { line-height:1.45; } .footer { display:flex; justify-content:space-between; margin-top:16px; gap:8px; }
        select { width:100%; } output { display:block; min-height:2.5em; margin-top:8px; }
        /* 44px is a touch target. With a mouse it is just a big button parked
           over the game, so shrink the launcher (never the dialog controls). */
        @media (pointer: fine) { #open { min-height:0; padding:3px 9px; font-size:12px; opacity:.5; }
            #open:hover, #open:focus-visible { opacity:1; } }
    </style>
    <button id="open" aria-haspopup="dialog">Controls</button>
    <dialog aria-labelledby="title"><h2 id="title">Movement controls</h2>
        <label><input id="enabled" type="checkbox"> Keyboard movement</label>
        <label><input id="arrows" type="checkbox"> Also use arrow keys</label>
        <label><input id="rotate" type="checkbox"> Q and E turn the camera</label>
        <label><input id="attack" type="checkbox"> Space attacks the nearest monster</label>
        <p>Space keeps attacking the same monster until it falls, the way clicking it does.
           Skills stay on the shortcut bar — F1 to F9 by default, and remappable in game.</p>
        <p>Physical keys keep directions consistent across keyboard layouts. Choose a direction to rebind it.</p>
        <div class="bindings"></div>
        <label for="policy">When battle shortcuts conflict</label>
        <select id="policy"><option value="movement">Movement takes priority</option><option value="shortcuts">Battle shortcuts take priority</option></select>
        <p>Chat and other text fields always take priority. Releasing stops new destinations; your character may finish the current few steps.</p>
        <output aria-live="polite"></output>
        <div class="footer"><button id="reset">Restore defaults</button><button id="close">Done</button></div>
    </dialog>`;
    document.body.append(host);
    const dialog = root.querySelector('dialog');
    const output = root.querySelector('output');
    let resume = null;
    let rebind = null;
    const render = () => {
        root.querySelector('#enabled').checked = preferences.enabled;
        root.querySelector('#arrows').checked = preferences.arrows;
        root.querySelector('#rotate').checked = preferences.rotate;
        root.querySelector('#attack').checked = preferences.attack;
        root.querySelector('#policy').value = preferences.policy;
        for (const [name, code] of Object.entries(preferences.bindings)) root.querySelector(`[data-direction="${name}"]`).textContent = `${name}: ${code}`;
    };
    const save = () => {
        driver.configure(preferences);
        try { api.preferences.set('controls', preferences); output.textContent = 'Saved on this browser.'; }
        catch { output.textContent = 'Applied for this session. Browser storage is unavailable.'; }
        render();
    };
    for (const name of Object.keys(DIRECTIONS)) {
        const button = document.createElement('button'); button.dataset.direction = name;
        button.addEventListener('click', () => { rebind = name; output.textContent = `Press a letter, number or arrow for ${name}. Escape cancels.`; });
        root.querySelector('.bindings').append(button);
    }
    dialog.addEventListener('keydown', event => {
        if (!rebind) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { rebind = null; output.textContent = 'Rebinding canceled.'; return; }
        if (!validCode(event.code) || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) { output.textContent = 'Choose one letter, number or arrow without modifiers.'; return; }
        if (Object.entries(preferences.bindings).some(([name, code]) => name !== rebind && code === event.code)) { output.textContent = 'That key is already assigned to another direction.'; return; }
        preferences.bindings[rebind] = event.code; rebind = null; save();
    });
    root.querySelector('#open').addEventListener('click', () => { resume = api.input.suspend(); dialog.showModal(); });
    dialog.addEventListener('close', () => { resume?.(); resume = null; rebind = null; });
    root.querySelector('#close').addEventListener('click', () => dialog.close());
    root.querySelector('#reset').addEventListener('click', () => { preferences = settings(); save(); });
    for (const key of ['enabled', 'arrows', 'rotate', 'attack']) root.querySelector(`#${key}`).addEventListener('change', event => { preferences[key] = event.target.checked; save(); });
    root.querySelector('#policy').addEventListener('change', event => { preferences.policy = event.target.value; save(); });
    api.on('map:enter', () => { host.hidden = !showLauncher; });
    api.on('map:leave', () => { host.hidden = true; if (dialog.open) dialog.close(); });
    host.hidden = !showLauncher || !api.snapshot().map;
    api.cleanup(() => { if (dialog.open) dialog.close(); resume?.(); host.remove(); });
    render();
}
