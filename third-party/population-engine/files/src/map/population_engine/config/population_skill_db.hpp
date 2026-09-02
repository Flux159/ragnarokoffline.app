// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell skill database — per-job skill overrides loaded from db/population_skill_db.yml.
// Access via population_skill_db() (declared in population_config.hpp).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace expanded_ai { class ExpandedCondition; }

/// Condition type for a population shell skill entry.
/// Numeric thresholds use cond_value_num (0–100 or cell count).
/// Status-name conditions use cond_value_str (e.g. "stun", "freeze").
enum class PopSkillCondition : uint8_t {
	Always          = 0,  ///< No condition — always eligible
	HpBelow         = 1,  ///< Self HP% < cond_value_num
	SpBelow         = 2,  ///< Self SP% < cond_value_num
	HpAbove         = 3,  ///< Self HP% > cond_value_num
	EnemyHpBelow    = 4,  ///< Target HP% < cond_value_num
	EnemyHpAbove    = 5,  ///< Target HP% > cond_value_num
	EnemyStatus     = 6,  ///< Target has SC named in cond_value_str
	NotEnemyStatus  = 7,  ///< Target does NOT have SC named in cond_value_str
	SelfStatus      = 8,  ///< Self has SC named in cond_value_str
	NotSelfStatus   = 9,  ///< Self does NOT have SC named in cond_value_str
	DistanceBelow   = 10, ///< Distance to target <= cond_value_num cells
	DistanceAbove   = 11, ///< Distance to target > cond_value_num cells
	EnemyCountNearby= 12, ///< >= cond_value_num enemies within detection range
	MapZone         = 13, ///< Shell spawned in category: 1=town,2=field,3=dungeon
	MeleeAttacked   = 14, ///< A melee-range mob is targeting this shell
	RangeAttacked   = 15, ///< A ranged mob is targeting this shell
	AllyHpBelow     = 16, ///< Any nearby ally (BL_PC in skill range) has HP% < cond_value_num
	AllyStatus      = 17, ///< Any nearby ally has SC named in cond_value_str
	NotAllyStatus   = 18, ///< No nearby ally has SC named in cond_value_str (or self lacks it)
	HasSphere       = 19, ///< Shell has >= cond_value_num spirit spheres
	// -- Phase 2 reactive conditions --
	EnemyHidden         = 20, ///< Any tracked enemy has Hiding/Cloaking/Chase Walk
	EnemyCasting        = 21, ///< Current target is casting a skill (ud.skilltimer active)
	EnemyCastingGround  = 22, ///< Current target is casting a ground-targeted skill
	CellHasSkillUnit    = 23, ///< A hostile skill unit exists on the shell's cell (traps, ground effects)
	SelfTargeted        = 24, ///< Shell was damaged within the last N seconds (Value: window in seconds, default 3) OR a mob in the tracker is targeting this shell. Works for PvP / non-mob attackers.
	EnemyElement        = 25, ///< Target's defense element matches cond_value_num (ELE_* constant)
	EnemyRace           = 26, ///< Target's race matches cond_value_num (RC_* constant)
	AllyCountNearby     = 27, ///< >= cond_value_num allied PCs within 9 cells
	EnemyIsBoss         = 28, ///< Target has MD_BOSS mode
	SpAbove             = 29, ///< Self SP% > cond_value_num
	Expanded            = 30, ///< Boolean tree built from `Condition:` map/sequence (see expanded_ai/). cond_value_num/cond_value_str unused; tree stored on `expanded` shared_ptr.
	SelfBeingCastOn     = 31, ///< Any nearby unit is currently casting (skilltimer != INVALID_TIMER) and targeting this shell, OR casting a ground skill within `cond_value_num` cells (default 3) of the shell. Powers proactive dodge logic.
	// -- Phase 3: combo / reactive conditions from mob_skill_db analysis --
	AfterSkill          = 32, ///< Shell's previous successful cast matches cond_value_str skill name. Enables sequential combos (e.g. Frostnova → Thunder Storm). cond_sc_resolved holds resolved skill ID.
	DamagedGt           = 33, ///< Shell received a single hit larger than (cond_value_num % of max HP). E.g. CondValue:10 triggers when hit by >10% max HP in one blow.
	SkillUsed           = 34, ///< A specific skill (cond_value_str) was used against this shell within the last 3 seconds. Mirrors mob_skill_db `skillused`. cond_sc_resolved holds resolved skill ID.
};

/// One skill entry from population_skill_db.yml.
struct s_pop_skill_entry {
	uint16_t skill_id  = 0;      ///< Resolved skill ID (0 = invalid/skip)
	uint16_t skill_lv  = 1;      ///< Skill level to cast
	uint16_t rate      = 10000;  ///< 1–10000 (per 10000); 0 = disabled
	uint8_t  state     = 0;      ///< 0=any, 1=has_target(combat), 2=no_target(roam)
	uint8_t  target    = 0;      ///< 0=current mob, 1=self, 2=ally (nearest BL_PC in range)
	uint8_t  around_range = 0;   ///< If >0, place ground/trap skills at a random cell within this radius (mirrors mob_skill_db around1–4 = around self, around5–8 = around target when around_target=true)
	bool     around_target = false; ///< When true, around_range centres on the enemy (mob_skill_db around5–8); when false (default), centres on self (mob_skill_db around1–4).
	uint32_t cooldown_ms = 0;    ///< Per-skill cooldown in ms after a successful cast (0 = no cooldown beyond global skill_cd)
	PopSkillCondition condition = PopSkillCondition::Always;
	uint8_t  cond_value_num = 0; ///< Numeric threshold (HP%, SP%, cell count, zone id)
	std::string cond_value_str;  ///< SC name for status conditions (e.g. "stun")
	std::shared_ptr<expanded_ai::ExpandedCondition> expanded; ///< Set when condition == Expanded; null otherwise.
};
