const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installDesktopEntry, entryText } = require('../electron/linux-desktop-entry');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-desktop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const appDir = path.join(home, 'mount');
  for (const size of ['512x512', '1024x1024']) {
    const dir = path.join(appDir, 'usr/share/icons/hicolor', size, 'apps');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ragnarokoffline.png'), `icon ${size}`);
  }
  const appImage = path.join(home, 'Downloads', 'Ragnarok Offline-1.2.0-x64.AppImage');
  fs.mkdirSync(path.dirname(appImage), { recursive: true });
  fs.writeFileSync(appImage, 'not really an appimage');
  const env = { APPIMAGE: appImage, APPDIR: appDir, XDG_DATA_HOME: path.join(home, '.local/share') };
  const file = path.join(env.XDG_DATA_HOME, 'applications/ragnarokoffline.desktop');
  return { home, env, appImage, appDir, file };
}

// The entry is only ever written on Linux, so the text is asserted against a
// Linux path literal rather than whatever the host's path separator is. The
// behaviour around it -- idempotence, following a move, leaving other people's
// files alone -- is not platform-specific and is exercised everywhere.
test('the entry points back at the AppImage, quoted so a space cannot split it', () => {
  const text = entryText('/home/player/My Games/Ragnarok Offline-1.2.0-x64.AppImage');
  assert.match(text, /^Exec="\/home\/player\/My Games\/Ragnarok Offline-1\.2\.0-x64\.AppImage" --no-sandbox %U$/m);
  assert.match(text, /^TryExec=\/home\/player\/My Games\/Ragnarok Offline-1\.2\.0-x64\.AppImage$/m);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^Categories=Game;$/m);
  assert.match(text, /^Icon=ragnarokoffline$/m);
});

test('an AppImage run writes a launcher entry pointing back at itself', t => {
  const s = sandbox(t);
  const result = installDesktopEntry({ env: s.env, home: s.home, platform: 'linux' });
  assert.equal(result.installed, true);
  assert.equal(result.updated, false);
  assert.equal(fs.readFileSync(s.file, 'utf8'), entryText(s.appImage));
  // Both icon sizes, at the path a hicolor theme looks in.
  for (const size of ['512x512', '1024x1024']) {
    const icon = path.join(s.env.XDG_DATA_HOME, 'icons/hicolor', size, 'apps/ragnarokoffline.png');
    assert.equal(fs.readFileSync(icon, 'utf8'), `icon ${size}`);
  }
});

test('a second launch changes nothing, and a moved AppImage is followed', t => {
  const s = sandbox(t);
  installDesktopEntry({ env: s.env, home: s.home, platform: 'linux' });
  const before = fs.statSync(s.file).mtimeMs;
  const again = installDesktopEntry({ env: s.env, home: s.home, platform: 'linux' });
  assert.equal(again.installed, false);
  assert.equal(again.reason, 'already current');
  assert.equal(fs.statSync(s.file).mtimeMs, before);

  const moved = path.join(s.home, 'Applications', 'RO.AppImage');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(s.appImage, moved);
  const after = installDesktopEntry({ env: { ...s.env, APPIMAGE: moved }, home: s.home, platform: 'linux' });
  assert.equal(after.installed, true);
  assert.equal(after.updated, true);
  assert.equal(fs.readFileSync(s.file, 'utf8'), entryText(moved));
});

test('nothing is written when it is not our AppImage to write about', t => {
  const s = sandbox(t);
  // Running from source, from a distribution package, or from an extracted
  // directory: no APPIMAGE, so nothing claims a launcher entry.
  assert.equal(installDesktopEntry({ env: { XDG_DATA_HOME: s.env.XDG_DATA_HOME }, home: s.home, platform: 'linux' }).installed, false);
  assert.equal(installDesktopEntry({ env: s.env, home: s.home, platform: 'darwin' }).installed, false);
  assert.equal(installDesktopEntry({ env: s.env, home: s.home, platform: 'win32' }).installed, false);
  assert.equal(
    installDesktopEntry({ env: { ...s.env, RAGNAROK_OFFLINE_NO_DESKTOP_ENTRY: '1' }, home: s.home, platform: 'linux' }).reason,
    'disabled by environment');
  assert.equal(fs.existsSync(s.file), false);
});

test("an entry this app did not write is left alone", t => {
  const s = sandbox(t);
  fs.mkdirSync(path.dirname(s.file), { recursive: true });
  // AppImageLauncher, a distribution package, or a person with opinions.
  fs.writeFileSync(s.file, '[Desktop Entry]\nExec=/opt/ragnarok/ragnarokoffline\n');
  const result = installDesktopEntry({ env: s.env, home: s.home, platform: 'linux' });
  assert.equal(result.installed, false);
  assert.equal(result.reason, 'an entry already exists');
  assert.match(fs.readFileSync(s.file, 'utf8'), /^Exec=\/opt\/ragnarok\/ragnarokoffline$/m);
});

test('an unwritable home is reported, not thrown', {
  // Windows does not honour a mode, and root ignores one.
  skip: (process.platform === 'win32' && 'no POSIX mode') || (process.getuid?.() === 0 && 'root ignores the mode'),
}, t => {
  const s = sandbox(t);
  const blocked = path.join(s.home, 'blocked');
  fs.mkdirSync(blocked);
  fs.chmodSync(blocked, 0o500);
  // Before the sandbox's own cleanup, which would otherwise not be able to
  // remove what is inside it.
  t.after(() => { try { fs.chmodSync(blocked, 0o700); } catch { /* already gone */ } });
  const result = installDesktopEntry({
    env: { ...s.env, XDG_DATA_HOME: path.join(blocked, 'share') }, home: s.home, platform: 'linux',
  });
  assert.equal(result.installed, false);
  assert.ok(result.reason);
});
