'use strict';
// Mods a registry entry points at rather than carries.
//
// Most registry entries are the mod: a folder in this repository, reviewed
// file by file, every byte checked against a digest on the way in
// (mod-registry.js). A *source* entry is instead a reviewed pointer to the
// author's own GitHub repository, for mods that change faster than a pull
// request here could keep up with. The registry vouches for the repository,
// not for each release, and everything below is built around saying so:
//
//   - nothing is fetched until the player asks to install or update, and
//     nothing is installed until they have seen the repository, the release
//     tag and what kind of code it carries, and said yes;
//   - only the latest published release is ever offered -- never a draft or
//     a pre-release -- and only from the repository the entry names, so an
//     entry that is taken out of the registry stops offering updates;
//   - the release goes through the same unpacking and checks as a zip the
//     player picked themselves (mod-zip.js), then the supervisor's own
//     manifest reader, and replaces the old copy in one rename -- so a failed
//     or refused update leaves the working version exactly where it was.
//
// Node built-ins only, like the rest of the shell: the app ships signed, and a
// GET with redirects is not worth a dependency tree to audit.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const modZip = require('./mod-zip');

const GITHUB_API = 'https://api.github.com';
// A release's JSON is a few kilobytes; a release zip for a mod is well under a
// megabyte today. The caps are generous and still far below a filled disk.
const RELEASE_LIMIT = 2 * 1024 * 1024;
const ASSET_LIMIT = 50 * 1024 * 1024;
const UNPACKED_LIMIT = 96 * 1024 * 1024;
const MAX_FILES = 2000;
// Long enough that opening the Mods tab twice does not spend two of the sixty
// lookups an hour GitHub allows without signing in; short enough that a
// release published a few minutes ago shows up when somebody goes looking.
const CACHE_MS = 5 * 60 * 1000;
// What was installed and from where, beside the mod's files. Inside the
// folder on purpose: it goes wherever the folder goes, including to the trash
// on Remove, so it can never describe a copy that is no longer there. The
// supervisor skips dot-files at the top of a mod.
const RECORD = '.source.json';

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const ASSET = /^[A-Za-z0-9._*?-]{1,100}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
// Where a GitHub download goes: the API, the release page, and the storage
// hosts its redirects end at. Anything else is not where a release lives.
const GITHUB_HOST = /^(?:api\.github\.com|github\.com|codeload\.github\.com|[a-z0-9-]+\.githubusercontent\.com)$/;

const onlyGitHub = url => url.protocol === 'https:' && GITHUB_HOST.test(url.hostname);

/** A registry entry's `source`, checked; null when it is not one this build understands. */
function readSource(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	if (typeof value.github !== 'string' || !REPO.test(value.github)) return null;
	if (value.asset !== undefined && (typeof value.asset !== 'string' || !ASSET.test(value.asset) || !/\.zip$/i.test(value.asset))) return null;
	return value.asset ? { github: value.github, asset: value.asset } : { github: value.github };
}

/** `standart-npc-*.zip` as a whole-name match: `*` is any run, `?` one character. */
function globToRegExp(glob) {
	const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
	return new RegExp(`^${body}$`, 'i');
}

class RateLimited extends Error {}

/**
 * One GET, following up to five redirects, every hop checked by `allow`.
 * Resolves with the status, headers and (capped) body whatever the status is,
 * so the caller can tell a rate limit from a missing release.
 */
function get(target, { limit, headers = {}, allow = onlyGitHub, redirects = 5, timeout = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		let url;
		try { url = new URL(target); } catch { reject(new Error(`${target} is not a URL`)); return; }
		if (!allow(url)) { reject(new Error(`Refusing to download from ${url.host}: a release has to come from GitHub over HTTPS.`)); return; }
		const client = url.protocol === 'http:' ? http : https;
		const request = client.get(url, { headers, timeout }, response => {
			const status = response.statusCode;
			if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
				response.resume();
				if (redirects <= 0) { reject(new Error(`${url.host} redirected too many times`)); return; }
				const next = new URL(response.headers.location, url).toString();
				// The API's headers mean nothing to the storage host, and
				// nothing here sends a credential to carry over.
				get(next, { limit, headers: { 'User-Agent': headers['User-Agent'] || 'RagnarokOffline' }, allow, redirects: redirects - 1, timeout })
					.then(resolve, reject);
				return;
			}
			// An error page is read for its message, not stored.
			const cap = status === 200 ? limit : 64 * 1024;
			const declared = Number(response.headers['content-length']);
			if (status === 200 && Number.isFinite(declared) && declared > cap) {
				response.resume();
				request.destroy();
				reject(new Error(`${url.pathname.split('/').pop()} is larger than ${Math.round(cap / 1048576)} MB`));
				return;
			}
			const chunks = [];
			let size = 0;
			response.on('data', chunk => {
				size += chunk.length;
				if (size > cap) {
					request.destroy();
					reject(new Error(`${url.pathname.split('/').pop()} is larger than ${Math.round(cap / 1048576)} MB`));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }));
			response.on('error', reject);
		});
		request.on('timeout', () => { request.destroy(); reject(new Error(`${url.host} did not answer in time`)); });
		request.on('error', reject);
	});
}

function rateLimitError(response) {
	const reset = Number(response.headers['x-ratelimit-reset']);
	const retry = Number(response.headers['retry-after']);
	const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000)
		: Number.isFinite(retry) && retry > 0 ? new Date(Date.now() + retry * 1000) : null;
	const at = when ? ` after ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' in a while';
	return new RateLimited('GitHub is limiting release lookups from this network '
		+ `(it allows 60 an hour without signing in). Nothing was changed; try again${at}.`);
}

const limited = response => response.status === 429
	|| (response.status === 403 && (response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after']));

function headersFor(userAgent) {
	return { 'User-Agent': userAgent || 'RagnarokOffline', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

/**
 * The latest published release of `repo`: GitHub's own `releases/latest`,
 * which already leaves out drafts and pre-releases -- checked again here
 * rather than trusted, because that is the one promise this rests on.
 */
async function latestRelease(repo, { api = GITHUB_API, allow, cache, fresh = false, now = Date.now, userAgent } = {}) {
	if (!REPO.test(repo)) throw new Error(`${repo} is not a GitHub repository name`);
	const key = repo.toLowerCase();
	const cached = cache && cache.get(key);
	if (cached && !fresh && now() - cached.at < CACHE_MS) return cached.release;

	const response = await get(`${api}/repos/${repo}/releases/latest`, { limit: RELEASE_LIMIT, headers: headersFor(userAgent), allow });
	if (limited(response)) throw rateLimitError(response);
	if (response.status === 404) throw new Error(`${repo} has no published release yet (drafts and pre-releases are not offered).`);
	if (response.status !== 200) throw new Error(`GitHub answered HTTP ${response.status} when asked for ${repo}'s latest release.`);
	let value;
	try { value = JSON.parse(response.body.toString('utf8')); } catch { throw new Error(`GitHub's answer about ${repo} was not JSON.`); }
	if (!value || typeof value !== 'object') throw new Error(`GitHub's answer about ${repo} was not a release.`);
	if (value.draft || value.prerelease) throw new Error(`${repo}'s latest release is a draft or pre-release, which is not offered.`);
	if (typeof value.tag_name !== 'string' || !TAG.test(value.tag_name)) throw new Error(`${repo}'s latest release has no usable tag.`);
	const secure = text => typeof text === 'string' && /^https:\/\//.test(text) ? text : '';
	const release = {
		repo,
		tag: value.tag_name,
		name: typeof value.name === 'string' ? value.name.slice(0, 200) : '',
		notes: typeof value.body === 'string' ? value.body.slice(0, 4000) : '',
		url: secure(value.html_url) || `https://github.com/${repo}/releases/tag/${encodeURIComponent(value.tag_name)}`,
		publishedAt: typeof value.published_at === 'string' ? value.published_at : '',
		assets: (Array.isArray(value.assets) ? value.assets : [])
			.filter(a => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string')
			.map(a => ({ name: a.name.slice(0, 200), size: Number(a.size) || 0, url: a.browser_download_url })),
		zipball: typeof value.zipball_url === 'string' ? value.zipball_url : '',
	};
	if (cache) cache.set(key, { at: now(), release });
	return release;
}

/**
 * Which file of a release is the mod: the first asset matching the entry's
 * pattern, else GitHub's zip of the tagged source. The second is what a repo
 * that keeps the mod at its root gets for free, and it is labelled as such.
 */
function pickAsset(release, pattern) {
	if (pattern) {
		const match = globToRegExp(pattern);
		const asset = release.assets.find(a => match.test(a.name));
		if (asset) return { kind: 'asset', name: asset.name, size: asset.size, url: asset.url };
	}
	if (!release.zipball) throw new Error(`${release.repo} ${release.tag} has no file to install.`);
	return { kind: 'zipball', name: `${release.repo.split('/')[1]}-${release.tag}.zip (source code)`, size: 0, url: release.zipball };
}

/** The release file itself, capped, with GitHub's redirects followed. */
async function download(asset, { allow, userAgent } = {}) {
	if (asset.size > ASSET_LIMIT) throw new Error(`${asset.name} is larger than ${ASSET_LIMIT / 1048576} MB, which is more than a mod should be.`);
	const response = await get(asset.url, { limit: ASSET_LIMIT, allow,
		headers: { 'User-Agent': userAgent || 'RagnarokOffline', Accept: 'application/octet-stream' } });
	if (limited(response)) throw rateLimitError(response);
	if (response.status !== 200) throw new Error(`Downloading ${asset.name} failed: HTTP ${response.status}.`);
	return response.body;
}

/** Dotted numbers compared piece by piece, as the supervisor does (mods.rs). */
function compareVersions(a, b) {
	const parts = s => String(s).split(/[-+]/)[0].split('.').map(p => Number.parseInt(p.trim(), 10) || 0);
	const x = parts(a), y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] || 0) - (y[i] || 0);
		if (d) return Math.sign(d);
	}
	return 0;
}

/** Null when `have` satisfies `requires.app`, else what is needed -- the supervisor's rule. */
function appRequirement(rule, have) {
	if (typeof rule !== 'string' || !rule.trim() || !have) return null;
	const trimmed = rule.trim();
	const [, op = '>=', want = ''] = /^(>=|==|>|=)?\s*(.*)$/.exec(trimmed);
	const operator = op === '==' ? '=' : op;
	if (!/^\d/.test(want)) return `its mod.json says "requires": {"app": "${trimmed}"}, which is not a version rule`;
	const cmp = compareVersions(have, want);
	const ok = operator === '>=' ? cmp >= 0 : operator === '>' ? cmp > 0 : cmp === 0;
	return ok ? null : `needs app ${operator}${want}, and this is ${have}`;
}

/** Whether `latest` is a newer tag than `installed`: numerically when both are versions. */
function isNewer(latest, installed) {
	if (!installed) return true;
	const bare = tag => String(tag).replace(/^v/i, '');
	if (/^\d/.test(bare(latest)) && /^\d/.test(bare(installed))) return compareVersions(bare(latest), bare(installed)) > 0;
	return latest !== installed;
}

/** What kind of code a staged mod carries, for the confirmation. */
function contents(dir) {
	const has = relative => fs.existsSync(path.join(dir, relative));
	const commandFiles = ['groups.yml', 'atcommands.yml'];
	let commands = commandFiles.some(f => has(`conf/${f}`));
	try {
		for (const option of fs.readdirSync(path.join(dir, 'conf', 'when'))) {
			if (commandFiles.some(f => has(`conf/when/${option}/${f}`))) commands = true;
		}
	} catch { /* no conditional conf */ }
	return { serverScripts: has('npc'), clientCode: has('client'), commands, tables: has('db') };
}

/**
 * Unpack a downloaded release into a staging folder beside the mods.
 *
 * The staging folder starts with a dot, so the supervisor does not see it as
 * a mod, and nothing in it runs until `commit` renames it into place.
 * `validate` is the supervisor's manifest check; it runs here so an update
 * the supervisor would refuse never replaces a copy that loads.
 */
async function stage(name, bytes, { modsDir, appVersion, validate } = {}) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-release-'));
	let staging = null;
	try {
		const zip = path.join(scratch, 'release.zip');
		fs.writeFileSync(zip, bytes);
		const { dir, files } = modZip.unpack(zip, { maxBytes: UNPACKED_LIMIT, maxFiles: MAX_FILES, label: `the ${name} release` });
		try {
			// The mod.json at the top, or inside the one folder the zip holds
			// (a release asset, or GitHub's `owner-repo-sha/`). Either way it
			// is installed under the registry's name, which is its identity.
			let root;
			if (files.includes('mod.json')) root = dir;
			else {
				const top = modZip.singleTopLevel(files);
				if (top && files.includes(`${top}/mod.json`)) root = path.join(dir, top);
			}
			if (!root) throw new Error(`The ${name} release has no mod.json at its top or inside its one folder, so it is not a mod this app can install.`);
			let manifest;
			try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'mod.json'), 'utf8')); } catch (e) {
				throw new Error(`The ${name} release's mod.json is not valid JSON (${e.message}).`);
			}
			if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`The ${name} release's mod.json is not an object.`);
			const version = typeof manifest.version === 'string' ? manifest.version.slice(0, 40) : '';
			const needs = appRequirement(manifest.requires && manifest.requires.app, appVersion);
			if (needs) throw new Error(`${name}${version ? ' ' + version : ''} ${needs}. Update the app first; nothing was changed.`);

			fs.mkdirSync(modsDir, { recursive: true });
			staging = path.join(modsDir, `.${name}.${crypto.randomBytes(6).toString('hex')}.new`);
			modZip.copyTree(root, staging);
			// A release does not get to write its own provenance.
			fs.rmSync(path.join(staging, RECORD), { force: true });
			if (validate) {
				try { await validate(staging); } catch (e) {
					throw new Error(`${name}${version ? ' ' + version : ''} would not load: ${String((e && e.message) || e).trim()}. Nothing was changed.`);
				}
			}
			return { name, staging, manifest, version, contents: contents(staging) };
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} catch (e) {
		if (staging) fs.rmSync(staging, { recursive: true, force: true });
		throw e;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function discard(staged) {
	if (staged && staged.staging) fs.rmSync(staged.staging, { recursive: true, force: true });
}

/**
 * Put a staged release in place of the installed copy, keeping the old one
 * until the new one is there. Settings and the on/off choice live in the
 * state directory (mod-settings.json, mods/disabled.txt), not in the folder, so
 * they carry over untouched.
 */
function commit(staged, { modsDir, record }) {
	fs.writeFileSync(path.join(staged.staging, RECORD), JSON.stringify(record, null, 2) + '\n');
	const destination = path.join(modsDir, staged.name);
	let old = null;
	if (fs.existsSync(destination)) {
		old = path.join(modsDir, `.${staged.name}.${crypto.randomBytes(6).toString('hex')}.old`);
		fs.renameSync(destination, old);
	}
	try {
		fs.renameSync(staged.staging, destination);
	} catch (e) {
		if (old) fs.renameSync(old, destination);
		throw new Error(`${staged.name} could not be put in place (${e.message}); the installed copy was left as it was.`);
	}
	if (old) fs.rmSync(old, { recursive: true, force: true });
	return destination;
}

/** What `commit` recorded about an installed mod, or null for any other mod. */
function readRecord(modDir) {
	let value;
	try { value = JSON.parse(fs.readFileSync(path.join(modDir, RECORD), 'utf8')); } catch { return null; }
	if (!value || typeof value !== 'object' || typeof value.repo !== 'string' || !REPO.test(value.repo)) return null;
	if (typeof value.tag !== 'string' || !TAG.test(value.tag)) return null;
	const text = field => typeof value[field] === 'string' ? value[field].slice(0, 200) : '';
	return { repo: value.repo, tag: value.tag, asset: text('asset'), sha256: text('sha256'),
		installedAt: text('installedAt'), version: text('version'), releaseUrl: text('releaseUrl') };
}

/**
 * Whether each source-installed mod has a newer release. Only mods whose
 * repository is still the one the registry lists are looked up: taking an
 * entry out of the registry is how a repository stops being vouched for.
 */
async function checkUpdates(installed, listing, options = {}) {
	const out = [];
	for (const mod of installed) {
		const record = readRecord(mod.dir);
		if (!record) continue;
		const entry = listing.find(m => m.name === mod.name);
		const base = { name: mod.name, repo: record.repo, installed: record.tag };
		if (!entry || !entry.source || entry.source.github.toLowerCase() !== record.repo.toLowerCase()) {
			out.push({ ...base, listed: false });
			continue;
		}
		try {
			const release = await latestRelease(record.repo, options);
			out.push({ ...base, listed: true, latest: release.tag, update: isNewer(release.tag, record.tag),
				url: release.url, notes: release.notes.slice(0, 1200), publishedAt: release.publishedAt });
		} catch (e) {
			out.push({ ...base, listed: true, error: e.message });
			// One rate limit answers for all of them.
			if (e instanceof RateLimited) break;
		}
	}
	return out;
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

module.exports = {
	readSource, globToRegExp, get, latestRelease, pickAsset, download, stage, commit, discard,
	readRecord, checkUpdates, appRequirement, compareVersions, isNewer, contents, sha256,
	RateLimited, GITHUB_API, ASSET_LIMIT, UNPACKED_LIMIT, MAX_FILES, CACHE_MS, RECORD, onlyGitHub,
};
