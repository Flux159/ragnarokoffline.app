// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guard: every component reference the patch script injects into an engine file
// must have a matching import in that same file.
//
// The bug this exists for: patch-client.sh inserted `CompanionPanel.prepare()`
// into MapEngine.js without adding the matching import. A bundler does not resolve
// bare identifiers, so it compiled cleanly and threw "CompanionPanel is not
// defined" the moment MapEngine.init ran. Because that throw is inside init(),
// everything after it was skipped - including ChatBox.onRequestTalk's assignment
// and the other UI engines' setup - so one missing import looked like three
// unrelated bugs and a half-built interface.
//
// Two traps this file has already fallen into, both worth remembering:
//   1. Matching the bare import string passes on the buggy commit, because the
//      BasicInfoCommon edit carries the same text. Assertions must be anchored to
//      the MapEngine edit specifically.
//   2. The script builds the inserted import by concatenation, so asserting a
//      literal two-line block fails on a correct patch. Assert on the pieces.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PATCH = path.join(ROOT, 'scripts', 'patch-client.sh');

const patch = fs.readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n');

// The MapEngine edit section: from the first mention of the file to the end of the
// script. Everything about the import/prepare coupling must live in here.
const mapEngine = patch.slice(patch.indexOf("src/Engine/MapEngine.js"));

const IMPORT_LITERAL = 'import CompanionPanel from \'UI/Components/CompanionPanel/CompanionPanel.js\';';
const ANCHOR_LITERAL = 'import Achievement from \'UI/Components/Achievement/Achievement.js\';';

test('the MapEngine edit defines the import it will insert', () => {
	assert.ok(mapEngine.length > 0, 'expected an edit section targeting MapEngine.js');
	assert.match(
		mapEngine,
		/NEEDS_IMPORT = "import CompanionPanel from 'UI\/Components\/CompanionPanel\/CompanionPanel\.js';"/,
		'the MapEngine edit must define NEEDS_IMPORT with the component import'
	);
});

test('the import is inserted after the Achievement import anchor', () => {
	assert.ok(
		mapEngine.includes(`anchor_import = "${ANCHOR_LITERAL}"`),
		'the import must be anchored on the existing Achievement import'
	);
	// The concatenation is how the actual insert is built; asserting a literal
	// two-line block here fails on a correct patch.
	assert.match(
		mapEngine,
		/s = s\.replace\(anchor_import, anchor_import \+ "\\n" \+ NEEDS_IMPORT, 1\)/,
		'the import must be inserted via the anchor and NEEDS_IMPORT'
	);
});

test('the prepare() call is emitted into the same file the import is added to', () => {
	assert.ok(mapEngine.includes('CompanionPanel.prepare();'), 'prepare() call must be in the MapEngine edit');
	assert.ok(mapEngine.includes('NEEDS_IMPORT'), 'the import must be applied in the same edit');
});

test('the patch refuses to emit a prepare() call without its import', () => {
	// The script's own drift guard, so a future edit cannot reintroduce the crash.
	assert.match(
		patch,
		/CompanionPanel\.prepare\(\) is called but CompanionPanel is not imported/,
		'patch-client.sh must fail loudly when the call and the import disagree'
	);
	assert.match(
		patch,
		/if "CompanionPanel\.prepare\(\)" in s and NEEDS_IMPORT not in s:/,
		'the drift guard must compare the call against NEEDS_IMPORT'
	);
});

test('the import is not only present in the BasicInfoCommon edit', () => {
	// Regression against the false-pass: the string exists in the BasicInfoCommon
	// edit on the buggy commit, so its presence alone proves nothing.
	const basicInfo = patch.slice(0, patch.indexOf("src/Engine/MapEngine.js"));
	if (basicInfo.includes(IMPORT_LITERAL)) {
		assert.ok(
			mapEngine.includes('NEEDS_IMPORT'),
			'the import appearing in the BasicInfoCommon edit does not satisfy the MapEngine edit'
		);
	}
});
