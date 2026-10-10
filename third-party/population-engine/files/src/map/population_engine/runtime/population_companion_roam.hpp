// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (roam): a recruited companion that walks its owner's map on its own,
// the way an ambient field shell does, instead of following; and the "I'm down"
// notice a companion gives when it dies, which a roaming one needs most.
//
// The whole feature lives in this file and population_companion_roam.cpp. The engine
// reaches it from lines marked "RAGNAROKMAC (roam)":
//
//   population_engine.cpp          owner-follow (leash, sitting), the companion loop
//                                  (target, stop-walking, formation, life watch), the
//                                  rest check, death, party-chat Recall, the recall
//                                  from the database, the companion list's fields
//   population_engine_combat.cpp   the companion's turn when it has no target
//
// A companion roams only when the server allows it (population_engine_companion_roam,
// Settings -> Population -> Companion roaming, off by default) and its owner says so
// (@companion roam, which the Companions window sends); every hook returns at once
// otherwise, so a companion that does not roam behaves exactly as before.
#pragma once

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

class map_session_data;

/// Whether `sd` is a recruited companion set to roam.
bool population_companion_roams(const map_session_data *sd);

/// The roaming companion's target, given what the party controller chose (`desired`).
/// It fights only what is near itself: a target out of its sight is dropped (the
/// owner's fight across the map is not its fight), and in Attack mode it picks
/// monsters around itself rather than around its owner.
uint32 population_companion_roam_target(map_session_data *sd, uint32 desired);

/// The companion's turn with no target: a roaming one walks on, as a field shell does.
void population_companion_roam_step(map_session_data *sd, t_tick tick);

/// Party-chat Recall brought the companion back: it follows again.
void population_companion_roam_recalled(map_session_data *sd);

/// After companions were recalled from the database: set the roam flag of every
/// live companion of `owner` from its row. Runs after the recall's own query is done.
void population_companion_roam_restore(map_session_data *owner);

/// The companion died: tell the party where, and refresh the owner's window.
void population_companion_on_down(map_session_data *sd);

/// Every companion tick, alive or dead: the first tick that finds a dead companion
/// alive again refreshes the owner's window (rAthena has no revive hook).
void population_companion_watch_life(map_session_data *sd);
