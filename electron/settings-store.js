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
  // Checked here as well as in the supervisor: the supervisor refuses to start
  // on a damaged value, and a refusal is a much worse way to learn about it
  // than a rejected Apply.
  if (Object.hasOwn(settings, 'instant_character_deletion') &&
      typeof settings.instant_character_deletion !== 'boolean') {
    throw new Error('Cannot read the character deletion setting. Repair settings.json before starting the server; the deletion delay was left in place.');
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
