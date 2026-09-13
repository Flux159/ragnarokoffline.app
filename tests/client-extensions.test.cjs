'use strict';
// Unit contracts. These do not substitute for built-game Playwright acceptance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const modules = Promise.all([
    import('../patches/client/MovementCore.mjs'),
    import('../patches/client/ExtensionRuntime.mjs'),
    import('../patches/client/PluginLoader.mjs'),
]);

test('directional input normalizes diagonals, rotates with the camera and bounds blocked attempts', async () => {
    const [{ createMovement }] = await modules;
    const moves = [], directions = [];
    let canMove = true, cameraDirection = 0, wall = false;
    const movement = createMovement({ read: () => ({ canMove, cameraDirection, position: [10, 10] }),
        destination: (position, direction) => { directions.push(direction); return wall ? null : position.map((v, i) => v + direction[i] * 3); },
        send: point => moves.push(point),
    });
    const keyboard = movement.register('keyboard');
    movement.setActive(true);
    keyboard.begin(5, 5); movement.tick(0);
    assert.ok(Math.abs(Math.hypot(...directions[0]) - 1) < 1e-10);
    // Assert the geometry, not the formula. Camera.js renders a map step
    // (dx,dy) at screen R(-angle) . (dx,dy), so projecting the map direction
    // back through R(-angle) must return the on-screen intent that produced
    // it. Checking the round trip is what stops a sign error being re-encoded
    // here: the previous expectation matched the implementation, and both were
    // wrong for every camera angle except zero.
    cameraDirection = 2; keyboard.update(0, 1); movement.tick(180);
    const onScreen = (vector, degrees) => {
        const t = -degrees * Math.PI / 180;
        return [vector[0] * Math.cos(t) - vector[1] * Math.sin(t),
                vector[0] * Math.sin(t) + vector[1] * Math.cos(t)];
    };
    const back = onScreen(directions[1], 90);
    assert.ok(Math.abs(back[0]) < 1e-10, `screen x ${back[0]} should be 0`);
    assert.ok(back[1] > 0.999, `screen y ${back[1]} should be +1 (the "up" that was pressed)`);
    wall = true;
    for (let time = 181; time < 540; time++) movement.tick(time);
    assert.equal(moves.length, 2); assert.equal(directions.length, 3);
    canMove = false; movement.tick(540); canMove = true; movement.tick(720);
    assert.equal(movement.snapshot().source, null);
    assert.equal(directions.length, 3, 'unblocking must not resume stale held input');
});

test('screen intent survives any camera angle, including the partial ones indoors', async () => {
    const [{ createMovement }] = await modules;
    // Indoor maps (prt_in) stop short of a full rotation, so the camera rests
    // between the 45-degree sprite buckets Camera.direction reports. Movement
    // has to follow the continuous angle or "right" drifts by up to 22.5.
    const onScreen = (vector, degrees) => {
        const t = -degrees * Math.PI / 180;
        return [vector[0] * Math.cos(t) - vector[1] * Math.sin(t),
                vector[0] * Math.sin(t) + vector[1] * Math.cos(t)];
    };
    for (const cameraAngle of [0, -45, 45, 90, -90, 17.5, -122.5, 180]) {
        for (const [label, intent] of [['right', [1, 0]], ['up', [0, 1]], ['down-left', [-1, -1]]]) {
            const directions = [];
            const movement = createMovement({
                read: () => ({ canMove: true, cameraAngle, position: [10, 10] }),
                destination: (position, direction) => { directions.push(direction); return position; },
                send: () => {},
            });
            const source = movement.register('keyboard');
            movement.setActive(true);
            source.begin(...intent); movement.tick(0);
            const back = onScreen(directions[0], cameraAngle);
            const want = intent.map(v => v / Math.max(1, Math.hypot(...intent)));
            for (const axis of [0, 1]) {
                assert.ok(Math.abs(back[axis] - want[axis]) < 1e-9,
                    `${label} at camera ${cameraAngle}: screen axis ${axis} was ${back[axis]}, wanted ${want[axis]}`);
            }
        }
    }
});

test('Q and E turn while held, and space attacks once without repeating', async () => {
    const [, , { createPluginLoader }] = await modules;
    void createPluginLoader;
    const { keyboard } = await import('../mods/wasd-movement/client/index.js');
    const turns = [];
    let attacks = 0, canMove = true;
    const listeners = {};
    const target = {
        addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    };
    const api = {
        movement: { register: () => ({ begin: () => true, update: () => true, end() {}, dispose() {} }) },
        input: { state: () => ({ canMove }), shortcutConflict: () => false },
        actions: { rotateCamera: d => { turns.push(d); return true; }, attackNearest: () => { attacks++; return true; } },
        cleanup() {},
    };
    const send = (type, code, repeat = false) => {
        for (const handler of listeners[type] || []) {
            handler({ code, repeat, preventDefault() {}, stopImmediatePropagation() {} });
        }
    };
    const driver = keyboard(api, {}, target);
    send('keydown', 'KeyQ');
    assert.ok(turns.length >= 1, 'holding Q turns immediately');
    assert.ok(turns.every(d => d > 0), 'Q turns one way');
    send('keyup', 'KeyQ');
    const afterRelease = turns.length;
    send('keydown', 'KeyE');
    assert.ok(turns.slice(afterRelease).every(d => d < 0), 'E turns the other way');
    send('keyup', 'KeyE');

    // Space is deliberately not a repeat key: the server continues an attack
    // on its own, so a held key must not re-issue the same order.
    send('keydown', 'Space');
    send('keydown', 'Space', true);
    send('keydown', 'Space', true);
    assert.equal(attacks, 1, 'OS key repeat must not re-issue the attack');
    send('keyup', 'Space');
    send('keydown', 'Space');
    assert.equal(attacks, 2, 'a fresh press attacks again');

    // Q, E and space are shortcut slots (row three, slots one and three for Q
    // and E), so battle-shortcut priority has to reach them the same way it
    // reaches the movement keys.
    // Its own target: the driver above is still listening on the shared one,
    // and a second subscriber there would leave its turn timer running.
    const otherListeners = {};
    const otherTarget = { addEventListener(type, handler) { (otherListeners[type] ||= []).push(handler); } };
    const yielding = keyboard(
        { ...api, input: { state: () => ({ canMove: true }), shortcutConflict: () => true } },
        { policy: 'shortcuts' }, otherTarget);
    const turnsBefore = turns.length, attacksBefore = attacks;
    for (const code of ['KeyQ', 'Space']) {
        for (const handler of otherListeners.keydown || []) {
            handler({ code, repeat: false, preventDefault() {}, stopImmediatePropagation() {} });
        }
    }
    assert.equal(turns.length, turnsBefore, 'Q yields to a bound shortcut');
    assert.equal(attacks, attacksBefore, 'space yields to a bound shortcut');
    yielding.dispose();

    // Nothing fires while the player cannot act.
    canMove = false;
    const before = turns.length;
    send('keydown', 'KeyQ');
    send('keydown', 'Space');
    assert.equal(turns.length, before, 'no turning while input is blocked');
    assert.equal(attacks, 2, 'no attack while input is blocked');
    driver.dispose();
});

test('the last deliberate source owns movement; release never restores an older source', async () => {
    const [{ createMovement }] = await modules;
    const sent = [], cancelled = [];
    const movement = createMovement({ read: () => ({ canMove: true, cameraDirection: 0, position: [0, 0] }),
        destination: (_, vector) => vector, send: v => sent.push(v), cancelled: v => cancelled.push(v),
    });
    const keyboard = movement.register('keyboard');
    const touch = movement.register('touch');
    movement.setActive(true);
    keyboard.begin(0, 1); movement.tick(0);
    touch.begin(1, 0); movement.tick(10);
    assert.equal(keyboard.update(0, 1), false);
    touch.end(); movement.tick(1000);
    assert.equal(sent.length, 2);
    assert.equal(movement.snapshot().source, null);
    keyboard.begin(0, 1); movement.clear('map-click'); movement.tick(2000);
    assert.equal(sent.length, 2);
    assert.equal(cancelled.at(-1).reason, 'map-click');
    keyboard.dispose(); touch.dispose();
    assert.equal(movement.snapshot().registeredSources, 0);
});

test('zero vectors cancel opposite directions while the current source can resume on release', async () => {
    const [{ createMovement }] = await modules;
    const sent = [];
    const movement = createMovement({ read: () => ({ canMove: true, cameraDirection: 0, position: [0, 0] }), destination: (_, v) => v, send: v => sent.push(v) });
    const keys = movement.register('keyboard'); movement.setActive(true);
    keys.begin(0, 1); movement.tick(0);
    keys.update(0, 0); movement.tick(200);
    keys.update(0, 1); movement.tick(400);
    keys.end(); movement.tick(600);
    assert.equal(sent.length, 2);
    movement.setActive(false); assert.equal(keys.begin(0, 1), false);
});

test('plugin scopes replay current state and clean listeners, movement and preferences without sharing ownership', async () => {
    const [, { createRuntime }] = await modules;
    const saved = new Map();
    const runtime = createRuntime({ storage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) } });
    const scope = runtime.scope('a'), other = runtime.scope('b');
    runtime.enterMap('prontera');
    const maps = [];
    scope.api.on('map:enter', v => maps.push(v.name));
    await Promise.resolve(); assert.deepEqual(maps, ['prontera']);
    scope.api.preferences.set('keys', { north: 'KeyZ' });
    assert.deepEqual(other.api.preferences.get('keys', {}), {});
    const keys = scope.api.movement.register('keys'); keys.begin(0, 1);
    let cleanups = 0; scope.api.cleanup(() => cleanups++);
    const state = scope.api.snapshot();
    assert.equal(Object.isFrozen(state.movement.vector), true);
    scope.dispose(); scope.dispose();
    assert.equal(cleanups, 1); assert.equal(runtime.movement.snapshot().registeredSources, 0);
    assert.equal(runtime.diagnostics().listeners, 0);
    const replacement = runtime.scope('a');
    assert.deepEqual(replacement.api.preferences.get('keys', {}), { north: 'KeyZ' });
    runtime.dispose(); assert.equal(runtime.diagnostics().scopes, 0);
});

test('async plugins initialize deterministically and a failed plugin releases partial setup', async () => {
    const [, { createRuntime }, { createPluginLoader }] = await modules;
    const runtime = createRuntime(); const order = [], errors = [];
    const loader = createPluginLoader({ runtime, report: (...args) => errors.push(args), importModule: async path => ({ default: async (_, api) => {
        order.push(path + ':begin'); api.on('map:enter', () => {});
        await Promise.resolve();
        if (path === 'broken') throw new Error('failure');
        order.push(path + ':end'); return () => order.push(path + ':cleanup');
    } }) });
    const first = loader.init({ first: 'one', bad: 'broken', last: 'three' });
    assert.equal(loader.init({ ignored: 'ignored' }), first);
    await first;
    assert.deepEqual(order, ['one:begin', 'one:end', 'broken:begin', 'three:begin', 'three:end']);
    assert.equal(runtime.diagnostics().listeners, 2); assert.equal(errors.length, 1);
    assert.deepEqual(loader.status().map(s => s.status), ['ready', 'failed', 'ready']);
    loader.dispose(); assert.equal(runtime.diagnostics().listeners, 0);
    assert.deepEqual(order.slice(-2), ['three:cleanup', 'one:cleanup']);
});

test('disposal during an async initializer cleans resources returned after disposal', async () => {
    const [, { createRuntime }, { createPluginLoader }] = await modules;
    const runtime = createRuntime(); let complete, started, disposed = 0;
    const entered = new Promise(resolve => { started = resolve; });
    const loader = createPluginLoader({ runtime, importModule: async () => ({ default: async () => {
        started(); await new Promise(resolve => { complete = resolve; }); return () => disposed++;
    } }) });
    const run = loader.init({ delayed: 'delayed' });
    await entered; loader.dispose(); complete(); await run;
    assert.equal(disposed, 1); assert.deepEqual(loader.status(), []);
    assert.equal(runtime.diagnostics().scopes, 0);
});

const keyboardModule = import('data:text/javascript;base64,' + require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../mods/wasd-movement/client/index.js')).toString('base64'));

test('keyboard consumes movement, cancels on focus and never revives a canceled key from OS repeat', async () => {
    const [, { createRuntime }] = await modules;
    const { keyboard } = await keyboardModule;
    let allowed = true;
    const moves = [];
    const runtime = createRuntime();
    runtime.configure({ inputState: () => ({ canMove: allowed }),
        movementState: () => ({ canMove: allowed, cameraDirection: 0, position: [0, 0] }),
        destination: (_, v) => v, sendMove: v => moves.push(v) });
    const scope = runtime.scope('wasd');
    const target = new EventTarget();
    keyboard(scope.api, {}, target);
    runtime.enterMap('test');
    const key = (type, code, rest = {}) => {
        const event = new Event(type, { cancelable: true });
        Object.assign(event, { code, repeat: false, ...rest }); target.dispatchEvent(event); return event;
    };
    assert.equal(key('keydown', 'KeyW').defaultPrevented, true);
    runtime.movement.tick(0); assert.equal(moves.length, 1);
    runtime.movement.clear('map-click');
    key('keydown', 'KeyW', { repeat: true }); runtime.movement.tick(200);
    assert.equal(moves.length, 1);
    key('keyup', 'KeyW'); key('keydown', 'KeyW'); runtime.movement.tick(400);
    assert.equal(moves.length, 2);
    allowed = false;
    assert.equal(key('keydown', 'KeyA').defaultPrevented, false, 'text input must remain usable');
    runtime.movement.tick(600); assert.equal(moves.length, 2);
    allowed = true;
    key('keydown', 'KeyW', { repeat: true }); runtime.movement.tick(800);
    assert.equal(moves.length, 2);
    key('keyup', 'KeyW'); scope.dispose();
    key('keydown', 'KeyD'); runtime.movement.tick(1000);
    assert.equal(moves.length, 2); assert.equal(runtime.movement.snapshot().registeredSources, 0);
});

test('shortcut priority, disable and remapping preserve one owner and let shortcuts receive their keys', async () => {
    const [, { createRuntime }] = await modules;
    const { keyboard, settings } = await keyboardModule;
    const runtime = createRuntime();
    runtime.configure({ inputState: () => ({ canMove: true }), shortcutConflict: code => code === 87 });
    const scope = runtime.scope('wasd'); const target = new EventTarget();
    const driver = keyboard(scope.api, { policy: 'shortcuts' }, target);
    runtime.enterMap('test');
    const press = (code, keyCode) => {
        const event = new Event('keydown', { cancelable: true });
        Object.assign(event, { code, keyCode, repeat: false }); target.dispatchEvent(event); return event;
    };
    assert.equal(press('KeyW', 87).defaultPrevented, false);
    assert.equal(runtime.movement.snapshot().source, null);
    driver.configure({ policy: 'movement' });
    assert.equal(press('KeyW', 87).defaultPrevented, true);
    const modifier = new Event('keydown', { cancelable: true });
    Object.assign(modifier, { code: 'ShiftLeft', shiftKey: true }); target.dispatchEvent(modifier);
    assert.equal(runtime.movement.snapshot().source, null, 'adding a modifier cancels held movement before native shortcuts');
    driver.configure({ enabled: false });
    assert.equal(runtime.movement.snapshot().source, null);
    assert.equal(press('KeyD', 68).defaultPrevented, false);
    driver.configure({ arrows: false, bindings: { up: 'KeyZ', left: 'KeyQ', down: 'KeyS', right: 'KeyD' } });
    assert.equal(press('ArrowUp', 38).defaultPrevented, false);
    assert.equal(press('KeyW', 87).defaultPrevented, false);
    assert.equal(press('KeyZ', 90).defaultPrevented, true);
    assert.equal(settings({ bindings: { up: 'KeyZ', left: 'KeyZ', down: 'KeyS', right: 'KeyD' } }).bindings.up, 'KeyW');
    scope.dispose();
});

test('plugin dialogs release shared input suspension on close, failure and disposal', async () => {
    const [, { createRuntime }] = await modules;
    const runtime = createRuntime();
    const one = runtime.scope('one'), two = runtime.scope('two');
    const release = one.api.input.suspend(); two.api.input.suspend();
    assert.equal(runtime.inputBlocked(), true);
    release(); release(); assert.equal(runtime.inputBlocked(), true);
    two.dispose(); assert.equal(runtime.inputBlocked(), false);
    one.api.input.suspend(); one.dispose(); assert.equal(runtime.inputBlocked(), false);
});

test('a stalled initializer does not strand login and its late cleanup still runs', async () => {
    const [, { createRuntime }, { createPluginLoader }] = await modules;
    const runtime = createRuntime(); let complete, cleaned = 0;
    const loader = createPluginLoader({ runtime, timeout: 10, report: () => {}, importModule: async path => ({ default: (_, api) => {
        if (path === 'stalled') {
            api.input.suspend();
            return new Promise(resolve => { complete = () => resolve(() => cleaned++); });
        }
        return true;
    } }) });
    await loader.init({ stalled: 'stalled', good: 'good' });
    assert.deepEqual(loader.status().map(s => s.status), ['failed', 'ready']);
    assert.equal(runtime.inputBlocked(), false);
    complete(); await Promise.resolve(); await Promise.resolve();
    assert.equal(cleaned, 1); loader.dispose();
});
