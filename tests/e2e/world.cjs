// Development-only test world. Never selects the player's save or starts a
// second host automatically. All generated state stays below RO_E2E_WORLD.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { AssetServer } = require('../../electron/asset-server');
const repo = path.resolve(__dirname, '../..');
const suffix = process.platform === 'win32' ? '.exe' : '';
const command = process.argv[2];
const selected = process.env.RO_E2E_WORLD;
if (!selected || !['prepare', 'up', 'serve', 'backup', 'down'].includes(command)) {
    throw new Error('Set RO_E2E_WORLD and run world.cjs prepare|up|serve|backup|down; see docs/TESTING.md');
}
const world = path.resolve(selected), root = path.join(world, 'runtime'), state = path.join(world, 'state');
const marker = path.join(world, '.ragnarok-e2e.json');
const stack = path.join(root, 'bin', 'ragnarok-stack' + suffix);
const environment = { ...process.env, RAGNAROK_OFFLINE_ROOT: root, RAGNAROK_OFFLINE_HOME: world,
    RAGNAROKMAC_STATE: state, NEBULA_HOME: path.join(world, 'nebula'), NEBULA_BIN: path.join(root, 'bin', 'nebula' + suffix),
    RAGNAROKMAC_DOCKER: path.join(root, 'bin', 'docker-slim' + suffix) };
function run(args) {
    const result = spawnSync(stack, args, { env: environment, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Test supervisor failed: ${args[0]} (exit ${result.status})`);
}
async function freePorts() {
    for (const port of [3338, 6900, 6121, 5121, 7462]) {
        const busy = await new Promise(resolve => {
            const socket = net.connect({ host: '127.0.0.1', port });
            const done = value => { socket.destroy(); resolve(value); };
            socket.once('connect', () => done(true)); socket.once('error', () => done(false));
            socket.setTimeout(1000, () => done(true));
        });
        if (busy) throw new Error(`Port ${port} is occupied. Finish quitting the other host before starting this test world.`);
    }
}
function validate() {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).disposable !== true) throw new Error('Not a disposable test world');
}
async function main() {
    if (command === 'prepare') {
        if (fs.existsSync(world)) throw new Error('Choose a new empty world path; existing state is never overwritten');
        const runtime = process.env.RO_E2E_RUNTIME;
        const selection = process.env.RO_E2E_CLIENT_JSON;
        if (!runtime || !selection) throw new Error('Preparation needs RO_E2E_RUNTIME and RO_E2E_CLIENT_JSON');
        await freePorts();
        const client = JSON.parse(fs.readFileSync(selection, 'utf8'));
        // Validate sources before creating anything, including the current
        // compiled binaries and pinned built game, not a stale packaged client.
        const sources = [runtime, client.data_grf, path.join(repo, 'stack/target/debug/ragnarok-stack' + suffix),
            path.join(repo, 'bin/robrowser-remoteclient' + suffix), path.join(repo, 'vendor/roBrowserLegacy/dist/Web/Online.js')];
        for (const source of sources) if (!source || !fs.existsSync(source)) throw new Error(`Missing preparation source: ${source}`);
        fs.mkdirSync(state, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify({ disposable: true, created: new Date().toISOString() }));
        const copy = (source, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true }); };
        for (const name of ['bin', 'guest']) copy(path.join(runtime, name), path.join(root, name));
        for (const name of ['config', 'sql', 'mods', 'client-assets', 'db-import']) {
            const source = path.join(repo, name);
            if (fs.existsSync(source)) copy(source, path.join(root, name));
        }
        copy(path.join(repo, 'stack/target/debug/ragnarok-stack' + suffix), stack);
        copy(path.join(repo, 'bin/robrowser-remoteclient' + suffix), path.join(root, 'bin/robrowser-remoteclient' + suffix));
        copy(path.join(repo, 'vendor/roBrowserLegacy/dist/Web'), path.join(root, 'vendor/roBrowserLegacy/dist/Web'));
        copy(path.join(repo, 'vendor/ROenglishRE/Translation'), path.join(root, 'vendor/ROenglishRE/Translation'));
        // The image archive is build output, not a database/save disk.
        const images = [path.join(repo, 'dist/images.tar.gz'), path.join(runtime, 'dist/images.tar.gz')].find(fs.existsSync);
        if (!images) throw new Error('No packaged container images found');
        copy(images, path.join(root, 'dist/images.tar.gz'));
        fs.writeFileSync(path.join(root, 'APP_VERSION'), require('../../package.json').version);
        run(['link-assets', ...['data_grf', 'rdata_grf', 'official_grf', 'bgm_dir'].map(key => client[key] || '')]);
        console.log('Prepared isolated test world:', world);
        return;
    }
    validate();
    if (command === 'up') { await freePorts(); run(['up', '--ram', '4096']); return; }
    if (command === 'backup') { run(['backup', path.join(world, `before-controls-${Date.now()}.sql`)]); return; }
    if (command === 'down') { run(['down']); return; }
    const server = new AssetServer({ log: text => console.log(text), identify: pid => require('../../electron/asset-server').processIdentity(pid, stack) });
    const fallback = name => { try { return fs.readFileSync(path.join(state, 'asset-config', name + '.path'), 'utf8').trim(); } catch { return ''; } };
    await server.start({ executable: path.join(root, 'bin/robrowser-remoteclient' + suffix), cwd: state, stateRoot: state,
        environment: { PORT: '3338', HOST: '127.0.0.1', NODE_ENV: 'production', SERVER_ROOT: path.join(state, 'assets'),
            CLIENT_PUBLIC_URL: 'http://127.0.0.1:3338', CLIENT_RESPATH: 'resources/', CLIENT_DATAINI: path.join(state, 'asset-config/DATA.INI'),
            CLIENT_AUTOEXTRACT: 'false', BGM_PATH: fallback('bgm'), AI_PATH: fallback('ai'), DATA_OVERRIDE_PATH: path.join(state, 'assets/.translation/data'),
            ROBROWSER_PATH: path.join(root, 'vendor/roBrowserLegacy/dist/Web'), ENABLE_STATIC_SERVE: 'true', ENABLE_WSPROXY: 'true',
            WS_ALLOWED_TARGETS: '127.0.0.1:6900,127.0.0.1:6121,127.0.0.1:5121' } });
    console.log('Owned test game ready at http://127.0.0.1:3338/; Ctrl-C stops assets, then run world.cjs down.');
    const stop = async () => { await server.stop(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
