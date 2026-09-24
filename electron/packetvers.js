'use strict';
//
// The client versions this build can play: config/PACKETVERS, which is also
// what the rAthena image was built from. The supervisor reads the same file
// (compiled in, stack/src/packetver.rs), starts the server build for the
// chosen one and rewrites roBrowser's `packetver` to match.
//
// settings.json stores `packetver: null` for "whatever this app's default is",
// never the default's number: a saved number outlives the version that wrote
// it, and when a later app moves the default the install would stay on the
// old one -- or, once the old one is dropped from the list, refuse to start.

const fs = require('node:fs');
const path = require('node:path');

function parse(text) {
	return text.split('\n')
		.map(line => line.replace(/#.*/, '').trim())
		.filter(Boolean)
		.map((line, i) => {
			const [version, ...tag] = line.split(/\s+/);
			if (!/^\d{8}$/.test(version)) throw new Error(`config/PACKETVERS: not a packet version: ${version}`);
			return { version, tag: tag.join(' '), isDefault: i === 0 };
		});
}

function list(root) {
	return parse(fs.readFileSync(path.join(root, 'config/PACKETVERS'), 'utf8'));
}

// 20221005 -> "2022-10-05", which is how players and client downloads name it.
function dated(version) {
	return `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}`;
}

module.exports = { parse, list, dated };
