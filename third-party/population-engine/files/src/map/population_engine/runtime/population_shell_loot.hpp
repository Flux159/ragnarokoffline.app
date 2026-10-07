// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (shell looting): ambient shells walk over and pick up what their
// kills dropped, the way a player would. Off unless population_engine_loot_enable.
#pragma once

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

class map_session_data;

// One looting step, run from the combat tick before target selection.
// Returns true when looting owns this tick (the shell is walking to an item,
// picking one up, or pausing between pickups), in which case the caller skips
// combat for the tick. Returns false when there is nothing to loot right now,
// or when combat should win (normal loot while being attacked).
//
// Which drops it means to take, decided once per drop:
//  - a rare one (any card, or a base drop rate at or below
//    population_engine_loot_rare_rate per 10000) with
//    population_engine_loot_rare_pickup_pct chance: very likely, not certain;
//  - anything else with population_engine_loot_common_pickup_pct chance.
// When it goes for them:
//  - a rare drop even while monsters attack the shell, unless its HP is below
//    population_engine_loot_hp_abort_pct;
//  - anything else once nothing is attacking or targeting the shell. A drop a
//    fight held back is forgotten with population_engine_loot_forget_pct
//    chance when the fight ends, and any drop not reached within
//    population_engine_loot_timeout_ms is given up (rare ones get twice as long).
bool population_shell_loot_tick(map_session_data *sd, t_tick now);

// True while the shell is busy looting (so the ambient wander sweep leaves it alone).
bool population_shell_loot_busy(const map_session_data *sd);

// Drop all looting state, e.g. on death, teardown or when looting is switched off.
void population_shell_loot_clear(map_session_data *sd);

// Cheap inventory-only lifecycle check; no floor scan or proximity requirement.
bool population_shell_loot_try_unload(map_session_data *sd, t_tick now);
