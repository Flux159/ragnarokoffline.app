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
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// `~/Library/Application Support/RagnarokMac`, not Electron's app.getPath(),
// which derives the folder from the app name and would drift if that changed.
// The name is also deliberately not the bundle id: a folder ending in `.app` is
// drawn by Finder as an application bundle and cannot be opened by double-click.
function dataRoot() {
	return path.join(os.homedir(), 'Library/Application Support/RagnarokMac');
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

	if (fs.existsSync(path.join(bundled, 'scripts/stack.sh'))) {
		const want = readIfExists(path.join(bundled, 'VERSION'));
		const have = readIfExists(path.join(installed, 'VERSION'));
		if (want !== have || !fs.existsSync(path.join(installed, 'scripts/stack.sh'))) {
			fs.mkdirSync(path.dirname(installed), { recursive: true });
			fs.rmSync(installed, { recursive: true, force: true });
			// -c asks APFS for copy-on-write clones: the payload is ~150 MB and
			// this runs on every version change.
			const r = spawnSync('/bin/cp', ['-Rc', bundled, installed]);
			if (r !== 0) {
				spawnSync('/bin/cp', ['-R', bundled, installed]);
			}
		}
		return installed;
	}
	return fs.existsSync(installed) ? installed : bundled;
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
	const bundled = path.join(projectRoot(), 'bin', name);
	if (fs.existsSync(bundled)) return bundled;
	for (const dir of toolPath().split(':')) {
		const p = path.join(dir, name);
		if (dir && fs.existsSync(p)) return p;
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
	if (fs.existsSync(dest)) return;
	const old = path.join(os.homedir(), 'Library/Application Support/com.ragnarokmac.app');
	if (!fs.existsSync(old)) return;

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
	try {
		fs.renameSync(old, dest);
		console.log(`moved ${old} -> ${dest}`);
	} catch (e) {
		console.error(`could not move ${old}: ${e}`);
	}
}

// ---------------------------------------------------------------------------
// stack.sh
// ---------------------------------------------------------------------------

function runStack(args) {
	return new Promise((resolve, reject) => {
		const root = projectRoot();
		execFile(
			'/bin/bash',
			[path.join(root, 'scripts/stack.sh'), ...args],
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
			CLIENT_PUBLIC_URL: 'http://127.0.0.1:3338',
			NODE_ENV: 'production',
			SERVER_ROOT: path.join(stateDir(), 'assets'),
			CLIENT_RESPATH: 'resources/',
			CLIENT_DATAINI: 'DATA.INI',
			ENABLE_STATIC_SERVE: 'true',
			ROBROWSER_PATH: path.join(root, 'vendor/roBrowserLegacy/dist/Web'),
			ENABLE_WSPROXY: 'true',
			WS_ALLOWED_TARGETS: '127.0.0.1:6900,127.0.0.1:6121,127.0.0.1:5121',
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
	// A previous run may have left one behind with no handle to kill.
	try {
		require('child_process').execSync('pkill -f robrowser-remoteclient', { stdio: 'ignore' });
	} catch {
		/* nothing matched */
	}
}

// ---------------------------------------------------------------------------
// Client paths and settings
// ---------------------------------------------------------------------------

function getClientPaths() {
	try {
		return JSON.parse(fs.readFileSync(clientConfigPath(), 'utf8'));
	} catch {
		return { data_grf: '', rdata_grf: '', official_grf: '', bgm_dir: '' };
	}
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
	const args = [
		path.join(root, 'scripts/link-assets.sh'),
		paths.data_grf,
		paths.rdata_grf,
	];
	if (paths.official_grf || paths.bgm_dir) args.push(paths.official_grf || '');
	if (paths.bgm_dir) args.push(paths.bgm_dir);
	return new Promise((resolve, reject) => {
		execFile(
			'/bin/bash',
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
		'// Generated by RagnarokMac. Edits here are overwritten.\n' +
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

	return runStack(['up']);
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
function productName() {
	switch (process.platform) {
		case 'darwin': return 'RagnarokMac';
		case 'linux': return 'RagnarokLinux';
		case 'win32': return 'RagnarokWindows';
		default: return 'Ragnarok';
	}
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
	win.loadFile(path.join(__dirname, '..', 'src', file));
	win.on('closed', () => delete windows[id]);
	windows[id] = win;
	return win;
}

const openGame = () => makeWindow('game', 'index.html', { width: 1280, height: 800, title: productName() });
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
		if (clientComplete(saved)) {
			fs.mkdirSync(stateDir(), { recursive: true });
			fs.writeFileSync(path.join(stateDir(), 'phase'), 'Indexing your client…\n');
			await linkClient(saved);
		}
		const out = await runStack(['up']);
		// The asset server starts here, not in launch_game: the boot page polls
		// assets_ready() before it will navigate, so nothing would ever start it.
		await assetsStart();
		return out;
	},

	// Asset server
	assets_start: () => assetsStart(),
	assets_stop: () => assetsStop(),
	assets_ready: () => assetsReady(),

	// State
	stack_phase: () => readIfExists(path.join(stateDir(), 'phase')).trim(),
	// The Application Support path, not the volume's own mountpoint: `docker
	// volume inspect` reports a path inside the guest that exists nowhere on
	// macOS, and showing it would send people hunting for a directory they can
	// never find.
	data_location: () => path.join(dataRoot(), 'nebula/disks/data.img'),
	client_ready: () => clientComplete(getClientPaths()),
	get_client_paths: () => getClientPaths(),
	set_client_paths: async ({ paths }) => {
		if (!fs.existsSync(paths.data_grf)) throw new Error('data.grf is not a file');
		if (!fs.existsSync(paths.rdata_grf)) throw new Error('rdata.grf is not a file');
		fs.writeFileSync(clientConfigPath(), JSON.stringify(paths, null, 2));
		return linkClient(paths);
	},
	scan_client_dir: ({ dir }) => scanClientDir(dir),
	get_settings: () => getSettings(),
	save_settings: ({ settings }) => saveSettings(settings),

	// Windows
	open_game: () => void openGame(),
	open_setup: () => void openSetup(),
	open_settings: () => void openSettings(),
	close_setup: () => {
		if (windows.setup && !windows.setup.isDestroyed()) windows.setup.close();
	},
	launch_game: () => {
		const win = openGame();
		win.loadURL('http://127.0.0.1:3338/api.html?app=ONLINE');
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

ipcMain.handle('invoke', async (_event, name, args) => {
	const fn = handlers[name];
	if (!fn) throw new Error(`unknown command: ${name}`);
	return await fn(args || {});
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
			NEBULA_BIN: path.join(root, 'bin/nebula'),
			RAGNAROKMAC_DOCKER: path.join(root, 'bin/docker-slim'),
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
	return new Promise(resolve => {
		const { cwd, env } = stackEnv();
		const child = execFile(
			'/bin/bash',
			[path.join(cwd, 'scripts/stack.sh'), 'down'],
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
	try {
		const { cwd, env } = stackEnv();
		require('child_process').execFileSync(
			'/bin/bash',
			[path.join(cwd, 'scripts/stack.sh'), 'down'],
			{ cwd, env, stdio: 'ignore', timeout: 120000 }
		);
	} catch {
		/* best effort: nothing useful to do if the teardown itself fails */
	}
}

app.whenReady().then(() => {
	// Before anything reads a path: an existing install still has its data
	// under the old folder name.
	migrateDataRoot();
	Menu.setApplicationMenu(buildMenu());
	openGame();

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
