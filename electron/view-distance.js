'use strict';
//
// View distance: how much of the map the server shows a player, and the three
// settings that have to move with it.
//
// A wider window already shows more terrain -- roBrowser keeps its vertical
// field of view fixed and widens the horizontal one to the window -- but the
// server only sends what is within `area_size` cells, so on a 21:9 or 32:9
// screen the sides are empty ground you cannot click. Every player here is
// their own server admin, which is why this is a setting rather than the usual
// "ask your server admin".
//
// One preset rather than four numbers, because the four only work together:
//
//   area_size         how far the server sends monsters, players and NPCs
//   max_walk_path     how many cells a click-to-walk may path; a click past it
//                     is silently dropped (unit_walktoxy)
//   view_range_rate   how far monsters see, as a percentage of mob_db range2
//   chase_range_rate  how far they chase, as a percentage of range3
//
// Draw distance past monster sight means hitting monsters that never react to
// you; a view past the walk limit means clicking ground you can see and not
// moving. Both rates are applied once, when the mob database loads, so this
// needs the restart Apply already does.

// `official` is rAthena's own defaults, so an install that never touches this
// writes exactly what the shipped config says.
//
// max_walk_path stops at 24: rAthena refuses anything over MAX_WALKPATH (32),
// and roBrowser's own pathfinder -- which animates every walk the server
// confirms -- works in the same 32x32 window with a small open list, so paths
// near 32 around obstacles are where the two stop agreeing. OFFICIAL_WALKPATH
// is compiled in as well and still caps a walk at 14 cells when something
// blocks the straight line; no config reaches that.
const PRESETS = {
	official: { area_size: 14, max_walk_path: 17, view_range_rate: 100, chase_range_rate: 100 },
	wide: { area_size: 20, max_walk_path: 20, view_range_rate: 140, chase_range_rate: 140 },
	ultrawide: { area_size: 28, max_walk_path: 24, view_range_rate: 200, chase_range_rate: 200 },
};

const DEFAULT = 'official';

// Anything not a known preset -- a hand-edited settings.json, a name from a
// later version -- writes rAthena's defaults rather than refusing to start.
function preset(name) {
	return Object.hasOwn(PRESETS, name) ? name : DEFAULT;
}

function viewDistanceConf(settings) {
	return Object.entries(PRESETS[preset(settings.view_distance)])
		.map(([key, value]) => `${key}: ${value}\n`)
		.join('');
}

module.exports = { viewDistanceConf, preset, PRESETS, DEFAULT };
