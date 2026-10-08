'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIMIT = 1024 * 1024;
const ERROR = 'Cannot read account creation policy. Repair settings.json before starting the server; registration was not enabled.';

function validate(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      (Object.hasOwn(settings, 'open_registration') && typeof settings.open_registration !== 'boolean')) {
    throw new Error(ERROR);
  }
  if (Object.hasOwn(settings, 'hosting_scope') && !['local', 'lan', 'friends', 'public'].includes(settings.hosting_scope)) {
    throw new Error('Invalid hosting scope. Choose local, lan, friends or public before starting.');
  }
  if (Object.hasOwn(settings, 'game_text') &&
      !['english', 'client_western', 'client_korean', 'client_taiwan'].includes(settings.game_text)) {
    throw new Error('Cannot read the game text setting. Choose English, or your client\'s own text, in Settings.');
  }
  // The format only: which versions exist is the supervisor's to say, from
  // config/PACKETVERS, and it refuses an unlisted one by name.
  if (Object.hasOwn(settings, 'packetver') && settings.packetver !== null &&
      !/^\d{8}$/.test(typeof settings.packetver === 'number' ? String(settings.packetver) : settings.packetver)) {
    throw new Error('Cannot read the client version setting. Choose one in Settings.');
  }
  // An IANA zone name (UTC, Europe/Berlin, Etc/GMT+5), or null for this
  // computer's: the same shape stack/src/timezone.rs accepts, since it ends up
  // on a docker command line.
  if (Object.hasOwn(settings, 'server_timezone') && settings.server_timezone !== null &&
      !(typeof settings.server_timezone === 'string' && settings.server_timezone.length <= 64 &&
        /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*){0,2}$/.test(settings.server_timezone))) {
    throw new Error('Cannot read the server clock setting. Choose a time zone in Settings.');
  }
  // Checked here as well as in the supervisor: the supervisor refuses to start
  // on a damaged value, and a refusal is a much worse way to learn about it
  // than a rejected Apply.
  if (Object.hasOwn(settings, 'instant_character_deletion') &&
      typeof settings.instant_character_deletion !== 'boolean') {
    throw new Error('Cannot read the character deletion setting. Repair settings.json before starting the server; the deletion delay was left in place.');
  }
  if (Object.hasOwn(settings, 'agent_count') &&
      !(Number.isInteger(settings.agent_count) && settings.agent_count >= 1 && settings.agent_count <= 4)) {
    throw new Error('Cannot read the AI agent setting. Choose how many agents again in Settings.');
  }
  // Settings -> Mods -> Favorites: mod folder names, at most a few hundred.
  if (Object.hasOwn(settings, 'mod_favorites') &&
      !(Array.isArray(settings.mod_favorites) && settings.mod_favorites.length <= 500 &&
        settings.mod_favorites.every(n => typeof n === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(n)))) {
    throw new Error('Cannot read the favourite mods. Star them again in Settings -> Mods.');
  }
  for (const key of ['agent_play', 'agent_window', 'map_editor_agent']) {
    if (Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean') {
      throw new Error('Cannot read the AI agent setting. Turn it off and on again in Settings.');
    }
  }
  return settings;
}

function read(file, defaults) {
  let body;
  try {
    if (fs.statSync(file).size > LIMIT) throw new Error(ERROR);
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ...defaults };
    throw new Error(ERROR);
  }
  let settings;
  try { settings = JSON.parse(body); }
  catch { throw new Error(ERROR); }
  return { ...defaults, ...validate(settings) };
}

function write(file, update, defaults) {
  validate(update);
  const settings = validate({ ...read(file, defaults), ...update });
  const body = JSON.stringify(settings, null, 2) + '\n';
  if (Buffer.byteLength(body) > LIMIT) throw new Error(ERROR);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return settings;
}

module.exports = { read, write };
