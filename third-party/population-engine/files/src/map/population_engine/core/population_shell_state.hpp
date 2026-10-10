// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
//
// Population shell: per-shell runtime state (sd->pop).

#ifndef POPULATION_SHELL_STATE_HPP
#define POPULATION_SHELL_STATE_HPP

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

#include <common/cbasetypes.hpp>
#include <common/timer.hpp> // t_tick

#include "population_engine_core.hpp"
#include "population_shell_hold.hpp" // RAGNAROKMAC

namespace expanded_ai { class ExpandedCondition; }

/// One offensive skill the population shell may rotate through (seeded from the PC skill tree or
/// population_skill_db.yml).  condition / cond_* mirror PopSkillCondition from population_skill_db.hpp
/// but stored as plain integers here to avoid cascading header dependencies.
struct PopulationShellCombatSkill {
	uint16_t skill_id   = 0;
	uint16_t skill_lv   = 0;
	uint16_t rate       = 10000; ///< 1–10000 per-10000; 0 = disabled
	bool     active     = true;
	uint8_t  condition  = 0;     ///< PopSkillCondition cast to uint8_t
	uint8_t  cond_value_num = 0; ///< Numeric threshold (HP%, SP%, cells, zone id)
	int16_t  cond_sc_resolved = -1; ///< Resolved sc_type for status conditions (-1 = none)
	uint8_t  target     = 0;    ///< 0=enemy (default), 2=ally (target=1 self skills go to buff list)
	uint8_t  around_range = 0;  ///< If >0, place ground/trap skills at a random cell within this radius of the shell
	bool     around_target = false; ///< When true, around_range centres on the enemy (mob_skill_db around5-8); when false (default), on self (around1-4)
	uint32_t cooldown_ms  = 0;  ///< Per-skill cooldown in ms after a successful cast (0 = no individual cooldown)
	std::shared_ptr<expanded_ai::ExpandedCondition> expanded; ///< Set iff condition == Expanded; evaluated in lieu of the flat condition fields.
};

/// One maintenance skill (Target:1=self, Target:2=ally) the population shell casts on upkeep.
/// Self skills re-cast whenever the associated SC expires.
/// Ally skills re-cast whenever a suitable ally (HP low, missing status, etc.) is found.
struct PopulationShellBuffSkill {
	uint16_t skill_id   = 0;
	uint16_t skill_lv   = 0;
	uint8_t  condition  = 0;     ///< PopSkillCondition cast to uint8_t
	uint8_t  cond_value_num = 0;
	int16_t  cond_sc_resolved = -1;
	uint8_t  target     = 1;     ///< 1=self, 2=ally
	uint8_t  around_range = 0;   ///< If >0, place ground/trap skills at a random cell within this radius of the shell
	bool     around_target = false; ///< When true, around_range centres on the enemy (mob_skill_db around5-8); when false (default), on self (around1-4)
	uint32_t cooldown_ms  = 0;   ///< Per-skill cooldown in ms after a successful cast (0 = no individual cooldown)
	std::shared_ptr<expanded_ai::ExpandedCondition> expanded; ///< Set iff condition == Expanded; evaluated in lieu of the flat condition fields.
};

/// RAGNAROKMAC (shell looting): one floor item a shell has decided to pick up.
/// Kept by block id and re-resolved every tick, never by pointer: the item can
/// be taken by someone else or expire between ticks.
struct PopulationShellLootEntry {
	int32_t  item_bl_id = 0;   ///< flooritem_data block id
	uint32_t nameid     = 0;   ///< guards against the block id being reused for another item
	t_tick   ready_at   = 0;   ///< reaction delay: not before this tick
	t_tick   give_up_at = 0;   ///< after this tick the shell "forgets" it
	bool     rare       = false;
	bool     interrupted = false; ///< a fight held it back; rolls the forget chance once the fight is over
	uint8_t  walk_fails = 0;
};

/// Population engine shell state (sd->pop). Only meaningful for bots managed by the population engine;
/// real players leave this in its default-constructed state.
struct s_population {
	std::vector<PopulationShellCombatSkill> attack_skills; ///< Offensive skill rotation (not `ca.autocombatskills` / not autosupport).
	/// RAGNAROKMAC: skill presets are seeded from the shell's CLASS, and the lists
	/// above are only built while empty. A companion that advances job therefore
	/// kept its old class's rotation forever (Acolyte -> Priest still cast Acolyte
	/// skills). The job-change path sets this, and the seeders rebuild when they
	/// see it, then clear it.
	bool     skills_need_reseed = false;
	/// RAGNAROKMAC (skill selector): the player's own skill selection.
	///
	/// `skill_override_active` distinguishes "the player never chose anything"
	/// (fall back to the preset list for the class) from "the player chose
	/// NOTHING on purpose" (auto-attack only). Testing the vector for emptiness
	/// alone cannot tell those apart, and the seeders rebuild a list while it is
	/// empty - so an empty choice would silently restore the full preset list.
	/// An entry with no curated behaviour row in population_skill_db.yml is
	/// dropped by the filter rather than cast blindly: those rows carry the
	/// rate, condition and target a cast needs.
	std::vector<uint16_t> skill_override;
	bool     skill_override_active = false;
	std::vector<PopulationShellBuffSkill>   buff_skills;   ///< Self-buff maintenance list (Target:1 from population_skill_db.yml).
	t_tick   reactive_buff_cd    = 0;  ///< Independent buff cooldown — decoupled from ca.skill_cd so self-buffs and attacks can fire in the same tick.
	t_tick   sticky_until        = 0;  ///< Tick at which the current sticky target commitment expires.
	uint32_t flags               = 0;  ///< PSF_* flag bitmask from population_engine.yml Flags: list.
	uint32_t sticky_target_id    = 0;  ///< Sticky-target commitment so the shell does not ping-pong between equidistant enemies. Standalone of autocombat's t3 sticky.
	int      max_attack_skill_range = -1; ///< Cached max range across attack_skills.
	int16_t  spawn_x             = 0;  ///< Spawn coordinates used by Guard behavior for return-to-post.
	int16_t  spawn_y             = 0;  ///< Spawn coordinates used by Guard behavior for return-to-post.
	int16_t  spawn_map_id        = -1; ///< Internal map ID of the designated spawn map (drift detection / death respawn).
	int      respawn_timer       = -1; ///< INVALID_TIMER when no respawn pending; else timer id from add_timer. Cancel before re-adding to prevent duplicates if a shell dies twice within the respawn window.
	uint8_t  attack_skill_cursor = 0;  ///< Round-robin index into attack_skills.
	uint8_t  map_category        = 0;  ///< Map category at spawn (0=none, 1=town, 2=field, 3=dungeon).
	uint8_t  behavior            = 2;  ///< Resolved behavior (mirrors PopulationBehavior, stored as uint8). Default: Combat.
	uint8_t  behavior_base       = 2;  ///< Original configured behavior (for daily cycle restore).
	int8_t   arena_team          = 0;  ///< PvP arena team (0=not in arena, 1=teamA, 2=teamB). Set by population_arena_start.
	int8_t   role                = 0;  ///< Combat role (0=none, 1=tank, 2=support, 3=attacker). From Role: in population_engine.yml.
	uint8_t  db_source           = 0;  ///< PopulationDbSource (0=Main, 1=Pvp, 2=Vendor). Set at spawn time so runtime lookups can find the correct DB.
	t_tick   last_attacked_tick  = 0;  ///< gettick() when shell last received damage (any source). Powers SelfTargeted condition for PvP / non-mob attackers.
	uint32_t last_attacker_id    = 0;  ///< id of the last source that damaged this shell (0 if unknown).
	int      last_damage_received = 0; ///< Largest single-hit damage received (reset on each hit). Powers damagedgt condition.
	uint16_t last_cast_skill_id   = 0; ///< Skill ID of the last offensive/buff skill successfully cast by this shell. Powers afterskill combo condition.
	uint16_t last_skill_used_on_me = 0; ///< Skill ID of the last skill used AGAINST this shell (set in on_shell_damaged from src unit_data). Powers skillused condition.
	t_tick   last_skill_used_on_me_tick = 0; ///< Tick when last_skill_used_on_me was recorded. Used for 3s stale window in SkillUsed condition eval.
	// RAGNAROKMAC (#373) diagnostics: shells found at 0 HP without rAthena's dead flag.
	t_tick   diag_zero_hp_tick   = 0;     ///< Last time a hit left the shell at 0 HP (pc_damage, before pc_dead); 0 = never
	t_tick   diag_death_tick     = 0;     ///< Last time pc_dead handled its death (population_engine_on_shell_death); 0 = never
	bool     diag_unhandled_logged = false; ///< Already logged at 0 HP without the dead flag; cleared once it has HP again
	t_tick   safetywall_kited_since = 0; ///< Tick when target first became unreachable while standing on SC_SAFETYWALL (0 = not kited). Used to abandon the wall after 4s so the bot can chase.

	// -----------------------------------------------------------------------
	// Standalone movement / combat runtime state
	// (was stored in sd->ca / s_autocombat in BanquetOfHeroes; moved here so
	//  the population engine has no dependency on the autocombat system)
	// -----------------------------------------------------------------------

	/// Which subsystem owns the walk token this tick (Roam, Combat, etc.).
	MovementOwner  movement_owner             = MovementOwner::None;
	MovementOwnerReason movement_owner_reason = MovementOwnerReason::None;
	uint32         movement_decision_trace_id = 0;
	t_tick         movement_owner_since_tick  = 0;
	t_tick         movement_owner_lock_until_tick = 0;
	bool           movement_emitted_this_tick = false;
	bool           movement_conflict_logged_this_tick = false;
	uint32         owner_switch_count  = 0;
	uint32         owner_blocked_count = 0;
	uint32         owner_noop_count    = 0;

	/// Last movement timestamp (gettick()).
	t_tick         last_move = 0;

	/// Last-known position (direction included for type-1 wander).
	s_pe_position  lastposition{};

	// --- Target / skill global cooldown ---
	int            target_id = 0;  ///< Active combat target (mob id or PC id in arena).
	t_tick         skill_cd  = 0;  ///< Global skill cooldown — no new skill until tick >= skill_cd.

	// --- Pathfinding ---
	std::vector<std::tuple<int, int>> path{}; ///< Pending waypoints (popped front-to-back).
	t_tick path_last_calc_tick = 0;

	// --- Session state ---
	/// Incremented whenever shell state is fully reset (map-change, disconnect, stop).
	/// 0 is reserved as unset; initial value is 1.
	uint32 session_guard       = 1;
	bool   initialized         = false; ///< True after first combat init (was: ca.client_addr != 0).
	uint32 unique_id           = 0;     ///< char_id or block id, set at init.
	bool   manual_stop_requested = false;
	int    action_on_end         = 0;   ///< 0=none, 1=return-to-savepoint, 2=relog.
	uint16 last_start_reject_code_raw = 0; ///< cast of CAStartRejectCode / rejection reason.
	/// Target IDs recently force-cleared, with the tick they were cleared.
	/// Prevents ping-pong re-targeting within PE_SHELL_TARGET_EXCLUSION_MS.
	std::unordered_map<uint32, t_tick> recently_cleared_targets{};

	// --- Local navigation FSM ---
	LocalNavState nav_state               = LocalNavState::DirectAdvance;
	int           nav_goal_x              = 0;
	int           nav_goal_y              = 0;
	int           nav_heading_x           = 0; ///< Normalized to -1/0/1.
	int           nav_heading_y           = 0; ///< Normalized to -1/0/1.
	t_tick        next_nav_attempt_tick   = 0;
	t_tick        last_nav_progress_tick  = 0;
	uint8         blocked_heading_streak  = 0;
	std::array<CANavBlockedCell, PE_NAV_BLOCKED_CELLS_MAX> nav_blocked_cells{};
	uint8         nav_blocked_cells_cursor = 0;

	// --- Roam anti-oscillation memory ---
	int    roam_last_target_x  = 0;
	int    roam_last_target_y  = 0;
	int    roam_last_dir_x     = 0; ///< Normalized to -1/0/1.
	int    roam_last_dir_y     = 0;
	t_tick roam_last_move_tick = 0;

	// --- Per-skill cooldown map (populated by skill-use logic) ---
	std::unordered_map<uint16, t_tick> skill_next_use_tick{};

	// --- Active buff tracking ---
	std::vector<s_pe_active_buff> active_buffs{};

	// --- Mob tracker ---
	s_pe_mob_tracker mob_tracker{};

	// --- Movetype-3 hotspot seeder ---
	std::array<Type3Hotspot, PE_TYPE3_HOTSPOTS_MAX> type3_hotspots{};

	// --- Movement emit tick (rate-limiter: one walk per tick) ---
	t_tick movement_emit_tick = 0; ///< Tick of last movement emission.

	// --- Pathfinding index / failure counters ---
	int    path_index          = 0; ///< Current index into path[] waypoint list.
	int    path_exec_fail_count = 0; ///< Consecutive ticks where position was stuck executing a path.
	t_tick last_move_fail      = 0; ///< Tick of last failed walk command (cooldown).

	// --- Attack / target tracking ---
	t_tick last_attack             = 0; ///< Tick of last normal or skill attack.
	t_tick last_target_switch_tick = 0; ///< Tick of last target switch.
	t_tick target_lost_tick        = 0; ///< Tick when the active target was lost.
	int    move_fail_count         = 0; ///< Consecutive movement failures chasing current target.
	int    attack_fail_count       = 0; ///< Consecutive attack command failures on current target.

	// RAGNAROKMAC: Pool-type vendor rotation. When >0, the vendor rotation timer
	// releases this shell once gettick() >= vendor_rotation_at; the autosummon
	// pass then re-fills the map with a fresh pick from the pool. Set at spawn
	// in the vending branch for vendors whose config has rotation_sec > 0.
	t_tick vendor_rotation_at = 0;
	// RAGNAROKMAC: the VendorKey this shell vends under (empty for non-vendors).
	// Lets the autosummon pass count vendors per placement rather than per map,
	// so several themed vendors can share a map without starving each other's
	// MaxVendors budget.
	std::string vendor_key;
	// RAGNAROKMAC: set only on shells spawned by the mod vendor pass. The pass
	// counts its own shells by this id (base vendors and other mods' never
	// match), and a fixed-seat block also records which seat the shell holds.
	std::string vendor_spawn_id;
	int16_t     vendor_seat = -1;
	// RAGNAROKMAC: items this stall lists by "fat-finger" mistake; undercutting
	// ignores them, so one typo does not drag the whole street's prices down.
	std::vector<t_itemid> vendor_mistakes;
	// RAGNAROKMAC: this mod vendor runs a buying store, not a vending stall.
	bool vendor_buying = false;
	/// RAGNAROKMAC: its mod's supply left its pool empty, so it opened no stall: the rotation
	/// pass releases it for the mod pass to roll the spot again (pop_mod_vendor_done).
	bool vendor_supply_empty = false;

	s_pop_hold hold; ///< RAGNAROKMAC: a script's hold on the shell (shell control API)
	// --- Party invite auto-accept flag ---
	bool   accept_party_request = false; ///< When true, bot auto-accepts the next party invite it receives.
	uint32_t party_request_account = 0; ///< Player who requested this one-shot invitation.
	t_tick party_request_until = 0; ///< Whisper permission expires after 60 seconds.
	uint32_t companion_owner_account = 0; ///< Real player this shell follows after joining their party.
	/// The owning CHARACTER. Companions belong to a character, not an account: two characters of
	/// one account each have their own, and only the owning character's session is "the owner".
	uint32_t companion_owner_char = 0;
	PopulationCompanionMode companion_mode = PopulationCompanionMode::Defensive; ///< Party-leader controlled engagement policy.
	/// Support healer thresholds, persisted with the companion row (v6). The support
	/// skill presets gate on ally_hp_below; these are the profile defaults they use.
	int16_t  companion_heal_at      = 75; ///< heal allies below this HP%
	/// Consecutive failed placement attempts near the owner; drives the backoff
	/// that replaced a per-tick re-warp loop (a shell teleported every 400 ms
	/// cannot walk, which reads as "the companion stands still").
	uint16_t placement_fail_streak = 0;
	/// RAGNAROKMAC (rest): the shell sat down to recover between fights (pop_shell_rest),
	/// so a companion's follow leaves it sitting while the owner stands still.
	bool     resting = false;
	/// RAGNAROKMAC (potions): the shell has its potion stock (pop_shell_stock_potions), given
	/// on its first combat tick and topped up after each full rest.
	bool     potions_stocked = false;
	t_tick   next_potion_tick = 0; ///< no potion before this tick: one a second, not one a tick
	/// RAGNAROKMAC (growth): last base level pushed to the party window. The stock
	/// party_send_levelup() routes through intif_party_changemap() to the CHAR
	/// server, which has no row for a shell and therefore discards it - so a
	/// companion's level in the party window only ever updated on a map change.
	/// The growth poll compares against this and re-broadcasts locally instead.
	int16_t  last_party_level_broadcast = 0;
	/// RAGNAROKMAC (growth): base level the extra point grant has been paid up to. Set on the
	/// first growth poll after spawn or recall without paying, so only levels gained from
	/// then on are paid, and reset down when a rebirth starts the level over.
	int16_t  points_granted_level = 0;
	int16_t  companion_emergency_at = 35; ///< emergency/big-heal below this HP%
	/// RAGNAROKMAC (rest): the companion sits down between fights below this SP% or HP%
	/// (0 = never) and stands once both are back to companion_rest_until. Set from the
	/// Companions window (@companion rest) and persisted with the row (v12).
	int16_t  companion_rest_below   = 30;
	int16_t  companion_rest_until   = 95;
	/// RAGNAROKMAC (gear custody): equip positions (EQP_* bits) worn by items the OWNER gave this
	/// companion, as opposed to the gear it was generated with. Only these come back through
	/// @companion gear, and only these are kept or handed back across a job advance. Persisted
	/// as cp_companion_persistence.given_mask so it survives a restart.
	uint32_t companion_given_mask = 0;
	/// RAGNAROKMAC (gear custody): the companion's inventory (nameid, amount per index) just before
	/// a trade's items move, so population_engine_companion_equip_traded acts only on what the trade
	/// brought in. Empty outside a trade.
	std::vector<std::pair<uint32_t, int32_t>> companion_trade_before;
	t_tick companion_follow_next = 0; ///< Rate limit for owner-follow movement decisions.
	bool companion_formation_active = false; ///< True while walking to the shell's assigned idle formation cell.
	int16_t companion_formation_x = 0; ///< Current formation walk destination.
	int16_t companion_formation_y = 0; ///< Current formation walk destination.
	/// RAGNAROKMAC (roam): the companion walks its owner's map on its own, as an ambient shell does,
	/// instead of following. It still changes maps with its owner. Set from the Companions window
	/// (@companion roam) and persisted with the row (v14).
	bool companion_roam = false;
	/// RAGNAROKMAC (roam): the companion was dead at the last companion tick, so the first tick
	/// that finds it alive again tells its owner's Companions window. rAthena has no revive hook.
	bool companion_was_dead = false;

	// --- RAGNAROKMAC (shell looting, population_shell_loot.cpp) ---
	bool ambient_quota = false; ///< Only ordinary autosummon shells may reserve a selling return.
	bool loot_selling_pending = false; ///< Deferred selling departure, rechecked before release.
	bool loot_collected = false; ///< At least one real pickup this lifetime; starting supplies do not count.
	bool loot_bag_blocked = false; ///< An owned drop would exceed the loot weight limit.
	std::vector<PopulationShellLootEntry> loot_queue{};     ///< Items it means to pick up, in no particular order.
	std::unordered_map<int32_t, t_tick> loot_seen{};      ///< Floor items already decided on (queued or forgotten) -> when to drop the record.
	t_tick  loot_next_scan    = 0; ///< Rate limit for the floor-item scan.
	t_tick  loot_next_action  = 0; ///< Short human pause between pickups.
	int32_t loot_walking_to   = 0; ///< Floor item the shell is walking to (0 = none).

	// --- Skill fail tracking ---
	t_tick last_skill_fail    = 0;  ///< Tick of last failed skill use.
	uint32 last_failed_target = 0;  ///< Target ID at last skill fail (0 = none).

	// --- Teleport tracking ---
	t_tick last_teleport = 0; ///< Tick of last warp / teleport.

	// --- Nearby mob tracking ---
	s_pe_mobs mobs{}; ///< Per-map mob-scan state (mapindex change detection).

	// --- Detection cache ---
	s_pe_detection_cache detection_cache{}; ///< Cached results of last nearest-mob scan.
};

#endif // POPULATION_SHELL_STATE_HPP
