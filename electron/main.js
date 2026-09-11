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
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, clipboard, screen, session, safeStorage, powerMonitor } = require('electron');
// Quiet launches mute every window for this run, without persisting a setting.
if (process.argv.includes('--quiet')) {
    app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { parseJoinAddress, GAME_PATH } = require('./join-address');
const { probeHost } = require('./host-probe');
const { installDesktopEntry } = require('./linux-desktop-entry');
const { JoinSession } = require('./join-session');
const joinSession = new JoinSession();
let sharing, sharingSecrets;
let sharingStartRequest = 0;
// Kept for the diagnostics bundle. A sharing failure used to arrive as one
// sentence with no address in it, and the report carried no way to work out
// which interface the check had objected to.
let lastListenerReport = null;
function getSharingSecrets() {
    return sharingSecrets ||= new (require('./sharing/secrets').SharingSecrets)(path.join(dataRoot(), 'sharing'), safeStorage);
}
function getSharing() {
    return sharing ||= new (require('./sharing/controller').SharingController)({
        directory: path.join(dataRoot(), 'sharing'),
        // 0 means "until you stop sharing": the gateway treats an infinite
        // lifetime as never expiring, and stopping or replacing still revokes.
        // Reuse the stored invitation so a link already sent to friends keeps
        // working across a restart, a crash or a Repair. Rotating it is a
        // deliberate act -- "Create a new link" in Settings.
        // Everything sharing does, kept on disk so a bug report carries it.
        // Bounded, because a reconnecting tunnel is chatty.
        log: message => {
            const line = `${new Date().toISOString()} ${message}\n`;
            appLog(`sharing: ${message}`);
            try {
                const file = path.join(dataRoot(), 'sharing', 'sharing.log');
                fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
                if ((fs.statSync(file, { throwIfNoEntry: false })?.size || 0) > 512 * 1024) {
                    fs.renameSync(file, file + '.1');
                }
                fs.appendFileSync(file, line);
            } catch { /* diagnostics must never break sharing */ }
        },
        invite: () => { try { return getSharingSecrets().loadInvite(); } catch { return null; } },
        onInvite: value => { try { getSharingSecrets().saveInvite(value); } catch { /* no secure store */ } },
        lifetime: () => {
            const days = Number(getSettings().sharing_invite_days);
            if (days === 0) return Infinity;
            return Math.min(30, Math.max(1, days || 7)) * 24 * 60 * 60 * 1000;
        },
        guard: async () => {
            const client = getClientPaths();
            if (client.mode !== 'host' || client.hosting_scope !== 'friends' || client.lan || !assetServer.running || !(await assetsReady())) throw Error('Start your own server in friends mode before sharing.');
            const checked = JSON.parse(await runStack(['sharing-check']));
            if (!checked.backendReady) throw Error('The server is not ready for friends.');
            // Configuration checks above verify each published container port
            // from the inside -- the container bindings and the engine's
            // publication flag. This is the outside second opinion: nothing of
            // ours should answer on a LAN address. It reports what it found
            // rather than refusing whenever it cannot tell, because a firewall
            // that drops the probe is the ordinary case on Windows and used to
            // fail here with a sentence naming neither an address nor a port.
            const probe = require('./listener-probe');
            lastListenerReport = await probe.probeListeners();
            appLog(`sharing: listener check\n${probe.describe(lastListenerReport)}`);
            const decided = probe.verdict(lastListenerReport);
            if (!decided.shareable) throw Error(decided.message);
            if (decided.message) appLog(`sharing: ${decided.message}`);
            // Returned, not just logged: the controller shows it beside the
            // sharing state so the player reads it without opening a log or
            // asking on Discord.
            return decided.message;
        },
        register: (request, stillInvited) => queueServerOperation(async () => {
            if (!stillInvited() || !sharing?.gateway || !['sharing', 'connecting', 'reconnecting'].includes(sharing.state)) throw Error('Sharing stopped');
            const era = getSettings().prerenewal ? 'prerenewal' : 'renewal';
            return require('./accounts').runAccounts(stackBin(), stackEnv(), { ...request, action: 'invite-create', era });
        }),
    });
}


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
	// Both eras, here, once -- not lazily when an era is first chosen.
	//
	// This runs when the payload is installed or updated, which is the only
	// moment the tars exist: unpacking deletes them. Doing it per era on
	// demand would mean the second switch finds no tar and no unpacked tree,
	// and silently serves the wrong era's maps.
	for (const era of TRANSLATION_ERAS) {
		const dir = path.join(root, 'vendor/ROenglishRE/Translation', era);
		const archive = path.join(dir, 'data.tar');
		if (!fs.existsSync(archive)) continue; // already unpacked, or an older payload
		try {
			extractTarLatin1(archive, dir);
			fs.rmSync(archive, { force: true });
		} catch (e) {
			appLog(`could not unpack the ${era} translation textures: ${e.message}`);
		}
	}
}

// Renewal first: it is the default era, and the fallback when a payload
// predates pre-renewal being packaged.
const TRANSLATION_ERAS = ['Renewal', 'Pre-Renewal'];

// The supervisor commits the era-specific translation with the asset tree.
function translationRoot() {
	return path.join(stateDir(), 'assets/.translation');
}

// A tar reader that decodes member names as UTF-8, on every platform.
//
// The names are CP949 bytes that were already stored as UTF-8 in the
// filesystem the archive was built from, so UTF-8 is the decoding that
// round-trips: read it, write it back, get the same bytes the client asks for.
//
// System tar does not do this. It decodes through whatever the platform
// considers current, and answers differently on each: on Windows it used the
// OEM codepage and produced box-drawing characters -- U+251C, U+2551 -- so 114
// button bitmaps sat on disk under names nothing would ever request. The menu
// text was translated and the buttons were not.
//
// Doing it here rather than shelling out is what makes the answer the same
// everywhere. tar has now produced three different results for these names.
function extractTarLatin1(archive, dest) {
	const buf = fs.readFileSync(archive);
	const BLOCK = 512;
	let off = 0;
	let longName = null;

	const str = (start, len) => {
		const end = buf.indexOf(0, start) === -1 ? start + len
			: Math.min(buf.indexOf(0, start), start + len);
		return buf.toString('utf8', start, end);
	};

	while (off + BLOCK <= buf.length) {
		if (buf[off] === 0) break; // end-of-archive padding
		const name = str(off, 100);
		const sizeField = buf.toString('ascii', off + 124, off + 136).replace(/\0.*$/, '').trim();
		const size = parseInt(sizeField, 8) || 0;
		const type = String.fromCharCode(buf[off + 156]);
		const prefix = str(off + 345, 155);
		off += BLOCK;

		// GNU long name: the following record's data is the real name.
		if (type === 'L') {
			longName = buf.toString('utf8', off, off + size).replace(/\0+$/, '');
			off += Math.ceil(size / BLOCK) * BLOCK;
			continue;
		}

		let full = longName || (prefix ? `${prefix}/${name}` : name);
		longName = null;
		// Never let an archive write outside its destination.
		const parts = full.split('/').filter(p => p && p !== '.' && p !== '..');
		const target = path.join(dest, ...parts);

		if (type === '5' || full.endsWith('/')) {
			fs.mkdirSync(target, { recursive: true });
		} else if (type === '0' || type === '\0' || type === '') {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, buf.subarray(off, off + size));
		}
		off += Math.ceil(size / BLOCK) * BLOCK;
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

// Throw away the client's own file cache when the mods behind it have changed.
//
// roBrowser saves every file it downloads into the browser's sandboxed
// filesystem and looks there before asking the server again, keyed by
// filename. That is what makes the second launch quick, and it is also why an
// enabled mod could change nothing on screen: the client already had a file of
// that name from before the mod existed, so it never asked for the new one.
// A mod's login background, loading screens and itemInfo table were all
// invisible this way, while the mod itself loaded on the server and read as
// `on` in Settings — the worst shape a bug can take, because everything that
// reports status says it is working.
//
// The stack writes a fingerprint of the overlay next to the assets it serves;
// anything that changes what the client is handed changes that number. Only
// then is the cache dropped, so an ordinary launch still starts from a warm
// one.
//
// Not just the sandboxed filesystem: Config.local.js and the plugin bundles
// are ordinary HTTP requests, and a stale one of those loads the previous
// mod's client code, or a plugin the player has since switched off.
async function dropStaleClientCache() {
	const want = readIfExists(path.join(stateDir(), 'assets', 'overlay.id')).trim();
	// No fingerprint means link-assets has not run, and dropping a warm cache
	// on a guess would just make the launch slower.
	if (!want) return;
	const stamp = path.join(stateDir(), 'client-cache.id');
	if (readIfExists(stamp).trim() === want) return;
	try {
		const ses = session.defaultSession;
		await ses.clearStorageData({ storages: ['filesystem', 'cachestorage'] });
		await ses.clearCache();
	} catch (e) {
		// A cache we failed to clear shows stale art. A launch we refused
		// shows nothing at all, so this is not worth failing over.
		console.error('could not clear the client cache:', e.message);
		return;
	}
	try {
		fs.mkdirSync(stateDir(), { recursive: true });
		// Written only after the clear succeeded: a stamp saved first would
		// mark the cache current and never try again.
		fs.writeFileSync(stamp, want + '\n');
	} catch {}
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

// Both flags the supervisor takes per invocation come from client.json, and
// both only mean anything to the verbs that boot the guest. Appended here
// rather than at each call site because there are seven of them and a missed
// one is a setting that silently does nothing.
function withEngineFlags(args) {
	if (!['up', 'repair', 'secure-services', 'hosting-check'].includes(args[0])) return args;
	const client = getClientPaths();
	const out = [...args];
	if (client.lan && !out.includes('--lan')) out.push('--lan');
	if (args[0] === 'hosting-check') return out;
	const ram = Number(client.vm_ram_mib);
	if (Number.isFinite(ram) && ram > 0) out.push('--ram', String(ram));
	return out;
}

async function runStack(rawArgs) {
    if (sharing && ['up', 'down', 'repair', 'backup', 'restore', 'secure-services'].includes(rawArgs[0])) await sharing.stop();
    return runStackProcess(rawArgs);
}
function runStackProcess(rawArgs) {
	const args = withEngineFlags(rawArgs);
	return new Promise((resolve, reject) => {
		const root = projectRoot();
		// spawn, and settle on the process exiting -- not on its streams
		// closing, which is what execFile waits for.
		//
		// `up` starts nebulad, and on Windows a daemon started this way keeps
		// the inherited stdio pipe open after its parent exits. The supervisor
		// finished, wrote "Ready" and was gone, and Node never saw EOF, so the
		// callback never fired: the app waited on a completed process until
		// execFile's fifteen-minute timeout. On the boot page that looked like
		// a stack that never started, when the stack was up the whole time.
		//
		// The 'exit' event does not depend on the pipes, so a daemon holding
		// one cannot hide the fact that the process ended.
		const child = spawn(stackBin(), args, {
			cwd: root,
			env: {
				...process.env,
				PATH: toolPath(),
				NEBULA_BIN: path.join(root, `bin/nebula${EXE}`),
				RAGNAROKMAC_DOCKER: path.join(root, `bin/docker-slim${EXE}`),
				RAGNAROKMAC_STATE: stateDir(),
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let out = '';
		let err = '';
		const cap = 8 * 1024 * 1024;
		child.stdout.on('data', d => { if (out.length < cap) out += d; });
		child.stderr.on('data', d => { if (err.length < cap) err += d; });

		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try { child.kill(); } catch { /* already gone */ }
			reject(new Error(`the supervisor did not finish within 15 minutes\n${out}${err}`));
		}, 15 * 60 * 1000);

		child.on('error', e => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(e);
		});

		child.on('exit', code => {
			if (settled) return;
			// A short grace so output already in flight is included; the
			// streams may never close, so this cannot wait for them.
			setTimeout(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (code === 0) resolve(out);
				else reject(new Error(`${out}${err}`.trim() || `the supervisor exited with code ${code}`));
			}, 250);
		});
	});
}

// ---------------------------------------------------------------------------
// Asset server
// ---------------------------------------------------------------------------

const { AssetServer, sha256, processIdentity } = require('./asset-server');
const assetServer = new AssetServer({ log: message => appLog(message), identify: pid => processIdentity(pid, stackBin()) });
let assetLinkQueue = Promise.resolve();

function assetsReady() { return assetServer.ready(); }

// The operating system as a person would name it, plus the number an engineer
// needs. Windows reports 10.0.x for both 10 and 11, so the build is the only
// thing that separates them and 22000 is where 11 begins.
function osDescription() {
	const rel = os.release();
	if (process.platform === 'win32') {
		const build = Number(rel.split('.')[2]) || 0;
		const name = build >= 22000 ? 'Windows 11' : 'Windows 10';
		return `${name} (build ${build || '?'}, ${rel})`;
	}
	if (process.platform === 'darwin') {
		// getSystemVersion is the marketing version (15.1); os.release() is the
		// Darwin kernel (24.1.0). Both, because bug reports quote the first and
		// anything technical is written against the second.
		return `macOS ${process.getSystemVersion()} (darwin ${rel})`;
	}
	const line = (readIfExists('/etc/os-release') || '')
		.split('\n')
		.find(l => l.startsWith('PRETTY_NAME='));
	const distro = line ? line.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '') : 'Linux';
	return `${distro} (kernel ${rel})`;
}

// The model string, because the vendor is in it: AuthenticAMD and GenuineIntel
// take different paths through the hypervisor, and Apple silicon is a third.
function cpuDescription() {
	const cpus = os.cpus();
	const model = ((cpus[0] && cpus[0].model) || 'unknown').replace(/\s+/g, ' ').trim();
	return `${model} (${cpus.length} logical, ${process.arch})`;
}

async function assetsStart() {
	await assetLinkQueue;
	const root = projectRoot();
	const server = findTool('robrowser-remoteclient');
	if (!server) throw new Error('the asset server binary is missing from this build');
	const client = getClientPaths();
	const sources = ['data_grf', 'rdata_grf', 'official_grf', 'bgm_dir'].map(key => {
		const filename = client[key] || '';
		try {
			const stat = fs.statSync(filename);
			return [key, filename, stat.size, stat.mtimeMs];
		} catch { return [key, filename, 'missing']; }
	});
	// Pass every RemoteClient setting explicitly, so .env/default changes
	// cannot create a different effective server behind the same fingerprint.
	return assetServer.start({
		executable: server, cwd: root, stateRoot: stateDir(),
		environment: {
			PATH: toolPath(), PORT: '3338',
			HOST: client.lan ? '0.0.0.0' : '127.0.0.1',
			CLIENT_PUBLIC_URL: `http://${advertiseHost()}:3338`,
			NODE_ENV: 'production',
			SERVER_ROOT: path.resolve(stateDir(), 'assets'),
			CLIENT_RESPATH: 'resources/', CLIENT_DATAINI: path.resolve(stateDir(), 'asset-config/DATA.INI'),
			BGM_PATH: readIfExists(path.join(stateDir(), 'asset-config/bgm.path')).trim(),
			AI_PATH: readIfExists(path.join(stateDir(), 'asset-config/ai.path')).trim(),
			ENABLE_STATIC_SERVE: 'true', ENABLE_WSPROXY: 'true',
			ROBROWSER_PATH: path.resolve(root, 'vendor/roBrowserLegacy/dist/Web'),
			WS_ALLOWED_TARGETS: proxyTargets(client).sort().join(','),
			DATA_OVERRIDE_PATH: path.resolve(translationRoot(), 'data'),
			ENABLE_COMPRESSION: process.env.ENABLE_COMPRESSION || 'true',
			CACHE_MAX_FILES: process.env.CACHE_MAX_FILES || '5000',
			CACHE_MAX_MEMORY_MB: process.env.CACHE_MAX_MEMORY_MB || '1024',
			CACHE_WARM_UP: process.env.CACHE_WARM_UP || 'false',
			CACHE_WARM_UP_LIMIT: process.env.CACHE_WARM_UP_LIMIT || '500',
			CLIENT_ENABLESEARCH: process.env.CLIENT_ENABLESEARCH || 'true',
			CLIENT_AUTOEXTRACT: process.env.CLIENT_AUTOEXTRACT || 'true',
			GRF_FILENAME_ENCODING: process.env.GRF_FILENAME_ENCODING || 'auto',
			RAGNAROK_PAYLOAD_VERSION: readIfExists(path.join(root, 'VERSION')).trim(),
			RAGNAROK_OVERLAY_ID: readIfExists(path.join(stateDir(), 'assets/overlay.id')).trim(),
			RAGNAROK_MANIFEST_ID: sha256(readIfExists(path.join(stateDir(), 'asset-config/DATA.INI'))),
			RAGNAROK_CLIENT_CONFIG_ID: sha256(readIfExists(path.join(stateDir(), 'assets/Config.local.js'))),
			RAGNAROK_ASSET_SOURCES_ID: sha256(JSON.stringify(sources)),
		},
	});
}

async function assetsStop() { if (sharing) await sharing.stop(); return assetServer.stop(); }

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
	// vm_ram_mib is deliberately absent: its default depends on the machine,
	// so it is computed in getClientPaths() when the file does not name one.
	// Anything written there -- by the slider in Settings -- wins permanently.
};

/// How much memory to let the virtual machine have, on a machine nobody has
/// told us about.
///
/// A quarter of the host, capped at 4 GB. The old fixed 4096 was fine on the
/// 16 GB and larger machines it was written on, and poor on an 8 GB one: nebula
/// only hands idle guest memory back where the backend supports ballooning,
/// which on Windows and Linux it does not and is not expected to -- so there
/// 4 GB behaves far more like a
/// reservation, against a Windows that already wants 2-3 GB, plus this app and
/// the browser rendering the game.
///
/// Floored at 2 GB because below that the server does not fit: rAthena's map
/// server alone sits near 450 MB before a single AI character exists, and a
/// guest that cannot start is worse than one that is tight.
function defaultVmRamMib() {
	const hostMib = Math.floor(os.totalmem() / (1024 * 1024));
	return Math.max(2048, Math.min(4096, Math.floor(hostMib / 4)));
}

function getClientPaths() {
	let saved = {};
	try {
		saved = JSON.parse(fs.readFileSync(clientConfigPath(), 'utf8'));
	} catch { /* no config yet */ }
	const out = { ...DEFAULT_CLIENT, ...saved };
	if (out.join_host) {
		try { out.join_host = joinSession.remember(out.join_host); }
		catch { out.join_host = ''; }
	}
	// Only when nothing has been chosen. A value in the file is the player's,
	// including one they set on a machine they have since upgraded.
	if (!Number.isFinite(Number(out.vm_ram_mib)) || Number(out.vm_ram_mib) <= 0) {
		out.vm_ram_mib = defaultVmRamMib();
	}
	return require('./hosting-policy').effective(out,
		require('./settings-store').read(path.join(stateDir(), 'settings.json'), {}));
}

// Stop joining and run the server here instead.
//
// Only the mode changes: join_host stays, so going back needs no retyping, and
// the GRFs -- which a player who has only ever joined has never picked -- are
// asked for by the boot page, which already knows how to ask.
function switchToHost() {
	fs.writeFileSync(clientConfigPath(), JSON.stringify({ ...getClientPaths(), mode: 'host' }, null, 2));
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

// Login always names the host-side proxy's loopback. rAthena returns its
// configured character/map address; keep precisely those three destinations.
function proxyTargets(client) {
	const backend = client.lan ? advertiseHost() : '127.0.0.1';
	return ['127.0.0.1:6900', `${backend}:6121`, `${backend}:5121`];
}

// One public web origin; legacy LAN addresses are normalized by join-address.
function serveUrl(host) {
	const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	return `http://${authority}:3338/`;
}
function joinUrl(hostSpec) { return parseJoinAddress(hostSpec).origin; }

async function prepareJoin(next) {
	const origin = joinSession.remember(next.join_host);
	const reached = await probeHost(origin);
	await stopLocalHostForJoin();
	joinSession.retarget(origin, reached.origin);
	// An HTTP-to-HTTPS redirect is resolved before the game gets an invite.
	// The saved host and navigation guard then agree on the secure origin.
	fs.writeFileSync(clientConfigPath(), JSON.stringify({ ...next, join_host: reached.origin }, null, 2));
	return reached;
}

async function stopLocalHostForJoin() {
	const hadAssets = assetServer.running;
	await assetsStop();
	// The first-run Join path has no runtime to stop. An existing host must
	// finish shutting down before its saved mode can say it is only joining.
	if (hadAssets || fs.existsSync(path.join(dataRoot(), 'nebula/run/docker.sock')))
		await runStack(['down']);
}

// rdata.grf is not required. It was a renewal overlay on an older base client,
// and clients have not been packaged that way for years -- a 2026 client from
// the rAthena forums is renewal, has fourth jobs, and ships one data.grf with
// everything merged in. Demanding a second file turned those players away from
// a client that would have worked.
function clientComplete(p) {
	return !!p.data_grf && fs.existsSync(p.data_grf);
}

function linkClient(paths) {
	const selected = { ...paths };
	const job = assetLinkQueue.then(() => linkClientOwned(selected));
	assetLinkQueue = job.catch(() => {});
	return job;
}

async function linkClientOwned(paths) {
	await assetServer.prepare(stateDir());
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
	// Named, and optional ones say so: three of these four can simply be
	// forgotten, and a player whose external drive is unplugged should be told
	// that rather than left to re-pick every location.
	const ASSETS = [
		['data_grf', paths.data_grf, 'data.grf', false],
		['rdata_grf', paths.rdata_grf, 'rdata.grf', true],
		['official_grf', paths.official_grf, 'official_data.grf', true],
		['bgm_dir', paths.bgm_dir, 'the BGM folder', true],
	];
	for (const [, p, label, optional] of ASSETS) {
		if (!p) continue;
		try {
			const st = fs.statSync(p);
			if (st.isFile()) fs.closeSync(fs.openSync(p, 'r'));
			else fs.readdirSync(p);
		} catch (e) {
			// The macOS advice is macOS advice. Telling a Windows player to open
			// System Settings > Privacy & Security sends them looking for a
			// screen that does not exist, and buries the thing that is actually
			// wrong -- which on Windows is usually a drive that is not there.
			let hint;
			if (e.code === 'ENOENT') {
				hint = `${label} is no longer at that location. If it is on a removable ` +
					'or network drive, connect it; if it moved, choose it again.';
				if (optional) {
					hint += ` ${label} is optional -- Change asset locations has an ` +
						'x beside it to forget it, and the game runs without it.';
				}
			} else if (process.platform === 'darwin') {
				hint = 'If this is in Downloads, Documents or Desktop, macOS needs permission: ' +
					'System Settings > Privacy & Security > Files and Folders.';
			} else {
				hint = 'The file is there but could not be opened. Another program may have ' +
					'it locked, or the account may not have permission to read it.';
			}
			throw new Error(`cannot read ${p}: ${e.message}\n\n${hint}`);
		}
	}
	// Positional: an empty string keeps rdata's slot so official and bgm still
	// land in theirs.
	const args = ['link-assets', paths.data_grf, paths.rdata_grf || ''];
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

let registryImages = null;

const SETTINGS_DEFAULTS = {
	open_registration: true,
	// How long a friends invitation stays valid, in days. Nothing to do with
	// Cloudflare -- the tunnel runs as long as the app shares; this is only how
	// long the invite token is accepted. A link posted in Discord should still
	// work next weekend, and "Replace invitation" revokes one at any time.
	sharing_invite_days: 7,
	base_exp_rate: 100,
	job_exp_rate: 100,
	quest_exp_rate: 100,
	item_rate_common: 100,
	item_rate_equip: 100,
	item_rate_card: 100,
	zeny_from_mobs: false,
	// rAthena's own defaults, so leaving these alone changes nothing. Both are
	// caps a player raises to mess about on their own server; see toBattleConf
	// for why raising one writes several keys.
	max_aspd: 190,
	max_parameter: 99,
	free_kafra_warp: true,
	population_enable: false,
	// A ceiling, not a target. Demand-driven spawning builds only the maps
	// somebody is on, and a map holds 20-40 by the spawn tables, so this binds
	// only if a group fans out across dozens of maps at once. 1500 is
	// deliberately "never in a solo game".
	population_max: 1500,
	// How crowded a single map feels, as a percentage of what the server's
	// spawn tables ask for. This is the dial players actually want; the limit
	// above is only a safety net.
	population_density: 100,
	// Whether deleting a character takes effect at once or a day after it is
	// queued. rAthena's default is the day, and it stays the default here: the
	// countdown on the slot is what lets a player undo a deletion somebody else
	// started, which matters the moment friends can reach the server.
	instant_character_deletion: false,
	// Which window a launch opens. Off means the game, which is what anyone
	// who has not asked for this gets; on means the Settings window and no
	// game window at all. The only shell-side preference in this file -- it is
	// here because settings.json is where the app's preferences live and the
	// window already reads it, and it is deliberately ignored by
	// writeSettingsFiles: the server knows nothing about it.
	open_settings_first: false,
	// Pre-renewal is a different rAthena build, not a runtime option, so this
	// selects which of the two the supervisor starts. Each mode keeps its own
	// characters -- see db_volume() in stack/src/cmds.rs for why sharing them
	// is not safe.
	prerenewal: false,
	// Where the game's text comes from, and with it the codepage every table
	// the client ships is read through. kRO is Korean and the bundled
	// ROenglishRE translation covers it, which is why English is the default;
	// a Latin American or international client already has its own text and is
	// better served reading that. See GameText in stack/src/assets.rs for why
	// the text and the codepage are one setting rather than two.
	game_text: 'english',
};

function getSettings() {
	return require('./settings-store').read(path.join(stateDir(), 'settings.json'), SETTINGS_DEFAULTS);
}

// Keys in settings.json that the app acts on rather than the server, and the
// only names set_app_preference will write. Everything else in that file
// changes how the server runs and has to go through Apply.
const APP_PREFERENCES = new Set(['open_settings_first']);

// Whether this launch opens Settings instead of the game.
//
// Guarded, and answering false on anything it cannot read: a settings.json the
// store refuses is already reported everywhere it matters, and the one thing it
// must not do is leave a launch with no window at all. The game window is the
// safe answer because it is the one nobody has to have asked for.
function openSettingsFirst() {
	try {
		return getSettings().open_settings_first === true;
	} catch {
		return false;
	}
}

// rAthena has no zeny multiplier: whether monsters drop zeny at all is a
// boolean and the amount derives from the mob's level. The *_boss and heal/use
// rates deliberately track the common rate rather than getting their own
// sliders, which keeps the Settings window to six numbers.
// rAthena's stock caps, by class group. These are raise-only settings: at or
// below the base default every group keeps its own stock value, and above it
// every group is lifted to the player's number.
//
// Raise-only because the stock values are not a flat line -- 99 for first and
// second jobs, 130 for third and summoner, 80 for baby. Any rule that mapped
// one number onto all of them while still allowing a decrease either nerfed
// third jobs on an untouched install or quietly raised baby classes from 80.
// Nobody asking for "max stats" wants either, and nobody has asked to lower
// them at all.
const ASPD_STOCK = { max_aspd: 190, max_third_aspd: 193, max_summoner_aspd: 193 };
const PARAM_STOCK = {
	max_parameter: 99,
	max_third_parameter: 130,
	max_baby_parameter: 80,
	max_extended_parameter: 130,
	max_summoner_parameter: 130,
};

// 100..199; rAthena refuses anything outside and falls back to its default,
// which would look like the setting doing nothing.
function aspdConf(v) {
	const want = Math.min(199, Math.max(100, Number(v) || ASPD_STOCK.max_aspd));
	return Object.entries(ASPD_STOCK)
		.map(([k, stock]) => `${k}: ${want > ASPD_STOCK.max_aspd ? Math.max(want, stock) : stock}\n`)
		.join('');
}

// 10..32767, rAthena's own bounds (SHRT_MAX).
function parameterConf(v) {
	const want = Math.min(32767, Math.max(10, Number(v) || PARAM_STOCK.max_parameter));
	return Object.entries(PARAM_STOCK)
		.map(([k, stock]) => `${k}: ${want > PARAM_STOCK.max_parameter ? Math.max(want, stock) : stock}\n`)
		.join('');
}

// Whether the player has asked for faster levelling at all. 100 is 1x, and
// rAthena's own bounds are the sliders' -- anything above 1x means the stock
// one-level-per-kill cap would start eating the difference.
function expRatesRaised(s) {
	return Number(s.base_exp_rate) > 100
		|| Number(s.job_exp_rate) > 100
		|| Number(s.quest_exp_rate) > 100;
}

function toBattleConf(s) {
	return (
		'// Generated by Ragnarok Offline. Edits here are overwritten.\n' +
		`base_exp_rate: ${s.base_exp_rate}\n` +
		`job_exp_rate: ${s.job_exp_rate}\n` +
		`quest_exp_rate: ${s.quest_exp_rate}\n` +
		// Follows the EXP sliders rather than getting a switch of its own.
		// rAthena ships this off, and off means a kill grants one level and
		// *discards* the overflow above it (pc_checkbaselevelup caps the carried
		// exp at next-1). So at any raised rate the sliders quietly stop paying
		// out most of what they promise -- the player sees one level per monster
		// at 50x and reads it as the setting not working. Quest exp counts too:
		// it feeds the same two bars, so a raised quest rate is discarded on
		// turn-in the same way.
		`multi_level_up: ${expRatesRaised(s) ? 'yes' : 'no'}\n` +
		require('./battle-rates').dropRateConf(s) +
		`item_rate_mvp: ${s.item_rate_common}\n` +
		`item_rate_treasure: ${s.item_rate_common}\n` +
		`zeny_from_mobs: ${s.zeny_from_mobs ? 'yes' : 'no'}\n` +
		// One cap in the UI, several keys here, because rAthena caps third,
		// baby, extended and summoner classes separately and a player who
		// raises "the" limit means all of them -- setting only max_parameter
		// leaves every third-job character on the stock 130.
		//
		// Raised to the player's number, never lowered below rAthena's own
		// default for that class group: the stock split is 99 for first and
		// second jobs against 130 for third, so writing the player's 99
		// everywhere would quietly nerf third jobs on a fresh install that had
		// touched nothing.
		aspdConf(s.max_aspd) +
		parameterConf(s.max_parameter) +
		// The count is always written, even when the engine is off: rAthena
		// clamps this one to 1..30000 and refuses a 0, so "none" is expressed by
		// the enable flag alone.
		`population_engine_enable: ${s.population_enable ? 1 : 0}\n` +
		`population_engine_max_count: ${Math.max(1, Number(s.population_max) || 1)}\n` +
		`population_engine_density_pct: ${Math.min(500, Math.max(10, Number(s.population_density) || 100))}\n` +
		// Off in the compiled defaults. Upstream turns it on in a conf file we
		// deliberately do not import, so without this line no shell ever opens
		// a stall -- and a town of people with nothing to sell is most of what
		// makes one feel dead.
		`population_engine_vending_enable: ${s.population_enable ? 1 : 0}\n`
	);
}

// Everything settings.json implies, written out.
//
// Split from saveSettings so a start can run it too. battle_conf.txt and the
// marker files used to be written only when Apply was pressed, so anything
// that changed settings.json by another route left the server running one
// configuration while the window showed another, with nothing in either to
// say they disagreed. Regenerating on every start makes settings.json the
// single source of truth.
function writeSettingsFiles(settings) {
	const state = stateDir();
	fs.mkdirSync(path.join(state, 'conf'), { recursive: true });
	fs.writeFileSync(path.join(state, 'conf/battle_conf.txt'), toBattleConf(settings));

}

async function saveSettings(settings) {
	// stateDir(), not projectRoot(): the runtime tree is replaced on update and
	// settings written there would be silently lost.
	const state = stateDir();
	fs.mkdirSync(path.join(state, 'conf'), { recursive: true });
	settings = require('./settings-store').write(path.join(state, 'settings.json'), settings, SETTINGS_DEFAULTS);
	writeSettingsFiles(settings);

	// A marker rather than a value: stack.sh regenerates the Kafra scripts from
	// a pristine copy on every start and only needs to know which way.
	const marker = path.join(state, 'free_kafra_warp');
	if (settings.free_kafra_warp) fs.writeFileSync(marker, '');
	else fs.rmSync(marker, { force: true });

	// Same shape: the supervisor only needs to know which era to start.
	const era = path.join(state, 'prerenewal');
	if (settings.prerenewal) fs.writeFileSync(era, '');
	else fs.rmSync(era, { force: true });

	// link-assets now owns the translated overlay and generated client config.
	// Restarting RemoteClient alone does not change either. Rebuild on Apply,
	// including retries after a partially completed era switch or mod change.
	const client = getClientPaths();
	if (client.mode === 'join') return 'Settings saved for your own server. Joining starts no local server.';
	const cycleAssets = assetServer.running;
	if (cycleAssets) {
		appLog('applying settings: stopping the asset server before rebuilding');
		await assetsStop();
	}

	const out = await runStack(['up']);
	if (clientComplete(client)) await linkClient(client);
	if (cycleAssets) {
		await assetsStart();
		appLog('settings applied: asset server restarted');
	}

	return out;
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

// Where a window was last left. The game window is the only one worth
// remembering -- setup is fixed-size and settings is a dialog -- but the store
// is keyed by window id so adding another is a one-line change.
//
// It lives beside settings.json rather than in the Chromium profile: this is
// the shell's own state, and a player clearing the client's cache to fix a
// stale mod should not also lose the size of their window.
function windowStatePath() {
	return path.join(stateDir(), 'window.json');
}

function readWindowState(id) {
	try {
		const all = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
		const st = all && all[id];
		if (!st || typeof st.width !== 'number' || typeof st.height !== 'number') return null;
		return st;
	} catch {
		return null;
	}
}

// A saved position is only usable if it still lands on a display that exists.
// Unplugging the monitor a window was left on, or a resolution change, would
// otherwise reopen it somewhere the player cannot reach it. Size is kept
// either way; only the position is dropped.
function usableWindowState(st) {
	if (!st) return null;
	const out = { width: st.width, height: st.height, maximized: !!st.maximized };
	if (typeof st.x !== 'number' || typeof st.y !== 'number') return out;
	const visible = screen.getAllDisplays().some(d => {
		const b = d.workArea;
		return st.x < b.x + b.width && st.x + st.width > b.x && st.y < b.y + b.height && st.y + st.height > b.y;
	});
	if (visible) {
		out.x = st.x;
		out.y = st.y;
	}
	return out;
}

function saveWindowState(id, win) {
	if (!win || win.isDestroyed()) return;
	try {
		let all = {};
		try {
			all = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) || {};
		} catch {
			all = {};
		}
		// getNormalBounds, not getBounds: a maximized window reports the screen,
		// and restoring that would leave nothing to un-maximize back to.
		all[id] = { ...win.getNormalBounds(), maximized: win.isMaximized() };
		fs.mkdirSync(stateDir(), { recursive: true });
		fs.writeFileSync(windowStatePath(), JSON.stringify(all, null, 2));
	} catch {
		// Losing the window size is not worth failing a quit over.
	}
}

// Windows whose geometry is remembered, so quitting can write them even when
// no `close` event is coming -- see saveTrackedWindows.
const trackedWindows = new Map();

// Resize and move fire continuously while dragging, so the write is debounced.
// `close` writes immediately, because the debounce timer would not survive it.
function trackWindowState(id, win) {
	let timer = null;
	const later = () => {
		clearTimeout(timer);
		timer = setTimeout(() => saveWindowState(id, win), 400);
	};
	for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later);
	win.on('close', () => {
		clearTimeout(timer);
		saveWindowState(id, win);
	});
	trackedWindows.set(id, win);
	win.on('closed', () => trackedWindows.delete(id));
}

// Quitting from the menu ends at app.exit and a signal ends at process.exit;
// neither closes the windows first, so `close` never fires and the last
// geometry would be lost. Clicking the red button does fire it -- this is for
// the other two ways out.
function saveTrackedWindows() {
	for (const [id, win] of trackedWindows) saveWindowState(id, win);
}

function makeWindow(id, file, opts) {
	if (windows[id] && !windows[id].isDestroyed()) {
		windows[id].focus();
		return windows[id];
	}
	// A remembered size and position wins over the defaults the caller passes.
	const saved = opts && opts.rememberBounds ? usableWindowState(readWindowState(id)) : null;
	const { rememberBounds, ...winOpts } = opts || {};
	const win = new BrowserWindow({
		...winOpts,
		...(saved ? { width: saved.width, height: saved.height } : {}),
		...(saved && typeof saved.x === 'number' ? { x: saved.x, y: saved.y } : {}),
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
	// Remote game pages stay on their selected web origin. In particular a
	// redirect must not downgrade HTTPS, forward an inherited invite fragment
	// to another origin, or navigate into a privileged local Settings file.
	if (id === 'game') {
		const guard = (event, legacyUrl) => {
			const current = getClientPaths();
			const allowed = current.mode === 'join' && current.join_host
				? joinUrl(current.join_host) : 'http://127.0.0.1:3338';
			let target;
			try { target = new URL(event.url || legacyUrl); } catch { event.preventDefault(); return; }
			if (target.origin !== allowed || target.username || target.password) {
				event.preventDefault();
				appLog('blocked game navigation outside the selected host origin');
			}
		};
		win.webContents.on('will-navigate', guard);
		win.webContents.on('will-redirect', guard);
		win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
			if (isMainFrame) joinSession.exchanged(url);
		});
		win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	}
	// Everything the game page logs, written to client.log.
	//
	// The client is where the failures we cannot see happen. A player reported
	// that they could log in and create a character and then never reach the
	// map; every server log was healthy and the asset server showed the client
	// simply never opening a connection to the map server. The reason was in
	// the renderer console, which went nowhere -- diagnostics collected
	// client.log, but nothing had ever written it.
	//
	// Levels are Electron's: 0 verbose, 1 info, 2 warning, 3 error.
	clientLogStart();
	win.webContents.on('console-message', (...a) => {
		// Electron 36 replaced (event, level, message, line, sourceId) with a
		// single details object. Accept both so this does not go quiet on an
		// upgrade -- silently logging nothing is the failure it exists to fix.
		const d = a.length === 1 && typeof a[0] === 'object' ? a[0] : null;
		const level = d ? d.level : a[1];
		const text = d ? d.message : a[2];
		const line = d ? d.lineNumber : a[3];
		const src = d ? d.sourceId : a[4];
		clientLog(level, text, line, src);
	});
	// A page that fails to load at all logs nothing, so it needs saying here.
	win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
		clientLog('error', `page failed to load: ${desc} (${code}) ${url || ''}`);
		if (id === 'game' && isMainFrame && code !== -3 && /^https?:/.test(url || '')) {
			showGameFailure(win, 'The game page could not load. Check the host connection, then retry.');
		}
	});
	win.webContents.on('render-process-gone', (_e, details) => {
		clientLog('error', `renderer gone: ${details && details.reason}`);
		if (id === 'game' && details?.reason !== 'clean-exit') {
			showGameFailure(win, 'The game window stopped unexpectedly. Retry to reopen the client and log in again.');
		}
	});
	// `opts.url` wins over a bundled page: a joining player's game window is
	// the host's own client, served over HTTP, not a local copy of it.
	if (opts && opts.url) win.loadURL(opts.url);
	else win.loadFile(path.join(__dirname, '..', 'src', file));
	if (saved && saved.maximized) win.maximize();
	if (opts && opts.rememberBounds) trackWindowState(id, win);
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
// Kept in the owner process so a failed/terminated game renderer cannot lose
// its recovery reason. Loading the boot page never retries automatically.
let gameFailure = null;
function showGameFailure(win, message) {
	if (tearingDown || !win || win.isDestroyed() || win !== windows.game || win.recoveryLoading) return;
	gameFailure = message;
	win.recoveryLoading = true;
	win.loadFile(path.join(__dirname, '..', 'src', 'index.html'))
		.catch(error => appLog(`Could not load game recovery: ${error.message}`))
		.finally(() => { win.recoveryLoading = false; });
}

const openGame = () => {
	const c = getClientPaths();
	const win = makeWindow('game', 'index.html', { width: 1280, height: 800, title: gameTitle(), rememberBounds: true });
	// Also on an existing window: makeWindow only applies the title when it
	// creates one, and the whole point is that this changes when you switch.
	if (win && !win.isDestroyed()) win.setTitle(gameTitle());
	return win;
};
const openSetup = () => makeWindow('setup', 'setup.html', { width: 620, height: 620, resizable: false, title: `${productName()} — set up your client` });
const openSettings = () => makeWindow('settings', 'settings.html', { width: 650, height: 800, title: `${productName()} — settings` });


// ---------------------------------------------------------------------------
// Installing a mod
// ---------------------------------------------------------------------------

// One folder, named for the mod. Anything else is a zip somebody built by
// selecting the files instead of the directory, and unpacking it would strew
// db/ and npc/ across the mods root.
function singleTopLevel(names) {
	const tops = new Set(names.map(n => n.split('/')[0]).filter(Boolean));
	return tops.size === 1 ? [...tops][0] : null;
}

// Refuse anything that would land outside the destination: `../`, an absolute
// path, or a drive letter. Zip-slip is the classic way an unpack becomes an
// arbitrary write.
function safeEntryName(name) {
	if (!name || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return null;
	const parts = name.split('/');
	if (parts.some(p => p === '..')) return null;
	return name;
}

async function installModFrom(src) {
	const dest = path.join(stateDir(), 'mods');
	fs.mkdirSync(dest, { recursive: true });

	let name;
	if (fs.statSync(src).isDirectory()) {
		name = path.basename(src);
		const target = path.join(dest, name);
		if (fs.existsSync(target)) throw new Error(`${name} is already installed. Remove it first.`);
		fs.cpSync(src, target, { recursive: true });
	} else {
		// `ditto` on macOS, `tar` elsewhere: both ship with the OS, and neither
		// needs a zip library in the app. Unpacked to a scratch directory first
		// so nothing lands in mods/ until it has been checked.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-'));
		try {
			const { execFileSync } = require('child_process');
			if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', src, tmp]);
			else execFileSync('tar', ['-xf', src, '-C', tmp]);

			const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true })
				.flatMap(e => e.isDirectory()
					? walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
					: [rel ? `${rel}/${e.name}` : e.name]);
			const entries = walk(tmp).filter(n => !n.split('/').some(p => p === '__MACOSX' || p.startsWith('._')));
			if (!entries.length) throw new Error('That archive is empty.');
			for (const e of entries) {
				if (!safeEntryName(e)) throw new Error(`Refusing ${src}: it contains an unsafe path (${e}).`);
			}
			name = singleTopLevel(entries);
			if (!name) throw new Error('A mod zip must contain exactly one folder, named for the mod.');
			const target = path.join(dest, name);
			if (fs.existsSync(target)) throw new Error(`${name} is already installed. Remove it first.`);
			fs.cpSync(path.join(tmp, name), target, { recursive: true });
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	// The supervisor is the authority on whether a mod is usable, so ask it
	// rather than re-implementing the manifest rules here. A mod that will be
	// refused is still installed -- the player may be about to switch era, and
	// deleting it would be worse -- but they are told now rather than after a
	// restart that appears to do nothing.
	let note = '';
	try {
		const rows = (await runStack(['mods'])).split('\n').filter(Boolean);
		const row = rows.map(l => l.split('\t')).find(r => r[1] === name);
		if (row && row[0] === 'refused') note = ` It will not load: ${row[3]}`;
	} catch { /* the supervisor may be unavailable; the install still stands */ }

	appLog(`installed mod ${name} from ${src}`);
	return `Installed ${name}.${note} Apply to restart the server.`;
}

// ---------------------------------------------------------------------------
// Sharing, and putting it back
// ---------------------------------------------------------------------------

// Set when the player stops sharing themselves, cleared when they start it by
// hand again. Since a connected domain resumes without being asked, this is
// what makes Stop mean stopped -- see auto-share.
let sharingStoppedByHand = false;

// The whole of "Share with friends", so that an automatic resume runs the same
// sequence as the button rather than a second, thinner version of it that
// drifts.
//
// `applyScope` is the only difference between the two callers. The button may
// be arriving from a server that is local-only or on the LAN, so it writes
// friends mode and cycles the stack to pick it up. A resume is already in
// friends mode -- that is one of the conditions for resuming at all -- and the
// stack it would cycle is the one that just came up.
async function shareWithFriends({ useDomain, applyScope }) {
	const request = ++sharingStartRequest;
	if (getClientPaths().mode !== 'host') throw Error('Start your own server before sharing.');
	const saved = useDomain ? getSharingSecrets().load() : null;
	if (useDomain && !saved) throw Error('Connect your Cloudflare domain first, or use a temporary session link.');
	// Securing this era's internal credentials is mechanical: it backs the
	// database up first and preserves every account and character. Refusing
	// here and telling the player to go find a button in another section is
	// what made "share with friends" feel like a maze, so just do it. Safe
	// to run from here -- sharing has not started, so runStack's stop-first
	// rule for this verb has nothing to interrupt.
	const era = getSettings().prerenewal ? 'prerenewal' : 'renewal';
	if (!fs.existsSync(path.join(stateDir(), 'private/service-credentials', era, 'credentials.json'))) {
		appLog('sharing: securing this era\u2019s internal service credentials (one time; the database is backed up first)');
		await runStack(['secure-services']);
	}
	// Account safeguards stay in force, but the signup policy is the
	// owner's to set. Sharing used to force it off and then hide the
	// resulting check failure, which made _M/_F unreachable over a link
	// even though the tunnel only carries invited friends.
	const policy = JSON.parse(await runStack(['hosting-check']));
	const missing = policy.checks.filter(check => !check.passed);
	if (missing.length) throw Error(missing.map(check => check.detail).join(' '));
	if (applyScope) await saveSettings({ hosting_scope: 'friends' });
	await assetsStart();
	if (request !== sharingStartRequest) return getSharing().status();
	await getSharing().start(saved);
	return getSharing().status();
}

// Put sharing back on after something stopped it. The conditions are in
// sharing/auto-share.js; this is the plumbing around them.
//
// Queued and not awaited, on purpose. The operation that just finished is what
// the player is waiting on, and a tunnel takes tens of seconds to come up, so
// this chains itself behind that operation and then reports through the sharing
// panel exactly like a manual start -- because it is one. Nothing about the
// triggering operation succeeds or fails on the strength of it.
//
// The generation is read now and checked again when the turn comes: a Stop, a
// crash, a suspend or a share started by hand in between all move it, and each
// of those is a reason to drop a resume that was decided before it happened.
function resumeSharing(reason) {
	const generation = sharingStartRequest;
	// Asked at both ends rather than once: the mode, the scope and a
	// Stop can all have happened by the time the queue reaches this, and the
	// answer that matters is the one at that moment.
	const assess = () => {
		const client = getClientPaths();
		// The secure store is opened only once the cheap conditions agree.
		// This runs after every server operation, and asking the operating
		// system to unlock a credential to answer a question already settled is
		// both slow and a source of failures that have nothing to do with
		// sharing. The repeated conditions are a guard on that lookup, not a
		// second opinion: auto-share still decides.
		let configured = false;
		if (client.mode === 'host' && client.hosting_scope === 'friends') {
			try {
				configured = !!getSharingSecrets().load();
			} catch (error) {
				// A domain is configured but its credential cannot be
				// unlocked. Carrying on with `configured: false` would read as
				// "no domain", which is a quiet refusal -- and this is worth
				// saying, because the host is expecting their link to be up.
				return { share: false, reason: error.message };
			}
		}
		return require('./sharing/auto-share').decide({
			mode: client.mode,
			scope: client.hosting_scope,
			state: sharing ? sharing.state : 'stopped',
			configured,
			stoppedByHand: sharingStoppedByHand,
			quitting: tearingDown,
		});
	};
	let decision;
	// A settings.json or client.json the store refuses is reported by every
	// other path that reads them; this one just does nothing about it.
	try { decision = assess(); } catch (error) { return appLog(`sharing: automatic resume skipped: ${error.message}`); }
	if (!decision.share) {
		// Silent on the installs that were never going to share, which is most
		// of them: a line after every server operation saying that nothing
		// happened is a line nobody can read past.
		if (!decision.quiet) appLog(`sharing: not resuming automatically (${decision.reason})`);
		return;
	}
	appLog(`sharing: resuming automatically ${reason} (${decision.reason})`);
	queueServerOperation(() => {
		if (generation !== sharingStartRequest) {
			return appLog('sharing: automatic resume dropped; sharing changed while it waited');
		}
		const now = assess();
		if (!now.share) return appLog(`sharing: automatic resume dropped (${now.reason})`);
		return shareWithFriends({ useDomain: now.useDomain, applyScope: false });
	}).catch(error => appLog(`sharing: automatic resume failed: ${error.message}`));
}

// ---------------------------------------------------------------------------
// IPC — every name the pages can call, reached via window.__ELECTRON__.core
// ---------------------------------------------------------------------------

const handlers = {
	// stack.sh
	stack_up: () => runStack(['up']),
	stack_down: () => runStack(['down']),
	stack_status: () => runStack(['status']),

	// Mods
	// Registry pictures already fetched this session, keyed by digest.
	// (declared below as a module-level binding)
	// The registry: an index of reviewed mods in a GitHub repository. Listed
	// on demand rather than cached, because the interesting failure is a stale
	// list showing a mod that has since been taken down.
	list_registry_mods: async () => {
		const registry = require('./mod-registry');
		return registry.list({ url: process.env.RAGNAROK_MOD_INDEX || registry.DEFAULT_INDEX });
	},
	// Pictures come through here rather than being loaded by the settings
	// window: it is a privileged page, and a list nobody reviewed should not
	// get to decide what addresses it reaches. Cached by digest, so a list of
	// a hundred icons is fetched once per session.
	registry_image: async ({ name, path: relative }) => {
		const registry = require('./mod-registry');
		registryImages = registryImages || new Map();
		return registry.image(name, relative, {
			url: process.env.RAGNAROK_MOD_INDEX || registry.DEFAULT_INDEX,
			cache: registryImages,
		});
	},
	install_registry_mod: async ({ name }) => {
		const registry = require('./mod-registry');
		const result = await registry.install(name, {
			url: process.env.RAGNAROK_MOD_INDEX || registry.DEFAULT_INDEX,
			modsDir: path.join(stateDir(), 'mods'),
		});
		appLog(`installed mod ${result.name} ${result.version} (${result.files} files)`);
		return result;
	},
	list_mods: async () => {
		const out = await runStack(['mods']);
		// Tab-separated, in the order mods.rs writes them. `refused` is its own
		// state rather than a flavour of off: the player did not switch it off,
		// the app would not run it, and the difference is the whole point of
		// having a reason to show.
		return out.split('\n').filter(Boolean).map(l => {
			const [state, name, description, reason, origin, version, author, grants, settings, problems] = l.split('\t');
			return {
				name,
				enabled: state === 'on',
				refused: state === 'refused',
				description: description || '',
				reason: reason || '',
				bundled: origin === 'bundled',
				version: version || '',
				author: author || '',
				// Supplies groups.yml or atcommands.yml, so it decides what
				// commands players get. Said next to the checkbox because a
				// mod's own description is not a trustworthy place to learn it.
				grantsCommands: grants === 'grants-commands',
				// Options the mod declared in its mod.json, each with the value
				// in force. Absent for a mod that declares none, and for an
				// older supervisor that does not write the field at all.
				settings: (() => {
					try { return JSON.parse(settings || '[]'); } catch { return []; }
				})(),
				// What the game server said about this mod's own tables the
				// last time it started. A mod can be switched on, have every
				// other layer in effect, and have had its db/ thrown away with
				// only a line in a log nobody opens to say so -- which is the
				// failure this carries out to Settings.
				problems: (() => {
					try { return JSON.parse(problems || '[]'); } catch { return []; }
				})(),
			};
		});
	},
	set_mod_enabled: ({ name, enabled }) =>
		runStack([enabled ? 'mod-enable' : 'mod-disable', name]),
	// Values reach the supervisor as one JSON argument; it validates them
	// against what the mod actually declares before writing anything. The
	// client only reads them when its config is regenerated, so rebuild the
	// asset overlay here rather than leaving the game showing stale options.
	set_mod_settings: async ({ name, values }) => {
		await runStack(['mod-settings', String(name), JSON.stringify(values ?? {})]);
		if (clientComplete(getClientPaths())) await linkClient(getClientPaths());
		return { applied: true };
	},
	// Install a mod from a folder or a .zip the player chose.
	//
	// A mod is not data: it drops scripts and tables into the server's paths and
	// can ship JavaScript that the game page executes. Installing one is running
	// somebody's code, so this checks before it moves anything, and unpacks
	// defensively.
	install_mod: async () => {
		const picked = await handlers.__dialog_open({
			filters: [{ name: 'Mod folder or .zip', extensions: ['zip'] }],
		});
		if (!picked) return 'Cancelled.';
		const src = Array.isArray(picked) ? picked[0] : picked;
		return installModFrom(src);
	},
	open_mods_folder: () => {
		const dir = path.join(stateDir(), 'mods');
		fs.mkdirSync(dir, { recursive: true });
		shell.openPath(dir);
		return dir;
	},
	// The data folder itself: characters, settings, logs, crash reports and
	// the staged backups all live under it, and it is the thing a bug report
	// or a manual backup actually wants. dataRoot(), not stateDir() -- the
	// player is looking for the whole install, not one directory inside it.
	open_data_folder: () => {
		const dir = dataRoot();
		fs.mkdirSync(dir, { recursive: true });
		shell.openPath(dir);
		return dir;
	},

	// One file a player can attach to a bug report.
	//
	// Reading a server log otherwise means knowing the app's private
	// NEBULA_HOME, the path to a bundled nebula binary and a docker subcommand
	// -- which is not a reasonable thing to ask of anyone, and was not
	// reasonable to ask of the maintainer either. Every report so far has
	// arrived without the one thing that would have explained it.
	collect_diagnostics: async () => {
		const lines = [];
		const add = (title, body) => lines.push(`===== ${title} =====\n${body}\n`);

		// Last N lines without reading the file. nebulad.log has been seen at
		// 72 MB, and the destination for all of this is a comment box.
		const tail = (file, wantLines) => {
			try {
				const size = fs.statSync(file).size;
				const span = Math.min(size, 512 * 1024);
				const buf = Buffer.alloc(span);
				const fd = fs.openSync(file, 'r');
				fs.readSync(fd, buf, 0, span, size - span);
				fs.closeSync(fd);
				const text = buf.toString('utf8');
				const all = text.split('\n');
				// Drop the first line when the window started mid-line.
				if (span < size) all.shift();
				const kept = all.slice(-wantLines).join('\n');
				return size > span
					? `(last ${wantLines} lines of ${Math.round(size / 1024)} KB)\n${kept}`
					: kept;
			} catch (e) {
				return `could not read: ${e.message}`;
			}
		};

		const totalMib = Math.floor(os.totalmem() / (1024 * 1024));
		const freeMib = Math.floor(os.freemem() / (1024 * 1024));
		add('app', [
			// Both: the release is what a player can tell us ("I'm on 1.0.3")
			// and what a fix ships in, the commit is what actually built the
			// payload. A report carrying only the hash meant looking it up to
			// learn something the tag would have said outright.
			`version   ${app.getVersion()} (build ${readIfExists(path.join(projectRoot(), 'VERSION')) || 'unknown'})`,
			`platform  ${process.platform} ${process.arch}`,
			// Which Windows, and whose silicon. "win32 x64" and a core count
			// cost a whole diagnosis once: a player's guest would not boot,
			// the cause was AMD-specific timer emulation, and nothing in the
			// bundle said AMD -- they had to mention their processor in prose,
			// and only after several wrong answers.
			`os        ${osDescription()}`,
			`cpu       ${cpuDescription()}`,
			`electron  ${process.versions.electron}`,
			`data      ${dataRoot()}`,
			// Host memory, because a virtual machine that will not boot on a
			// small machine looks identical to one that will not boot at all,
			// and two reports have now arrived without it.
			`host ram  ${totalMib} MiB total, ${freeMib} MiB free`,
			`vm ram    ${getClientPaths().vm_ram_mib} MiB (default here: ${defaultVmRamMib()})`,

		].join('\n'));

		// What the host will and will not let the engine do: virtualisation,
		// and whether Smart App Control will load an unsigned binary at all.
		// Both are invisible from inside the app, both end in the same "the
		// virtual machine did not start", and neither was ever in a bundle --
		// so every report carried the symptom and none carried the cause. A
		// player on Windows 10 with an AMD chip and a hypervisor switched off
		// at boot produced a report indistinguishable from a feature that was
		// simply never ticked, and the advice we gave was for the wrong one.
		//
		// The supervisor writes its own section headers here, so that one
		// process answers both questions.
		try {
			lines.push(await runStack(['host-check']));
		} catch (e) {
			add('host', `could not read: ${e}`);
		}

		// Paths only: a client folder name is not a secret, and knowing whether
		// the GRFs were found is most of triage.
		const c = getClientPaths();
		add('client', Object.entries(c)
			.map(([k, v]) => `${k.padEnd(14)}${v === '' ? '(unset)' : v}`).join('\n'));
		add('settings', JSON.stringify(getSettings(), null, 2));
		add('Cloudflare sharing', JSON.stringify({
			state: sharing?.state || 'stopped',
			helper: require('./sharing/helper').helperDiagnostics(path.join(dataRoot(), 'sharing/helpers')),
		}, null, 2));

		// The addresses the listener check runs against, and what it last
		// found. Diagnostics carried neither, so a report saying the check had
		// failed gave no way to tell which interface it objected to -- and on
		// a machine with virtual adapters that is most of the question.
		try {
			const probe = require('./listener-probe');
			add('network', [
				`interfaces  ${probe.localAddresses().join(', ') || 'none (loopback only)'}`,
				`ports       ${probe.GAME_PORTS.join(', ')}`,
				'',
				lastListenerReport
					? probe.describe(lastListenerReport)
					: 'listener check has not run in this session',
			].join('\n'));
		} catch (e) {
			add('network', `could not read: ${e.message}`);
		}

		// What sharing actually did, including the helper download and
		// cloudflared's own output. The status block above says the current
		// state; this says how it got there.
		try {
			const file = path.join(dataRoot(), 'sharing', 'sharing.log');
			const body = fs.readFileSync(file, 'utf8').split('\n');
			add('sharing.log (tail)', body.slice(-80).join('\n'));
		} catch { /* never shared from this install */ }

		// Preserved map-server crashes. The container log above only carries
		// the run it is on, so a server that has died more than once loses
		// every earlier trace from it -- these are the retained copies, and
		// they are the whole reason the crash capture exists.
		try {
			const crashes = path.join(stateDir(), 'crashes');
			// Structured incident reports, and the raw server logs kept beside
			// them. Newest last, and only the last few in full: a server that
			// has died repeatedly would otherwise bury everything else.
			const listed = [];
			for (const [where, label] of [[path.join(crashes, 'reports'), 'report'], [crashes, 'log']]) {
				for (const name of fs.readdirSync(where).sort()) {
					const file = path.join(where, name);
					if (fs.statSync(file).isFile() && name.endsWith('.log')) listed.push({ file, name, label });
				}
			}
			if (listed.length) {
				add('preserved crashes', listed.map(e => `${e.label}: ${e.name}`).join('\n'));
				for (const entry of listed.slice(-3)) {
					add(`crash ${entry.label}: ${entry.name}`,
						fs.readFileSync(entry.file, 'utf8').slice(-40000));
				}
			}
		} catch { /* no crashes recorded */ }

		try {
			add('engine', await runStack(['status']));
		} catch (e) {
			add('engine', `could not read: ${e}`);
		}
		for (const svc of ['login', 'char', 'map', 'db']) {
			try {
				add(`${svc} server`, await runStack(['logs', svc, '200']));
			} catch (e) {
				add(`${svc} server`, `could not read: ${e}`);
			}
		}
		for (const f of ['app.log', 'assets.log']) {
			const p2 = path.join(stateDir(), f);
			if (fs.existsSync(p2)) {
				add(f, fs.readFileSync(p2, 'utf8').split('\n').slice(-200).join('\n'));
			}
		}

		// client.log is mostly one line per file the client loads, so the last
		// 200 lines of it are nearly always "Loading file" and never the part
		// that matters. Lift every warning and error out first -- a failure
		// here is usually a single line, thousands back.
		const clog = path.join(stateDir(), 'client.log');
		if (fs.existsSync(clog)) {
			const all = fs.readFileSync(clog, 'utf8').split('\n');
			const loud = all.filter(l => l.includes('[error]') || l.includes('[warning]'));
			const shown = loud.slice(-80);
			add('client.log (warnings and errors)', loud.length
				? `${loud.length} total${loud.length > shown.length
					? `, showing the last ${shown.length}` : ''}\n${shown.join('\n')}`
				: 'none');
			add('client.log (tail)', all.slice(-60).join('\n'));
		}

		// Which game files the player's Ragnarok folder does not have. Every
		// asset pack is a little different, and a file the client needs but
		// cannot read fails quietly: the game stops without an error, and the
		// server logs all look perfectly healthy. assets.log only says how many
		// were missing, never which -- so a report arrives reading "it just
		// won't connect" and there is no way to tell from it what is absent.
		const missing = path.join(stateDir(), 'assets', 'logs', 'missing-files.log');
		if (fs.existsSync(missing)) {
			const seen = new Set();
			for (const line of tail(missing, 400).split('\n')) {
				if (!line.trim()) continue;
				try {
					seen.add(JSON.parse(line).requestedPath);
				} catch {
					// A torn first line from the tail, or a format change.
					seen.add(line.trim());
				}
			}
			add('missing game files', seen.size
				? `${seen.size} distinct\n${[...seen].sort().join('\n')}`
				: 'none');
		}

		// The engine's own logs. When the virtual machine will not start there
		// are no server logs at all, and these are the only record of why --
		// which is exactly the report that is hardest to get out of someone.
		const nebulaLogs = path.join(path.join(dataRoot(), 'nebula'), 'logs');
		// vessel-console.worker-stderr.log is the one that answers "the guest
		// never booted". The krun backend runs the VMM in a separate worker
		// process and writes its stderr there precisely because a detached
		// spawn severs the usual inherit chain -- so when the worker dies at
		// startup, nebulad only sees a health probe that never answers and
		// reports a 20-second timeout, while the actual reason (a WHP
		// partition that could not be created, a hypervisor that is not
		// available) sits in that file. A report arrived with an empty console
		// log, a generic timeout, and this never collected.
		for (const [file, want] of [['nebulad.log', 200], ['vessel-console.log', 100],
		                            ['vessel-console.worker-stderr.log', 100],
		                            ['launchd.err.log', 60]]) {
			const p2 = path.join(nebulaLogs, file);
			if (fs.existsSync(p2)) {
				add(`nebula/${file}`, tail(p2, want));
			}
		}
		// Guest image sizes against what the shipped archives say they should
		// be. The report that led to this check could not distinguish a
		// hypervisor problem from a rootfs that antivirus had truncated.
		const gzSize = (f) => {
			try {
				const size = fs.statSync(f).size;
				const b = Buffer.alloc(4);
				const fd = fs.openSync(f, 'r');
				fs.readSync(fd, b, 0, 4, size - 4);
				fs.closeSync(fd);
				return b.readUInt32LE(0);
			} catch { return null; }
		};
		const nh = path.join(dataRoot(), 'nebula');
		const images = [
			['kernel', path.join(projectRoot(), 'guest/Image.gz'), path.join(nh, 'kernel/Image')],
			['rootfs', path.join(projectRoot(), 'guest/rootfs.img.gz'),
			 path.join(nh, 'images/rootfs-pristine.img')],
		].map(([what, src, dst]) => {
			const want = gzSize(src);
			const got = fs.existsSync(dst) ? fs.statSync(dst).size : null;
			const verdict = got === null ? 'not installed'
				: want === null ? 'cannot check'
				: got === want ? 'ok' : `DAMAGED (expected ${want})`;
			return `${what.padEnd(8)}${String(got ?? '-').padEnd(12)}${verdict}`;
		});
		add('guest images', images.join('\n'));

		// Whether the guest can hand memory back. macOS can; the krun backend
		// used on Windows and Linux logs a failure every cycle, which turns the
		// ceiling into something much closer to a reservation.
		const nlog = path.join(nebulaLogs, 'nebulad.log');
		if (fs.existsSync(nlog)) {
			const recent = tail(nlog, 400);
			const failed = (recent.match(/balloon set failed/g) || []).length;
			const ok = (recent.match(/balloon target updated/g) || []).length;
			add('ballooning', failed > 0
				? `NOT working: ${failed} failures in the last 400 log lines.\n`
				  + 'Guest memory is not returned to the host on this backend.'
				: ok > 0 ? `working (${ok} adjustments in the last 400 log lines)`
				: 'no balloon activity in the last 400 log lines');
		}

		const cfgToml = path.join(path.join(dataRoot(), 'nebula'), 'config.toml');
		if (fs.existsSync(cfgToml)) {
			add('nebula/config.toml', fs.readFileSync(cfgToml, 'utf8'));
		}
		return joinSession.redact(lines.join('\n'));
	},

	// Straight to the clipboard, because the destination is a text box on
	// GitHub or Reddit, not a folder.
	copy_diagnostics: async () => {
		const text = await handlers.collect_diagnostics();
		clipboard.writeText(text);
		return `Copied ${Math.round(text.length / 1024)} KB — paste it into the issue.`;
	},

	save_diagnostics: async ({ path: dest }) => {
		fs.writeFileSync(dest, await handlers.collect_diagnostics());
		return `Saved to ${dest}`;
	},

	// A prefilled issue, with the diagnostics already on the clipboard. GitHub
	// caps a prefilled body in the URL at a few KB, and a real log blows
	// through that, so the body is a placeholder telling them to paste.
	report_issue: async () => {
		const text = await handlers.collect_diagnostics();
		clipboard.writeText(text);
		const body = [
			'**What happened?**', '', '(describe it here)', '',
			'**What did you expect?**', '', '', '---', '',
			'Diagnostics are on your clipboard — paste them below this line',
			'(they contain your file paths and server logs, no passwords).',
			'', '',
		].join('\n');
		await shell.openExternal(
			'https://github.com/Flux159/ragnarokoffline.app/issues/new'
			+ `?title=${encodeURIComponent('')}&body=${encodeURIComponent(body)}`);
		return 'Diagnostics copied. Paste them into the issue that just opened.';
	},
	stack_repair: () => runStack(['repair']),
	secure_services: async () => {
		if (getClientPaths().mode !== 'host') throw new Error('Switch to your own server before securing its internal credentials.');
		const output = await runStack(['secure-services']);
		return output.match(/^Internal service credentials secured for (?:renewal|prerenewal)\..*$/m)?.[0]
			|| 'Internal service credentials secured. Player accounts and characters were preserved.';
	},
    sharing_token_help: () => shell.openExternal('https://dash.cloudflare.com/profile/api-tokens'),
    sharing_status: () => {
        let saved, configurationError = '';
        try { saved = getSharingSecrets().load(); } catch (error) { configurationError = error.message; }
        // The invitation itself, so Settings can show the link a friend
        // actually needs rather than the hostname alone -- a hostname on its
        // own looks copyable and is useless to whoever receives it. Only while
        // sharing, and only to the host's own window.
        let invitation = '';
        try { invitation = getSharing().invitation(); } catch { /* not sharing yet */ }
        return { configured: !!saved, ...getSharing().status(), configuredHostname: saved?.hostname || '', configurationError, invitation };
    },
    sharing_connect: async request => {
        if (getClientPaths().mode !== 'host') throw Error('Cloudflare setup belongs to your own server.');
        const secrets = getSharingSecrets(); secrets.requireStorage();
        if (secrets.load()) throw Error('Cloudflare is already connected. Forget the saved setup before choosing another hostname.');
        await require('./sharing/helper').ensureHelper(path.join(dataRoot(), 'sharing/helpers'));
        const saved = await require('./sharing/cloudflare').provision(request);
        try { secrets.save(saved); }
        catch {
            const api = require('./sharing/cloudflare').api;
            try {
                await api(request.apiToken, 'DELETE', `/zones/${saved.zoneId}/dns_records/${saved.dnsRecordId}`);
                await api(request.apiToken, 'DELETE', `/accounts/${saved.accountId}/cfd_tunnel/${saved.tunnelId}`);
            } catch { throw Error('Could not save setup or remove its Cloudflare records. Remove this hostname and its Ragnarok Offline tunnel in Cloudflare before retrying.'); }
            throw Error('Could not save Cloudflare setup. Check your secure password storage and disk permissions.');
        }
        return { hostname: saved.hostname };
    },
    // Starting by hand also withdraws any earlier Stop: the player has said
    // what they want twice now, and an automatic resume may act again.
    sharing_start: async ({ useDomain = false } = {}) => {
        sharingStoppedByHand = false;
        return shareWithFriends({ useDomain, applyScope: true });
    },
    // Remembered, so that applying a setting a minute later does not undo it.
    // Cleared by the next start, by hand or at the next launch.
    sharing_stop: async () => { sharingStoppedByHand = true; ++sharingStartRequest; await getSharing().stop(); return getSharing().status(); },
    sharing_copy: () => {
        clipboard.writeText(getSharing().invitation());
        // Say the figure actually in force rather than a number baked into the
        // sentence: this is configurable, and it was never Cloudflare's limit.
        const days = Number(getSettings().sharing_invite_days);
        if (days === 0) return 'Invitation copied. It works until you replace it or stop sharing.';
        const span = Math.min(30, Math.max(1, days || 7));
        return `Invitation copied. It works for ${span} day${span === 1 ? '' : 's'}, until you replace it, or until you stop sharing.`;
    },
    // The invitation is otherwise reused for the life of the install, so this
    // is the only thing that changes a link -- and it disconnects everyone
    // holding the old one, which is why the button is styled as destructive.
    sharing_replace: () => {
        getSharing().replaceInvitation();
        return 'New link created. The previous link stopped working and friends using it were disconnected.';
    },
    sharing_forget: async () => { sharingStoppedByHand = true; await getSharing().stop(); getSharingSecrets().forget(); return 'Saved credentials removed. The hostname and stopped tunnel remain in your Cloudflare account for you to remove there.'; },
	hosting_check: async () => {
		if (getClientPaths().mode !== 'host') throw new Error('Hosting checks belong to your own server.');
		return JSON.parse(await runStack(['hosting-check']));
	},
	db_backup: ({ path: p }) => runStack(['backup', p]),
	db_restore: ({ path: p }) => runStack(['restore', p]),

	// Re-link the client every start: a freshly materialised runtime has no GRF
	// generated assets or a private archive manifest yet, and only the setup window writes those.
	start_stack: async () => {
		const saved = getClientPaths();
		// Joining runs no engine, no containers and no asset server: the host
		// runs all of it. Confirm the host answers instead, so an unreachable
		// address fails here with something a player can act on rather than as
		// a blank window later.
		if (saved.mode === 'join') {
			fs.mkdirSync(stateDir(), { recursive: true });
			fs.writeFileSync(path.join(stateDir(), 'phase'), `Connecting to ${saved.join_host}…\n`);
			await prepareJoin(saved);
			fs.writeFileSync(path.join(stateDir(), 'phase'), 'Ready\n');
			return 'joined';
		}
		if (clientComplete(saved)) {
			fs.mkdirSync(stateDir(), { recursive: true });
			fs.writeFileSync(path.join(stateDir(), 'phase'), 'Indexing your client…\n');
			await linkClient(saved);
		}
		// Before the supervisor reads any of it, so a start always serves what
		// settings.json says rather than whatever was last written.
		writeSettingsFiles(getSettings());
		appLog('start_stack: running the supervisor');
		const out = await runStack(['up']);
		appLog('start_stack: supervisor finished, starting the asset server');
		// The asset server starts here, not in launch_game: the boot page polls
		// assets_ready() before it will navigate, so nothing would ever start it.
		await assetsStart();
		appLog('start_stack: asset server started');
		return out;
	},

	// Asset server
	assets_start: () => assetsStart(),
	assets_stop: () => { ++sharingStartRequest; return assetsStop(); },
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
			await prepareJoin(next);
			return 'joined';
		}
		if (!fs.existsSync(next.data_grf)) throw new Error('data.grf is not a file');
		// Only when one was given: absent is allowed, wrong is not.
		if (next.rdata_grf && !fs.existsSync(next.rdata_grf)) {
			throw new Error('rdata.grf is not a file');
		}
		if (Object.hasOwn(paths, 'lan')) {
			next.hosting_scope = paths.lan ? 'lan' : 'local';
			require('./settings-store').write(path.join(stateDir(), 'settings.json'),
				{ hosting_scope: paths.lan ? 'lan' : 'local' }, SETTINGS_DEFAULTS);
		}
		fs.writeFileSync(clientConfigPath(), JSON.stringify(next, null, 2));
		return linkClient(next);
	},

	// Host mode, LAN toggle, and the string a host gives out. Kept separate
	// from set_client_paths because switching mode must not require re-picking
	// a client that is already configured.
	get_mode: () => {
		const c = getClientPaths();
		return {
			mode: c.mode, lan: !!c.lan, hosting_scope: c.hosting_scope, join_host: c.join_host,
			// Only meaningful once the stack has run; before that there is no
			// endpoint.json and no address to give out.
			join_address: c.mode === 'host' && c.lan ? serveUrl(advertiseHost()) : '',
		};
	},
	set_mode: async ({ mode, lan, join_host }) => {
		const prev = getClientPaths();
		const next = { ...prev };
		if (mode !== undefined) next.mode = mode;
		if (lan !== undefined) next.lan = !!lan;
		// Provoke the macOS prompt here, next to the switch that needs it.
		if (lan === true && !prev.lan) await nudgeLocalNetworkPermission();
		if (join_host !== undefined) next.join_host = join_host ? joinSession.remember(join_host) : '';
		if (mode === 'join' && prev.mode !== 'join') await stopLocalHostForJoin();
		if (lan !== undefined) {
			next.hosting_scope = lan ? 'lan' : 'local';
			require('./settings-store').write(path.join(stateDir(), 'settings.json'),
				{ hosting_scope: lan ? 'lan' : 'local' }, SETTINGS_DEFAULTS);
		}
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
		return next;
	},
	scan_client_dir: ({ dir }) => scanClientDir(dir),
	get_settings: () => getSettings(),
	accounts: request => {
		if (getClientPaths().mode !== 'host') throw new Error('Accounts belong to the host. Switch to your own server to manage them.');
		return require('./accounts').runAccounts(stackBin(), stackEnv(), request);
	},
	host_ram_mib: () => Math.floor(require('os').totalmem() / (1024 * 1024)),
	// Whether idle guest memory comes back. vz (macOS) balloons; the krun
	// backend behind Windows and Linux does not, and is not expected to, so on
	// those the ceiling is in practice held for the life of the server.
	host_facts: () => ({
		total_mib: Math.floor(os.totalmem() / (1024 * 1024)),
		default_mib: defaultVmRamMib(),
		balloons: process.platform === 'darwin',
	}),
	get_vm_ram_mib: () => getClientPaths().vm_ram_mib,
	// Write only. The caller follows with save_settings, which restarts the
	// stack and so picks the new ceiling up -- doing it here as well would
	// restart the VM twice for one press of Apply.
	set_vm_ram_mib: ({ mib }) => {
		const next = { ...getClientPaths(), vm_ram_mib: Number(mib) };
		fs.writeFileSync(clientConfigPath(), JSON.stringify(next, null, 2));
		return next.vm_ram_mib;
	},
	save_settings: ({ settings }) => saveSettings(settings),
	// The preferences the app acts on itself. Written straight to
	// settings.json, and deliberately not server operations: nothing the
	// supervisor reads is involved, and going the usual way would restart the
	// whole stack to record which window opens next launch.
	//
	// The allowlist is the point. Every other key in settings.json changes how
	// the server runs and has to go through Apply, which regenerates its config
	// and restarts it; a setter that took any name would be a way around that.
	set_app_preference: ({ key, value }) => {
		if (!APP_PREFERENCES.has(key)) throw new Error(`${key} is not an app preference`);
		const on = !!value;
		require('./settings-store').write(path.join(stateDir(), 'settings.json'),
			{ [key]: on }, SETTINGS_DEFAULTS);
		return on;
	},

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
	open_crash_reports: async () => {
		const directory = path.join(stateDir(), 'crashes', 'reports');
		if (!fs.existsSync(directory)) throw new Error('No crash reports have been saved yet.');
		const error = await shell.openPath(directory);
		if (error) throw new Error('Could not open the crash reports folder.');
	},
	boot_failure: () => gameFailure,
	clear_boot_failure: () => { gameFailure = null; },
	open_game: () => {
		gameFailure = null;
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
	launch_game: async () => {
		const c = getClientPaths();
		// The host's asset server when joining, our own when hosting. Hardcoding
		// loopback here sent a joining player to a server that does not exist on
		// their machine.
		const base = c.mode === 'join' ? joinUrl(c.join_host) : 'http://127.0.0.1:3338';
		// Before the page loads, not after: the client reads its cache as it
		// boots, and clearing it out from under a running client would be a
		// race for no gain.
		if (c.mode !== 'join') await dropStaleClientCache();
		const win = openGame();
		try {
			await win.loadURL(c.mode === 'join' ? joinSession.url(base) : base + GAME_PATH);
		} catch (error) {
			if (error.code !== 'ERR_ABORTED') showGameFailure(win, 'The game page could not load. Check the host connection, then retry.');
			throw error;
		}
		win.setTitle(gameTitle());
	},

	// Dialogs — the return shape the pages branch on: a path string, an array
	// when multiple, null when cancelled.
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
// client.log is truncated per run: it is a record of this session's client,
// and the interesting part is always the run the player is complaining about.
let clientLogReady = false;
function clientLogStart() {
	if (clientLogReady) return;
	clientLogReady = true;
	try {
		const dir = stateDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'client.log'),
			`${new Date().toISOString()} client log started\n`);
	} catch {
		/* logging must never be the thing that breaks the app */
	}
}

const CLIENT_LOG_LEVELS = ['verbose', 'info', 'warning', 'error'];
let clientLogBytes = 0;
function clientLog(level, text, line, src) {
	text = joinSession.redact(text);
	src = joinSession.redact(src);
	// roBrowser logs a line per file it loads, and the DB alone is hundreds.
	// That volume is worth keeping -- comparing the loads that started against
	// the ones that finished is exactly how a stalled database is spotted --
	// but not without a ceiling.
	if (clientLogBytes > 4 * 1024 * 1024) return;
	try {
		const name = typeof level === 'number'
			? (CLIENT_LOG_LEVELS[level] || String(level))
			: String(level);
		const where = src ? ` (${String(src).split('/').pop()}:${line})` : '';
		const entry = `${new Date().toISOString()} [${name}] ${text}${where}\n`;
		clientLogBytes += entry.length;
		clientLogStart();
		fs.appendFileSync(path.join(stateDir(), 'client.log'), entry);
	} catch {
		/* as above */
	}
}

function appLog(line) {
	line = joinSession.redact(line);
	try {
		const dir = stateDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* logging must never be the thing that breaks the app */
	}
}

// What the *game* page is allowed to call.
//
// Every window this app opens shares one preload, and the game window is then
// navigated to whatever is serving the game — which, when the player joins a
// friend, is a page from somebody else's machine. Without this list that page
// could call any handler here: stop the local server, rewrite settings, restore
// a database from a path of its choosing, or hand `save_diagnostics` an
// arbitrary path to write to.
//
// So the bridge is split by where the page came from. The app's own windows are
// loaded from three exact bundled files and own the controls. The game is
// loaded over HTTP or HTTPS and gets only what is on this list.
//
// It is empty today because the game page needs nothing. Adding a name here is
// a decision about what a page served by a stranger may do to this machine —
// not a convenience.
const GAME_PAGE_HANDLERS = new Set([]);
// Includes settings writes before their supervisor call: an era marker must
// not change halfway through an account operation. Read-only status stays live.
const SERVER_OPERATIONS = new Set(['sharing_connect', 'sharing_start', 'sharing_forget', 'accounts', 'hosting_check', 'save_settings', 'set_mode', 'set_client_paths', 'start_stack',
	'stack_up', 'stack_down', 'stack_repair', 'secure_services', 'db_backup', 'db_restore']);
// The operations that must never be followed by an automatic resume. Sharing's
// own verbs answer for themselves, and `stack_down` is a server the player has
// just taken offline on purpose. Everything else in the set above leaves a
// running server behind it.
const NEVER_RESUMES_SHARING = new Set(['sharing_connect', 'sharing_start', 'sharing_forget', 'stack_down']);
let serverOperationQueue = Promise.resolve();
function queueServerOperation(operation) {
	if (tearingDown) return Promise.reject(new Error('The app is quitting; wait until the next launch.'));
	const pending = serverOperationQueue.then(operation);
	serverOperationQueue = pending.catch(() => {});
	return pending;
}

// Only our exact bundled top-level pages own the host controls. A generic
// file:// check would also grant them to any other local document.
function callerIsOwnPage(event) {
	const url = (event && event.senderFrame && event.senderFrame.url) || '';
	if (!event || !event.sender || event.senderFrame !== event.sender.mainFrame) return false;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'file:') return false;
		const filename = require('url').fileURLToPath(parsed);
		return ['index.html', 'setup.html', 'settings.html']
			.some(name => filename === path.join(__dirname, '..', 'src', name));
	} catch { return false; }
}

ipcMain.handle('invoke', async (event, name, args) => {
	if (!callerIsOwnPage(event) && !GAME_PAGE_HANDLERS.has(name)) {
		const from = (event && event.senderFrame && event.senderFrame.url) || 'unknown';
		appLog(`refused ${name} from ${from}`);
		throw new Error(`${name} is not available to this page`);
	}
	const fn = handlers[name];
	if (!fn) throw new Error(`unknown command: ${name}`);
	try {
		if (SERVER_OPERATIONS.has(name)) {
			const result = await queueServerOperation(async () => {
                if (sharing && ((name === 'accounts' && args?.action !== 'list') || ['set_mode', 'set_client_paths', 'save_settings', 'stack_repair', 'secure_services', 'db_restore'].includes(name))) await sharing.stop();
                return fn(args || {});
            });
			// Every operation above either stops sharing on the way in or
			// cycles the stack underneath it, and the server is back up by the
			// time one returns. This is the single place that offers it back,
			// rather than a call at the end of each handler that the next
			// handler forgets to copy. Only on success: a failed start is not
			// a server to share.
			if (!NEVER_RESUMES_SHARING.has(name)) resumeSharing(`after ${name}`);
			return result;
		}
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
const crashMonitor = new (require('./crash-monitor').CrashMonitor)({
	active: () => !tearingDown && assetServer.running && assetServer.current?.identity?.launchId,
	collect: () => queueServerOperation(() => !tearingDown && assetServer.running
		? runStack(['capture-crashes']) : ''),
	log: message => appLog(message),
	onCrash: services => {
        ++sharingStartRequest;
        if (sharing) sharing.stop().catch(() => {});
		const label = services.includes('map') ? 'Map server' : 'Game server';
		showGameFailure(windows.game, `${label} stopped unexpectedly. A private crash report was saved. Retry to restart the server and log in again.`);
	},
});
// Set when a launch arrives while we are quitting: see the second-instance
// handler. Guarded because two clicks must not queue two copies.
let relaunchQueued = false;

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
async function teardownAsync() {
    ++sharingStartRequest;
    if (sharing) await sharing.stop();
	await serverOperationQueue;
	try { await assetsStop(); } catch (error) { appLog(`asset shutdown failed: ${error.message}`); }
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
    if (sharing?.child) sharing.child.kill();
	assetServer.stopSync();
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

// One copy at a time. Two are not merely redundant: both drive the same
// microVM and the same containers, and both own the same Chromium profile.
// A player who quits and relaunches straight away gets exactly that, because
// quitting is not instant -- the first copy is still stopping the stack, and
// the second one starts on top of it. The report that made this obvious was
// "it forgot my volume and where I put my windows": the second copy read
// localStorage before the first had flushed it, then wrote its own stale view
// back over it on the way out.
//
// The database pays a higher price. Two supervisors racing over one data disk
// is how a MariaDB volume ends up with a redo log it cannot recover
// ("Missing FILE_CHECKPOINT"), which no amount of restarting or repairing
// fixes -- the characters are simply gone.
//
// app.exit, not app.quit: quit would run before-quit in the *second* copy,
// and its teardown would stop the stack the first copy is still using.
if (!app.requestSingleInstanceLock()) {
	app.exit(0);
} else {
	app.on('second-instance', () => {
		// Quitting is not instant -- the stack takes the better part of a
		// minute to stop -- and this copy holds the lock for all of it. A
		// player who closes the game and opens it again straight away would
		// otherwise get nothing at all: no window, no error, no clue that
		// anything happened, because the launch they just made ended in a
		// process that exited on the spot. They click again, and again, and
		// eventually one lands after this copy is gone.
		//
		// So take the click as what it plainly means and come back on our own
		// once the teardown is finished. app.relaunch only queues it; the
		// exit already scheduled is what carries it out.
		if (tearingDown) {
			if (!relaunchQueued) {
				relaunchQueued = true;
				app.relaunch();
			}
			return;
		}
		// Otherwise it is "show me the game", and the window already exists.
		const win = windows.game || BrowserWindow.getAllWindows()[0];
		if (win && !win.isDestroyed()) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
}

app.whenReady().then(() => {
	crashMonitor.start();
    powerMonitor.on('suspend', () => { ++sharingStartRequest; if (sharing) sharing.stop().catch(() => {}); });
	// Before anything reads a path: an existing install still has its data
	// under the old folder name.
	migrateDataRoot();
	// An AppImage installs nothing, so without this there is no icon to click
	// the second time -- see linux-desktop-entry.js. Idempotent, and it reports
	// rather than throws, because a launcher entry must never stop a launch.
	if (process.platform === 'linux') {
		const entry = installDesktopEntry();
		if (entry.installed) appLog(`desktop entry ${entry.updated ? 'updated' : 'written'}: ${entry.file}`);
		else if (entry.file) appLog(`desktop entry not written: ${entry.reason}`);
	}
	Menu.setApplicationMenu(buildMenu());

	// Joining loads the host's page directly, so nothing on the way there
	// would notice the host being down -- Electron would just render its own
	// "cannot be reached" page, which says nothing about which host or why.
	const c = getClientPaths();
	// Asked for by people who are in Settings more often than in the game. The
	// game window is not opened behind it -- opening both would defeat the
	// point, and Settings already has "Open game", which runs the same boot
	// page. Nothing is prepared here either, in either mode: the boot page owns
	// starting the server and reaching a host, whenever it is finally opened.
	if (openSettingsFirst()) {
		openSettings();
	} else if (c.mode === 'join' && c.join_host) {
		queueServerOperation(() => prepareJoin(c))
			.then(() => openGame())
			.catch(err => {
				dialog.showMessageBox({
					type: 'warning',
					message: `Could not connect to ${c.join_host}`,
					// Every button here is something to do about it. The old
					// dialog offered a settings window and a retry, so a player
					// whose friend was simply not online had nothing to press
					// -- while a whole offline game they own sat one setting
					// away.
					detail: `${err.reason || err.message}\n\n` +
						'You can wait for the host and try again, or play on this computer ' +
						'instead — your own server runs entirely offline.',
					buttons: ['Change address…', 'Play on this computer', 'Try anyway'],
					defaultId: 1,
					cancelId: 2,
				}).then(({ response }) => {
					if (response === 0) openSettings();
					// The boot page asks for the GRFs when there are none, so
					// a player who has only ever joined lands in setup rather
					// than on a host mode that cannot start.
					else if (response === 1) switchToHost();
					if (response !== 0) openGame();
				});
			});
	} else {
		openGame();
	}

	// Clicking the Dock icon with every window closed is the same question as
	// launching the app, so it gets the same answer.
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length) return;
		if (openSettingsFirst()) openSettings();
		else openGame();
	});
});

// Quit is a two-pass affair: the first pass cancels the quit, stops the stack
// in the background, and only then really exits. Without the cancel, Electron
// tears the process down while `stack.sh down` is still running and leaves four
// containers and a microVM behind.
// DOMStorage is written lazily: Chromium batches it and commits on its own
// schedule. Both exits below are immediate -- app.exit skips the normal quit
// path and process.exit skips Electron entirely -- so anything the player
// changed in the last seconds before quitting was still in memory and went
// with it. That is the whole of "it forgets my volume and where I put the
// windows": roBrowser saves those to localStorage the moment they change, and
// the save simply never reached disk.
function flushClientStorage() {
	saveTrackedWindows();
	try {
		session.defaultSession.flushStorageData();
	} catch {
		// Best effort; never worth failing a quit over.
	}
}

// Ask the game page to write its window layout before the process ends.
//
// roBrowser saves each window's position and size in that component's
// onRemove hook and nowhere else, so the layout reaches localStorage only
// when something removes the components -- a return to character select, or
// the page going away. Quitting from inside the game does neither: this
// process exits and takes the renderer with it, and nothing was ever written.
// The client exposes roPersistUI for exactly this call.
//
// Fire-and-forget on purpose. It runs in the renderer while the stack is
// still being torn down, which takes long enough for the write to land, and
// the flush before exit is what puts it on disk.
function persistClientUi() {
	for (const win of BrowserWindow.getAllWindows()) {
		if (win.isDestroyed()) continue;
		win.webContents
			.executeJavaScript('window.roPersistUI && window.roPersistUI(), 0')
			.catch(() => {});
	}
}

app.on('before-quit', e => {
	if (tearingDown) return; // second pass: let it go
	e.preventDefault();
	tearingDown = true;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.setTitle(`${productName()} — shutting down…`);
	}
	// Order matters: ask the page to write its layout, let the teardown run
	// (which is what gives that write time to happen), and only then flush and
	// exit. Flushing first would commit a localStorage that does not yet have
	// the layout in it.
	persistClientUi();
	saveTrackedWindows();
	teardownAsync().finally(() => {
		flushClientStorage();
		app.exit(0);
	});
});

app.on('window-all-closed', () => app.quit());

// A signal terminates the process without a before-quit, so `kill`, a logout or
// Ctrl-C would otherwise leave the whole stack running.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
	process.on(sig, () => {
		if (!tearingDown) {
			tearingDown = true;
			persistClientUi();
			teardownSync();
			flushClientStorage();
		}
		process.exit(0);
	});
}
