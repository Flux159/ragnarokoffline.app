'use strict';
//
// Population engine lines for the generated battle configuration.
//
// Kept in its own module because main.js exports nothing and so nothing here
// could be tested -- which is how a setting went out unclamped before (see
// battle-rates.js). Every number goes through one place, so the Settings
// window and the server always agree on bounds.

// rAthena's MAX_PARTY in our fork is 12: leader plus members. The companion cap
// may never swallow a slot a real player could take, which is why the UI and
// this clamp top out at 11. The floor of 4 keeps existing saves meaningful and
// matches what every guide already documents as the minimum party shape.
const COMPANION_LIMIT_MIN = 4;
const COMPANION_LIMIT_MAX = 11;

function companionLimit(s) {
	const v = Number(s.population_companion_limit);
	if (!Number.isFinite(v)) return COMPANION_LIMIT_MIN;
	return Math.min(COMPANION_LIMIT_MAX, Math.max(COMPANION_LIMIT_MIN, Math.round(v)));
}

/**
 * Every population key the server reads, in order. The count is always
 * written, even when the engine is off: rAthena refuses a 0 for it and "none"
 * is expressed by the enable flag alone (see main.js toBattleConf).
 */
function lines(settings) {
	const on = settings.population_enable ? 1 : 0;
	const max = Math.max(1, Number(settings.population_max) || 1);
	const density = Math.min(500, Math.max(10, Number(settings.population_density) || 100));
	return (
		`population_engine_enable: ${on}\n` +
		`population_engine_max_count: ${max}\n` +
		`population_engine_density_pct: ${density}\n` +
		// Written even while the engine is off, so a raise sticks if it is turned on later.
		`population_engine_companion_limit: ${companionLimit(settings)}\n` +
		// Off in the compiled defaults. Upstream turns it on in a conf file we
		// deliberately do not import, so without this line no shell ever opens
		// a stall -- and a town of people with nothing to sell is most of what
		// makes one feel dead.
		`population_engine_vending_enable: ${on}\n`
	);
}

module.exports = { lines, companionLimit, COMPANION_LIMIT_MIN, COMPANION_LIMIT_MAX };
