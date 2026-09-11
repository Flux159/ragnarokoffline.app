'use strict';
// Finding and installing mods from a reviewed index.
//
// Every mod in the registry is a folder in a GitHub repository, and the way in
// is a pull request. That review is the trust boundary, and it has to be,
// because a mod is not data: it can ship `conf/groups.yml` deciding what
// commands players get, NPC scripts the server runs, and a roBrowser plugin
// that executes in the game page. Nothing here tries to make an unreviewed mod
// safe to install, because nothing could.
//
// What this side owns is narrower and still worth doing properly: the bytes
// that arrive are the bytes that were reviewed, they land where they are meant
// to, and a half-finished download is never left looking like a mod.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The app's own repository, so a mod submission is a pull request against the
// thing that installs it and the review that gates one is the review this
// project already runs. `RAGNAROK_MOD_INDEX` points it elsewhere for testing,
// or if the list ever outgrows living here.
const DEFAULT_INDEX = 'https://raw.githubusercontent.com/Flux159/ragnarokoffline.app/main/registry/index.json';
// An index is a few hundred small entries; a mod is a handful of files, of
// which a sprite sheet is the big one. Both caps are far above anything real
// and far below anything that could fill a disk.
const INDEX_LIMIT = 4 * 1024 * 1024;
const FILE_LIMIT = 16 * 1024 * 1024;
const TOTAL_LIMIT = 96 * 1024 * 1024;
const MAX_FILES = 600;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** One HTTPS GET, capped, with redirects refused rather than followed. */
function download(url, limit) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 20000 }, response => {
      // A redirect could move an install off the reviewed origin, and the
      // index has no reason to need one.
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          request.destroy();
          reject(new Error(`${url} is larger than ${limit} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => { request.destroy(); reject(new Error(`${url} timed out`)); });
    request.on('error', reject);
  });
}

/**
 * Where one of a mod's files lives, derived rather than taken from the index.
 *
 * The entry says which file it wants, never where to get it: a URL in the
 * index would let a reviewed entry point its bytes at an unreviewed host.
 */
function fileUrl(indexUrl, name, relative) {
  const base = new URL(indexUrl);
  const directory = base.pathname.replace(/[^/]*$/, '');
  const target = new URL(`${directory}mods/${name}/${relative}`, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(directory)) {
    throw new Error(`${name}: ${relative} does not resolve inside the registry`);
  }
  return target.toString();
}

/** A path a mod may contain: relative, no traversal, nothing platform-special. */
function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative.length || relative.length > 200) return null;
  if (relative.includes('\\') || relative.includes('\0')) return null;
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.'))) return null;
  if (parts.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) return null;
  if (path.isAbsolute(relative)) return null;
  return parts.join('/');
}

/** Check an index into the shape the rest of this file may rely on. */
function readIndex(body) {
  let value;
  try { value = JSON.parse(body); }
  catch { throw new Error('The mod list is not valid JSON'); }
  if (!value || typeof value !== 'object' || value.version !== 1 || !Array.isArray(value.mods)) {
    throw new Error('The mod list is not in a format this version understands');
  }
  const mods = [];
  for (const entry of value.mods) {
    if (!entry || typeof entry !== 'object') continue;
    if (!NAME.test(entry.name || '')) continue;
    if (!Array.isArray(entry.files) || !entry.files.length || entry.files.length > MAX_FILES) continue;
    const files = [];
    let ok = true;
    for (const file of entry.files) {
      const relative = safeRelative(file && file.path);
      if (!relative || !SHA256.test((file && file.sha256) || '')) { ok = false; break; }
      files.push({ path: relative, sha256: file.sha256.toLowerCase() });
    }
    // A mod whose own manifest is missing would install as an unnamed folder.
    if (!ok || !files.some(file => file.path === 'mod.json')) continue;
    const text = (field, limit) => typeof entry[field] === 'string' ? entry[field].slice(0, limit) : '';
    mods.push({ name: entry.name, version: text('version', 40), author: text('author', 80),
      description: text('description', 600), homepage: /^https:\/\//.test(entry.homepage || '') ? entry.homepage : '',
      files });
  }
  return mods;
}

/** The registry's own listing, ready for the settings window. */
async function list({ url = DEFAULT_INDEX, fetch = download } = {}) {
  const body = await fetch(url, INDEX_LIMIT);
  return readIndex(body.toString('utf8'));
}

/**
 * Install one mod from the registry into the mods directory.
 *
 * Everything is fetched and verified before anything is published, so a
 * failure halfway leaves no folder for the supervisor to find and half-apply.
 */
async function install(name, { url = DEFAULT_INDEX, fetch = download, modsDir, mods } = {}) {
  const listing = mods || await list({ url, fetch });
  const entry = listing.find(mod => mod.name === name);
  if (!entry) throw new Error(`${name} is not in the mod list`);

  const staged = [];
  let total = 0;
  for (const file of entry.files) {
    const bytes = await fetch(fileUrl(url, entry.name, file.path), FILE_LIMIT);
    const got = digest(bytes);
    if (got !== file.sha256) {
      throw new Error(`${entry.name}: ${file.path} does not match the reviewed copy`);
    }
    total += bytes.length;
    if (total > TOTAL_LIMIT) throw new Error(`${entry.name} is larger than ${TOTAL_LIMIT} bytes`);
    staged.push({ path: file.path, bytes });
  }

  // Written beside the destination and renamed into place, so an interrupted
  // install cannot leave a partial mod behind under the real name.
  const destination = path.join(modsDir, entry.name);
  const temporary = path.join(modsDir, `.${entry.name}.${crypto.randomBytes(6).toString('hex')}.new`);
  fs.mkdirSync(modsDir, { recursive: true });
  fs.rmSync(temporary, { recursive: true, force: true });
  try {
    for (const file of staged) {
      const target = path.join(temporary, file.path);
      if (!target.startsWith(temporary + path.sep)) throw new Error(`${entry.name}: ${file.path} escapes the mod folder`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return { name: entry.name, version: entry.version, files: staged.length, bytes: total };
}

module.exports = { list, install, readIndex, safeRelative, fileUrl, DEFAULT_INDEX };
