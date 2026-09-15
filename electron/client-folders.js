'use strict';
//
// The client folders nobody picks.
//
// The setup screen asks for data.grf, rdata.grf, official_data.grf and BGM.
// link-assets then takes two more on its own, from the folder holding data.grf
// or its dll_exe/ (`link` in stack/src/assets.rs):
//
//   System/  the client's own tables, filling whatever the translation lacks
//   AI/      homunculus and mercenary AI, served straight from the folder
//
// Nothing on screen said so, and a client without AI/ ran with no homunculus AI
// and no word as to why. This repeats that lookup so the setup screen and
// Settings can show it. Keep the two in step: if assets.rs looks somewhere new,
// so must this.
//
const fs = require('fs');
const path = require('path');

function firstDir(candidates) {
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch { /* not there */ }
	}
	return '';
}

// An empty string for a folder that is not there, matching how the chosen
// paths read when unset.
function clientFolders(dataGrf) {
	if (!dataGrf) return { system_dir: '', ai_dir: '' };
	const dir = path.dirname(dataGrf);
	const find = name => firstDir([path.join(dir, name), path.join(dir, 'dll_exe', name)]);
	return { system_dir: find('System'), ai_dir: find('AI') };
}

module.exports = { clientFolders };
