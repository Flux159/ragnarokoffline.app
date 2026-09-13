'use strict';
// Giving a Linux install an icon.
//
// macOS puts the app in Applications and the Windows installer writes a Start
// Menu entry, so on both there is something to click the second time. An
// AppImage is a single file that nothing installs: it is downloaded, made
// executable, and run. The desktop never hears about it, so it appears in no
// launcher and no search, and a player who forgets which folder they saved it
// in has genuinely lost it.
//
// Nothing in the AppImage can fix that from the outside, but the app itself
// runs as the user and knows where it was started from. So the first run
// writes a launcher entry pointing back at that path, and copies the icon out
// of the mount before it disappears. This is what AppImageLauncher would do,
// for the many systems that do not have it -- SteamOS among them.
//
// Deliberately not done: registering a MIME type, a Steam shortcut, or
// anything outside the two directories below. The entry is per-user, it is
// rewritten when the AppImage moves, and `TryExec` makes a stale one hide
// itself rather than sit in the menu launching nothing.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The same base name electron-builder gives the bundled copy, so a system that
// *does* integrate AppImages ends up with one entry rather than two.
const ENTRY = 'ragnarokoffline.desktop';
const ICON = 'ragnarokoffline';

function dataHome(env, home) {
  return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

// Desktop entry values are not shell: the only thing that needs escaping in an
// Exec line is the quoting, and a literal backslash or quote inside it.
// Reserved characters get a path quoted; everything else is left alone so the
// common case stays readable in a text editor.
function quote(value) {
  return `"${value.replace(/(["`$\\])/g, '\\$1')}"`;
}

function entryText(appImage) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Ragnarok Offline',
    'Comment=Ragnarok Online, offline, in one app',
    `Exec=${quote(appImage)} --no-sandbox %U`,
    `TryExec=${appImage}`,
    `Icon=${ICON}`,
    'Terminal=false',
    'Categories=Game;',
    // Matches what Electron reports as the window class, which is how a
    // desktop associates the open window with this entry.
    'StartupWMClass=Ragnarok Offline',
    // Ours, so a later version can recognise its own work and a person
    // reading the file can tell where it came from.
    'X-RagnarokOffline-Generated=true',
    '',
  ].join('\n');
}

// The icons ship in the AppImage under the usual hicolor tree. Copy whatever
// sizes are there into the user's own tree at the same relative path, rather
// than picking one size and guessing what a panel wants.
function copyIcons(appDir, target) {
  const source = path.join(appDir, 'usr', 'share', 'icons', 'hicolor');
  const copied = [];
  let sizes;
  try {
    sizes = fs.readdirSync(source);
  } catch {
    return copied;
  }
  for (const size of sizes) {
    const from = path.join(source, size, 'apps', `${ICON}.png`);
    if (!fs.existsSync(from)) continue;
    const to = path.join(target, 'icons', 'hicolor', size, 'apps', `${ICON}.png`);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Only when it would change: rewriting an icon every launch makes every
      // icon cache on the system redo its work for nothing.
      const next = fs.readFileSync(from);
      let current = null;
      try { current = fs.readFileSync(to); } catch { /* not there yet */ }
      if (!current || !current.equals(next)) fs.writeFileSync(to, next);
      copied.push(to);
    } catch { /* an icon is not worth failing a launch over */ }
  }
  return copied;
}

// Returns what it did, so the caller can log it and a test can assert it.
// Never throws: a launcher entry is a convenience, and a read-only or unusual
// home directory must not stop the app opening.
function installDesktopEntry({
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  if (platform !== 'linux') return { installed: false, reason: 'not linux' };
  // Set by the AppImage runtime, and by nothing else -- so this is also the
  // check for "was this an AppImage at all". A run from source, a distribution
  // package or an extracted directory writes nothing.
  const appImage = env.APPIMAGE;
  if (!appImage || !path.isAbsolute(appImage)) {
    return { installed: false, reason: 'not running from an AppImage' };
  }
  if (env.RAGNAROK_OFFLINE_NO_DESKTOP_ENTRY) {
    return { installed: false, reason: 'disabled by environment' };
  }
  const target = dataHome(env, home);
  const file = path.join(target, 'applications', ENTRY);
  const text = entryText(appImage);
  try {
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* first run */ }
    // Someone else's file, or one a person has edited by hand, is left alone.
    // The marker is only written by this function.
    if (current !== null && !current.includes('X-RagnarokOffline-Generated=true')) {
      return { installed: false, reason: 'an entry already exists', file };
    }
    if (current === text) {
      return { installed: false, reason: 'already current', file, icons: copyIcons(env.APPDIR || '', target) };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return {
      installed: true,
      updated: current !== null,
      file,
      icons: copyIcons(env.APPDIR || '', target),
    };
  } catch (error) {
    return { installed: false, reason: error.message, file };
  }
}

module.exports = { installDesktopEntry, entryText, ENTRY, ICON };
