/**
 * UI/Components/CompanionPanel/CompanionPanel.js
 *
 * Companion management window.
 *
 * This is a real roBrowser GUIComponent, so it behaves like every other window
 * in the client: it is in the UIManager list, it is draggable by its title bar,
 * it remembers its position, and the game below it does not receive clicks that
 * land on it.
 *
 * Every button here sends the SAME packet the player would send by typing the
 * command into chat (see MapEngine's onRequestTalk): this is a keyboard
 * replacement, not a second command system. The server side is unchanged - it
 * cannot tell a button from a keystroke, which is the point.
 *
 * This file is part of ROBrowser, (http://www.robrowser.com/).
 */

import UIManager from 'UI/UIManager.js';
import GUIComponent from 'UI/GUIComponent.js';
import Preferences from 'Core/Preferences.js';
import Renderer from 'Renderer/Renderer.js';
import ChatBox from 'UI/Components/ChatBox/ChatBox.js';
import DB from 'DB/DBManager.js';
import SkillDescription from 'UI/Components/SkillDescription/SkillDescription.js';
import htmlText from './CompanionPanel.html?raw';
import cssText from './CompanionPanel.css?raw';
import 'UI/Elements/Elements.js';

const CompanionPanel = new GUIComponent('CompanionPanel', cssText);

CompanionPanel.render = () => htmlText;

/// Preferences: window position and the saved squads, per browser.
const _preferences = Preferences.get(
	'CompanionPanel',
	{
		x: 300,
		y: 120,
		// User-chosen size. 0 means "follow the content", which is the default:
		// the window is as wide as the widest tab needs, so nothing is cropped.
		width: 0,
		height: 0,
		squads: {},
		// The Summon tab's sex choice: 'm', 'f' or '' for either.
		draftSex: ''
	},
	1.0
);

/// The roster as last received from the server, parsed from @companion list raw.
let _roster = [];
/// Rows of the batch currently arriving; swapped into _roster at @CPEND so a
/// partial read never shows a half-built list.
let _pending = [];
/// Set when a redraw is wanted even if the data is unchanged (a manual Refresh).
let _forceRedraw = false;
/// Our own duty choices, so a row can show the badge before the next roster says so.
/// The roster's own duty replaces an entry as soon as it arrives.
const _duties = {};
/// The server's duty numbers (PopulationRoleType): 0 is no duty yet.
const DUTY_NAMES = { 1: 'tank', 2: 'support', 3: 'attacker' };

/// The companion whose skill picker is open ('' = closed), and the menu last
/// received from the server for it.
///
/// The menu is authoritative server-side: the engine emails the legal set (a tick
/// box per skill, `@CPSK|id|name|selected|level`) and this only mirrors it. A click
/// sends `toggle` and waits for the server to re-send, so the panel can never show a
/// tick the server did not agree to - which matters because the selection is what
/// decides whether a companion heals or fights.
let _skillTarget = '';
let _skillPending = [];
let _skills = [];
let _skillMeta = { job: '', chosen: false, emitted: 0, answered: false };

/**
 * Jobs the Summon tab offers: the same names @companion jobs prints and the
 * engine's kJobNameMap resolves. Kept as plain data so the panel needs no
 * server round-trip to draw the list.
 */
const JOB_TIERS = [
	['1st', ['Swordsman', 'Mage', 'Archer', 'Acolyte', 'Merchant', 'Thief']],
	['2nd', ['Knight', 'Priest', 'Wizard', 'Blacksmith', 'Hunter', 'Assassin',
		'Crusader', 'Monk', 'Sage', 'Rogue', 'Alchemist', 'Bard', 'Dancer']],
	['Trans', ['LordKnight', 'HighPriest', 'HighWizard', 'Whitesmith', 'Sniper',
		'AssassinCross', 'Paladin', 'Champion', 'Professor', 'Stalker',
		'Creator', 'Clown', 'Gypsy']],
	['3rd', ['RuneKnight', 'Warlock', 'Ranger', 'ArchBishop', 'Mechanic',
		'GuillotineCross', 'RoyalGuard', 'Sorcerer', 'Minstrel', 'Wanderer',
		'Sura', 'Genetic', 'ShadowChaser']],
	['4th', ['DragonKnight', 'Meister', 'ShadowCross', 'ArchMage', 'Cardinal',
		'Windhawk', 'ImperialGuard', 'Biolo', 'AbyssChaser', 'ElementalMaster',
		'Inquisitor', 'Troubadour', 'Trouvere', 'SkyEmperor', 'SoulAscetic',
		'Shinkiro', 'Shiranui', 'NightWatch', 'HyperNovice', 'SpiritHandler']]
];

/**
 * Jobs that are only ever one sex. The engine keeps their sex whatever the
 * draft asks for (get_job_required_sex); the Summon tab says so instead of
 * offering a choice that would be ignored.
 */
const FIXED_SEX = {
	Bard: 'm', Clown: 'm', Minstrel: 'm', Troubadour: 'm', Kagerou: 'm', Shinkiro: 'm',
	Dancer: 'f', Gypsy: 'f', Wanderer: 'f', Trouvere: 'f', Oboro: 'f', Shiranui: 'f'
};

/**
 * The @companion draft line for a job and the chosen sex ('m', 'f' or '').
 * A fixed-sex job is sent without one, so the reply does not complain.
 *
 * @param {string} job
 * @param {string} sex
 * @returns {string}
 */
function _draftCommand(job, sex) {
	return (sex === 'm' || sex === 'f') && !FIXED_SEX[job]
		? `@companion draft ${job} ${sex}`
		: `@companion draft ${job}`;
}

/**
 * Which job tier a class name belongs to, read off JOB_TIERS.
 *
 * The tier decides the stat ceiling a companion can grow into (1st/2nd/trans cap
 * at 99, 3rd and 4th at 130), so it is worth showing next to the class rather
 * than making the player remember which names are which era.
 *
 * @param {string} job
 * @returns {string} '' when the class is not in the table
 */
function _tierOf(job) {
	for (const [tier, jobs] of JOB_TIERS) {
		if (jobs.indexOf(job) >= 0) {
			return tier;
		}
	}
	return '';
}

/**
 * Send a chat line exactly as typing it would.
 *
 * @param {string} text
 * @param {boolean} party - true = party channel (the channel the stance and
 *                           duty orders are read from), false = public (the
 *                           channel at-commands like @companion summon use)
 */
function talk(text, party) {
	ChatBox.onRequestTalk('', text, party ? ChatBox.TYPE.PARTY : ChatBox.TYPE.PUBLIC);
}

/**
 * Ask the server for the roster in its machine-readable form.
 * Answered through onChatMessage as @CP|... lines.
 */
/// When the last roster request went out, so a press with no answer can be told
/// apart from a press that was never wired up.
let _rosterRequestedAt = 0;
let _rosterLastCount = -1;

function refreshRoster() {
	_rosterRequestedAt = Date.now();
	_pending = [];
	// A manual refresh must visibly do something even when nothing changed.
	_forceRedraw = true;
	_renderStatus('asking the server…');
	talk('@companion list raw', false);
	// The hiring rules decide what the Summon tab offers; asked with the roster
	// so a change in Settings shows the next time the panel is opened.
	talk('@companion terms', false);
}

/// Put a one-line status under the Party tab heading, so pressing Refresh always
/// changes something on screen even when the list itself is unchanged.
function _renderStatus(text) {
	const page = _page('party');
	if (!page) return;
	let el = page.querySelector('.roster-status');
	if (!el) {
		el = document.createElement('div');
		el.className = 'roster-status hint';
		page.append(el);
	}
	el.textContent = text;
}

/**
 * The server's machine-readable line, or null when this is anything else.
 *
 * The server sends these with clif_displaymessage, which reaches ChatBox.addText as the bare
 * text - no "Name : " prefix. Everything a person says arrives with one (public, party and
 * guild chat, our own included), so a line counts only when it STARTS with @CP: someone
 * typing "@CP|..." in chat can neither add rows to this window nor be hidden from the log.
 *
 * @param {string} text
 * @return {string|null}
 */
function rosterBody(text) {
	if (typeof text !== 'string') {
		return null;
	}
	const body = text.replace(/^\s+/, '');
	return body.startsWith('@CP') ? body : null;
}

/**
 * Parse one @CP line. Format (see population_engine_companion_list_raw):
 *   @CP|name|job|base_level|active|favorite|live_level|live_job|pet|duty|rebirth
 *      |heal_at|emergency_at|rest_below|rest_until
 *   @CPEND|count
 *
 * @param {string} text
 * @return {boolean} true when the line was ours
 */
/**
 * Parse one @CPSK line (see population_engine_companion_skill_list):
 *   @CPSK|<id>|<name>|<selected 0/1>|<max level>|<exclusive 0/1>
 *   @CPSKEND|<count>|<job>|<chosen 0/1>|<summoned 0/1>
 *
 * @param {string} text
 * @return {boolean} true when the line was ours
 */
function parseSkillLine(text) {
	const body = rosterBody(text);
	if (body === null || !body.startsWith('@CPSK')) {
		return false;
	}
	if (body.startsWith('@CPSKEND')) {
		const p = body.split('|');
		_skills = _skillPending.slice();
		_skillPending = [];
		_skillMeta = {
			job: p[2] || '',
			chosen: p[3] === '1',
			emitted: parseInt(p[1], 10) || 0,
			answered: true
		};
		// Redraw only when the picker is open, so a stray push does not churn the DOM.
		if (_skillTarget) {
			_render();
		}
		return true;
	}
	if (body.startsWith('@CPSKFAIL')) {
		_skillPending = [];
		_skills = [];
		_skillMeta = { job: '', chosen: false, emitted: 0, answered: true };
		if (_skillTarget) {
			_render();
		}
		return true;
	}
	const p = body.split('|');
	if (p[0] !== '@CPSK' || p.length < 5) {
		return false;
	}
	_skillPending.push({
		id: parseInt(p[1], 10) || 0,
		name: p[2],
		selected: p[3] === '1',
		level: parseInt(p[4], 10) || 0,
		// Ends another listed skill's status (a song, a dance, a stance). Absent from an older
		// server, which then shows no such group.
		exclusive: p[5] === '1'
	});
	return true;
}

/**
 * The hiring rules (Settings -> Population -> Companions), from @companion terms:
 *   @CPTERMS|mode|tier|zeny|item id|item amount|item name|jobs (':'-joined)
 * mode 0 = free choice (any job, as before), 1 = hired from this panel, 2 = hired
 * from a Companion Recruiter in town. null until the server has answered.
 */
let _terms = null;

function parseTermsLine(text) {
	const body = rosterBody(text);
	if (body === null || !body.startsWith('@CPTERMS')) {
		return false;
	}
	const p = body.split('|');
	_terms = {
		mode: parseInt(p[1], 10) || 0,
		tier: parseInt(p[2], 10) || 0,
		zeny: parseInt(p[3], 10) || 0,
		item: parseInt(p[4], 10) || 0,
		amount: parseInt(p[5], 10) || 0,
		itemName: p[6] || '',
		jobs: (p[7] || '').split(':').filter(Boolean)
	};
	_render();
	return true;
}

/** What hiring costs, as words: "12,000 zeny and 1 Yggdrasil Berry", or ''. */
function _feeText(t) {
	const parts = [];
	if (t.zeny > 0) {
		parts.push(`${t.zeny.toLocaleString()} zeny`);
	}
	if (t.item > 0 && t.amount > 0) {
		parts.push(`${t.amount} ${t.itemName || 'item #' + t.item}`);
	}
	return parts.join(' and ');
}

/** A numeric @CP field by position, or null when this server does not send it. */
function _field(parts, i) {
	const raw = parts.length > i ? parseInt(parts[i], 10) : NaN;
	return Number.isFinite(raw) ? raw : null;
}

/**
 * The healer and resting thresholds to show on the Battle tab: what the server holds for
 * the party, read from a summoned companion first (the commands set every summoned one),
 * else any companion, else the defaults every companion starts with.
 */
function _thresholds() {
	const fallback = { healAt: 75, emergencyAt: 35, restBelow: 30, restUntil: 95 };
	const from = _roster.find(m => m.active && m.healAt !== null) || _roster.find(m => m.healAt !== null);
	if (!from) {
		return fallback;
	}
	const pick = key => (from[key] !== null && from[key] !== undefined ? from[key] : fallback[key]);
	return {
		healAt: pick('healAt'),
		emergencyAt: pick('emergencyAt'),
		restBelow: pick('restBelow'),
		restUntil: pick('restUntil')
	};
}

function parseRosterLine(text) {
	const body = rosterBody(text);
	if (body === null) {
		return false;
	}
	if (body.startsWith('@CPEND')) {
		// The server sends these unsolicited when the roster changes, and in answer
		// to our own request. Either way this batch is authoritative: replace what
		// we had. Redraw only when something differs, so a push that changes
		// nothing does not churn the DOM or reset scroll position.
		const fresh = _pending.slice();
		const changed = fresh.length !== _roster.length ||
			fresh.some((m, i) => !_roster[i] ||
				m.name !== _roster[i].name || m.job !== _roster[i].job ||
				m.liveJob !== _roster[i].liveJob ||
				m.level !== _roster[i].level || m.active !== _roster[i].active ||
				m.liveLevel !== _roster[i].liveLevel || m.hom !== _roster[i].hom ||
				m.duty !== _roster[i].duty ||
				m.healAt !== _roster[i].healAt || m.emergencyAt !== _roster[i].emergencyAt ||
				m.restBelow !== _roster[i].restBelow || m.restUntil !== _roster[i].restUntil ||
				m.canRoam !== _roster[i].canRoam || m.roam !== _roster[i].roam || m.dead !== _roster[i].dead);
		_roster = fresh;
		_pending = [];
		const age = _rosterRequestedAt ? Math.round((Date.now() - _rosterRequestedAt) / 1000) : 0;
		_renderStatus(`${_roster.length} companion${_roster.length === 1 ? '' : 's'}` +
			(_rosterRequestedAt ? ` — updated ${age}s ago` : ' — pushed by the server'));
		if (changed || _forceRedraw) {
			_forceRedraw = false;
			_render();
		}
		return true;
	}
	if (body.startsWith('@CPFAIL')) {
		_roster = [];
		_pending = [];
		_renderStatus('the server could not read the list (see map-server console)');
		_forceRedraw = false;
		_render();
		return true;
	}
	const parts = body.split('|');
	if (parts[0] !== '@CP' || parts.length < 7) {
		return false;
	}
	_pending.push({
		name: parts[1],
		job: parts[2],
		level: parseInt(parts[3], 10) || 0,
		active: parts[4] === '1',
		favorite: parts[5] === '1',
		liveLevel: parseInt(parts[6], 10) || 0,
		// The class the shell is actually running. The persisted `job` above lags a
		// job change until the next snapshot, so this wins when present; absent on
		// an older server, which is why it is read positionally with a fallback.
		liveJob: (parts[7] || '').trim(),
		// The pet switch (phase 3c): -1 = this class cannot have a homunculus, 0 = the
		// player put it away, 1 = on. Read positionally with a -1 fallback so an older
		// server that does not send the field draws no control instead of a wrong one.
		hom: (() => {
			const raw = parts.length > 8 ? parseInt(parts[8], 10) : NaN;
			return Number.isFinite(raw) ? raw : -1;
		})(),
		// The duty the server holds: 'tank', 'support', 'attacker', or null for none yet (and
		// for an older server that does not send it). Kept only in _duties before, the badge
		// went blank on every restart, reload and relog although the server still had it.
		duty: DUTY_NAMES[parseInt(parts[9], 10)] || null,
		// Rebirth readiness: -1 = this class cannot be reborn, 0 = a 2nd class that has not
		// met the gate yet, 1 = ready. APPENDED after duty so the fields either side already
		// relies on keep their positions; an older server simply offers no rebirth.
		rebirth: (() => {
			const raw = parts.length > 10 ? parseInt(parts[10], 10) : NaN;
			return Number.isFinite(raw) ? raw : -1;
		})(),
		// The Battle tab's saved thresholds, appended after rebirth. null from an older server,
		// which leaves the boxes on their defaults as before.
		healAt: _field(parts, 11),
		emergencyAt: _field(parts, 12),
		restBelow: _field(parts, 13),
		restUntil: _field(parts, 14),
		// Roaming (walks the map on its own) and down (a summoned companion that is dead),
		// appended after the thresholds. The server sends -1 for roaming while Settings ->
		// Population -> Companion roaming is off, and an older server nothing: no control then.
		canRoam: parts[15] === '0' || parts[15] === '1',
		roam: parts[15] === '1',
		dead: parts[16] === '1'
	});
	// The server has answered for this companion; its duty is the one to show.
	if (parts.length > 9) {
		delete _duties[parts[1]];
	}
	return true;
}

let _raf = 0;

function _render() {
	if (_raf) {
		return;
	}
	_raf = window.requestAnimationFrame(() => {
		_raf = 0;
		if (!CompanionPanel.__active) {
			return;
		}
		_drawParty();
		_drawSummon();
		_drawBattle();
		_drawSkills();
		_drawGear();
		_drawRebirth();
		_mountSkillPicker();
	});
}

function _page(name) {
	return CompanionPanel.getRoot().querySelector(`.page[data-page="${name}"]`);
}

function _button(label, className, handler, title) {
	const b = document.createElement('button');
	b.className = className;
	b.textContent = label;
	if (title) {
		b.title = title;
	}
	b.addEventListener('mousedown', e => e.stopImmediatePropagation());
	b.addEventListener('click', e => {
		e.stopPropagation();
		handler();
	});
	return b;
}

function _row(...children) {
	const row = document.createElement('div');
	row.className = 'row';
	children.forEach(c => row.append(c));
	return row;
}

function _drawParty() {
	const page = _page('party');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const head = document.createElement('h4');
	head.textContent = `Saved companions (${_roster.length})`;
	page.append(head);

	if (!_roster.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'None yet. Recruit in game, or draft one on the Summon tab.';
		page.append(e);
		page.append(_button('Refresh', 'b wide', refreshRoster));
		return;
	}

	_roster.forEach(m => {
		// Layout B: the name sits on the first line and the class + tier on a
		// second one, inside a single flexible column. The class used to live in
		// nm.title (a hover tooltip), so the saved list showed no class at all;
		// stacking it also means a long class name is cropped by the column
		// instead of pushing the level and the buttons off the row. The level
		// always comes from the live shell when there is one - the persisted
		// base_level is the recruit-time snapshot and lags a levelling companion.
		const id = document.createElement('div');
		id.className = 'id';

		const nm = document.createElement('div');
		nm.className = 'nm';
		nm.textContent = (m.dead ? '✝ ' : '') + (m.favorite ? '★ ' : '') + m.name;
		nm.title = m.dead
			? `${m.name} is down. Revive it with Resurrection or a Yggdrasil Leaf.`
			: m.name;

		const cls = document.createElement('div');
		cls.className = 'cls';
		// Live class first: a companion that just advanced would otherwise show the
		// class it was recruited as until the next persistence snapshot.
		const job = m.liveJob || m.job;
		const tier = _tierOf(job);
		cls.textContent = tier ? `${job} · ${tier} job` : job;
		cls.title = m.liveLevel ? `${job} (live at Lv.${m.liveLevel})` : job;

		id.append(nm, cls);

		const lv = document.createElement('span');
		lv.className = 'lv';
		lv.textContent = `Lv.${m.liveLevel || m.level}`;

		const current = _duties[m.name] || m.duty;
		const badge = document.createElement('span');
		badge.className = `badge ${current || (m.active ? 'on' : '')}`;
		badge.textContent = current || (m.active ? 'ON' : 'OFF');
		badge.title = m.active ? 'Summoned' : 'Not summoned';

		const duty = _button('Duty', 'b', () => {
			// attacker -> tank -> support -> attacker, sent as party chat. No "none" step: the
			// server has no order for it, so the badge said none while the companion kept its duty.
			const order = ['attacker', 'tank', 'support'];
			const next = order[(order.indexOf(current) + 1) % order.length];
			_duties[m.name] = next;
			talk(`${m.name} ${next}`, true);
			_render();
		}, 'Set this companion\'s duty in battle');

		const summon = _button(m.active ? 'Bench' : 'Summon', 'b', () => {
			if (m.active) {
				talk(`@companion dismiss ${m.name}`, false);
			} else {
				talk(`@companion summon ${m.name}`, false);
			}
			window.setTimeout(refreshRoster, 600);
		}, m.active ? 'Send back to the saved list' : 'Summon into the party');

		const fav = _button(m.favorite ? '★' : '☆', 'b', () => {
			talk(`@companion ${m.favorite ? 'unfavorite' : 'favorite'} ${m.name}`, false);
			window.setTimeout(refreshRoster, 600);
		}, 'Favorite (sorts first)');

		// Delete is permanent - it removes the saved row, not just the party slot -
		// so it asks first, in-window.
		const trash = _button('🗑', 'b danger', () => {
			confirmInWindow(
				`Delete ${m.name} permanently?`,
				'The saved companion, its level and its equipment are removed for good. This cannot be undone.'
			).then(ok => {
				if (!ok) return;
				talk(`@companion remove ${m.name}`, false);
				window.setTimeout(refreshRoster, 600);
			});
		}, 'Delete this saved companion permanently');

		// Skills sits beside Duty: both configure how this companion fights, and both
		// are per-companion, so they belong next to each other on the row.
		const skills = _button('Skills', 'b', () => {
			openSkillPicker(m.name);
		}, `Choose which skills ${m.name} may use`);

		// PETHOM (phase 3c): the homunculus switch, drawn only for a companion whose class
		// can have one at all (the server sends -1 for the rest, so a Swordsman shows no
		// control rather than a dead one). The engine attaches the pet by itself at spawn,
		// so this is a switch and not a summon: the label carries the state, and the click
		// sends the same at-command a player would type, then lets the server's pushed
		// roster confirm it - the panel never invents the new state.
		const pet = m.hom < 0 ? null : _button(
			m.hom ? 'Pet on' : 'Pet off',
			'b',
			() => {
				talk(`@companion homunculus ${m.name} ${m.hom ? 'off' : 'on'}`, false);
				window.setTimeout(refreshRoster, 600);
			},
			m.hom ? `Put ${m.name}'s homunculus away` : `Bring ${m.name}'s homunculus back`
		);

		// Roam: this companion walks the map on its own instead of following. Like the pet
		// switch, the label is the state the server holds and the click asks for the other.
		const roam = !m.canRoam ? null : _button(
			m.roam ? 'Roaming' : 'Following',
			m.roam ? 'b on' : 'b',
			() => {
				talk(`@companion roam ${m.name} ${m.roam ? 'off' : 'on'}`, false);
			},
			m.roam ? `${m.name} walks the map on its own. Click to have it follow you`
				: `${m.name} follows you. Click to let it roam the map on its own`
		);

		// The row's call shape is pinned by tests/companion-panel-row and -skill-picker, and this
		// control is conditional, so build the row as usual and slot the button in beside Duty
		// and Skills rather than rebuilding the child list on every added control.
		const row = _row(id, lv, badge, duty, skills, summon, fav, trash);
		if (m.dead) {
			row.classList.add('dead');
		}
		if (roam) {
			row.insertBefore(roam, summon);
		}
		if (pet) {
			row.insertBefore(pet, summon);
		}
		page.append(row);
	});

	page.append(_button('Refresh', 'b wide', refreshRoster));
}

function _drawSummon() {
	const page = _page('summon');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	page.append(hint);

	// Hired companions (Settings -> Population -> Companions): your own class
	// tier, at your level, for a fee -- here, or from a recruiter in town.
	const t = _terms;
	if (t && t.mode === 2) {
		const fee = _feeText(t);
		hint.textContent = 'Companions are hired from a Companion Recruiter, beside the healer in each town.'
			+ (fee ? ` The fee for you is ${fee}.` : '')
			+ ' Your saved companions can still be called back from the Party tab.';
		return;
	}
	let tiers = JOB_TIERS;
	if (t && t.mode === 1) {
		const fee = _feeText(t);
		hint.textContent = 'Hire a companion of your own class tier, at your level. It joins your party at once.'
			+ (fee ? ` Fee: ${fee}.` : '');
		tiers = t.jobs.length ? [['Your tier', t.jobs]] : [];
		if (!t.jobs.length) {
			hint.textContent += ' There is nobody to hire for your tier right now.';
		}
	} else {
		hint.textContent = 'Draft a new companion of any job. It joins your party at once.';
	}

	// Male / Female / Random for the next draft. Remembered, like the window's place.
	const sexRow = document.createElement('div');
	sexRow.className = 'sex-choice';
	const sexLabel = document.createElement('span');
	sexLabel.textContent = 'Sex:';
	sexRow.append(sexLabel);
	[['m', 'Male'], ['f', 'Female'], ['', 'Random']].forEach(([value, label]) => {
		const b = _button(label, 'b', () => {
			_preferences.draftSex = value;
			_preferences.save();
			_drawSummon();
		}, value ? `Draft ${label.toLowerCase()} companions` : 'Draft either sex, at random');
		b.classList.toggle('on', (_preferences.draftSex || '') === value);
		sexRow.append(b);
	});
	page.append(sexRow);
	const sexNote = document.createElement('div');
	sexNote.className = 'hint';
	sexNote.textContent = 'Jobs marked \u2642 or \u2640 are always that sex.';
	page.append(sexNote);

	tiers.forEach(([tier, jobs]) => {
		const h = document.createElement('h4');
		h.textContent = tier;
		page.append(h);

		const wrap = document.createElement('div');
		wrap.className = 'jobs';
		jobs.forEach(job => {
			const fixed = FIXED_SEX[job];
			wrap.append(_button(
				job.replace(/([a-z])([A-Z])/g, '$1 $2') + (fixed ? (fixed === 'm' ? ' \u2642' : ' \u2640') : ''),
				'',
				() => {
					talk(_draftCommand(job, _preferences.draftSex || ''), false);
					window.setTimeout(refreshRoster, 900);
				},
				fixed ? `Draft a ${job} (always ${fixed === 'm' ? 'male' : 'female'})` : `Draft a ${job}`
			));
		});
		page.append(wrap);
	});
}

function _drawBattle() {
	const page = _page('battle');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const h = document.createElement('h4');
	h.textContent = 'Stance (whole party)';
	page.append(h);

	const stances = [
		['attack', 'Free', 'Engage on sight near you'],
		['defensive', 'Standard', 'Fight what you fight'],
		['passive', 'Hold', 'Never start a fight']
	];
	const grid = document.createElement('div');
	grid.className = 'grid';
	stances.forEach(([cmd, label, tip]) => {
		grid.append(_button(label, 'b wide', () => talk(cmd, true), tip));
	});
	page.append(grid);

	// Movement: follow you, or walk the map on their own as field players do. Per companion
	// on the Party tab; these set every one of them. Only while the server allows roaming
	// (Settings -> Population -> Companion roaming), which the roster says.
	if (_roster.some(m => m.canRoam)) {
		const hm = document.createElement('h4');
		hm.textContent = 'Movement (whole party)';
		page.append(hm);
		const moves = document.createElement('div');
		moves.className = 'grid';
		moves.append(
			_button('Follow', 'b wide', () => talk('@companion roam off', false), 'Stay with you'),
			_button('Roam', 'b wide', () => talk('@companion roam on', false), 'Walk the map on their own')
		);
		page.append(moves);
	}

	const h2 = document.createElement('h4');
	h2.textContent = 'Orders';
	page.append(h2);
	const orders = document.createElement('div');
	orders.className = 'grid';
	orders.append(
		_button('Taunt / Pull', 'b wide', () => talk('taunt', true), 'Your defender grabs your target'),
		_button('Recall', 'b wide', () => talk('recall', true), 'Teleport every companion to you')
	);
	page.append(orders);

	// What the server has saved, so the boxes open on the party's own values.
	const saved = _thresholds();

	const h3 = document.createElement('h4');
	h3.textContent = 'Healer thresholds';
	page.append(h3);
	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Support companions heal below these HP levels.';
	page.append(hint);

	const normal = document.createElement('input');
	normal.className = 'num';
	normal.type = 'number';
	normal.min = 1;
	normal.max = 99;
	normal.value = String(saved.healAt);
	const emergency = document.createElement('input');
	emergency.className = 'num';
	emergency.type = 'number';
	emergency.min = 1;
	emergency.max = 99;
	emergency.value = String(saved.emergencyAt);

	page.append(_row(
		(() => {
			const s = document.createElement('span');
			s.className = 'nm';
			s.textContent = 'Heal below';
			return s;
		})(),
		normal,
		(() => {
			const s = document.createElement('span');
			s.className = 'lv';
			s.textContent = '% / emergency';
			return s;
		})(),
		emergency,
		_button('Set', 'b', () => {
			const a = Math.max(1, Math.min(99, Number(normal.value) || 75));
			const b = Math.max(1, Math.min(99, Number(emergency.value) || 35));
			talk(`@companion heal ${a} ${b}`, false);
		})
	));

	// When companions sit down to rest between fights (whole party, like the
	// healer thresholds). The server keeps "until" at least 5 above "below",
	// or a companion would stand up and sit straight back down.
	const h5 = document.createElement('h4');
	h5.textContent = 'Resting';
	page.append(h5);
	const restHint = document.createElement('div');
	restHint.className = 'hint';
	restHint.textContent = 'Between fights, companions sit down to recover below this SP or HP level, '
		+ 'and stand once both are back. 0 = never rest.';
	page.append(restHint);

	const restBelow = document.createElement('input');
	restBelow.className = 'num';
	restBelow.type = 'number';
	restBelow.min = 0;
	restBelow.max = 90;
	restBelow.value = String(saved.restBelow);
	const restUntil = document.createElement('input');
	restUntil.className = 'num';
	restUntil.type = 'number';
	restUntil.min = 5;
	restUntil.max = 100;
	restUntil.value = String(saved.restUntil);

	page.append(_row(
		(() => {
			const s = document.createElement('span');
			s.className = 'nm';
			s.textContent = 'Rest below';
			return s;
		})(),
		restBelow,
		(() => {
			const s = document.createElement('span');
			s.className = 'lv';
			s.textContent = '% / until';
			return s;
		})(),
		restUntil,
		_button('Set', 'b', () => {
			const a = Math.max(0, Math.min(90, Math.round(Number(restBelow.value)) || 0));
			const b = Math.max(a + 5, Math.min(100, Math.round(Number(restUntil.value)) || 95));
			restBelow.value = String(a);
			restUntil.value = String(b);
			talk(`@companion rest ${a} ${b}`, false);
		})
	));
}

/// Ask the server for one companion's skill menu. Answered through the chat hook
/// as @CPSK|... lines, terminated by @CPSKEND.
///
/// `refresh` re-asks after a change made in the open picker: the list on screen stays
/// until the answer replaces it. Clearing it here redrew the picker as "asking the
/// server…" between every tick and its answer, and the list came back scrolled to the top.
function askSkills(name, refresh) {
	_skillPending = [];
	if (!refresh) {
		_skills = [];
		_skillMeta = { job: '', chosen: false, emitted: 0, answered: false };
	}
	talk(`@companion skills ${name}`, false);
}

/// Open the picker for one saved companion. Works for a benched companion too -
/// the selection is stored on its row and applies at its next summon, which is what
/// lets a player configure three priests before summoning any of them.
function openSkillPicker(name) {
	_skillTarget = name;
	askSkills(name);
	_render();
}

function closeSkillPicker() {
	// A description the picker opened goes with it; one the skill window opened stays.
	if (_skills.some(s => s.id === SkillDescription.uid)) {
		SkillDescription.remove();
	}
	_skillTarget = '';
	_skillPending = [];
	_skills = [];
	_render();
}

/// Escape closes the picker. Installed once from init(); it defers to the panel
/// being open AND a picker being up, so it never steals Escape from a dialogue or
/// from the client's own windows.
function installSkillEscape() {
	if (window.__companionSkillEscape === true) {
		return;
	}
	window.addEventListener('keydown', ev => {
		if (ev.key !== 'Escape' || !_skillTarget) {
			return;
		}
		if (!CompanionPanel.__active || !CompanionPanel._host
			|| CompanionPanel._host.style.display === 'none') {
			return;
		}
		ev.stopPropagation();
		closeSkillPicker();
	}, true);
	window.__companionSkillEscape = true;
}

/// The picker overlay: one tick box per legal skill, grouped Offense / Defence /
/// Support by the skill's own target so a player can find "the heals" without
/// reading 70 ids.
function _skillPickerOverlay() {
	const overlay = document.createElement('div');
	overlay.className = 'skill-overlay';

	const box = document.createElement('div');
	box.className = 'skill-box';

	const head = document.createElement('div');
	head.className = 'skill-head';
	const title = document.createElement('div');
	title.className = 'skill-title';
	title.textContent = _skillMeta.job
		? `Skills — ${_skillTarget} (${_skillMeta.job})`
		: `Skills — ${_skillTarget}`;
	head.append(title);
	box.append(head);

	const state = document.createElement('div');
	state.className = 'hint';
	if (!_skillMeta.answered) {
		state.textContent = 'asking the server…';
		box.append(state);
	} else if (!_skills.length) {
		state.textContent = 'This companion has no usable skills for its class yet.';
		box.append(state);
	} else {
		// The count is the one thing that tells the player whether their tick landed.
		state.textContent = `${_skills.filter(s => s.selected).length} of ${_skills.length} selected`
			+ (_skillMeta.chosen ? '' : ' — using the full class list')
			+ '. Right-click a skill for its description.';
		box.append(state);

		const list = document.createElement('div');
		list.className = 'skill-list';
		let lastGroup = '';
		// Skills that end each other go first, in the server's order, which is the order the
		// companion prefers them in: ticking several means the first one that is ready plays.
		const ordered = _skills.filter(s => s.exclusive).concat(_skills.filter(s => !s.exclusive));
		ordered.forEach(s => {
			// The engine does not send a target, so group by name prefix family:
			// this is display only and never decides behaviour.
			const group = s.exclusive ? EXCLUSIVE_GROUP : _skillGroupOf(s.name);
			if (group !== lastGroup) {
				lastGroup = group;
				const h = document.createElement('h4');
				h.textContent = group;
				list.append(h);
				if (s.exclusive) {
					const note = document.createElement('div');
					note.className = 'hint skill-note';
					note.textContent = 'Only one of these can run at a time. Tick the one you want. '
						+ 'If several are ticked, the one higher in this list plays, '
						+ 'and the others fill in while it is unavailable.';
					list.append(note);
				}
			}
			const row = document.createElement('label');
			row.className = 'skill-row' + (s.selected ? ' on' : '');

			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.checked = !!s.selected;
			cb.addEventListener('click', e => e.stopPropagation());
			cb.addEventListener('change', () => {
				// One small command per click: the atcommand's param buffer is 23
				// bytes, so a whole list cannot travel in one line. The server
				// re-sends the menu after the change, so the tick follows the server
				// rather than being set optimistically here.
				cb.disabled = true;
				talk(`@companion skills ${_skillTarget} toggle ${s.id}`, false);
				window.setTimeout(() => askSkills(_skillTarget, true), 250);
			});

			// The in-game name, as the skill window shows it; the server sends the Aegis
			// name, kept as the hover title and as the fallback for a skill the client's
			// tables do not name.
			const nm = document.createElement('span');
			nm.className = 'skill-name';
			nm.textContent = DB.getSkillName(s.id) || s.name;
			nm.title = s.name;

			// Right-click shows the description, as in the skill window; right-clicking
			// the same skill again closes it.
			row.addEventListener('contextmenu', e => {
				e.preventDefault();
				e.stopPropagation();
				_toggleSkillDescription(s.id);
			});

			const lv = document.createElement('span');
			lv.className = 'skill-lv';
			lv.textContent = s.level ? `Lv${s.level}` : '';

			row.append(cb, nm, lv);
			list.append(row);
		});
		box.append(list);
	}

	const actions = document.createElement('div');
	actions.className = 'skill-actions';
	const mk = (label, cmd, title) => _button(label, 'b', () => {
		talk(`@companion skills ${_skillTarget} ${cmd}`, false);
		window.setTimeout(() => askSkills(_skillTarget, true), 300);
	}, title);
	actions.append(
		mk('All', 'all', 'Use every skill this class can use'),
		mk('None', 'none', 'Use no skills (auto-attack only)'),
		mk('Auto', 'auto', 'Back to the class default list'),
		_button('Close', 'b', closeSkillPicker, 'Close this picker')
	);
	box.append(actions);

	overlay.append(box);
	overlay.addEventListener('mousedown', e => e.stopImmediatePropagation());
	overlay.addEventListener('click', e => e.stopPropagation());
	return overlay;
}

/// The client's own skill description window, the one the skill window opens on a
/// right-click. Toggles like it: the same skill again closes it.
function _toggleSkillDescription(id) {
	if (SkillDescription.uid === id) {
		SkillDescription.remove();
		return;
	}
	SkillDescription.append();
	SkillDescription.setSkill(id);
}

/// Heading for the skills that end each other (the @CPSK exclusive flag).
const EXCLUSIVE_GROUP = 'Songs, dances & stances: one at a time';

/// Display bucket for a skill, from its Aegis name prefix. Presentation only.
function _skillGroupOf(name) {
	const p = String(name || '').slice(0, 2).toUpperCase();
	if (p === 'AL' || p === 'PR' || p === 'AB' || p === 'HP' || p === 'CD') return 'Support';
	if (p === 'SM' || p === 'KN' || p === 'LK' || p === 'RK' || p === 'DK' || p === 'CR'
		|| p === 'PA' || p === 'IG' || p === 'MO' || p === 'CH' || p === 'SR' || p === 'IQ') return 'Melee / defence';
	return 'Offense / utility';
}

function _drawSkills() {
	const page = _page('skills');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Each companion keeps its own skill set. Pick one to choose which of '
		+ 'its class skills it may use — a Priest can be built for support or for melee.';
	page.append(hint);

	if (!_roster.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'No saved companions yet.';
		page.append(e);
		page.append(_button('Refresh', 'b wide', refreshRoster));
		return;
	}

	_roster.forEach(m => {
		const row = document.createElement('div');
		row.className = 'row';
		const id = document.createElement('div');
		id.className = 'id';
		const nm = document.createElement('div');
		nm.className = 'nm';
		nm.textContent = (m.favorite ? '★ ' : '') + m.name;
		const cls = document.createElement('div');
		cls.className = 'cls';
		cls.textContent = m.liveJob || m.job;
		id.append(nm, cls);
		row.append(id, _button('Choose skills', 'b', () => openSkillPicker(m.name),
			`Choose which skills ${m.name} may use`));
		page.append(row);
	});
}

/// Mount the picker overlay when one is open. Called from every _render() so the
/// list follows the server's answer, and it drops any previous overlay first - a
/// stacked overlay would swallow clicks meant for the one underneath.
/// The element overlay UI must be appended to.
///
/// NOT `getRoot()`. GUIComponent sets `id="<Name>"` on the HOST element while the html's
/// `<div id="CompanionPanel">` renders INSIDE the shadow root, and getRoot() returns the
/// shadow root. Every rule in CompanionPanel.css is scoped `#CompanionPanel ...`, so an
/// overlay appended to the shadow root sits OUTSIDE that wrapper and none of its styles
/// apply - it draws bare over the game world with no background or border. Mount into the
/// wrapper instead; fall back to the root only if the wrapper is genuinely absent.
function _panelMount() {
	const root = CompanionPanel.getRoot();
	return (root && root.querySelector) ? (root.querySelector('#CompanionPanel') || root) : root;
}

function _mountSkillPicker() {
	const wrap = _panelMount();
	// The picker is rebuilt on every redraw; carry the list's scroll position over, or each
	// tick (which redraws twice: the click and the server's answer) jumps back to the top.
	const old = wrap.querySelector('.skill-overlay .skill-list');
	const scroll = old ? old.scrollTop : 0;
	wrap.querySelectorAll('.skill-overlay').forEach(el => el.remove());
	if (!_skillTarget) {
		return;
	}
	const overlay = _skillPickerOverlay();
	wrap.append(overlay);
	const list = overlay.querySelector('.skill-list');
	if (list && scroll) {
		list.scrollTop = scroll;
	}
}

/// The Rebirth tab: a companion that has maxed its 2nd job can be reborn, and the player chooses
/// how. Both options change class, which unequips anything the new class cannot wear - gear the
/// player handed over goes back to the player, so the choice is made with that on screen rather than
/// discovered afterwards.
function _drawRebirth() {
	const page = _page('rebirth');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Reborn companions start again, so this is never automatic. Entering a transcendent class also unequips gear it can no longer wear; what you gave it comes back to you. Only a 2nd class at base 99 / job 50 can be reborn.';
	page.append(hint);

	const ready = _roster.filter(m => m.rebirth === 1);
	const waiting = _roster.filter(m => m.rebirth === 0);

	if (!ready.length && !waiting.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'No companion here can be reborn. 1st classes advance on their own; only a maxed 2nd class is offered this.';
		page.append(e);
		return;
	}

	ready.forEach(m => {
		const h = document.createElement('h4');
		h.textContent = `${m.name} - ready to be reborn`;
		page.append(h);

		const grid = document.createElement('div');
		grid.className = 'grid';
		grid.append(_button('High Novice', 'b', () => {
			confirmInWindow(
				`Rebirth ${m.name} as a High Novice?`,
				`It restarts at level 1 and climbs back up as a high class, then a transcendent one. Gear it can no longer wear is unequipped, and anything you gave it comes back to you.`,
				'Rebirth', true
			).then(ok => {
				if (!ok) return;
				talk(`@companion rebirth ${m.name} novice`, false);
				window.setTimeout(refreshRoster, 900);
			});
		}, 'The proper rebirth: High Novice at level 1, then the full climb'));
		grid.append(_button('Transcendent', 'b', () => {
			confirmInWindow(
				`Advance ${m.name} straight to its transcendent class?`,
				`It keeps its level and becomes the transcendent class immediately. Gear it can no longer wear is unequipped, and anything you gave it comes back to you.`,
				'Advance', false
			).then(ok => {
				if (!ok) return;
				talk(`@companion rebirth ${m.name} trans`, false);
				window.setTimeout(refreshRoster, 900);
			});
		}, 'Straight to the transcendent class, keeping its level'));
		page.append(grid);
	});

	waiting.forEach(m => {
		const p = document.createElement('div');
		p.className = 'hint';
		p.textContent = `${m.name} - not ready yet: needs base 99 and job 50.`;
		page.append(p);
	});
}

function _drawGear() {
	const page = _page('gear');
	if (!page) {
		return;
	}
	page.replaceChildren();

	const hint = document.createElement('div');
	hint.className = 'hint';
	hint.textContent = 'Take gear back from a summoned companion. Choose a companion, then the slots.';
	page.append(hint);

	const summoned = _roster.filter(m => m.active);
	if (!summoned.length) {
		const e = document.createElement('div');
		e.className = 'empty';
		e.textContent = 'No companion is summoned right now.';
		page.append(e);
		return;
	}

	summoned.forEach(m => {
		const h = document.createElement('h4');
		h.textContent = m.name;
		page.append(h);

		const slots = ['weapon', 'shield', 'armor', 'shoes', 'garment', 'acc', 'head', 'costume', 'shadow'];
		const grid = document.createElement('div');
		grid.className = 'grid';
		grid.append(_button('All', 'b', () => {
			talk(`@companion gear ${m.name}`, false);
		}, 'Take everything'));
		slots.forEach(slot => {
			grid.append(_button(slot, 'b', () => {
				talk(`@companion gear ${m.name} ${slot}`, false);
			}, `Take back: ${slot}`));
		});
		page.append(grid);
	});
}


/**
 * Route the roster's machine-readable lines into the parser and keep them out of
 * the chat log.
 *
 * Installed from init() rather than at module scope on purpose: BasicInfo is
 * imported after ChatBox, so importing this component at module scope closes an
 * import cycle and the ChatBox binding is still undefined here. Reaching into it
 * during module evaluation threw and the client failed to load entirely
 * ("Failed to load app: Online.js"), which is exactly the bug this replaces.
 */
function installChatHook() {
	if (typeof ChatBox === 'undefined' || ChatBox === null || !ChatBox.addText) {
		return;
	}
	if (ChatBox.__companionPanelHooked) {
		return;
	}
	const original = ChatBox.addText;
	ChatBox.addText = function addText(text, ...rest) {
		if (parseSkillLine(text) || parseTermsLine(text) || parseRosterLine(text)) {
			return;
		}
		return original.call(this, text, ...rest);
	};
	ChatBox.__companionPanelHooked = true;
}

/**
 * Show an in-window confirmation. Resolves to true when the player confirms.
 *
 * Deliberately not window.confirm(): a blocking browser dialog freezes the game
 * loop and input until it is dismissed, inside a component that lives on the game
 * page. This overlay is plain DOM, so the confirming click is an ordinary click on
 * this component and nothing else stops.
 *
 * @param {string} question
 * @param {string} detail
 * @return {Promise<boolean>}
 */
/// Ask a yes/no in-window. `okLabel` names the confirming action, because the same dialog is used
/// for things that are not deletions (a rebirth is not a delete, and a button that says Delete for
/// it says the opposite of what it does). The default keeps the delete caller's wording unchanged.
function confirmInWindow(question, detail, okLabel = 'Delete', okDanger = true) {
	return new Promise(resolve => {
		const root = CompanionPanel.getRoot();
		const overlay = document.createElement('div');
		overlay.className = 'confirm-overlay';
		overlay.innerHTML = `
			<div class="confirm-box">
				<div class="confirm-question"></div>
				<div class="confirm-detail"></div>
				<div class="confirm-buttons">
					<button class="b" data-act="cancel">Cancel</button>
					<button class="b" data-act="ok"></button>
				</div>
			</div>`;
		overlay.querySelector('.confirm-question').textContent = question;
		overlay.querySelector('.confirm-detail').textContent = detail || '';
		const okButton = overlay.querySelector('[data-act="ok"]');
		okButton.textContent = okLabel;
		if (okDanger) {
			okButton.classList.add('danger');
		}

		const done = answer => {
			overlay.remove();
			resolve(answer);
		};
		overlay.addEventListener('mousedown', e => e.stopImmediatePropagation());
		overlay.querySelector('[data-act="cancel"]').addEventListener('click', e => {
			e.stopPropagation();
			done(false);
		});
		overlay.querySelector('[data-act="ok"]').addEventListener('click', e => {
			e.stopPropagation();
			done(true);
		});
		// Escape cancels, matching every other window in the client.
		const onKey = ev => {
			if (ev.key === 'Escape') {
				ev.stopPropagation();
				window.removeEventListener('keydown', onKey, true);
				done(false);
			}
		};
		window.addEventListener('keydown', onKey, true);
		// Same wrapper rule as the skill picker (see _panelMount).
		_panelMount().append(overlay);
	});
}

/**
 * Initialize events
 */
CompanionPanel.init = function init() {
	installChatHook();
	installSkillEscape();
	const root = this.getRoot();

	this.draggable('.titlebar');

	// Resize grip. Dragging it sets an explicit size; the stored size wins over
	// the content-driven default from then on. Double-click resets to auto.
	const grip = root.querySelector('.resize-grip');
	if (grip) {
		const panel = root.querySelector('.panel');
		grip.addEventListener('pointerdown', event => {
			event.preventDefault();
			event.stopPropagation();
			const startX = event.clientX;
			const startY = event.clientY;
			const startW = panel.offsetWidth;
			const startH = panel.offsetHeight;
			grip.setPointerCapture(event.pointerId);
			const move = ev => {
				const w = Math.max(296, startW + (ev.clientX - startX));
				const h = Math.max(160, startH + (ev.clientY - startY));
				panel.style.width = `${w}px`;
				panel.style.height = `${h}px`;
			};
			const up = () => {
				grip.removeEventListener('pointermove', move);
				grip.removeEventListener('pointerup', up);
				_preferences.width = panel.offsetWidth;
				_preferences.height = panel.offsetHeight;
				_preferences.save();
			};
			grip.addEventListener('pointermove', move);
			grip.addEventListener('pointerup', up);
		});
		grip.addEventListener('dblclick', event => {
			event.stopPropagation();
			panel.style.width = '';
			panel.style.height = '';
			_preferences.width = 0;
			_preferences.height = 0;
			_preferences.save();
		});
	}

	root.querySelector('.titlebar .close').addEventListener('click', () => {
		_hidePanel();
	});

	// Tabs are ui-button elements now, not plain <button>, so select on the class
	// and data attribute instead of the tag name.
	const tabs = root.querySelectorAll('.tab[data-tab]');
	tabs.forEach(btn => {
		btn.addEventListener('click', () => {
			tabs.forEach(b => b.classList.toggle('on', b === btn));
			root.querySelectorAll('.page').forEach(p => {
				p.style.display = p.dataset.page === btn.dataset.tab ? '' : 'none';
			});
			// Switching to a tab re-reads the roster, so a stale list cannot sit
			// there looking broken after companions are summoned or benched.
			if (btn.dataset.tab === 'party' || btn.dataset.tab === 'gear' ||
				btn.dataset.tab === 'rebirth') {
				refreshRoster();
			}
			// The Skills tab shows a chooser, so it opens with the list already fresh.
			if (btn.dataset.tab === 'skills') {
				_render();
			}
		});
	});
	if (tabs.length) {
		tabs[0].classList.add('on');
	}

};

/**
 * Intercept roster lines coming from the server BEFORE init runs, so the hook is
 * in place even if the first refresh answers before the component is initialised.
 *
 * ChatBox.addText is the single funnel every server message passes through, so
 * wrapping it is how the panel sees its own data without a second network path.
 * @CP lines return false so they never reach the chat log - the raw format is
 * machine data, not something a player should read.
 */


/// Keep where the player left the window. Closing it only hides it, and reopening goes
/// through append() -> onAppend, which places it from the preference; saving only in
/// onRemove (a map change or logout) put it back wherever it was before the last move.
function _savePosition() {
	// A hidden host reports offsetLeft/Top as 0; its position was saved as it was hidden.
	if (!CompanionPanel._host || CompanionPanel._host.style.display === 'none') {
		return;
	}
	_preferences.x = CompanionPanel._host.offsetLeft;
	_preferences.y = CompanionPanel._host.offsetTop;
	_preferences.squads = _preferences.squads || {};
	_preferences.save();
}

function _hidePanel() {
	_savePosition();
	CompanionPanel._host.style.display = 'none';
}

/**
 * When the window is removed
 */
CompanionPanel.onRemove = function onRemove() {
	_savePosition();
};

/**
 * Once appended: position from the saved preference (clamped to the viewport,
 * like every other window) and ask for the roster. A map change re-appends the
 * component, so this is also where the list is refreshed after a warp.
 */
CompanionPanel.onAppend = function onAppend() {
	// A size the player chose is applied here; with none, the panel keeps its
	// content-driven width so nothing is ever cropped by a stale fixed value.
	const panel = this.getRoot().querySelector('.panel');
	if (panel) {
		panel.style.width = _preferences.width ? `${_preferences.width}px` : '';
		panel.style.height = _preferences.height ? `${_preferences.height}px` : '';
	}
	Object.assign(this._host.style, {
		top: `${Math.min(Math.max(0, _preferences.y), Renderer.height - this._host.getBoundingClientRect().height)}px`,
		left: `${Math.min(Math.max(0, _preferences.x), Renderer.width - this._host.getBoundingClientRect().width)}px`
	});
	_roster = [];
	refreshRoster();
};

/**
 * Clean up
 */
CompanionPanel.clean = function clean() {
	_preferences.save();
};

CompanionPanel.toggle = function toggle() {
	// append() prepares on demand (see GUIComponent.append -> prepare), so this
	// also covers the case where the engine never prepared this component: a
	// button press must not be the thing that discovers _host is still null.
	if (!this.__active || !this._host || this._host.style.display === 'none') {
		this.append();
		this._host.style.display = '';
		if (typeof this._fixPositionOverflow === 'function') {
			this._fixPositionOverflow();
		}
	} else {
		_hidePanel();
	}
};

export default UIManager.addComponent(CompanionPanel);
export { refreshRoster };
