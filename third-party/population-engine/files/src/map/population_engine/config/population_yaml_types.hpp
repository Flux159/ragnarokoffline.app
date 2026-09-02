// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Population engine: YAML-driven equipment, identity, and name profile types.

#ifndef POPULATION_YAML_TYPES_HPP
#define POPULATION_YAML_TYPES_HPP

#include <cstdint>
#include <string>
#include <vector>

#include <common/mmo.hpp> // t_itemid

struct script_code;

/// Optional per-job attack skill list (db/population_engine.yml `Skills:` sequence).
struct PopulationShellYamlSkill {
	uint16_t skill_id = 0;
	/// From YAML `Level` (default 10 per entry). 0 = do not force level via pc_skill; else ensure at least this level (capped by skill max).
	uint16_t level_cap = 0;
};

/// High-level shell behavior after spawn (db/population_engine.yml: Behavior).
enum class PopulationBehavior : uint8_t {
	None    = 0, ///< No wander, no combat
	Wander  = 1, ///< Random walk only
	Combat  = 2, ///< AutoCombat + wander (default)
	Support = 3, ///< Reserved for support AI (wander, no combat)
	Sit     = 4, ///< /sit emote, stays near spawn; minimal wander
	Social  = 5, ///< Wander + frequent chat + emotes
	Vendor  = 6, ///< Stand at spawn, display overhead shop message
	Guard   = 7, ///< Stand at spawn, attack on approach; return after combat
};

/// Named gear set for GearSet: inheritance in db/population_engine.yml.
/// Only gear slot pools and skip_arrow are inherited; Script/identity/stats are not.
struct PopulationGearSet {
	std::vector<uint16_t> weapon_pool;
	std::vector<uint16_t> shield_pool;
	std::vector<uint16_t> head_top_pool;
	std::vector<uint16_t> head_mid_pool;
	std::vector<uint16_t> head_bottom_pool;
	std::vector<uint16_t> armor_pool;
	std::vector<uint16_t> garment_pool;
	std::vector<uint16_t> shoes_pool;
	std::vector<uint16_t> acc_l_pool;
	std::vector<uint16_t> acc_r_pool;
	bool skip_arrow = false;
};

/// Shell combat role for coordinated party play (db/population_engine.yml: Role).
enum class PopulationRoleType : int8_t {
	None     = 0, ///< No role bias (default)
	Tank     = 1, ///< Frontliner: intercepts enemies threatening low-HP allies; prefers melee
	Support  = 2, ///< Healer/buffer: deprioritizes direct combat; prioritizes heal/buff skills
	Attacker = 3, ///< DPS: maximizes offensive output
};

struct PopulationEngine {
	/// Equipment slot pools — a random entry is picked each spawn.
	/// YAML scalar 0 = empty slot; scalar item_id/AegisName = one fixed item;
	/// YAML sequence of item_ids/AegisNames = random pick per spawn.
	/// Parser validates each entry against the slot's equip flag at load time.
	std::vector<uint16_t> weapon_pool;
	std::vector<uint16_t> shield_pool;
	std::vector<uint16_t> head_top_pool;
	std::vector<uint16_t> head_mid_pool;
	std::vector<uint16_t> head_bottom_pool;
	std::vector<uint16_t> armor_pool;
	std::vector<uint16_t> garment_pool;
	std::vector<uint16_t> shoes_pool;
	std::vector<uint16_t> acc_l_pool;
	std::vector<uint16_t> acc_r_pool;
	/// Full raw script source (YAML: Script: |).  Run once at spawn via run_script
	/// to execute side-effect commands (setriding, setfalcon, setcart, setarrow).
	std::string script_str;
	/// Filtered script source: script_str with side-effect commands removed.
	/// Registered via pc_bonus_script_add so bonus commands (bonus bStr,
	/// bonus3 bAutoSpell, …) survive every future status_calc_pc call.
	/// Side-effect commands are excluded because they internally call
	/// status_calc_pc / pc_equipitem and would cause a "Double continuation" crash.
	std::string bonus_script_str;
	/// Compiled script block — pre-compiled for validation at load time.
	struct script_code* script = nullptr;
	/// If true, do not auto-equip arrows for bow-class YAML weapons (YAML: Arrow: false).
	bool skip_arrow = false;
	/// If true (default), run normal job skill tree after spawn. If false, only basic survival skills.
	bool grant_skill_tree = true;
	/// Non-empty when `Skills:` is a sequence (attack rotation + optional grants). Empty when `Skills:` is bool only.
	std::vector<PopulationShellYamlSkill> shell_attack_skill_yaml;
	PopulationBehavior behavior = PopulationBehavior::Combat;

	/// Per-map-category behavior overrides.
	/// When set (not None), replace `behavior` for shells spawned in that category.
	/// Allows e.g. Combat in fields but Wander in towns.
	PopulationBehavior town_behavior    = PopulationBehavior::None;
	PopulationBehavior field_behavior   = PopulationBehavior::None;
	PopulationBehavior dungeon_behavior = PopulationBehavior::None;

	/// Guard behavior: aggro range in cells (0 = use default 5).
	uint8_t guard_range = 0;

	/// Combat role for party coordination. Influences skill selection priority in combat.
	PopulationRoleType role_type = PopulationRoleType::None;

	/// Vendor behavior: overhead message text (empty = job-default string).
	std::string vendor_message;
	/// Optional key into db/population_vendors.yml (VendorKey:). Empty = built-in default stock.
	std::string vendor_key;

	/// Phase 2 identity: -1 / unset = use engine defaults (random or job rule).
	int16_t str_min = -1, str_max = -1;
	int16_t agi_min = -1, agi_max = -1;
	int16_t vit_min = -1, vit_max = -1;
	int16_t intl_min = -1, intl_max = -1; // YAML key "Int"
	int16_t dex_min = -1, dex_max = -1;
	int16_t luk_min = -1, luk_max = -1;
	int16_t base_level_min = -1, base_level_max = -1;
	int16_t job_level_min = -1, job_level_max = -1;
	/// -1 = auto (job rule + random); 0 = female; 1 = male
	int8_t sex_override = -1;
	int16_t hair_min = -1, hair_max = -1;
	int16_t hair_color_min = -1, hair_color_max = -1;
	int16_t cloth_color_min = -1, cloth_color_max = -1;
	std::string name_profile;
	std::string name_prefix;
	std::string name_suffix;
	/// Phase 3: key in db/population_chat.yml (ChatProfile rows); empty = no random overhead lines
	std::string chat_profile;
	/// Shell behavior flags — bitfield of PSF_* values below.
	uint32_t flags = 0;
	/// Name of the Profile: this entry inherited from (empty if none). Used by
	/// PopulationEngineDatabase::jobs_with_profile() so the spawn loader can
	/// translate a profile name from population_spawn.yml into a list of jobs.
	std::string source_profile_name;
	~PopulationEngine();
};

/// Population shell flags (bitfield stored in PopulationEngine::flags and sd->pop.flags).
namespace PSF {
	constexpr uint32_t Mortal      = 1u << 0; ///< Shell can take damage and die (default: immortal)
	constexpr uint32_t AttackOnly  = 1u << 1; ///< Skip skills/buffs; only basic attack
	constexpr uint32_t SkillOnly   = 1u << 2; ///< Skip basic attack; only skill attacks
	constexpr uint32_t FleeOnLow   = 1u << 3; ///< Flee when HP drops below 30% (squishy jobs)
	constexpr uint32_t Kite        = 1u << 4; ///< Maintain max skill range instead of closing to melee
	constexpr uint32_t BossAvoid     = 1u << 5; ///< Avoid targeting MVP/boss monsters (non-tank roles)
	constexpr uint32_t CombatActive  = 1u << 6; ///< Runtime: shell fully set up and not yet in teardown
}

struct PopulationNameProfile {
	enum class Strategy : uint8_t { None = 0, Syllables, AdjectiveNoun, PickOne, BotIndex, PrefixNumber };
	Strategy strategy = Strategy::None;
	std::vector<std::string> syllables_start;
	std::vector<std::string> syllables_mid;
	std::vector<std::string> syllables_end;
	std::vector<std::string> adjectives;
	std::vector<std::string> nouns;
	std::vector<std::string> pool;
	int min_len = 2;
	int max_len = 22;
};

/// One item in a vendor's predefined stock list (db/population_vendors.yml).
struct PopulationVendorStock {
	t_itemid nameid = 0;
	int16_t  amount = 1;
	uint32_t price  = 0; ///< 0 = auto (item_data.value_buy)
};

/// A named vendor configuration entry from db/population_vendors.yml.
struct PopulationVendorEntry {
	std::string key;
	std::string title;           ///< Overhead vend title (empty = "Shop")
	bool        dynamic = false; ///< Derive stock from map mob drop tables at spawn time
	int         max_slots = 12;  ///< Cap vend slots (MC_VENDING lv10 = 12)
	uint32_t    price_multiplier = 100; ///< % of item sell value for dynamic entries
	std::vector<PopulationVendorStock> stock;

	// Dynamic-mode source pool: which maps to scan for mob drops.
	// Priority: explicit source_maps > source_category auto-discovery > spawn map (legacy).
	std::vector<std::string> source_maps; ///< Explicit map list (overrides auto-discovery).
	std::string source_category;          ///< "dungeon" | "field" | "both" (empty = legacy/spawn map only).
	bool        randomize_per_shell = false; ///< If true, each shell picks ONE map; else merge all maps.

	// Item type filters for dynamic-mode item inclusion.
	bool allow_equipment = false; ///< Include items where item_data.equip != 0.
	bool allow_cards     = false; ///< Include IT_CARD items.
	bool allow_etc       = true;  ///< Include IT_ETC items.
	bool allow_usable    = true;  ///< Include IT_HEALING / IT_USABLE / IT_DELAYCONSUME.

	// MaxAmount: per-item stack-size randomization range for dynamic-mode stock.
	// When dyn_amount_max > 0, each generated stockpile rolls a random integer in
	// [dyn_amount_min, dyn_amount_max].  Equipment is always capped to 1 (non-stackable).
	int dyn_amount_min = 0; ///< 0 = use built-in default (30).
	int dyn_amount_max = 0; ///< 0 = use built-in default (30).
};

/// Per-map vendor placement constraint (from db/population_engine.yml VendorPlacement: block).
struct PopulationVendorPlacement {
	std::string map;             ///< Map name this entry applies to.
	int min_spacing = 0;         ///< Minimum cells between two vendor shells (0 = no spacing check).
	int max_vendors = 0;         ///< Hard cap on simultaneous vendor shells on this map (0 = unlimited).
	int16_t area_x1 = -1, area_y1 = -1, area_x2 = -1, area_y2 = -1; ///< Optional bounding box (-1 = whole map).
};

#endif // POPULATION_YAML_TYPES_HPP
