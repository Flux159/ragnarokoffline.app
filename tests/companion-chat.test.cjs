// Guards for the two chat switches: Companion chat (companions in a player's party) and
// Population chat (every other shell), both in Settings -> Population, on by default.
//
// The risks these pin down: a speech path that forgets to ask which switch applies; the chat
// timer stopping for everyone when only one group is off; a companion's answer to its owner's
// command being silenced with the chatter; and the app not writing a switch, which would leave
// the engine's compiled default in charge.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const MAP = 'third-party/population-engine/files/src/map/';
const engine = read(MAP + 'population_engine.cpp');
const strategy = read(MAP + 'population_engine/strategy/population_strategy.cpp');
const roam = read(MAP + 'population_engine/runtime/population_companion_roam.cpp');
const patch = read('third-party/population-engine/patches/0039-companion-chat-switch.patch');
const settings = read('src/settings.html');
const main = read('electron/main.js');
const { lines, companionChat, shellChat } = require('../electron/population-conf');

const body = (src, signature) => {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `${signature} exists`);
	const open = src.indexOf('\n{', start);
	return src.slice(open, src.indexOf('\n}', open));
};

test('the companion switch is registered, on by default, 0 to 1', () => {
	assert.match(patch, /^\+\{ "population_engine_companion_chat_enable",&battle_config\.population_engine_companion_chat_enable,1,0,1,\},$/m);
	assert.match(patch, /^\+int32 population_engine_companion_chat_enable;$/m);
});

test('one helper picks the switch: companions theirs, every other shell the engine\'s own', () => {
	const helper = body(engine, 'static bool population_engine_shell_may_chat(const map_session_data *sd)');
	assert.match(helper, /pop_is_companion\(sd\) \? battle_config\.population_engine_companion_chat_enable != 0\s*: battle_config\.population_engine_chat_enable != 0;/);
});

test('every line a shell says of its own accord asks it', () => {
	const timer = engine.slice(engine.indexOf('TIMER_FUNC(population_engine_chat_timer)'), engine.indexOf('static bool population_engine_deliver_chat_reply_locked'));
	assert.match(timer, /if \(!battle_config\.population_engine_chat_enable && !battle_config\.population_engine_companion_chat_enable\)/,
		'the timer runs while either group may chat');
	assert.match(timer, /if \(!population_engine_shell_may_chat\(raw_sd\)\)\s*\/\/[^\n]*\n\s*continue;/, 'ambient lines');
	assert.match(body(engine, 'static bool population_engine_deliver_chat_reply_locked'),
		/!population_engine_shell_may_chat\(bot_sd\)/, 'replies to a name or a whisper');
	assert.match(body(engine, 'void population_engine_on_shell_kills_player'),
		/if \(!population_engine_shell_may_chat\(killer_sd\)\)/, 'kill taunts');
	const mention = body(engine, 'void population_engine_on_global_chat_mention');
	assert.match(mention, /!battle_config\.population_engine_chat_enable && !battle_config\.population_engine_companion_chat_enable/,
		'a mention still reaches companions while only the other shells are quiet');
	assert.match(body(strategy, 'static void say(Turn &t, const Rule &rule, const RuleState &rs, block_list *target)'),
		/companion \? battle_config\.population_engine_companion_chat_enable : battle_config\.population_engine_chat_enable/, 'strategy rule lines');
});

test('answers to the owner are not chatter', () => {
	assert.match(engine, /"%s : Understood\. My role is now %s\."/);
	assert.doesNotMatch(body(roam, 'void population_companion_on_down(map_session_data *sd)'), /chat_enable|may_chat/,
		'a roaming companion still says it is down');
});

test('both are settings in the app, on by default, and always written', () => {
	assert.match(main, /population_companion_chat: true,/);
	assert.match(main, /population_chat: true,/);
	for (const id of ['population_companion_chat', 'population_chat']) {
		assert.match(settings, new RegExp(`id="${id}"`));
		assert.match(settings, new RegExp(`settings\\.${id} = \\$\\('${id}'\\)\\.checked;`));
		assert.match(settings, new RegExp(`\\$\\('${id}'\\)\\.checked = s\\.${id} !== false;`),
			'a save from before these existed reads as on');
	}
	assert.equal(companionChat({}), 1);
	assert.equal(shellChat({}), 1);
	assert.equal(companionChat({ population_companion_chat: false }), 0);
	assert.equal(shellChat({ population_chat: false }), 0);
	const base = { population_enable: true, population_max: 100 };
	assert.match(lines(base), /^population_engine_companion_chat_enable: 1$/m);
	assert.match(lines(base), /^population_engine_chat_enable: 1$/m);
	const quiet = lines({ ...base, population_companion_chat: false, population_chat: false });
	assert.match(quiet, /^population_engine_companion_chat_enable: 0$/m);
	assert.match(quiet, /^population_engine_chat_enable: 0$/m);
});
