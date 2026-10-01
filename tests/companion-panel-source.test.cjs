// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guard against the failure mode that shipped once and stopped the client from
// loading at all: a client component reaching into another module's object at
// module scope, when that module is imported LATER in the engine's import order.
//
// Concretely, CompanionPanel is pulled in through BasicInfo (MapEngine line 85)
// while ChatBox is imported at line 34. The cycle BasicInfo -> BasicInfoCommon ->
// CompanionPanel -> ChatBox leaves the ChatBox binding uninitialised when
// CompanionPanel's body runs, so `ChatBox.addText = ...` at module scope threw
// during import and the game never started. The client only reported
// "Failed to load app: Online.js TypeError: Cannot read properties of undefined".
//
// This is deliberately structural rather than a full client load, because a build
// cannot catch it and loading the real client in a test is not practical.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMPONENT = path.join(ROOT, 'patches', 'CompanionPanel.js');

/** Imported bindings referenced at column 0 (i.e. outside any function). */
function moduleScopeImportedAccess(src) {
	const lines = src.split('\n');
	const names = [];
	for (const line of lines) {
		const m = line.match(/^import\s+(?:\{\s*([^}]+)\s*\}|([A-Za-z_$][\w$]*))\s+from/);
		if (!m) continue;
		if (m[1]) m[1].split(',').forEach(n => names.push(n.trim().split(/\s+as\s+/).pop()));
		if (m[2]) names.push(m[2]);
	}
	const found = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/^\S/.test(line)) continue;                       // indented => inside a function
		if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;         // comment
		if (/^import\b/.test(line)) continue;
		for (const name of names) {
			if (new RegExp(`^${name}\\s*\\.`).test(line)) {
				found.push({ line: i + 1, text: line.trim(), name });
			}
		}
	}
	return { found, names };
}

const src = fs.readFileSync(COMPONENT, 'utf8').replace(/\r\n/g, '\n');

test('CompanionPanel touches no imported binding at module scope', () => {
	const { found, names } = moduleScopeImportedAccess(src);
	assert.ok(names.length > 0, 'expected the component to import something');
	assert.deepStrictEqual(
		found.map(f => `line ${f.line}: ${f.text}`),
		[],
		'access at module scope runs while the import cycle is still resolving; move it into init()'
	);
});

test('the roster hook is installed from init(), not at module scope', () => {
	assert.match(src, /function installChatHook\s*\(/, 'installChatHook is missing');
	assert.match(
		src,
		/CompanionPanel\.init = function init\(\)\s*\{[\s\S]{0,200}?installChatHook\(\)/,
		'installChatHook must be called at the top of CompanionPanel.init()'
	);
});

test('the roster wire format matches what the server writes', () => {
	// population_engine_companion_list_raw writes:
	//   "@CP|%s|%s|%d|%d|%d|%d|%s|%d"
	//     name, job, base_level, active, favorite, live_level, live_job, pet switch
	//     (-1 = this job cannot have one, 0 = switched off, 1 = on)
	//   "@CPEND|%d"              (count)
	const engine = fs.readFileSync(
		path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp'),
		'utf8'
	).replace(/\r\n/g, '\n');
	assert.match(engine, /"@CP\|%s\|%s\|%d\|%d\|%d\|%d\|%s\|%d"/,
		'server @CP format changed (expected the 9-field form: the 9th is the pet switch)');
	assert.match(engine, /"@CPEND\|%d"/, 'server sentinel changed');
	// The client must consume exactly that prefix and that sentinel.
	assert.match(src, /'@CP'/, 'client no longer keys on the @CP prefix');
	assert.match(src, /startsWith\('@CPEND'\)/, 'client no longer recognises the sentinel');
	// The 8th field is optional: the client's length guard must still accept a
	// 7-field line so a client cannot break against an older map server.
	assert.match(src, /parts\.length < 7/, 'the client must still accept a 7-field (older) line');
});

test('the component is prepared at startup by the engine', () => {
	// Without this call the component has no _host, and the first button press
	// dies inside GUIComponent.toggle with a null-_host error that names the
	// symptom rather than the missing call.
	const patch = fs.readFileSync(path.join(ROOT, 'scripts', 'patch-client.sh'), 'utf8').replace(/\r\n/g, '\n');
	assert.match(
		patch,
		/CompanionPanel\.prepare\(\)/,
		'patch-client.sh must add CompanionPanel.prepare() to the engine prepare list'
	);
});

test('toggle() does not assume a prepared host', () => {
	const body = src.match(/CompanionPanel\.toggle = function toggle\(\) \{[\s\S]*?\n\};/);
	assert.ok(body, 'CompanionPanel.toggle not found');
	assert.match(
		body[0],
		/!this\._host/,
		'toggle() must handle a null _host, since append() prepares on demand'
	);
});
