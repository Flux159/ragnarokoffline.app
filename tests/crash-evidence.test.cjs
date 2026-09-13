'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('compiled collector captures abnormal exits privately, redacts secrets, deduplicates and bounds logs',
  { skip: !process.env.STACK_BIN }, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-crash-evidence-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const binary = path.join(root, 'engine' + (process.platform === 'win32' ? '.exe' : ''));
    const built = spawnSync('rustc', [path.join(__dirname, 'fixtures/crash-engine.rs'), '-o', binary], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const era = path.join(root, 'private/service-credentials/renewal');
    fs.mkdirSync(era, { recursive: true });
    const secrets = { root: 'root-private-sentinel', database: 'db-private-sentinel', interserver: 'game-private-sentinel' };
    fs.writeFileSync(path.join(era, 'credentials.json'), JSON.stringify(secrets), { mode: 0o600 });
    fs.writeFileSync(path.join(root, '.db-volume'), 'ragnarokmac-db');
    const id = 'a'.repeat(64);
    const state = { Status: 'exited', ExitCode: 139, OOMKilled: false,
      StartedAt: '2026-09-07T01:00:00Z', FinishedAt: '2026-09-07T02:00:00Z' };
    const writeInspect = () => fs.writeFileSync(path.join(root, 'inspect.json'), JSON.stringify([
      { Id: id, Image: 'sha256:image-fixture', State: state, Config: { Env: ['NEVER_EXPORT_INSPECT_SECRET'] } },
    ]));
    writeInspect();
    fs.writeFileSync(path.join(root, 'map.log'), '\x1b[31mReceived a crash signal\x1b[0m\n' + Object.values(secrets).join('\n'));
    const run = () => spawnSync(process.env.STACK_BIN, ['capture-crashes'], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, RO_CRASH_FIXTURE: root, RAGNAROK_OFFLINE_ROOT: root,
        RAGNAROKMAC_STATE: root, RAGNAROKMAC_DOCKER: binary, NEBULA_HOME: path.join(root, 'never-started') } });
    let result = run(); assert.equal(result.status, 0, result.stderr);
    const reports = path.join(root, 'crashes/reports');
    const files = () => fs.readdirSync(reports).filter(x => x.endsWith('.log'));
    assert.equal(files().length, 1);
    const reportPath = path.join(reports, files()[0]);
    const body = fs.readFileSync(reportPath, 'utf8');
    const metadata = JSON.parse(body.split('\n')[0]);
    assert.equal(metadata.reason, 'rathena-crash-signal');
    assert.equal(metadata.exitCode, 139); assert.equal(metadata.backtraceAvailable, false);
    assert.equal(metadata.era, 'renewal'); assert.equal(metadata.image, 'sha256:image-fixture');
    for (const secret of [...Object.values(secrets), 'NEVER_EXPORT_INSPECT_SECRET']) assert.equal(body.includes(secret), false);
    assert.equal(body.includes('\x1b'), false); assert.match(body, /last stderr context/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(files().length, 1);
    assert.equal(result.stdout.trim(), '');
    // A restarted process in the same container is a new incident.
    state.StartedAt = '2026-09-07T03:00:00Z'; state.ExitCode = 137; state.OOMKilled = true;
    writeInspect(); fs.writeFileSync(path.join(root, 'map.log'), 'x'.repeat(2 * 1024 * 1024) + '\nfinal fault marker\n');
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(files().length, 2);
    const latest = fs.readFileSync(path.join(reports, files().sort().at(-1)), 'utf8');
    assert.equal(JSON.parse(latest.split('\n')[0]).reason, 'oom-killed');
    assert.ok(latest.length < 1024 * 1024); assert.match(latest, /final fault marker/);
    state.StartedAt = '2026-09-07T04:00:00Z'; state.OOMKilled = false; state.ExitCode = 0; writeInspect();
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(files().length, 2);
    fs.writeFileSync(path.join(root, 'map.log'), '2026-09-07T01:00:00.000000000Z Received a crash signal\nold trace\n2026-09-07T04:00:01Z Finished\n');
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(files().length, 2);
    state.StartedAt = '2026-09-07T05:00:00Z'; state.ExitCode = 139; writeInspect();
    fs.writeFileSync(path.join(root, 'map.log'), 'RAGNAROK_CRASH_TRACE v1 signal=0xb\nRAGNAROK_CRASH_FRAME index=0x0 pc=0x42 main_offset=0x42 function=original_fault+0x1\nRAGNAROK_CRASH_TRACE_END partial\n');
    result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(files().length, 3);
    const traced = fs.readFileSync(path.join(reports, files().sort().at(-1)), 'utf8');
    assert.equal(JSON.parse(traced.split('\n')[0]).backtraceAvailable, true);
    assert.match(traced, /may be partial/);
    assert.doesNotMatch(traced, /No native fault stack was captured/);
    assert.equal(fs.existsSync(path.join(root, 'never-started')), false);
    assert.ok(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').every(x => /^(inspect|logs) /.test(x)));
  });
