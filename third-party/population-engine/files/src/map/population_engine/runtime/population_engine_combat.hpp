// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine: shell combat management (standalone tick in population_engine_combat.cpp).
#pragma once

#include <cstdint>

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

class map_session_data;

enum class PopulationCombatStartMode : uint8 {
	AutoCombat = 0,
};

enum class PopulationCombatRejectCode : uint16 {
	NONE = 0,
	UNKNOWN = 1,
	INVALID_SESSION = 2,
	NOT_ACTIVE_OR_WARPING = 3,
	NO_DURATION = 4,
	SESSION_NOT_ACTIVE = 5,
	FAKE_MISSING_CLIENT_ADDR = 6,
	BEHAVIOR_LIMIT = 7,
	INVALID_MAP = 8,
	MAP_TOWN_BLOCKED = 9,
	MAP_PVP_BLOCKED = 10,
	MAP_GVG_BLOCKED = 11,
	MAP_BG_BLOCKED = 12,
	OVERWEIGHT_BLOCKED = 13,
	LIMIT_IP = 14,
	LIMIT_MAC = 15,
	LIMIT_GEPARD = 16,
	MAP_INSTANCE_BLOCKED = 17,
	MAP_WOE_BLOCKED = 18,
};

struct PopulationCombatStartResult {
	bool started = false;
	PopulationCombatStartMode mode = PopulationCombatStartMode::AutoCombat;
	PopulationCombatRejectCode reject_code = PopulationCombatRejectCode::NONE;
	int16 status_sc = 0;
	t_tick duration = INFINITE_TICK;
};

const char *population_combat_reject_code_name(PopulationCombatRejectCode code);

PopulationCombatStartResult population_engine_combat_start_session(map_session_data *sd, PopulationCombatStartMode mode, t_tick duration_override = -1, int32 scstart_flags = 0x01);
bool population_engine_combat_changestate(map_session_data *sd, int flag);
void population_engine_combat_cleanup_player(map_session_data *sd);

/// One timer tick for SC_POPULATION_COMBAT (population shell; map main thread only).
/// do_skills: false on movement-only passes (Phase 3 two-tier timer) — skips skill picker for lower per-tick cost.
int population_engine_combat_per_tick(map_session_data *sd, bool do_skills = true);

void do_init_population_engine_combat();
void do_final_population_engine_combat();

int32 population_engine_combat_defer_start(int32 tid, t_tick tick, int32 id, intptr_t data);

/// Stops population hat effect; safe if none was applied. Call before map_quit on shells.
void population_engine_combat_shell_teardown(map_session_data *sd);

/// Marks the shell combat-active (PSF::CombatActive). Returns false if the shell is not on a map.
bool population_engine_combat_try_start(map_session_data *sd);

/// Event-driven reactive cast: attempt self/ally buff skills immediately after the shell
/// receives damage, mirroring the mob_skill_db `closedattacked`/`longrangeattacked` model.
/// Only skills whose condition passes right now (e.g. SelfTargeted, MeleeAttacked) will fire.
/// Safe to call from population_engine_on_shell_damaged (main map thread only).
void population_engine_shell_reactive_cast(map_session_data *sd);

/// Shell is on-map and PSF::CombatActive is set (prune / wander gate).
bool population_engine_combat_shell_ac_ok(const map_session_data *sd);
