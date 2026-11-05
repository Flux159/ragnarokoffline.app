'use strict';
// Graphics+'s Screen effects switch: off, the mod registers its full-screen
// pass but it never runs, so the client draws straight to the screen (no
// offscreen picture for Performance mode to shrink). Everything drawn into
// the map itself (grass, water, shadows) is left to its own settings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MOD = path.join(__dirname, '..', 'mods', 'graphics-plus');
const manifest = JSON.parse(fs.readFileSync(path.join(MOD, 'mod.json'), 'utf8'));
const defaults = Object.fromEntries(manifest.settings.map(s => [s.key, s.default]));

async function start(overrides) {
    const { default: init } = await import(path.join(MOD, 'client', 'index.js'));
    const passes = [];
    const hooks = [];
    const listeners = [];
    const api = {
        version: 1,
        graphics: {
            supported: () => true,
            registerPass: spec => { passes.push(spec); return () => {}; },
            hook: spec => { hooks.push(spec.name); return () => {}; },
        },
        on: () => {},
        snapshot: () => ({ map: 'prontera' }),
        cleanup: fn => listeners.push(fn),
    };
    globalThis.addEventListener ??= () => {};
    globalThis.removeEventListener ??= () => {};
    init({ ...defaults, ...overrides }, api);
    listeners.forEach(fn => fn());
    return { passes, hooks };
}

test('Screen effects is a switch, on by default', () => {
    const setting = manifest.settings.find(s => s.key === 'screen_effects');
    assert.ok(setting, 'declared in mod.json');
    assert.equal(setting.type, 'boolean');
    assert.equal(setting.default, true);
    const page = fs.readFileSync(path.join(MOD, 'settings', 'index.html'), 'utf8');
    assert.match(page, /keys: \['screen_effects'\]/, 'the settings page shows it');
    assert.match(page, /name: 'Off'[^\n]*screen_effects: false/, 'the Off preset turns it off');
});

test('on, the pass runs as before', async () => {
    const { passes } = await start({});
    assert.equal(passes.length, 1);
    assert.equal(passes[0].enabled(), true);
});

test('off, the pass never runs, and the map effects are untouched', async () => {
    const on = await start({});
    const off = await start({ screen_effects: false });
    assert.equal(off.passes.length, 1);
    assert.equal(off.passes[0].enabled(), false);
    assert.deepEqual(off.hooks, on.hooks, 'grass, water, shadows and the rest are hooked either way');
});
