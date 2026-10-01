// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
// Guards for the party_send_xy_timer SIGSEGV (exit 139) that killed the map server
// when the player teleported to Prontera.
//
// The crash frame was explicit:
//   RAGNAROK_CRASH_FRAME index=0x0 function=_Z19party_send_xy_timerilil+0x8c
// and the log showed the death-release lines immediately before it.
//
// Mechanism: pop_companion_register_local_party() moved a shell into a new party
// without leaving the old one. The roster is shared across the owner's characters,
// so switching characters (Jews -> radiator) re-runs the recall and moves every
// companion into the newly logged-in character's party - and the shell then had a
// data[].sd pointer in BOTH. shell_release() scrubs only party_search(
// status.party_id), i.e. the new party; party_send_xy_timer iterates EVERY party in
// party_db and dereferences data[i].sd after only a null check, so the stale
// pointer in the abandoned party was dereferenced after the shell was freed.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'third-party', 'population-engine', 'files', 'src', 'map', 'population_engine.cpp');
const src = fs.readFileSync(ENGINE, 'utf8').replace(/\r\n/g, '\n');

test('registering a companion into a party leaves the party it came from', () => {
	const i = src.indexOf('static void pop_companion_register_local_party(map_session_data *sd, map_session_data *owner)\n{');
	assert.ok(i > 0, 'register_local_party not found');
	const body = src.slice(i, i + 4200);

	assert.match(body, /sd->status\.party_id != party_id/,
		'the move must be detected (only a move needs the old party withdrawn from)');
	assert.match(body, /intif_party_leave\(old_party_id/,
		'the shell must LEAVE the old party, not just be repointed');
	assert.match(body, /party_member_withdraw\(old_party_id/,
		'and its member row must be withdrawn');
	assert.match(body, /struct party_data \*old_pd = party_search\(old_party_id\)/,
		'the old party struct must be resolved');
	assert.match(body, /old_pd->data\[slot\]\.sd = nullptr/,
		'and the data[] slot pointing at this shell must be nulled - this is the '
		+ 'dangling pointer party_send_xy_timer dereferences');
});

test('the withdraw-on-move runs BEFORE the shell is pointed at the new party', () => {
	// Ordering matters: if status.party_id is overwritten first, the old party id is
	// lost and there is nothing left to withdraw from - which is precisely how the
	// bug shipped.
	const i = src.indexOf('static void pop_companion_register_local_party(map_session_data *sd, map_session_data *owner)\n{');
	const body = src.slice(i, i + 4200);
	const guard = body.indexOf('sd->status.party_id != party_id');
	const capture = body.indexOf('const int32 old_party_id = sd->status.party_id;');
	const assign = body.indexOf('\tsd->status.party_id = party_id;');
	assert.ok(guard > 0 && capture > guard && assign > capture,
		'the old party id must be captured and torn down before status.party_id is overwritten');
});

test('every party holding a shell is scrubbed on release, not just the current one', () => {
	// The release path is the other half: it must clear the data[] slot, and the
	// timer iterates all parties, so a leak in ANY party the shell was registered
	// into is fatal. This guards the original fix as well as the new one.
	const i = src.indexOf('void population_engine_shell_release(map_session_data* sd)');
	assert.ok(i > 0, 'shell_release not found');
	const body = src.slice(i, i + 4500);
	assert.match(body, /pd->data\[slot\]\.sd = nullptr/,
		'release must null the data[] slot that pointed at the shell');
	assert.match(body, /pd->data\[slot\]\.x = 0/,
		'and zero the cached position the timer compares against');
});
