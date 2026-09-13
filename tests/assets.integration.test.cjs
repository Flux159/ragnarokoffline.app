'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { AssetServer } = require('../electron/asset-server');
const grf = require('./fixtures/grf.cjs');
const enabled = process.env.STACK_BIN && process.env.REMOTECLIENT_BIN;

test('assembled assets serve from selected volumes, preserve sources and restore disabled overlays', {
    skip: !enabled && 'set STACK_BIN and REMOTECLIENT_BIN to test real asset assembly', timeout: 45000,
}, async t => {
    const temp = base => fs.mkdtempSync(path.join(base, 'ro-assets-'));
    const state = temp(process.env.RAGNAROK_TEST_STATE_ROOT || os.tmpdir());
    const root = temp(process.env.RAGNAROK_TEST_APP_ROOT || os.tmpdir());
    // Hosted Windows runners normally have workspace D: and temp/state C:.
    // Report actual roots, so two directories are never claimed as two volumes.
    const client = temp(process.env.RAGNAROK_TEST_CLIENT_ROOT || (process.platform === 'win32' ? process.cwd() : os.tmpdir()));
    const server = new AssetServer();
    const readOnlyFiles = [];
    t.after(async () => {
        await server.stop();
        for (const file of readOnlyFiles) fs.chmodSync(file, 0o600);
        for (const dir of [state, root, client]) fs.rmSync(dir, { recursive: true, force: true });
    });
    t.diagnostic(`asset fixtures: app=${path.parse(root).root}, state=${path.parse(state).root}, client=${path.parse(client).root}`);
    if (process.env.RAGNAROK_REQUIRE_CROSS_VOLUME === '1') {
        assert.notEqual(path.parse(client).root.toLowerCase(), path.parse(state).root.toLowerCase());
    }
    const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
    const data = path.join(client, 'game files 한글/data.grf');
    const music = path.join(client, 'BGM/theme.mp3');
    const rdata = path.join(root, 'selected archives/rdata.grf');
    const official = path.join(state, 'selected archives/official.grf');
    write(data, grf());
    write(rdata, grf('data\\priority.txt', Buffer.from('rdata priority')));
    write(official, grf('data\\priority.txt', Buffer.from('official priority')));
    write(music, 'original music');
    write(path.join(client, 'game files 한글/System/font.ttf'), 'font bytes');
    write(path.join(root, 'vendor/ROenglishRE/Translation/Renewal/data/english.txt'), 'translated bytes');
    write(path.join(root, 'vendor/ROenglishRE/Translation/Renewal/SystemEN/LuaFiles514/itemInfo.lua'), 'English items');
    write(path.join(root, 'vendor/ROenglishRE/Translation/Renewal/SystemEN/OngoingQuests.lub'), 'English quests');
    write(path.join(root, 'config/Config.local.js'), 'window.ROConfigLocal = {\nrenewal: true,\n};\n');
    write(path.join(root, 'config/index.html'), 'game entry');
    write(path.join(root, 'vendor/roBrowserLegacy/dist/Web/Config.local.js'), 'stale bundled config');
    write(path.join(state, 'mods/music/BGM/theme.mp3'), 'mod music');
    write(path.join(state, 'mods/enabled.txt'), 'music\n');
    const original = fs.readFileSync(data);
    const originals = [data, rdata, official, music].map(file => [file, fs.readFileSync(file)]);
    for (const [file] of originals) { fs.chmodSync(file, 0o444); readOnlyFiles.push(file); }
    const link = () => execFileSync(process.env.STACK_BIN, ['link-assets', data, rdata, official, path.dirname(music)], {
        env: { ...process.env, RAGNAROK_OFFLINE_ROOT: root, RAGNAROKMAC_STATE: state }, timeout: 15000,
    });
    link();
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const options = () => ({ executable: process.env.REMOTECLIENT_BIN, cwd: state, stateRoot: state, environment: {
        PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', SERVER_ROOT: path.join(state, 'assets'),
        CLIENT_PUBLIC_URL: `http://127.0.0.1:${port}`, CLIENT_RESPATH: 'resources/',
        CLIENT_DATAINI: path.join(state, 'asset-config/DATA.INI'), CLIENT_AUTOEXTRACT: 'false',
        BGM_PATH: fs.readFileSync(path.join(state, 'asset-config/bgm.path'), 'utf8'),
        DATA_OVERRIDE_PATH: path.join(state, 'assets/.translation/data'),
        ROBROWSER_PATH: path.join(root, 'vendor/roBrowserLegacy/dist/Web'), ENABLE_STATIC_SERVE: 'true',
    } });
    await server.start(options());
    const get = file => fetch(`http://127.0.0.1:${port}/${file}`);
    assert.equal(await (await get('data/fixture.txt')).text(), 'synthetic archive bytes');
    assert.equal(await (await get('data/priority.txt')).text(), 'official priority');
    assert.equal(await (await get('data/english.txt')).text(), 'translated bytes');
    assert.equal(await (await get('System/itemInfo.lua')).text(), 'English items');
    assert.equal(await (await get('BGM/theme.mp3')).text(), 'mod music');
    assert.match(await (await get('Config.local.js')).text(), /renewal: true/);
    for (const file of ['resources/data.grf', 'resources/DATA.INI', '.translation/data/english.txt']) {
        assert.equal((await get(file)).status, 404, file);
    }
    await server.stop();
    write(path.join(state, 'mods/disabled.txt'), 'music\n');
    link();
    await server.start(options());
    assert.equal(await (await get('BGM/theme.mp3')).text(), 'original music');
    assert.equal(fs.existsSync(path.join(state, 'assets/BGM/theme.mp3')), false);
    assert.deepEqual(fs.readFileSync(data), original);
    for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.readFileSync(music, 'utf8'), 'original music');
    assert.equal(fs.existsSync(path.join(state, 'assets/resources/data.grf')), false);
    assert.deepEqual(fs.readdirSync(path.join(state, 'assets/resources')), []);
    assert.equal(fs.readFileSync(path.join(root, 'vendor/roBrowserLegacy/dist/Web/Config.local.js'), 'utf8'), 'stale bundled config');
});
