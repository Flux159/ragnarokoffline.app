'use strict';
//
// The app shell. Ported from src-tauri/src/lib.rs, which was 859 lines of
// orchestration with no domain logic in it: spawn a process, read or write a
// JSON file, resolve a path. Everything underneath — stack.sh, the Rust asset
// server, the nebula binaries — is unchanged and still does the actual work.
//
// Electron rather than Tauri because Tauri uses the system webview, so we
// shipped WebKit on macOS and Linux and Chromium on Windows, and character
// sprites render doubled on WebKit (roBrowserLegacy #1350). One engine
// everywhere is worth ~60 MB of download.
//
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// Windows ships every payload binary with a .exe suffix, which the embed kit
// and our own build both produce correctly -- it was only ever this side that
// asked for the wrong name.
const EXE = process.platform === 'win32' ? '.exe' : '';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Not Electron's app.getPath(), which derives the folder from the app name and
// would drift if that changed. The name is also deliberately not the bundle id:
// a folder ending in `.app` is drawn by Finder as an application bundle and
// cannot be opened by double-click.
//
// macOS keeps the path it has always had, because shipped installs have their
// database and generated config there. Linux and Windows get their own
// conventional locations rather than inheriting the macOS one — this used to
// return the Library path on every platform, which created a literal
// `~/Library/Application Support` directory on Linux.
//
// Must stay in step with data_root() in stack/src/config.rs.
function dataRoot() {
	// Same override the supervisor honours (see data_root() in
	// stack/src/config.rs), so the two agree and a test run can be pointed at a
	// scratch directory instead of a real install.
	if (process.env.RAGNAROK_OFFLINE_HOME) return process.env.RAGNAROK_OFFLINE_HOME;
	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library/Application Support/Ragnarok Offline');
	}
	if (process.platform === 'win32') {
		return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
			'Ragnarok Offline');
	}
	return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
		'Ragnarok Offline');
}

// The supervisor binary that replaced stack.sh and link-assets.sh. One
// implementation for all three platforms; Windows has no POSIX shell, and a
// second PowerShell copy of the same logic would be two things that must agree
// forever and eventually would not.
function stackBin() {
	return path.join(projectRoot(), 'bin', process.platform === 'win32'
		? 'ragnarok-stack.exe' : 'ragnarok-stack');
}

function stateDir() {
	return process.env.RAGNAROKMAC_STATE || path.join(dataRoot(), 'state');
}

function clientConfigPath() {
	fs.mkdirSync(dataRoot(), { recursive: true });
	return path.join(dataRoot(), 'client.json');
}

// The payload ships read-only inside the .app; it is materialised into
// Application Support so the scripts have somewhere writable and so an app
// update can replace the tree wholesale without touching state/.
function projectRoot() {
	if (process.env.RAGNAROKMAC_ROOT) {
		return process.env.RAGNAROKMAC_ROOT;
	}
	const bundled = app.isPackaged
		? path.join(process.resourcesPath, 'payload')
		: path.join(__dirname, '..', 'payload');
	const installed = path.join(dataRoot(), 'runtime');

	const marker = process.platform === 'win32' ? 'bin/ragnarok-stack.exe' : 'bin/ragnarok-stack';
	if (fs.existsSync(path.join(bundled, marker))) {
		const want = readIfExists(path.join(bundled, 'VERSION'));
		const have = readIfExists(path.join(installed, 'VERSION'));
		if (want !== have || !fs.existsSync(path.join(installed, marker))) {
			fs.mkdirSync(path.dirname(installed), { recursive: true });
			// Stop the engine before replacing the tree it runs from.
			//
			// nebulad deliberately outlives the app -- quitting removes the
			// containers but leaves the engine up so the next start is quick --
			// and it runs from runtime/bin. Unix lets you unlink a running
			// executable; Windows locks it, so an update failed with "EBUSY:
			// resource busy or locked, rmdir ...\runtime" before the app could
			// do anything about it. They also accumulate: two were holding the
			// directory, from two earlier versions.
			stopEngineIn(installed);
			rmWithRetries(installed);
			// -c asks APFS for copy-on-write clones: the payload is ~150 MB and
			// this runs on every version change. There is no equivalent
			// elsewhere, so the other platforms use a plain recursive copy.
			//
			// Checked on .status, not on the returned object: `r !== 0` is true
			// for every spawnSync result, so the fallback copy used to run on
			// every update regardless of whether the clone had succeeded --
			// copying the payload twice.
			let cloned = false;
			if (process.platform === 'darwin') {
				const r = spawnSync('/bin/cp', ['-Rc', bundled, installed]);
				cloned = r.status === 0;
			}
			if (!cloned) {
				fs.cpSync(bundled, installed, { recursive: true, verbatimSymlinks: true });
			}
			unpackTranslationData(installed);
		}
		return installed;
	}
	return fs.existsSync(installed) ? installed : bundled;
}

// The English translation's texture tree ships as a tar and is unpacked here.
//
// 21 of its names are CP949 bytes read as Latin-1, and macOS filesystems
// normalise them differently -- so as loose files in the bundle they change
// byte sequence when the app is copied out of the .dmg, which breaks the code
// signature's seal and gets the app refused as "damaged". Inside the archive
// the bytes are opaque, and what lands here is never code-signed.
//
// System tar, because every platform we ship to has one: macOS and Linux
// always, and Windows since 1803 ships bsdtar as tar.exe.
function unpackTranslationData(root) {
	const dir = path.join(root, 'vendor/ROenglishRE/Translation/Renewal');
	const archive = path.join(dir, 'data.tar');
	if (!fs.existsSync(archive)) return; // older payload, already a directory
	try {
		const r = spawnSync('tar', ['-xf', archive, '-C', dir], { stdio: 'ignore' });
		if (r.status !== 0) throw new Error(`tar exited ${r.status}`);
		fs.rmSync(archive, { force: true });
	} catch (e) {
		// Not fatal: the game runs, the English interface textures do not
		// appear. Say so rather than failing the whole launch.
		console.error(`could not unpack the translation textures: ${e.message}`);
	}
}

// Ask an installed runtime's own engine to shut down, so its files can be
// replaced. Best-effort: an absent or already-stopped engine is the normal
// case, and a failure here is reported by the removal that follows.
function stopEngineIn(runtime) {
	const nebula = path.join(runtime, 'bin', `nebula${EXE}`);
	if (!fs.existsSync(nebula)) return;
	try {
		spawnSync(nebula, ['down'], {
			env: { ...process.env, NEBULA_HOME: path.join(dataRoot(), 'nebula') },
			stdio: 'ignore',
			timeout: 30000,
		});
	} catch {
		/* nothing was running */
	}
}

// Windows releases a lock a moment after the holder exits rather than
// instantly, so a single attempt can fail on a directory that is about to be
// free. Fails loudly if it never is -- silently continuing would leave a
// half-replaced runtime, which is worse than not starting.
function rmWithRetries(dir) {
	for (let i = 0; i < 10; i++) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (e) {
			if (i === 9) {
				throw new Error(
					`could not replace ${dir}: ${e.message}\n\n` +
					'Something is still using it. Quit the app, end any nebulad ' +
					'processes, and start it again.'
				);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
		}
	}
}

function readIfExists(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch {
		return '';
	}
}

function spawnSync(cmd, args) {
	const { spawnSync: ss } = require('child_process');
	const r = ss(cmd, args, { stdio: 'ignore' });
	return r.status === 0 ? 0 : 1;
}

// A GUI app launched from Finder inherits launchd's minimal PATH, so nothing
// installed by Homebrew or Rancher Desktop is visible to anything we spawn.
function toolPath() {
	return [
		path.join(os.homedir(), '.rd/bin'),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/opt/podman/bin',
		process.env.PATH || '',
	].join(':');
}

function findTool(name) {
	// Both spellings, and path.delimiter rather than ':' -- PATH is
	// semicolon-separated on Windows, so the fallback loop searched one
	// enormous nonexistent directory.
	for (const n of [`${name}${EXE}`, name]) {
		const bundled = path.join(projectRoot(), 'bin', n);
		if (fs.existsSync(bundled)) return bundled;
	}
	for (const dir of toolPath().split(path.delimiter)) {
		if (!dir) continue;
		for (const n of [`${name}${EXE}`, name]) {
			const p = path.join(dir, n);
			if (fs.existsSync(p)) return p;
		}
	}
	return null;
}

// Data written under the old identifier-named folder moves once. Skipped when
// the new location exists, so it cannot clobber a live install. The engine is
// stopped first: `nebula up` registers a launchd label derived from
// NEBULA_HOME, and moving the directory under a running instance leaves it
// writing to a path that is gone.
function migrateDataRoot() {
	const dest = dataRoot();
	// Not "does the directory exist": anything that creates it -- a stray run
	// of the supervisor with NEBULA_HOME pointed here, a half-finished copy --
	// disables this one-shot migration permanently, and the owner silently
	// starts over with an empty database while their characters sit in the old
	// home. What marks a *real* install is a client.json, so that is the test.
	if (fs.existsSync(path.join(dest, 'client.json'))) return;
	// Two previous homes, oldest last: com.ragnarokmac.app was the Tauri bundle
	// id, RagnarokMac was the readable folder that replaced it, and this is the
	// rename to the product's real name. An install can be sitting on either, so
	// take the first that exists rather than assuming a single hop.
	const support = path.join(os.homedir(), 'Library/Application Support');
	// Likewise, an old home only counts if it holds a configured install.
	const old = [path.join(support, 'RagnarokMac'), path.join(support, 'com.ragnarokmac.app')]
		.find(p => fs.existsSync(path.join(p, 'client.json')));
	if (!old) return;

	const oldNebula = path.join(old, 'nebula');
	if (fs.existsSync(oldNebula)) {
		const nebula = path.join(old, 'runtime/bin/nebula');
		if (fs.existsSync(nebula)) {
			try {
				require('child_process').execFileSync(nebula, ['down'], {
					env: { ...process.env, NEBULA_HOME: oldNebula },
					stdio: 'ignore',
					timeout: 30000,
				});
			} catch {
				/* the engine may already be down */
			}
		}
	}
	// rename() onto an existing non-empty directory fails, so anything already
	// sitting at the destination is moved aside rather than merged or removed.
	// It is never deleted: whatever it is, it is not ours to throw away, and
	// the one thing worse than a failed migration is a successful one that
	// took someone's data with it.
	try {
		if (fs.existsSync(dest)) {
			const parked = `${dest}.orphaned-${Date.now()}`;
			fs.renameSync(dest, parked);
			console.log(`moved an unconfigured ${dest} aside -> ${parked}`);
		}
		fs.renameSync(old, dest);
		console.log(`moved ${old} -> ${dest}`);
	} catch (e) {
		console.error(`could not move ${old}: ${e}`);
	}
}

// ---------------------------------------------------------------------------
// The stack supervisor
// ---------------------------------------------------------------------------

function runStack(args) {
	return new Promise((resolve, reject) => {
		const root = projectRoot();
		execFile(
			stackBin(),
			args,
			{
				cwd: root,
				env: {
					...process.env,
					PATH: toolPath(),
					NEBULA_BIN: path.join(root, 'bin/nebula'),
					RAGNAROKMAC_DOCKER: path.join(root, 'bin/docker-slim'),
					RAGNAROKMAC_STATE: stateDir(),
				},
				maxBuffer: 8 * 1024 * 1024,
				timeout: 15 * 60 * 1000,
			},
			(err, stdout, stderr) => {
				if (err) return reject(new Error(`${stdout || ''}${stderr || ''}` || String(err)));
				resolve(stdout);
			}
		);
	});
}

// ---------------------------------------------------------------------------
// Asset server
// ---------------------------------------------------------------------------

let assetsChild = null;

function assetsReady() {
	return new Promise(resolve => {
		const req = require('http').get(
			{ host: '127.0.0.1', port: 3338, path: '/api/health', timeout: 2000 },
			res => {
				res.resume();
				resolve(res.statusCode === 200);
			}
		);
		req.on('error', () => resolve(false));
		req.on('timeout', () => {
			req.destroy();
			resolve(false);
		});
	});
}

async function assetsStart() {
	if (await assetsReady()) return;
	const root = projectRoot();
	const server = findTool('robrowser-remoteclient');
	if (!server) throw new Error('the asset server binary is missing from this build');

	const logPath = path.join(stateDir(), 'assets.log');
	fs.mkdirSync(stateDir(), { recursive: true });
	// Truncated on start, appended to by both streams: this log is where a
	// failed asset request or a rejected proxy target shows up.
	const log = fs.openSync(logPath, 'w');

	assetsChild = spawn(server, [], {
		cwd: root,
		env: {
			...process.env,
			PATH: toolPath(),
			PORT: '3338',
			CLIENT_PUBLIC_URL: `http://${advertiseHost()}:3338`,
			NODE_ENV: 'production',
			SERVER_ROOT: path.join(stateDir(), 'assets'),
			CLIENT_RESPATH: 'resources/',
			CLIENT_DATAINI: 'DATA.INI',
			ENABLE_STATIC_SERVE: 'true',
			ROBROWSER_PATH: path.join(root, 'vendor/roBrowserLegacy/dist/Web'),
			ENABLE_WSPROXY: 'true',
			// The proxy refuses anything not listed, so a LAN host must allow
			// its own routable address as well as loopback -- a joining client
			// asks the proxy to reach the address the char-server handed it,
			// which is the LAN one.
			WS_ALLOWED_TARGETS: [...new Set(['127.0.0.1', advertiseHost()])]
				.flatMap(h => [`${h}:6900`, `${h}:6121`, `${h}:5121`])
				.join(','),
			DATA_OVERRIDE_PATH: path.join(root, 'vendor/ROenglishRE/Translation/Renewal/data'),
		},
		stdio: ['ignore', log, log],
		detached: false,
	});
	assetsChild.on('exit', () => {
		assetsChild = null;
	});
}

function assetsStop() {
	if (assetsChild) {
		try {
			assetsChild.kill();
		} catch {
			/* already gone */
		}
		assetsChild = null;
	}
	// A previous run may have left one behind with no handle to kill. pkill
	// does not exist on Windows, so each platform gets the tool it has.
	try {
		const { execFileSync } = require('child_process');
		if (process.platform === 'win32') {
			execFileSync('taskkill', ['/F', '/IM', 'robrowser-remoteclient.exe'], { stdio: 'ignore' });
		} else {
			execFileSync('pkill', ['-f', 'robrowser-remoteclient'], { stdio: 'ignore' });
		}
	} catch {
		/* nothing matched */
	}
}

// ---------------------------------------------------------------------------
// Client paths and settings
// ---------------------------------------------------------------------------

// One executable, three runtime modes, chosen here rather than at build time:
//
//   host    run the server locally and play on it (the original behaviour)
//   join    connect to someone else's host and play as a pure client
//
// and `lan`, which is host mode listening on the network instead of loopback.
// A joining player needs no assets, no engine and no containers: the host is
// already serving the client, the GRF contents and the WebSocket proxy over
// HTTP for its own use, so joining is that URL in a window.
const DEFAULT_CLIENT = {
	mode: 'host', join_host: '', lan: false,
	data_grf: '', rdata_grf: '', official_grf: '', bgm_dir: '',
};

function getClientPaths() {
	try {
		return { ...DEFAULT_CLIENT, ...JSON.parse(fs.readFileSync(clientConfigPath(), 'utf8')) };
	} catch {
		return { ...DEFAULT_CLIENT };
	}
}

// The address this host tells other machines to come back to.
//
// Read from the endpoint.json the supervisor just wrote rather than computed
// again here. The two must agree: rAthena hands a connecting client the
// address in char_ip/map_ip, and the WebSocket proxy refuses any target not on
// its allow-list. If those disagree the client is told to go somewhere the
// proxy will not take it, and the failure is a silent hang with nothing in any
// log to explain it.
function advertiseHost() {
	try {
		const ep = JSON.parse(fs.readFileSync(path.join(stateDir(), 'endpoint.json'), 'utf8'));
		if (ep && ep.host) return ep.host;
	} catch {
		/* not written yet -- first boot, or host mode without LAN */
	}
	return '127.0.0.1';
}

// Confirm a host is actually serving before a window is pointed at it, so an
// address typo or an offline friend produces a sentence rather than a blank
// window that never loads.
function probeHost(url) {
	return new Promise((resolve, reject) => {
		const req = require('http').get(url, { timeout: 8000 }, res => {
			res.resume();
			// Any HTTP answer means something is listening and speaking HTTP,
			// which is all this needs to establish.
			resolve();
		});
		req.on('timeout', () => {
			req.destroy();
			reject(new Error(`${url} did not answer within 8 seconds. Is the host running, and are you on the same network?`));
		});
		req.on('error', e => {
			reject(new Error(`Could not reach ${url}: ${e.message}`));
		});
	});
}

// The client's entry point on an asset server. Not the root: the root serves
// roBrowser's own default page, which loads but is not this game -- joining
// would have appeared to work and shown the wrong thing. Defined once so the
// local and remote paths cannot drift.
const GAME_PATH = '/api.html?app=ONLINE';

// `host:port`, defaulted to the asset server's port so a player can paste just
// an address. Returned as a base URL: callers append GAME_PATH when they want
// the game, and probe the base when they only want to know it is up.
function joinUrl(hostSpec) {
	const spec = String(hostSpec || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
	if (!spec) return '';
	return `http://${spec.includes(':') ? spec : spec + ':3338'}`;
}

function clientComplete(p) {
	return (
		!!p.data_grf &&
		!!p.rdata_grf &&
		fs.existsSync(p.data_grf) &&
		fs.existsSync(p.rdata_grf)
	);
}

function linkClient(paths) {
	const root = projectRoot();
	// Read each path from *this* process before handing them to bash.
	//
	// macOS gates ~/Downloads, ~/Documents and ~/Desktop behind TCC. The consent
	// prompt is raised against the process making the access, and a bash
	// subprocess is a poor place for that: launched from Finder the script just
	// blocks, with nothing logged as denied because consent is pending rather
	// than refused. Launched from a terminal it works, because it inherits the
	// terminal's grant — which is exactly the confusing asymmetry this avoids.
	// Opening the file here makes the app itself the requester, so the prompt
	// appears attached to the app and the answer is remembered.
	for (const p of [paths.data_grf, paths.rdata_grf, paths.official_grf, paths.bgm_dir]) {
		if (!p) continue;
		try {
			const st = fs.statSync(p);
			if (st.isFile()) fs.closeSync(fs.openSync(p, 'r'));
			else fs.readdirSync(p);
		} catch (e) {
			throw new Error(
				`cannot read ${p}: ${e.message}\n\n` +
					'If this is in Downloads, Documents or Desktop, macOS needs permission: ' +
					'System Settings > Privacy & Security > Files and Folders.'
			);
		}
	}
	const args = ['link-assets', paths.data_grf, paths.rdata_grf];
	if (paths.official_grf || paths.bgm_dir) args.push(paths.official_grf || '');
	if (paths.bgm_dir) args.push(paths.bgm_dir);
	return new Promise((resolve, reject) => {
		execFile(
			stackBin(),
			args,
			{
				cwd: root,
				env: { ...process.env, PATH: toolPath(), RAGNAROKMAC_STATE: stateDir() },
				maxBuffer: 8 * 1024 * 1024,
			},
			(err, stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve(stdout))
		);
	});
}

const SETTINGS_DEFAULTS = {
	base_exp_rate: 100,
	job_exp_rate: 100,
	quest_exp_rate: 100,
	item_rate_common: 100,
	item_rate_equip: 100,
	item_rate_card: 100,
	zeny_from_mobs: false,
	free_kafra_warp: true,
};

function getSettings() {
	try {
		return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(stateDir(), 'settings.json'), 'utf8')) };
	} catch {
		return { ...SETTINGS_DEFAULTS };
	}
}

// rAthena has no zeny multiplier: whether monsters drop zeny at all is a
// boolean and the amount derives from the mob's level. The *_boss and heal/use
// rates deliberately track the common rate rather than getting their own
// sliders, which keeps the Settings window to six numbers.
function toBattleConf(s) {
	return (
		'// Generated by Ragnarok Offline. Edits here are overwritten.\n' +
		`base_exp_rate: ${s.base_exp_rate}\n` +
		`job_exp_rate: ${s.job_exp_rate}\n` +
		`quest_exp_rate: ${s.quest_exp_rate}\n` +
		`item_rate_common: ${s.item_rate_common}\n` +
		`item_rate_common_boss: ${s.item_rate_common}\n` +
		`item_rate_equip: ${s.item_rate_equip}\n` +
		`item_rate_equip_boss: ${s.item_rate_equip}\n` +
		`item_rate_card: ${s.item_rate_card}\n` +
		`item_rate_card_boss: ${s.item_rate_card}\n` +
		`item_rate_heal: ${s.item_rate_common}\n` +
		`item_rate_use: ${s.item_rate_common}\n` +
		`item_rate_mvp: ${s.item_rate_common}\n` +
		`item_rate_treasure: ${s.item_rate_common}\n` +
		`zeny_from_mobs: ${s.zeny_from_mobs ? 'yes' : 'no'}\n`
	);
}

async function saveSettings(settings) {
	// stateDir(), not projectRoot(): the runtime tree is replaced on update and
	// settings written there would be silently lost.
	const state = stateDir();
	fs.mkdirSync(path.join(state, 'conf'), { recursive: true });
	fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify(settings, null, 2));
	fs.writeFileSync(path.join(state, 'conf/battle_conf.txt'), toBattleConf(settings));

	// A marker rather than a value: stack.sh regenerates the Kafra scripts from
	// a pristine copy on every start and only needs to know which way.
	const marker = path.join(state, 'free_kafra_warp');
	if (settings.free_kafra_warp) fs.writeFileSync(marker, '');
	else fs.rmSync(marker, { force: true });

	return runStack(getClientPaths().lan ? ['up', '--lan'] : ['up']);
}

// Fill in a whole client from one folder. A full-client archive unzips to
// exactly this layout, and asking for each file separately made the user hunt
// through a folder they had just extracted. Case-insensitive because the
// archives are packed on Windows; also looks one level into dll_exe/, which
// some repacks nest everything under.
function scanClientDir(dir) {
	const found = { data_grf: '', rdata_grf: '', official_grf: '', bgm_dir: '' };
	for (const base of [dir, path.join(dir, 'dll_exe')]) {
		let entries;
		try {
			entries = fs.readdirSync(base, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = path.join(base, e.name);
			const name = e.name.toLowerCase();
			if (e.isDirectory()) {
				if (name === 'bgm' && !found.bgm_dir) found.bgm_dir = p;
				continue;
			}
			let key = null;
			if (name === 'data.grf') key = 'data_grf';
			else if (name === 'rdata.grf') key = 'rdata_grf';
			// The English overlay is a separate download and people rename it,
			// so take any other .grf as a candidate.
			else if (name.endsWith('.grf')) key = 'official_grf';
			if (key && !found[key]) found[key] = p;
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// Matches the PRODUCT name stack.sh puts in the MOTD, so the window title and
// the in-game greeting agree.
// One name on every platform now that the product is called Ragnarok Offline.
// stack.sh still writes a platform-flavoured MOTD ("Welcome to RagnarokMac
// Offline!"), which is a greeting rather than an identity and reads fine.
function productName() {
	return 'Ragnarok Offline';
}

const windows = {};

function makeWindow(id, file, opts) {
	if (windows[id] && !windows[id].isDestroyed()) {
		windows[id].focus();
		return windows[id];
	}
	const win = new BrowserWindow({
		...opts,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	// Electron adopts the loaded page's <title>, and the game page calls itself
	// "roBrowserLegacy". Ours is the name on the icon the user launched.
	win.on('page-title-updated', e => e.preventDefault());

	// roBrowser sets window.onbeforeunload ("Are you sure to exit roBrowser ?")
	// in App/Online.js. In a browser tab that produces the leave-site prompt; in
	// Electron it just vetoes the close, so the red button appeared dead and the
	// app could only be quit from the menu. preventDefault here overrides the
	// veto. Nothing is lost by ignoring it: the confirmation exists to stop
	// someone navigating away from a tab, and quitting runs the same teardown
	// either way.
	win.webContents.on('will-prevent-unload', e => e.preventDefault());
	// `opts.url` wins over a bundled page: a joining player's game window is
	// the host's own client, served over HTTP, not a local copy of it.
	if (opts && opts.url) win.loadURL(opts.url);
	else win.loadFile(path.join(__dirname, '..', 'src', file));
	win.on('closed', () => delete windows[id]);
	windows[id] = win;
	return win;
}

// This machine's address on the network, found the same way the supervisor
// finds it: ask the routing table which source address would reach the
// internet. A connected UDP socket sends nothing, but the kernel still binds
// it, and the address it picks is the one a peer would see.
function lanIp() {
	return new Promise(resolve => {
		let settled = false;
		let sock;
		const finish = v => {
			if (settled) return;
			settled = true;
			try { sock && sock.close(); } catch { /* already closed */ }
			resolve(v);
		};
		try {
			sock = require('dgram').createSocket('udp4');
		} catch {
			return finish(null);
		}
		sock.on('error', () => finish(null));
		// connect() is asynchronous here: the socket is not bound until the
		// callback runs, so reading address() before it returns the unbound
		// state -- which is what made this always answer null.
		sock.connect(80, '1.1.1.1', () => {
			try {
				const a = sock.address();
				finish(a && a.address && a.address !== '0.0.0.0' ? a.address : null);
			} catch {
				finish(null);
			}
		});
		setTimeout(() => finish(null), 1000);
	});
}

// Ask macOS for local-network access at the moment the player turns LAN
// hosting on, rather than when the game first tries to reach a peer.
//
// The permission is triggered by touching a local address, so the prompt used
// to appear mid-login: the connection that provoked it was also the connection
// it blocked, so the first attempt failed, and the second -- because the
// dialog is answered asynchronously and the retry raced it. It took three
// logins to get in. Doing it here means the dialog appears next to the switch
// that caused it, and is answered long before anything depends on it.
async function nudgeLocalNetworkPermission() {
	if (process.platform !== 'darwin') return;
	const ip = await lanIp();
	if (!ip) return;
	try {
		// Any attempt to reach a local address is enough; whether it connects
		// is irrelevant, so this is deliberately short and its result ignored.
		const sock = require('net').connect({ host: ip, port: 3338 });
		sock.setTimeout(1500);
		const done = () => sock.destroy();
		sock.on('connect', done);
		sock.on('timeout', done);
		sock.on('error', done);
	} catch {
		/* the prompt is best-effort; the game still works without it */
	}
}

// Which world this window is showing. Two people on a call, one hosting and
// one joining, otherwise see identical windows -- and someone who has switched
// servers has no way to tell which one they are actually on.
function gameTitle() {
	const c = getClientPaths();
	return c.mode === 'join' && c.join_host
		? `${productName()} (${c.join_host})`
		: `${productName()} (Local)`;
}

// Always the boot page, in both modes. It reports which step is running,
// surfaces a failure with a retry, and only then navigates -- a joining player
// pointed straight at a host gets a blank window when that host is down, with
// nothing to act on. Where it navigates *to* is decided in launch_game.
const openGame = () => {
	const c = getClientPaths();
	const win = makeWindow('game', 'index.html', { width: 1280, height: 800, title: gameTitle() });
	// Also on an existing window: makeWindow only applies the title when it
	// creates one, and the whole point is that this changes when you switch.
	if (win && !win.isDestroyed()) win.setTitle(gameTitle());
	return win;
};
const openSetup = () => makeWindow('setup', 'setup.html', { width: 620, height: 620, resizable: false, title: `${productName()} — set up your client` });
const openSettings = () => makeWindow('settings', 'settings.html', { width: 620, height: 780, title: `${productName()} — settings` });

// ---------------------------------------------------------------------------
// IPC — the same 23 names the Tauri build exposed, so the pages are unchanged
// ---------------------------------------------------------------------------

const handlers = {
	// stack.sh
	stack_up: () => runStack(['up']),
	stack_down: () => runStack(['down']),
	stack_status: () => runStack(['status']),
	stack_repair: () => runStack(['repair']),
	db_backup: ({ path: p }) => runStack(['backup', p]),
	db_restore: ({ path: p }) => runStack(['restore', p]),

	// Re-link the client every start: a freshly materialised runtime has no GRF
	// symlinks or DATA.INI in it yet, and only the setup window writes those.
	start_stack: async () => {
		const saved = getClientPaths();
		// Joining runs no engine, no containers and no asset server: the host
		// runs all of it. Confirm the host answers instead, so an unreachable
		// address fails here with something a player can act on rather than as
		// a blank window later.
		if (saved.mode === 'join') {
			const url = joinUrl(saved.join_host);
			fs.mkdirSync(stateDir(), { recursive: true });
			fs.writeFileSync(path.join(stateDir(), 'phase'), `Connecting to ${saved.join_host}…\n`);
			await probeHost(url);
			fs.writeFileSync(path.join(stateDir(), 'phase'), 'Ready\n');
			return 'joined';
		}
		if (clientComplete(saved)) {
			fs.mkdirSync(stateDir(), { recursive: true });
			fs.writeFileSync(path.join(stateDir(), 'phase'), 'Indexing your client…\n');
			await linkClient(saved);
		}
		appLog('start_stack: running the supervisor');
		const out = await runStack(getClientPaths().lan ? ['up', '--lan'] : ['up']);
		appLog('start_stack: supervisor finished, starting the asset server');
		// The asset server starts here, not in launch_game: the boot page polls
		// assets_ready() before it will navigate, so nothing would ever start it.
		await assetsStart();
		appLog('start_stack: asset server started');
		return out;
	},

	// Asset server
	assets_start: () => assetsStart(),
	assets_stop: () => assetsStop(),
	// In host mode this is the local asset server coming up. A joining player
	// starts no asset server at all, so waiting for one would spin until the
	// boot page's deadline and then report a stall that never had anything to
	// wait for; readiness there is the host answering.
	assets_ready: () => {
		const c = getClientPaths();
		if (c.mode === 'join') {
			return probeHost(joinUrl(c.join_host)).then(() => true, () => false);
		}
		return assetsReady();
	},

	// State
	stack_phase: () => readIfExists(path.join(stateDir(), 'phase')).trim(),
	// The Application Support path, not the volume's own mountpoint: `docker
	// volume inspect` reports a path inside the guest that exists nowhere on
	// macOS, and showing it would send people hunting for a directory they can
	// never find.
	data_location: () => path.join(dataRoot(), 'nebula/disks/data.img'),
	client_ready: () => {
		const c = getClientPaths();
		return c.mode === 'join' ? !!c.join_host : clientComplete(c);
	},
	get_client_paths: () => getClientPaths(),
	set_client_paths: async ({ paths }) => {
		const next = { ...getClientPaths(), ...paths };
		if (next.mode === 'join') {
			// A joining player supplies an address and nothing else -- no GRFs
			// to validate, and nothing to link, because the host serves both
			// the client and its assets.
			const url = joinUrl(next.join_host);
			if (!url) throw new Error('Enter the address your friend gave you.');
			await probeHost(url);
			next.join_host = url.replace(/^http:\/\//, '');
			fs.writeFileSync(clientConfigPath(), JSON.stringify(next, null, 2));
			return 'joined';
		}
		if (!fs.existsSync(next.data_grf)) throw new Error('data.grf is not a file');
		if (!fs.existsSync(next.rdata_grf)) throw new Error('rdata.grf is not a file');
		fs.writeFileSync(clientConfigPath(), JSON.stringify(next, null, 2));
		return linkClient(next);
	},

	// Host mode, LAN toggle, and the string a host gives out. Kept separate
	// from set_client_paths because switching mode must not require re-picking
	// a client that is already configured.
	get_mode: () => {
		const c = getClientPaths();
		return {
			mode: c.mode, lan: !!c.lan, join_host: c.join_host,
			// Only meaningful once the stack has run; before that there is no
			// endpoint.json and no address to give out.
			join_address: c.mode === 'host' && c.lan ? `${advertiseHost()}:3338` : '',
		};
	},
	set_mode: async ({ mode, lan, join_host }) => {
		const prev = getClientPaths();
		const next = { ...prev };
		if (mode !== undefined) next.mode = mode;
		if (lan !== undefined) next.lan = !!lan;
		// Provoke the macOS prompt here, next to the switch that needs it.
		if (lan === true && !prev.lan) await nudgeLocalNetworkPermission();
		if (join_host !== undefined) next.join_host = String(join_host).trim();
		fs.writeFileSync(clientConfigPath(), JSON.stringify(next, null, 2));
		// Before anything slow: the mode has already changed, and leaving the
		// window claiming (Local) over a server that is about to stop is the
		// same staleness as a boot page that checked once.
		if (windows.game && !windows.game.isDestroyed()) windows.game.setTitle(gameTitle());

		// Switching to a friend's server stops your own. Nothing would use it,
		// and leaving it up means a microVM, four containers and an asset
		// server running for a session spent entirely on someone else's host --
		// on a laptop that is a lot of battery for nothing.
		//
		// The database is untouched: it lives in a volume that outlives the
		// containers, so switching back to hosting finds the same characters.
		if (mode === 'join' && prev.mode !== 'join') {
			assetsStop();
			try {
				await runStack(['down']);
			} catch {
				/* nothing was running */
			}
		}
		return next;
	},
	scan_client_dir: ({ dir }) => scanClientDir(dir),
	get_settings: () => getSettings(),
	save_settings: ({ settings }) => saveSettings(settings),

	copy_text: ({ text }) => clipboard.writeText(String(text || '')),

	// Windows
	// Reload when the window is already there, do not just focus it.
	//
	// The boot page checks client_ready once: on a first run it finds nothing
	// configured, shows "Waiting for your client…", opens the setup window and
	// returns. Setup then calls this when it finishes -- and makeWindow found
	// an existing game window and only focused it, so the page that had
	// already given up stayed on screen forever, with the assets saved and the
	// server never started. Finishing setup is exactly the event that makes
	// the earlier answer wrong, so the page has to run again.
	open_game: () => {
		const existed = windows.game && !windows.game.isDestroyed();
		const win = openGame();
		// Load the boot page, not reload(). By the time this is called the
		// window has usually navigated away to whichever server was serving it,
		// and reload() would simply fetch that same URL again -- the local one
		// that was just stopped when the player switched to a friend's server.
		// This is "start the boot flow", so it has to put the window back on
		// the page that runs it, wherever it had got to.
		if (existed && win && !win.isDestroyed()) {
			win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
		}
	},
	open_setup: () => void openSetup(),
	open_settings: () => void openSettings(),
	close_setup: () => {
		if (windows.setup && !windows.setup.isDestroyed()) windows.setup.close();
	},
	launch_game: () => {
		const c = getClientPaths();
		// The host's asset server when joining, our own when hosting. Hardcoding
		// loopback here sent a joining player to a server that does not exist on
		// their machine.
		const base = c.mode === 'join' ? joinUrl(c.join_host) : 'http://127.0.0.1:3338';
		const win = openGame();
		win.loadURL(base + GAME_PATH);
		win.setTitle(gameTitle());
	},

	// Dialogs — Tauri's plugin API, reimplemented so the pages keep their shape
	__dialog_open: async ({ directory, filters, multiple }) => {
		const props = [directory ? 'openDirectory' : 'openFile'];
		if (multiple) props.push('multiSelections');
		const r = await dialog.showOpenDialog({ properties: props, filters: filters || [] });
		if (r.canceled || !r.filePaths.length) return null;
		return multiple ? r.filePaths : r.filePaths[0];
	},
	__dialog_save: async ({ defaultPath, filters }) => {
		const r = await dialog.showSaveDialog({ defaultPath, filters: filters || [] });
		return r.canceled || !r.filePath ? null : r.filePath;
	},
};

// Every failure gets written down.
//
// Electron's main process logs to stdout, which a packaged app does not have,
// so a handler that threw left no trace anywhere: no message, no file, and a
// phase file still naming the last step it reached. A launch that failed and a
// launch that was slow looked identical, on a machine reachable only over SSH.
// Several debugging rounds went into inferring from side effects what one line
// of log would have said.
function appLog(line) {
	try {
		const dir = stateDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* logging must never be the thing that breaks the app */
	}
}

ipcMain.handle('invoke', async (_event, name, args) => {
	const fn = handlers[name];
	if (!fn) throw new Error(`unknown command: ${name}`);
	try {
		return await fn(args || {});
	} catch (e) {
		const msg = (e && e.message) || String(e);
		appLog(`${name} failed: ${msg}`);
		if (e && e.stack) appLog(e.stack.split('\n').slice(1, 4).join(' | '));
		// The phase file is what the boot window shows. Leaving it on the last
		// step it reached is how a failure reads as a hang.
		if (name === 'start_stack') {
			try {
				fs.writeFileSync(path.join(stateDir(), 'phase'), `Failed: ${msg.split('\n')[0]}\n`);
			} catch {
				/* the thrown error below is still reported to the window */
			}
		}
		throw e;
	}
});

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
	return Menu.buildFromTemplate([
		{
			label: app.name,
			submenu: [
				{ role: 'about' },
				{ type: 'separator' },
				{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
				{ type: 'separator' },
				{ label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools() },
				{ type: 'separator' },
				{ role: 'quit' },
			],
		},
		{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
		{ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
	]);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tearingDown = false;

function stackEnv() {
	const root = projectRoot();
	return {
		cwd: root,
		env: {
			...process.env,
			PATH: toolPath(),
			NEBULA_BIN: path.join(root, `bin/nebula${EXE}`),
			RAGNAROKMAC_DOCKER: path.join(root, `bin/docker-slim${EXE}`),
			RAGNAROKMAC_STATE: stateDir(),
		},
	};
}

// Asynchronous, because this runs while the app is still alive and `stack.sh
// down` takes tens of seconds: doing it synchronously on the main thread froze
// the whole app — the window stopped redrawing and the Dock showed it as not
// responding until the containers finished stopping. Quitting must stay
// responsive even though the work behind it is slow.
function teardownAsync() {
	assetsStop();
	// A joining player started no engine and no containers, so there is
	// nothing to stop -- and `down` would spend its timeout talking to a
	// docker socket that was never created.
	if (getClientPaths().mode === 'join') return Promise.resolve();
	return new Promise(resolve => {
		const { cwd, env } = stackEnv();
		const child = execFile(
			stackBin(),
			['down'],
			{ cwd, env, timeout: 120000 },
			() => resolve()
		);
		child.on('error', () => resolve());
	});
}

// The signal path stays synchronous on purpose: the process is being torn down
// by the OS and there is no guarantee the event loop runs again, so there is
// nothing to await with.
function teardownSync() {
	assetsStop();
	if (getClientPaths().mode === 'join') return;
	try {
		const { cwd, env } = stackEnv();
		require('child_process').execFileSync(
			stackBin(),
			['down'],
			{ cwd, env, stdio: 'ignore', timeout: 120000 }
		);
	} catch {
		/* best effort: nothing useful to do if the teardown itself fails */
	}
}

// Before any menu is built: app.name otherwise falls back to package.json's
// "name" field, which is the old project identifier, and every platform that
// draws an application menu labels it with that.
app.setName(productName());

app.whenReady().then(() => {
	// Before anything reads a path: an existing install still has its data
	// under the old folder name.
	migrateDataRoot();
	Menu.setApplicationMenu(buildMenu());

	// Joining loads the host's page directly, so nothing on the way there
	// would notice the host being down -- Electron would just render its own
	// "cannot be reached" page, which says nothing about which host or why.
	const c = getClientPaths();
	if (c.mode === 'join' && c.join_host) {
		probeHost(joinUrl(c.join_host))
			.then(() => openGame())
			.catch(err => {
				dialog.showMessageBox({
					type: 'warning',
					message: `Could not reach ${c.join_host}`,
					detail: `${err.message}\n\nCheck the address, and that the host has started their server.`,
					buttons: ['Change address…', 'Try anyway'],
					defaultId: 0,
				}).then(({ response }) => {
					if (response === 0) openSettings();
					else openGame();
				});
			});
	} else {
		openGame();
	}

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) openGame();
	});
});

// Quit is a two-pass affair: the first pass cancels the quit, stops the stack
// in the background, and only then really exits. Without the cancel, Electron
// tears the process down while `stack.sh down` is still running and leaves four
// containers and a microVM behind.
app.on('before-quit', e => {
	if (tearingDown) return; // second pass: let it go
	e.preventDefault();
	tearingDown = true;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.setTitle(`${productName()} — shutting down…`);
	}
	teardownAsync().finally(() => app.exit(0));
});

app.on('window-all-closed', () => app.quit());

// A signal terminates the process without a before-quit, so `kill`, a logout or
// Ctrl-C would otherwise leave the whole stack running.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(sig, () => {
		if (!tearingDown) {
			tearingDown = true;
			teardownSync();
		}
		process.exit(0);
	});
}
