'use strict';
// Unpacking a mod that arrived as a zip.
//
// One path for both ways a zip gets here -- one the player picked in Settings
// → Mods, and a release a registry entry points at -- so both get the same
// checks and neither can drift into being the lenient one.
//
// The unpacking itself is the operating system's (`ditto` on macOS, `tar`
// elsewhere): both ship with the OS and neither needs a zip library in the
// app. What this file adds is everything around it, done twice on purpose:
//
//   - before anything is written, the zip's own table of contents is read and
//     refused if it names a path outside the folder, a symbolic link, or more
//     bytes or files than the caller allows -- so a zip bomb is refused rather
//     than unpacked and then measured;
//   - after unpacking, the tree on disk is walked with lstat and checked
//     again, because that is what will actually be copied, and a format this
//     reader does not understand (zip64) must not be a way around the first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Refuse anything that would land outside the destination: `../`, an absolute
// path, or a drive letter. Zip-slip is the classic way an unpack becomes an
// arbitrary write.
function safeEntryName(name) {
	if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) return null;
	const parts = name.split(/[\\/]/);
	if (parts.some(p => p === '..')) return null;
	return name;
}

// One folder, named for the mod. Anything else is a zip somebody built by
// selecting the files instead of the directory, and unpacking it would strew
// db/ and npc/ across the mods root.
function singleTopLevel(names) {
	const tops = new Set(names.map(n => n.split('/')[0]).filter(Boolean));
	return tops.size === 1 ? [...tops][0] : null;
}

// Finder's resource-fork litter, which is not part of anybody's mod.
const litter = name => name.split('/').some(p => p === '__MACOSX' || p.startsWith('._') || p === '.DS_Store');

/**
 * The entries a zip says it holds, read from its central directory without
 * unpacking anything. Null when the archive uses a form this reader does not
 * handle (zip64, a split archive); the walk after unpacking still applies.
 */
function zipEntries(file) {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const tail = Math.min(size, 22 + 0xffff);
		const end = Buffer.alloc(tail);
		fs.readSync(fd, end, 0, tail, size - tail);
		let at = -1;
		for (let i = tail - 22; i >= 0; i--) {
			if (end.readUInt32LE(i) === 0x06054b50) { at = i; break; }
		}
		if (at < 0) throw new Error('That file is not a zip archive.');
		const count = end.readUInt16LE(at + 10);
		const length = end.readUInt32LE(at + 12);
		const offset = end.readUInt32LE(at + 16);
		if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) return null;
		if (end.readUInt16LE(at + 4) !== 0 || offset + length > size) return null;
		const directory = Buffer.alloc(length);
		fs.readSync(fd, directory, 0, length, offset);
		const entries = [];
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > length || directory.readUInt32LE(p) !== 0x02014b50) return null;
			const madeBy = directory.readUInt16LE(p + 4) >> 8;
			const unpacked = directory.readUInt32LE(p + 24);
			const nameLength = directory.readUInt16LE(p + 28);
			const extraLength = directory.readUInt16LE(p + 30);
			const commentLength = directory.readUInt16LE(p + 32);
			const attributes = directory.readUInt32LE(p + 38);
			if (unpacked === 0xffffffff) return null;
			const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
			// Unix permissions live in the high half of the external
			// attributes; S_IFLNK there is a link the unpacker will recreate.
			const mode = (attributes >>> 16) & 0o170000;
			entries.push({ name, size: unpacked, symlink: madeBy === 3 && mode === 0o120000,
				directory: name.endsWith('/') });
			p += 46 + nameLength + extraLength + commentLength;
		}
		return entries;
	} finally {
		fs.closeSync(fd);
	}
}

function checkLimits(files, bytes, { maxBytes, maxFiles }, label) {
	if (files > maxFiles) throw new Error(`Refusing ${label}: it holds more than ${maxFiles} files.`);
	if (bytes > maxBytes) throw new Error(`Refusing ${label}: it unpacks to more than ${Math.round(maxBytes / 1048576)} MB.`);
}

function unpackWithOs(src, into) {
	if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', src, into]);
	// On Windows, by full path: Git's GNU tar is often first on PATH, and it
	// reads `C:` as a remote host and cannot open a zip at all (#174).
	else if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', src, '-C', into]);
	else {
		// GNU tar, which is what `tar` is on most Linux systems, cannot read
		// a zip at all; libarchive's bsdtar (SteamOS has it) and Info-ZIP's
		// unzip can. Tried in that order, GNU tar last for anything else.
		const tries = [['bsdtar', ['-xf', src, '-C', into]], ['unzip', ['-q', '-o', src, '-d', into]], ['tar', ['-xf', src, '-C', into]]];
		let last;
		for (const [tool, args] of tries) {
			try { execFileSync(tool, args, { stdio: 'ignore' }); return; } catch (e) {
				last = e;
				if (e.code !== 'ENOENT') break;
			}
		}
		throw new Error(`Could not unpack the zip (${(last && last.message) || 'no unzip tool found'}).`);
	}
}

/** Every regular file under `dir`, relative and with `/`; links are refused. */
function walk(dir, label, rel = '') {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const relative = rel ? `${rel}/${entry.name}` : entry.name;
		const full = path.join(dir, entry.name);
		const stat = fs.lstatSync(full);
		if (stat.isSymbolicLink()) throw new Error(`Refusing ${label}: it contains a link (${relative}).`);
		if (stat.isDirectory()) out.push(...walk(full, label, relative));
		else if (stat.isFile()) out.push({ path: relative, size: stat.size });
		else throw new Error(`Refusing ${label}: ${relative} is not an ordinary file.`);
	}
	return out;
}

/**
 * Unpack `src` into a new scratch directory and check what came out.
 *
 * Returns `{ dir, files }`; the caller owns `dir` and removes it. Nothing is
 * left behind when this throws.
 */
function unpack(src, { maxBytes = 2 * 1024 ** 3, maxFiles = 50000, label = src } = {}) {
	const listed = zipEntries(src);
	if (listed) {
		const real = listed.filter(e => !litter(e.name));
		for (const e of real) {
			if (!safeEntryName(e.name.replace(/\/$/, ''))) throw new Error(`Refusing ${label}: it contains an unsafe path (${e.name}).`);
			if (e.symlink) throw new Error(`Refusing ${label}: it contains a link (${e.name}).`);
		}
		const files = real.filter(e => !e.directory);
		checkLimits(files.length, files.reduce((sum, e) => sum + e.size, 0), { maxBytes, maxFiles }, label);
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-mod-'));
	try {
		unpackWithOs(src, dir);
		for (const name of fs.readdirSync(dir)) {
			if (litter(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
		}
		const files = walk(dir, label).filter(f => !litter(f.path));
		if (!files.length) throw new Error('That archive is empty.');
		for (const f of files) {
			if (!safeEntryName(f.path)) throw new Error(`Refusing ${label}: it contains an unsafe path (${f.path}).`);
		}
		checkLimits(files.length, files.reduce((sum, f) => sum + f.size, 0), { maxBytes, maxFiles }, label);
		return { dir, files: files.map(f => f.path) };
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}

/** Copy a checked tree, leaving Finder's litter behind. */
function copyTree(from, to) {
	fs.cpSync(from, to, { recursive: true, filter: source => !litter(path.basename(source)) });
}

module.exports = { unpack, zipEntries, safeEntryName, singleTopLevel, copyTree, litter };
