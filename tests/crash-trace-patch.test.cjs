'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('server trace hook is idempotent, precedes legacy macros and fails on changed anchors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-trace-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const common = path.join(root, 'src/common'); fs.mkdirSync(common, { recursive: true });
  const core = path.join(common, 'core.cpp');
  const original = '#include "core.hpp"\nvoid signals_init() {\n\tcompat_signal(SIGFPE, sig_proc);\n}\n';
  fs.writeFileSync(core, original);
  const run = () => spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [path.join(__dirname, '../scripts/apply-crash-trace.py'), root], { encoding: 'utf8' });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const once = fs.readFileSync(core, 'utf8');
  assert.ok(once.indexOf('ragnarok_crash_trace.hpp') < once.indexOf('core.hpp'));
  assert.match(once, /ragnarok_crash_trace::install\(sig_proc\)/);
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(core, 'utf8'), once);
  assert.equal(fs.readFileSync(path.join(common, 'ragnarok_crash_trace.hpp'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../third-party/crash-trace/ragnarok_crash_trace.hpp'), 'utf8'));
  assert.ok(fs.statSync(path.join(root, 'ragnarok-crash-tests/libunwind-COPYING')).size > 100);
  fs.writeFileSync(core, original.replace('SIGFPE', 'SIGBUS'));
  result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /signal anchor changed/);
  assert.equal(fs.readFileSync(core, 'utf8'), original.replace('SIGFPE', 'SIGBUS'));
});
