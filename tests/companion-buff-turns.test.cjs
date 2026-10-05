// Guards for companion buffs reaching the player (#290 testing).
//
// A cast trace of an Arch Bishop companion showed Increase AGI tried 31 times and cast 6: each
// tick ran the self buffs first, and when one started casting, the ally buffs tried in the same
// tick were refused (already casting, or in the after-cast delay). The commonest refusal, 60 for
// Suffragium alone, was "skill interval": self buffs tried while on their own cooldown. And the
// ally a buff went to was whoever the map listed first, so in a party of companions the player was
// often buffed last. Both passes now wait while the caster cannot act, skip a skill on cooldown,
// and an ally buff goes to the owner first, then other players, then companions.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const combat = fs.readFileSync(path.join(__dirname, '..', 'third-party', 'population-engine', 'files', 'src',
	'map', 'population_engine', 'runtime', 'population_engine_combat.cpp'), 'utf8').replace(/\r\n/g, '\n');

function fn(name) {
	const start = combat.indexOf(name);
	assert.ok(start >= 0, `${name} must exist`);
	return combat.slice(start, combat.indexOf('\n}\n', start));
}

test('neither buff pass casts while the caster cannot act, or a skill on cooldown', () => {
	for (const name of ['static bool population_shell_cast_expired_self_buffs(',
		'static bool population_shell_cast_ally_attack_skill(']) {
		const body = fn(name);
		assert.match(body, /sd->ud\.skilltimer != INVALID_TIMER \|\| DIFF_TICK\(current_tick, sd->ud\.canact_tick\) < 0/, name);
		assert.match(body, /sd->scd\.find\((bs|sk)\.skill_id\) != sd->scd\.end\(\)/, name);
	}
});

test('an ally buff goes to the owner first, then players, then companions', () => {
	const rank = fn('static int pop_ally_rank(');
	assert.match(rank, /ally->status\.account_id == shell->pop\.companion_owner_account\)\s*return 0;/);
	assert.match(rank, /population_engine_is_population_pc\(ally->id\) \? 2 : 1/);
	const offer = fn('static int32 pop_ally_offer(');
	assert.match(offer, /rank < ctx->result_rank/);
	assert.match(offer, /return rank == 0 \? 1 : 0;/, 'the scan stops only at the owner');
	for (const cb of ['static int32 pop_ally_status_scan_cb(', 'static int32 pop_ally_any_scan_cb(']) {
		const body = fn(cb);
		assert.match(body, /return pop_ally_offer\(ctx, ally\);/, cb);
		assert.doesNotMatch(body, /ctx->result = ally;/, `${cb} must not take the first ally`);
	}
});

// A GM's @hide (OPTION_INVISIBLE) makes the owner untargetable: every buff aimed at them was refused,
// and with the owner first in line nobody else got one either.
test('an ally nobody can target is passed over', () => {
	const body = fn('static bool pop_ally_untargetable(');
	assert.match(body, /pc_isinvisible\(ally\)/);
	assert.match(body, /OPTION_HIDE \| OPTION_CLOAK \| OPTION_CHASEWALK/);
	for (const cb of ['static int32 pop_ally_hp_scan_cb(', 'static int32 pop_ally_status_scan_cb(',
		'static int32 pop_ally_any_scan_cb('])
		assert.match(fn(cb), /if \(pop_ally_untargetable\(ally\)\) return 0;/, cb);
});

test('a companion heals and buffs its own side, not passing AI players', () => {
	const body = /static bool pop_shell_may_help\([^)]*\)\n\{([\s\S]*?)\n\}/.exec(combat);
	assert.ok(body, 'pop_shell_may_help must exist');
	assert.match(body[1], /ally->status\.account_id == shell->pop\.companion_owner_account/, 'its owner, party or not');
	assert.match(body[1], /shell->pop\.companion_owner_account == 0\s*\|\| ally->pop\.companion_owner_account == shell->pop\.companion_owner_account/,
		'ambient shells help any shell; a companion only its owner\'s');
	for (const cb of ['pop_ally_hp_scan_cb', 'pop_ally_status_scan_cb', 'pop_ally_any_scan_cb']) {
		const m = new RegExp(`static int32 ${cb}\\([^)]*\\)\\n\\{([\\s\\S]*?)\\n\\}`).exec(combat);
		assert.ok(m && /if \(!pop_shell_may_help\(ctx->shell, ally\)\)/.test(m[1]), cb);
		assert.ok(!/ally->state\.population_combat && !pop_is_party_ally/.test(m[1]), `${cb} drops the old any-shell rule`);
	}
});

test('Devotion skips allies rAthena would refuse it on', () => {
	const body = /static bool pop_ally_devotion_refused\([^)]*\)\n\{([\s\S]*?)\n\}/.exec(combat);
	assert.ok(body, 'pop_ally_devotion_refused must exist');
	assert.match(body[1], /battle_config\.devotion_level_difference/, 'the level gap');
	assert.match(body[1], /dev->val1 != shell->id/, 'devoted by another Crusader');
	assert.match(body[1], /MAPID_CRUSADER/);
	assert.match(body[1], /shell->devotion\[i\] == ally->id \|\| shell->devotion\[i\] == 0/, 'a free slot');
	for (const cb of ['pop_ally_hp_scan_cb', 'pop_ally_status_scan_cb', 'pop_ally_any_scan_cb']) {
		const m = new RegExp(`static int32 ${cb}\\([^)]*\\)\\n\\{([\\s\\S]*?)\\n\\}`).exec(combat);
		assert.ok(m && /if \(pop_ally_skill_refused\(ctx->shell, ally, ctx->skill_id\)\) return 0;/.test(m[1]), cb);
	}
	assert.match(combat, /case CR_DEVOTION:\n\t\treturn pop_ally_devotion_refused\(shell, ally\);/, 'Devotion keeps its own checks');
});
