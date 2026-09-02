// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
//
// Population Engine — merged core header.
// Consolidates:
//   population_engine_globals.hpp   — shared extern state (g_population_engine_pcs)
//   population_engine_internal.hpp  — internal function declarations
//   population_engine_types.hpp     — standalone runtime types/enums/structs
//   population_shell_constants.hpp  — timing constants and PAI flag namespace
#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

class map_session_data;

// ---------------------------------------------------------------------------
// Shared extern state (was: population_engine_globals.hpp)
// ---------------------------------------------------------------------------

extern std::vector<map_session_data *> g_population_engine_pcs;

// ---------------------------------------------------------------------------
// Internal function declarations (was: population_engine_internal.hpp)
// ---------------------------------------------------------------------------

/// Remove one shell from the map (map_quit). Clears chat/wander keys.
void population_engine_shell_release(map_session_data *sd);

/// Removes stale shells from g_population_engine_pcs and returns them.
/// Caller must call population_engine_shell_release on each returned pointer.
std::vector<map_session_data*> population_engine_collect_stale_shells();

/// Increment walk_failures counter in g_population_engine_stats.
void population_engine_stats_record_walk_failure();

// ---------------------------------------------------------------------------
// Runtime types (was: population_engine_types.hpp)
// ---------------------------------------------------------------------------

/// Which subsystem currently holds the movement token for this shell.
/// Exactly one owner can emit movement per tick.
enum class MovementOwner : uint8 {
	None   = 0,
	Combat = 1,
	Loot   = 2,
	Roam   = 3,
};

enum class MovementOwnerReason : uint8 {
	None           = 0,
	TargetActive   = 1,
	LootActive     = 2,
	NoValidTarget  = 3,
	TargetSearch   = 4,
	PathRecovery   = 5,
};

// ---------------------------------------------------------------------------
// Local navigation FSM
// ---------------------------------------------------------------------------

enum class LocalNavState : uint8 {
	DirectAdvance = 0,
	WallFollow    = 1,
	Recover       = 2,
};

// ---------------------------------------------------------------------------
// Navigation blocked cells
// ---------------------------------------------------------------------------

constexpr int PE_NAV_BLOCKED_CELLS_MAX = 16;
constexpr int PE_TYPE3_HOTSPOTS_MAX    = 8;

struct CANavBlockedCell {
	int    x          = 0;
	int    y          = 0;
	t_tick until_tick = 0;
};

// ---------------------------------------------------------------------------
// Forward-roam hotspot seeding
// ---------------------------------------------------------------------------

struct Type3Hotspot {
	int    x              = 0;
	int    y              = 0;
	int    score          = 0;
	t_tick last_seen_tick = 0;
};

// ---------------------------------------------------------------------------
// Active buff tracking
// ---------------------------------------------------------------------------

struct s_pe_active_buff {
	uint16 skill_id   = 0;
	uint16 skill_lv   = 0;
	t_tick expires_at = 0;  ///< When this buff expires (gettick()-based)
	uint32 target_id  = 0;  ///< Who the buff is on (0 = self)

	s_pe_active_buff() = default;
	s_pe_active_buff(uint16 id, uint16 lv, t_tick expires, uint32 target = 0)
		: skill_id(id), skill_lv(lv), expires_at(expires), target_id(target) {}
};

// ---------------------------------------------------------------------------
// Mob tracking
// ---------------------------------------------------------------------------

struct s_pe_tracked_mob {
	uint32  mob_id      = 0;
	int16   mob_type_id = 0; ///< mob_data->mob_id (the type, not the instance ID)
	int     x           = 0;
	int     y           = 0;
	t_tick  last_seen   = 0;
	int     hp          = 0;
	int     max_hp      = 0;
	uint32  target_id   = 0;
};

struct s_pe_mob_tracker {
	t_tick last_scan     = 0;
	t_tick scan_interval = 1000; ///< Scan interval in ms (default 1 s)
	std::unordered_map<uint32, s_pe_tracked_mob> tracked_mobs; ///< Key: mob instance ID
	int16  map_id        = 0;
};

// ---------------------------------------------------------------------------
// Position record
// ---------------------------------------------------------------------------

struct s_pe_position {
	int   map = 0;
	short x   = 0;
	short y   = 0;
	short dx  = 0;
	short dy  = 0;
};

// ---------------------------------------------------------------------------
// Mob-map record (tracks which map the last mob scan was performed on)
// ---------------------------------------------------------------------------

struct s_pe_mobs {
	uint16_t map = 0; ///< mapindex of the most recent mob scan.
};

// ---------------------------------------------------------------------------
// Detection cache
// ---------------------------------------------------------------------------

struct s_pe_detection_cache {
	std::vector<unsigned int> cached_monsters{}; ///< IDs from last mob scan.
	std::vector<unsigned int> cached_items{};    ///< IDs from last item scan.
	t_tick last_update  = 0; ///< Tick of last scan (0 = never).
	int    last_x       = 0; ///< Shell x at time of last scan.
	int    last_y       = 0; ///< Shell y at time of last scan.
	int    cache_radius = 0; ///< Radius used for the cached scan.
};

// ---------------------------------------------------------------------------
// Timing constants (was: population_shell_constants.hpp)
// ---------------------------------------------------------------------------

/// Defer SC start while warping / inactive
constexpr int PE_SHELL_DEFER_START_MS = 200;
/// Target exclusion after forced clear (matches legacy AC_TARGET_EXCLUSION_DURATION_MS)
constexpr int PE_SHELL_TARGET_EXCLUSION_MS = 500;
/// Stuck target / item pick (matches legacy autocombat timeouts)
constexpr int PE_SHELL_TARGET_ATTACK_TIMEOUT_MS = 4000;
constexpr int PE_SHELL_ITEM_PICK_TIMEOUT_MS = 5000;
constexpr int PE_SHELL_ATTACK_FAIL_CLEAR_COUNT = 5;
constexpr int PE_SHELL_SKILL_FAIL_CLEAR_TARGET_MS = 2000;
constexpr int PE_SHELL_ATTACK_APPROACH_CELLS = 2;
/// Max defer timer retries (~30s at 200ms) before giving up
constexpr intptr_t PE_SHELL_DEFER_MAX_ATTEMPTS = 150;

/// Population AI behavior flags (bitmask, read from battle_config.population_engine_ai):
namespace PAI {
	constexpr int32 ChaseRefresh    = 0x001; ///< Re-evaluate chase path every step
	constexpr int32 TargetSwitch    = 0x002; ///< Switch to closer enemy mid-combat
	constexpr int32 SkillWhileChase = 0x004; ///< Evaluate skills while approaching
	constexpr int32 ReactiveCheck   = 0x008; ///< Re-check conditions every tick
	constexpr int32 FleeOnLowHP    = 0x010; ///< Squishy roles retreat at low HP
	constexpr int32 SupportPriority = 0x020; ///< Support roles heal before self-buff
	constexpr int32 PackBehavior   = 0x040; ///< Share target info with nearby shells
	constexpr int32 KiteRanged     = 0x080; ///< Ranged jobs maintain max skill range
	constexpr int32 ComboAwareness = 0x100; ///< Chain skills fire in sequence
	constexpr int32 BossAvoidance  = 0x200; ///< Non-tank roles avoid boss monsters
}
