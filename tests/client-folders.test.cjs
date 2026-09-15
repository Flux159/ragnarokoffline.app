const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clientFolders } = require('../electron/client-folders');

// A client folder with these entries: a trailing slash is a directory.
function client(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-folders-'));
  for (const entry of entries) {
    const p = path.join(root, entry);
    if (entry.endsWith('/')) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    }
  }
  return root;
}

test('System and AI are found beside data.grf, where link-assets takes them from', () => {
  const root = client(['data.grf', 'System/', 'AI/USER_AI/']);
  assert.deepEqual(clientFolders(path.join(root, 'data.grf')), {
    system_dir: path.join(root, 'System'),
    ai_dir: path.join(root, 'AI'),
  });
});

test('a repack that nests everything under dll_exe is found one level down', () => {
  const root = client(['dll_exe/data.grf', 'dll_exe/System/', 'dll_exe/AI/']);
  // Either way the player might have picked it: the GRF inside dll_exe, or one
  // beside a dll_exe that holds the folders.
  assert.deepEqual(clientFolders(path.join(root, 'dll_exe', 'data.grf')), {
    system_dir: path.join(root, 'dll_exe', 'System'),
    ai_dir: path.join(root, 'dll_exe', 'AI'),
  });
  const beside = client(['data.grf', 'dll_exe/AI/']);
  assert.equal(clientFolders(path.join(beside, 'data.grf')).ai_dir, path.join(beside, 'dll_exe', 'AI'));
});

test('the folder beside data.grf wins over the one in dll_exe', () => {
  const root = client(['data.grf', 'AI/', 'dll_exe/AI/']);
  assert.equal(clientFolders(path.join(root, 'data.grf')).ai_dir, path.join(root, 'AI'));
});

test('a missing folder, or a file with that name, reads as not found', () => {
  const root = client(['data.grf', 'AI']);
  assert.deepEqual(clientFolders(path.join(root, 'data.grf')), { system_dir: '', ai_dir: '' });
});

test('with no data.grf chosen there is nowhere to look', () => {
  assert.deepEqual(clientFolders(''), { system_dir: '', ai_dir: '' });
  assert.deepEqual(clientFolders(undefined), { system_dir: '', ai_dir: '' });
});
