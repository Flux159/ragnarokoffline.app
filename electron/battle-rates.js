'use strict';
//
// Drop rate keys for the generated battle configuration.
//
// rAthena keeps three independent families of drop rate -- ordinary monsters,
// bosses, and MVPs -- and reads a separate key per item category in each.
// Only part of two families were ever written: bosses got common, equipment
// and card but not healing or usable, and MVPs got nothing at all. A player
// who raised the sliders saw them work on ordinary monsters and not on the
// monsters they most wanted them for, which is what `@rates` reported.
//
// Generated from one table so a family cannot go half-covered again, and kept
// in its own module because main.js exports nothing and so nothing here could
// be tested -- which is the reason this went out wrong.

// The five categories rAthena scales, and which slider each follows. Healing
// and usable ride the item slider alongside common: the UI offers three
// numbers, not five, and splitting them here would invent a setting.
const CATEGORY_SLIDER = {
	common: 'item_rate_common',
	heal: 'item_rate_common',
	use: 'item_rate_common',
	equip: 'item_rate_equip',
	card: 'item_rate_card',
};

// '' is ordinary monsters. rAthena spells the other two as key suffixes.
const FAMILIES = ['', '_boss', '_mvp'];

/**
 * Every drop rate key, for every monster family, as battle-conf lines.
 *
 * Deliberately not included: `item_rate_mvp` is the MVP *reward* rather than a
 * drop and `item_rate_treasure` is chest contents, both of which the caller
 * sets from the item slider already; `item_rate_adddrop` scales drops granted
 * by equipment scripts, which is not what any of these sliders describes.
 */
function dropRateConf(settings) {
	return FAMILIES.flatMap(family =>
		Object.entries(CATEGORY_SLIDER).map(
			([category, slider]) => `item_rate_${category}${family}: ${settings[slider]}`))
		.join('\n') + '\n';
}

module.exports = { dropRateConf, FAMILIES, CATEGORY_SLIDER };
