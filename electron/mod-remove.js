'use strict';
//
// Which folder "Remove" is allowed to take away.
//
// The name comes from the Settings page, and the page got it from a line the
// supervisor printed about a folder somebody else built. So it is checked here
// as if it were hostile: one plain folder name, sitting directly in the mods
// directory, and a real directory rather than a link. A link would send the
// trash after whatever it points at, which is not the mod.
//
const fs = require('node:fs');
const path = require('node:path');

function modFolder(modsDir, name) {
	if (typeof name !== 'string' || !name || name === '.' || name === '..'
		|| /[\\/\0]/.test(name) || /^[a-zA-Z]:/.test(name)) {
		throw new Error('That is not a mod name.');
	}
	const root = path.resolve(modsDir);
	const target = path.join(root, name);
	if (path.dirname(target) !== root) throw new Error('That is not a mod name.');
	let stat;
	try {
		stat = fs.lstatSync(target);
	} catch {
		throw new Error(`${name} is not in the mods folder. It may already have been removed.`);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${name} is not a plain folder in the mods folder, so it was left alone. Remove it by hand from Open mods folder.`);
	}
	return target;
}

module.exports = { modFolder };
