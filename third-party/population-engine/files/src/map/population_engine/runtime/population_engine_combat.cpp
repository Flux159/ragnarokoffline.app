// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
//
// Population engine shell combat: synchronous main-thread tick.
// Path/target/movement state stored in map_session_data::pop.
// Offensive skills stored in map_session_data::pop::attack_skills.

#include "population_engine_combat.hpp"

#include "../../population_engine.hpp"
#include "../config/population_yaml_types.hpp"
#include "../core/population_engine_core.hpp"
#include "population_shell_runtime.hpp"

#include <algorithm>
#include <cmath>
#include <ctime>
#include <unordered_set>
#include <vector>

#include <common/nullpo.hpp>
#include <common/random.hpp>
#include <common/showmsg.hpp>
#include <common/socket.hpp>
#include <common/timer.hpp>
#include <common/utils.hpp>
#include <common/utilities.hpp>

#include "../config/population_config.hpp"
#include "../config/population_skill_db.hpp"
#include "../config/population_yaml_types.hpp"
#include "../expanded_ai/expanded_condition.hpp"
#include "../../battle.hpp"
#include "../../clif.hpp"
#include "../../script.hpp"
#include "../../map.hpp"
#include "../../mob.hpp"
#include "../../path.hpp"
#include "../../pc.hpp"
#include "../../skill.hpp"
#include "../../status.hpp"
#include "../../unit.hpp"

using namespace rathena;

namespace {

static void population_engine_apply_shell_hat_effect(map_session_data *sd, bool enable)
{
#if PACKETVER_MAIN_NUM >= 20150507 || PACKETVER_RE_NUM >= 20150429 || defined(PACKETVER_ZERO)
	if (sd == nullptr)
		return;
	const int effectID = population_config_shell_hat_effect_id();
	if (effectID <= HAT_EF_MIN || effectID >= HAT_EF_MAX)
		return;
	unit_data *ud = unit_bl2ud(sd);
	if (ud == nullptr)
		return;
	if (enable) {
		if (rathena::util::vector_exists(ud->hatEffects, static_cast<int16>(effectID)))
			return;
		ud->hatEffects.push_back(static_cast<int16>(effectID));
	} else {
		rathena::util::vector_erase_if_exists(ud->hatEffects, static_cast<int16>(effectID));
	}
	clif_hat_effect_single(*sd, static_cast<uint16>(effectID), enable);
#else
	(void)sd;
	(void)enable;
#endif
}

static int shell_effective_move_max()
{
	int v = battle_config.population_engine_shell_move_max;
	return v > 0 ? v : 20;
}

static int shell_effective_move_min()
{
	int v = battle_config.population_engine_shell_move_min;
	return v > 0 ? v : 7;
}

static void population_shell_try_roam_step(map_session_data *sd)
{
	if (sd == nullptr || unit_is_walking(sd))
		return;
	s_population &pe = sd->pop;
	MovementOwner owner = pe.movement_owner == MovementOwner::None ? MovementOwner::Roam : pe.movement_owner;
	if (!population_shell_can_emit_movement(sd, owner, "population_shell:roam")) {
		return;
	}

	const int max_distance = shell_effective_move_max();
	const int min_distance = shell_effective_move_min();
	// Cap walk target so unit_walktoxy path_len checks pass.
	// max_walk_path - 5 leaves headroom for A* obstacle detours; floor at min_distance.
	const int walk_cap = std::min(max_distance,
		std::max(static_cast<int>(min_distance), battle_config.max_walk_path - 5));

	// Helper: try full A* walk (flag=0) to (tx,ty).
	auto try_walk = [&](int tx, int ty) -> bool {
		if (tx == sd->x && ty == sd->y) return false;
		if (!map_getcell(sd->m, static_cast<short>(tx), static_cast<short>(ty), CELL_CHKPASS))
			return false;
		if (!unit_walktoxy(sd, static_cast<short>(tx), static_cast<short>(ty), 0) &&
		    !unit_walktoxy(sd, static_cast<short>(tx), static_cast<short>(ty), 1))
			return false;
		pe.last_move = gettick();
		return true;
	};

	// 1. Pick a random direction within walk_cap.
	int dx = (rnd() % (walk_cap * 2 + 1)) - walk_cap;
	int dy = (rnd() % (walk_cap * 2 + 1)) - walk_cap;
	dx = (dx >= 0) ? std::max(dx, min_distance) : -std::max(-dx, min_distance);
	dy = (dy >= 0) ? std::max(dy, min_distance) : -std::max(-dy, min_distance);
	dx = std::clamp(dx, -walk_cap, walk_cap);
	dy = std::clamp(dy, -walk_cap, walk_cap);

	// 2. Progressive fallback: full vector → half → quarter.
	//    This avoids the hard drop to 1-cell steps when the full target is unreachable
	//    (e.g. the A* path would exceed max_walk_path due to town obstacles).
	for (int scale = 1; scale <= 4; scale *= 2) {
		const int tdx = dx / scale;
		const int tdy = dy / scale;
		if (tdx == 0 && tdy == 0) break;
		if (try_walk(sd->x + tdx, sd->y + tdy))
			return;
	}

	// 2.5. Perpendicular half-scale steps before dropping to 1-cell adjacents.
	if (dx != 0 || dy != 0) {
		const int half = std::max(1, walk_cap / 2);
		const int perp1x = std::clamp(-dy, -half, half);
		const int perp1y = std::clamp(dx,  -half, half);
		const int perp2x = std::clamp(dy,  -half, half);
		const int perp2y = std::clamp(-dx, -half, half);
		if ((perp1x != 0 || perp1y != 0) && try_walk(sd->x + perp1x, sd->y + perp1y))
			return;
		if ((perp2x != 0 || perp2y != 0) && try_walk(sd->x + perp2x, sd->y + perp2y))
			return;
	}

	// 4. Last resort: try each of the 8 adjacent cells.
	static const int step_offsets[8][2] = {
		{1, 0}, {-1, 0}, {0, 1}, {0, -1},
		{1, 1}, {1, -1}, {-1, 1}, {-1, -1},
	};
	for (int i = 0; i < 8; ++i) {
		if (try_walk(sd->x + step_offsets[i][0], sd->y + step_offsets[i][1]))
			return;
	}
	// All immediate steps failed — give up this tick. Async A* fallback removed;
	// rAthena's built-in pathing in unit_walktoxy already handles complex routing.
	pe.movement_emitted_this_tick = false;
}

/// State-driven sphere chain picker for Monk/Champion/Sura — any bot that knows
/// MO_CALLSPIRITS, MO_EXPLOSIONSPIRITS, or MO_EXTREMITYFIST.
/// Returns true and fills out_id/out_lv when it overrides the generic rotation.
/// Chain: build spheres → Fury (if Asura available) → build spheres → Asura Strike.
/// For bots without Asura: build spheres → FINGEROFFENSIVE.
static bool population_shell_pick_sphere_chain_skill(map_session_data *sd, uint16 &out_id, uint16 &out_lv)
{
	out_id = 0;
	out_lv = 0;
	if (!sd)
		return false;

	const uint16 callspirits_lv    = pc_checkskill(sd, MO_CALLSPIRITS);
	const uint16 zen_lv            = pc_checkskill(sd, CH_SOULCOLLECT);      // Zen: instant 5 spheres
	const uint16 fury_lv           = pc_checkskill(sd, MO_EXPLOSIONSPIRITS); // Fury: needs 5 spheres
	const uint16 asura_lv          = pc_checkskill(sd, MO_EXTREMITYFIST);
	const uint16 finger_lv         = pc_checkskill(sd, MO_FINGEROFFENSIVE);
	const uint16 investigate_lv    = pc_checkskill(sd, MO_INVESTIGATE);
	const uint16 triple_lv         = pc_checkskill(sd, MO_TRIPLEATTACK);

	// Only take over if at least one sphere-management skill is known
	if (!callspirits_lv && !zen_lv)
		return false;

	const int  spheres      = sd->spiritball;
	const bool has_fury     = sd->sc.getSCE(SC_EXPLOSIONSPIRITS) != nullptr;
	// Max spheres CALLSPIRITS can fill to equals its skill level (cast fails if already at cap)
	const int  sphere_cap   = callspirits_lv ? static_cast<int>(callspirits_lv) : 5;
	const int  spheres_needed = 5; // Both Fury and Asura consume 5 spheres

	auto pick = [&](uint16 id, uint16 lv) {
		if (!skill_isNotOk(id, *sd) && sd->status.sp >= static_cast<uint32>(skill_get_sp(id, lv))) {
			out_id = id; out_lv = lv; return true;
		}
		return false;
	};

	// --- Asura path (bot knows Fury or Asura) ---
	if (fury_lv || asura_lv) {
		if (has_fury && spheres >= spheres_needed && asura_lv)
			if (pick(MO_EXTREMITYFIST, asura_lv)) return true;

		// Need more spheres (either pre-Fury or post-Fury building)
		if (spheres < spheres_needed) {
			// Zen is instant 5 spheres — prefer it over 5× CALLSPIRITS
			if (zen_lv && pick(CH_SOULCOLLECT, zen_lv)) return true;
			if (callspirits_lv && spheres < sphere_cap)
				if (pick(MO_CALLSPIRITS, callspirits_lv)) return true;
		}

		// Have 5 spheres, no Fury yet → trigger Fury
		if (!has_fury && spheres >= spheres_needed && fury_lv)
			if (pick(MO_EXPLOSIONSPIRITS, fury_lv)) return true;
	} else {
		// --- Simple sphere path: CALLSPIRITS → FINGEROFFENSIVE ---
		if (finger_lv && spheres >= 1 && spheres >= sphere_cap)
			if (pick(MO_FINGEROFFENSIVE, finger_lv)) return true;
		if (zen_lv && spheres < spheres_needed && pick(CH_SOULCOLLECT, zen_lv)) return true;
		if (callspirits_lv && spheres < sphere_cap)
			if (pick(MO_CALLSPIRITS, callspirits_lv)) return true;
		if (finger_lv && spheres >= 1)
			if (pick(MO_FINGEROFFENSIVE, finger_lv)) return true;
	}

	// Fallback: reliable damage skills that need no sphere/state
	if (investigate_lv && pick(MO_INVESTIGATE, investigate_lv)) return true;
	if (triple_lv      && pick(MO_TRIPLEATTACK, triple_lv))     return true;

	return false;
}

/// Resolve a SC name (e.g. "stun") to sc_type at seed time.
/// Tries the name as-is, then with "SC_" prefix uppercased.
/// Returns -1 if unresolvable.
static int16_t population_shell_resolve_sc_name(const std::string& name)
{
	if (name.empty())
		return -1;
	int64_t cst = 0;
	if (script_get_constant(name.c_str(), &cst))
		return static_cast<int16_t>(cst);
	std::string prefixed = "SC_";
	for (char c : name)
		prefixed += static_cast<char>(::toupper(static_cast<unsigned char>(c)));
	if (script_get_constant(prefixed.c_str(), &cst))
		return static_cast<int16_t>(cst);
	return -1;
}

// ============================================================================
// Ally target finder helpers (population shell support AI)
// ============================================================================

/// Shared context passed to ally scan callbacks.
struct PopAllySearchCtx {
	map_session_data *shell;
	uint8_t           hp_threshold;    ///< HP% upper bound for AllyHpBelow scans
	int16_t           sc_resolved;     ///< Resolved sc_type; -1 = none
	bool              want_has_status; ///< true=find ally WITH status, false=WITHOUT
	int               best_hp_pct;     ///< Tracks lowest HP% seen (100=no winner yet)
	map_session_data *result;          ///< Best ally found (nullptr if none)
};

/// Scan callback: finds the living ally with the lowest HP% below hp_threshold.
static int32 pop_ally_hp_scan_cb(block_list *bl, va_list ap)
{
	map_session_data *ally = BL_CAST(BL_PC, bl);
	if (!ally) return 0;
	PopAllySearchCtx *ctx = va_arg(ap, PopAllySearchCtx*);
	if (ally->id == ctx->shell->id) return 0;
	// Real players are skipped UNLESS they are an arena ally of this shell
	// (team-2 shell + real player on the same arena map = mutual allies).
	if (!ally->state.population_combat
	    && !population_engine_arena_is_ally(ctx->shell, ally))
		return 0;
	if (!ally->state.active || ally->state.warping) return 0;
	if (status_isdead(*ally)) return 0;
	if (ally->battle_status.max_hp == 0) return 0;
	const int pct = static_cast<int>(ally->battle_status.hp * 100 / ally->battle_status.max_hp);
	if (pct < ctx->hp_threshold && pct < ctx->best_hp_pct) {
		ctx->best_hp_pct = pct;
		ctx->result = ally;
	}
	return 0;
}

/// PackBehavior callback: share target_id with nearby idle shells.
static int32 pop_pack_share_target_cb(block_list *bl, va_list ap)
{
	map_session_data *ally = BL_CAST(BL_PC, bl);
	if (!ally) return 0;
	int source_id = va_arg(ap, int);
	int target_id = va_arg(ap, int);
	if (ally->id == source_id) return 0;
	if (!ally->state.population_combat) return 0;
	if (!ally->state.active || ally->state.warping) return 0;
	if (status_isdead(*ally)) return 0;
	// Only share with idle shells (no current target).
	if (ally->pop.target_id != 0) return 0;
	// Only share with combat-capable shells.
	const auto beh = static_cast<PopulationBehavior>(ally->pop.behavior);
	if (beh != PopulationBehavior::Combat && beh != PopulationBehavior::Guard)
		return 0;
	population_shell_target_change(ally, target_id);
	return 0;
}

/// Scan callback: counts living ally PCs (population shells) in range.
static int32 pop_ally_count_cb(block_list *bl, va_list ap)
{
	map_session_data *ally = BL_CAST(BL_PC, bl);
	if (!ally) return 0;
	int *count = va_arg(ap, int*);
	int shell_id = va_arg(ap, int);
	if (ally->id == shell_id) return 0; // exclude self
	if (!ally->state.active || status_isdead(*ally)) return 0;
	(*count)++;
	return 0;
}

/// Scan callback: detect any unit currently casting (skilltimer active) that
/// is targeting this shell directly OR landing a ground skill within `ground_radius`
/// cells of the shell. Sets *hit = true on first match and short-circuits.
static int32 pop_being_cast_on_cb(block_list *bl, va_list ap)
{
	unit_data *ud = unit_bl2ud(bl);
	if (!ud) return 0;
	if (ud->skilltimer == INVALID_TIMER) return 0;
	bool *hit          = va_arg(ap, bool*);
	int   shell_id     = va_arg(ap, int);
	int   shell_x      = va_arg(ap, int);
	int   shell_y      = va_arg(ap, int);
	int   ground_radius = va_arg(ap, int);
	if (bl->id == shell_id) return 0; // ignore self-casts
	if (*hit) return 0;
	// Direct-target cast on this shell.
	if (ud->skilltarget == shell_id) { *hit = true; return 1; }
	// Ground/AoE cast landing near the shell.
	if (ud->skill_id != 0) {
		const int inf = skill_get_inf(ud->skill_id);
		if (inf & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
			const int dx = ud->skillx - shell_x;
			const int dy = ud->skilly - shell_y;
			if (dx * dx + dy * dy <= ground_radius * ground_radius) { *hit = true; return 1; }
		}
	}
	return 0;
}

/// Scan callback: finds the first living ally that has (or lacks) a specific SC.
static int32 pop_ally_status_scan_cb(block_list *bl, va_list ap)
{
	map_session_data *ally = BL_CAST(BL_PC, bl);
	if (!ally) return 0;
	PopAllySearchCtx *ctx = va_arg(ap, PopAllySearchCtx*);
	if (ally->id == ctx->shell->id) return 0;
	if (!ally->state.population_combat
	    && !population_engine_arena_is_ally(ctx->shell, ally))
		return 0;
	if (!ally->state.active || ally->state.warping) return 0;
	if (status_isdead(*ally)) return 0;
	if (ctx->sc_resolved < 0) return 0;
	const status_change *sca = status_get_sc(ally);
	const bool has_it = sca && sca->hasSCE(static_cast<sc_type>(ctx->sc_resolved));
	if (has_it == ctx->want_has_status) {
		ctx->result = ally;
		return 1; // stop scan
	}
	return 0;
}

/// Scan callback: finds any living nearby ally (for Always-condition ally casts).
static int32 pop_ally_any_scan_cb(block_list *bl, va_list ap)
{
	map_session_data *ally = BL_CAST(BL_PC, bl);
	if (!ally) return 0;
	PopAllySearchCtx *ctx = va_arg(ap, PopAllySearchCtx*);
	if (ally->id == ctx->shell->id) return 0;
	if (!ally->state.population_combat
	    && !population_engine_arena_is_ally(ctx->shell, ally))
		return 0;
	if (!ally->state.active || ally->state.warping) return 0;
	if (status_isdead(*ally)) return 0;
	ctx->result = ally;
	return 1; // take the first one
}

/// Context for Tank-role intercept: find a mob that is targeting a nearby population-shell ally.
struct PopTankInterceptCtx {
	map_session_data *tank;        ///< The intercepting tank shell
	int32              result_id;  ///< BL id of the mob to intercept (0 if none found)
};

/// Scan callback: finds the first living mob whose target_id is a population shell ally (not self).
static int32 pop_tank_intercept_cb(block_list *bl, va_list ap)
{
	mob_data *md = BL_CAST(BL_MOB, bl);
	if (!md || md->status.hp <= 0) return 0;
	if (md->target_id == 0) return 0;
	PopTankInterceptCtx *ctx = va_arg(ap, PopTankInterceptCtx*);
	// Only intercept mobs targeting population shell allies (not targeting the tank itself).
	if (md->target_id == ctx->tank->id) return 0;
	block_list *tgt = map_id2bl(md->target_id);
	map_session_data *tgt_sd = BL_CAST(BL_PC, tgt);
	if (!tgt_sd) return 0;
	if (!tgt_sd->state.population_combat) return 0; // only protect shell allies, not real players
	if (!tgt_sd->state.active || status_isdead(*tgt_sd)) return 0;
	ctx->result_id = md->id;
	return 1; // stop scan on first match
}

/// Find the best ally target within scan_range cells satisfying the given condition.
/// Returns nullptr if no suitable ally exists.
static map_session_data* population_shell_find_ally_target(
	map_session_data *sd,
	uint8_t condition, uint8_t threshold, int16_t sc_resolved,
	int16_t scan_range = 9)
{
	using C = PopSkillCondition;
	const C cond = static_cast<C>(condition);
	PopAllySearchCtx ctx{};
	ctx.shell           = sd;
	ctx.hp_threshold    = threshold;
	ctx.sc_resolved     = sc_resolved;
	ctx.want_has_status = false;
	ctx.best_hp_pct     = 101;
	ctx.result          = nullptr;

	switch (cond) {
	case C::AllyHpBelow:
		map_foreachinrange(pop_ally_hp_scan_cb, sd, scan_range, BL_PC, &ctx);
		break;
	case C::AllyStatus:
		ctx.want_has_status = true;
		map_foreachinrange(pop_ally_status_scan_cb, sd, scan_range, BL_PC, &ctx);
		break;
	case C::NotAllyStatus:
		ctx.want_has_status = false;
		map_foreachinrange(pop_ally_status_scan_cb, sd, scan_range, BL_PC, &ctx);
		break;
	case C::Always:
		// For unconditional ally casts: prefer lowest-HP ally, fallback to any
		ctx.hp_threshold = 100;
		map_foreachinrange(pop_ally_hp_scan_cb, sd, scan_range, BL_PC, &ctx);
		if (!ctx.result)
			map_foreachinrange(pop_ally_any_scan_cb, sd, scan_range, BL_PC, &ctx);
		break;
	default:
		break;
	}
	return ctx.result;
}

} // namespace (close anon — next function must be in global namespace so its
  //              forward declaration in expanded_ai/predicates.hpp resolves)

/// Returns true if the condition attached to a skill entry is currently satisfied.
/// target_bl may be nullptr for self-targeted skills (EnemyHp* / Distance* return false then).
/// NOT static: shared across the unity TU so expanded_ai/predicates.hpp can
/// forward-declare it for LegacyPredicate.
bool population_shell_skill_condition_ok(
	map_session_data* sd,
	uint8_t condition, uint8_t cond_value_num, int16_t cond_sc_resolved,
	block_list* target_bl)
{
	using C = PopSkillCondition;
	const C cond = static_cast<C>(condition);

	switch (cond) {
	case C::Always:
		return true;

	case C::HpBelow: {
		if (sd->battle_status.max_hp == 0) return false;
		const int pct = static_cast<int>(sd->battle_status.hp * 100 / sd->battle_status.max_hp);
		return pct < cond_value_num;
	}
	case C::SpBelow: {
		if (sd->battle_status.max_sp == 0) return false;
		const int pct = static_cast<int>(sd->battle_status.sp * 100 / sd->battle_status.max_sp);
		return pct < cond_value_num;
	}
	case C::HpAbove: {
		if (sd->battle_status.max_hp == 0) return false;
		const int pct = static_cast<int>(sd->battle_status.hp * 100 / sd->battle_status.max_hp);
		return pct > cond_value_num;
	}
	case C::EnemyHpBelow:
	case C::EnemyHpAbove: {
		if (!target_bl) return false;
		const status_data* tst = status_get_base_status(target_bl);
		if (!tst || tst->max_hp == 0) return false;
		const int pct = static_cast<int>(tst->hp * 100 / tst->max_hp);
		return (cond == C::EnemyHpBelow) ? (pct < cond_value_num) : (pct > cond_value_num);
	}
	case C::EnemyStatus:
	case C::NotEnemyStatus: {
		if (!target_bl || cond_sc_resolved < 0)
			return (cond == C::NotEnemyStatus);
		const status_change* tsc = status_get_sc(target_bl);
		const bool has_it = tsc && tsc->hasSCE(static_cast<sc_type>(cond_sc_resolved));
		return (cond == C::EnemyStatus) ? has_it : !has_it;
	}
	case C::SelfStatus:
	case C::NotSelfStatus: {
		if (cond_sc_resolved < 0)
			return (cond == C::NotSelfStatus);
		const status_change* ssc = status_get_sc(sd);
		const bool has_it = ssc && ssc->hasSCE(static_cast<sc_type>(cond_sc_resolved));
		return (cond == C::SelfStatus) ? has_it : !has_it;
	}
	case C::DistanceBelow:
	case C::DistanceAbove: {
		if (!target_bl) return false;
		const int dist = distance_bl(sd, target_bl);
		return (cond == C::DistanceBelow) ? (dist <= cond_value_num) : (dist > cond_value_num);
	}
	case C::EnemyCountNearby: {
		const int det = battle_config.population_engine_shell_mdetection_cells > 0
			? battle_config.population_engine_shell_mdetection_cells : 30;
		int count = 0;
		for (const auto &pair : sd->pop.mob_tracker.tracked_mobs) {
			const s_pe_tracked_mob &tracked = pair.second;
			if (tracked.hp <= 0)
				continue;
			const int dx = std::abs(static_cast<int>(sd->x) - tracked.x);
			const int dy = std::abs(static_cast<int>(sd->y) - tracked.y);
			if (std::max(dx, dy) <= det)
				++count;
		}
		return count >= static_cast<int>(cond_value_num);
	}
	case C::MapZone:
		return sd->pop.map_category == cond_value_num;

	case C::MeleeAttacked:
	case C::RangeAttacked: {
		// Check if any tracked mob is targeting this shell and has matching attack range.
		const bool want_ranged = (cond == C::RangeAttacked);
		for (const auto &pair : sd->pop.mob_tracker.tracked_mobs) {
			if (pair.second.target_id != static_cast<uint32>(sd->id))
				continue;
			TBL_MOB *md = map_id2md(pair.second.mob_id);
			if (!md || md->status.hp <= 0)
				continue;
			// Melee mobs have attack range <= 3; ranged mobs have range >= 4.
			const bool is_ranged = (md->status.rhw.range >= 4);
			if (is_ranged == want_ranged)
				return true;
		}
		return false;
	}

	case C::AllyHpBelow: {
		// True if any living ally in skill range has HP% below threshold.
		PopAllySearchCtx ctx{};
		ctx.shell        = sd;
		ctx.hp_threshold = cond_value_num;
		ctx.best_hp_pct  = 101;
		ctx.result       = nullptr;
		map_foreachinrange(pop_ally_hp_scan_cb, sd, 9, BL_PC, &ctx);
		return ctx.result != nullptr;
	}
	case C::AllyStatus:
	case C::NotAllyStatus: {
		if (cond_sc_resolved < 0)
			return (cond == C::NotAllyStatus);
		PopAllySearchCtx ctx{};
		ctx.shell           = sd;
		ctx.sc_resolved     = cond_sc_resolved;
		ctx.want_has_status = (cond == C::AllyStatus);
		ctx.result          = nullptr;
		map_foreachinrange(pop_ally_status_scan_cb, sd, 9, BL_PC, &ctx);
		return ctx.result != nullptr;
	}
	case C::HasSphere:
		return sd->spiritball >= static_cast<int>(cond_value_num);

	case C::SpAbove: {
		if (sd->battle_status.max_sp == 0) return false;
		const int pct = static_cast<int>(sd->battle_status.sp * 100 / sd->battle_status.max_sp);
		return pct > cond_value_num;
	}

	case C::EnemyHidden: {
		// True if any tracked enemy has Hiding, Cloaking, or Chase Walk.
		for (const auto &pair : sd->pop.mob_tracker.tracked_mobs) {
			if (pair.second.hp <= 0) continue;
			TBL_MOB *md = map_id2md(pair.second.mob_id);
			if (!md) continue;
			const status_change *msc = status_get_sc(md);
			if (msc && (msc->hasSCE(SC_HIDING) || msc->hasSCE(SC_CLOAKING) ||
			            msc->hasSCE(SC_CHASEWALK) || msc->hasSCE(SC_CLOAKINGEXCEED)))
				return true;
		}
		return false;
	}

	case C::EnemyCasting:
	case C::EnemyCastingGround: {
		if (!target_bl) return false;
		unit_data *tud = unit_bl2ud(target_bl);
		if (!tud || tud->skilltimer == INVALID_TIMER) return false;
		if (cond == C::EnemyCasting) return true;
		// Ground-cast check: skill with INF_GROUND_SKILL or INF_TRAP_SKILL
		const int inf = skill_get_inf(tud->skill_id);
		return (inf & (INF_GROUND_SKILL | INF_TRAP_SKILL)) != 0;
	}

	case C::CellHasSkillUnit: {
		// True if any skill unit exists on the shell's cell (traps, ground AoE, etc.).
		return map_find_skill_unit_oncell(sd, sd->x, sd->y, 0, nullptr, 0) != nullptr;
	}

	case C::SelfTargeted: {
		// Recently damaged by ANY source (PvP players, traps, ground AoE, mobs not yet
		// in the tracker). Window: cond_value_num seconds, defaulting to 3s when 0.
		// This makes Hiding/escape rotations work in PvP, where mob_tracker is empty.
		const t_tick now_tick = gettick();
		const t_tick window_ms = (cond_value_num > 0)
			? static_cast<t_tick>(cond_value_num) * 1000
			: 3000;
		if (sd->pop.last_attacked_tick != 0 &&
		    DIFF_TICK(now_tick, sd->pop.last_attacked_tick) <= window_ms)
			return true;
		// Fallback: any tracked mob is currently targeting this shell.
		// Gated by a recent-activity window (8s past last_attacked_tick) so a
		// stale tracker entry from a mob that long-since lost interest doesn't
		// pin self_targeted to true forever — that pinned hide-class buffs into
		// a re-cast spam loop after check_unhide() ended SC_HIDING (the Sin/Sin-X
		// "stuck spamming hide on one cell" bug).
		const t_tick stale_window_ms = 8000;
		if (sd->pop.last_attacked_tick == 0 ||
		    DIFF_TICK(now_tick, sd->pop.last_attacked_tick) > stale_window_ms)
			return false;
		for (const auto &pair : sd->pop.mob_tracker.tracked_mobs) {
			if (pair.second.target_id == static_cast<uint32>(sd->id) && pair.second.hp > 0)
				return true;
		}
		return false;
	}

	case C::EnemyElement: {
		if (!target_bl) return false;
		const status_data *tst = status_get_base_status(target_bl);
		if (!tst) return false;
		return (tst->def_ele == cond_value_num);
	}

	case C::EnemyRace: {
		if (!target_bl) return false;
		const status_data *tst = status_get_base_status(target_bl);
		if (!tst) return false;
		return (tst->race == cond_value_num);
	}

	case C::AllyCountNearby: {
		int count = 0;
		map_foreachinrange(pop_ally_count_cb, sd, 9, BL_PC, &count, sd->id);
		return count >= static_cast<int>(cond_value_num);
	}

	case C::EnemyIsBoss: {
		if (!target_bl) return false;
		TBL_MOB *md = BL_CAST(BL_MOB, target_bl);
		if (!md) return false;
		return (md->status.mode & MD_MVP) != 0;
	}

	case C::SelfBeingCastOn: {
		// Proactive dodge condition: any nearby unit is mid-cast against this shell
		// (direct target) or landing a ground skill within `ground_radius` cells.
		// `cond_value_num` overrides the ground-radius (default 3 cells when 0).
		const int ground_radius = (cond_value_num > 0) ? static_cast<int>(cond_value_num) : 3;
		bool hit = false;
		map_foreachinrange(pop_being_cast_on_cb, sd, AREA_SIZE, BL_CHAR,
		                   &hit, sd->id, static_cast<int>(sd->x), static_cast<int>(sd->y), ground_radius);
		return hit;
	}

	case C::AfterSkill:
		// Fires when this shell's last successfully cast skill matches the configured skill name.
		// cond_sc_resolved holds the resolved skill ID (populated_shell_resolve_sc_name handles
		// skill constants the same as SC constants since both go through script_get_constant).
		return cond_sc_resolved >= 0 &&
		       sd->pop.last_cast_skill_id == static_cast<uint16_t>(cond_sc_resolved);

	case C::DamagedGt: {
		// Fires when a single incoming hit exceeded (cond_value_num % of max HP).
		// E.g. CondValue:15 triggers when one blow dealt more than 15% max HP.
		// Mirrors mob_skill_db `damagedgt` but uses HP% instead of absolute damage
		// so it scales cleanly across shells with different gear/stats.
		if (sd->pop.last_damage_received <= 0) return false;
		if (sd->battle_status.max_hp == 0) return false;
		const int threshold = static_cast<int>(sd->battle_status.max_hp) *
		                      static_cast<int>(cond_value_num) / 100;
		return sd->pop.last_damage_received > threshold;
	}

	case C::SkillUsed: {
		// Fires when a specific skill was used against this shell within the last 3 seconds.
		// cond_sc_resolved holds the resolved skill ID of the skill to watch for.
		// last_skill_used_on_me is set in population_engine_on_shell_damaged from the
		// attacker's unit_data::skill_id at the point of impact.
		if (cond_sc_resolved < 0) return false;
		if (sd->pop.last_skill_used_on_me != static_cast<uint16_t>(cond_sc_resolved)) return false;
		const t_tick now_tick = gettick();
		return DIFF_TICK(now_tick, sd->pop.last_skill_used_on_me_tick) <= 3000;
	}

	case C::Expanded:
		// Expanded conditions carry their evaluator on s_pop_skill_entry::expanded; the
		// shared_ptr is not visible from this flat-fields signature. Call sites short-circuit
		// with the pop_skill_cond_satisfied() helper, so reaching here means the entry was
		// flagged Expanded but no tree was attached — reject.
		return false;

	default:
		return false;
	}
}

namespace { // reopen anon namespace for the rest of the file

/// Unified condition gate that picks between the flat-enum legacy path and the
/// expanded boolean tree based on whether the entry has a tree attached.
/// Templated over the skill struct type so it works for both attack and buff entries.
template <typename SkillT>
static inline bool pop_skill_cond_satisfied(map_session_data* sd, const SkillT& sk, block_list* target_bl) {
	if (sk.expanded) {
		expanded_ai::TargetBag bag;
		bag.shell = sd;
		bag.enemy = target_bl;
		return (*sk.expanded)(bag);
	}
	return population_shell_skill_condition_ok(sd, sk.condition, sk.cond_value_num, sk.cond_sc_resolved, target_bl);
}

static void population_shell_pick_attack_skill(map_session_data *sd, uint16 &skill_id, uint16 &skill_lv, block_list* target_bl = nullptr, bool ignore_rate = false, bool ally_only = false)
{
	skill_id = 0;
	skill_lv = 0;
	if (sd == nullptr)
		return;
	const size_t n = sd->pop.attack_skills.size();
	if (n == 0)
		return;

	// Standalone improvements (no autocombat dep):
	//  * SP-reserve floor: skip skills that would drop SP below configured % of max.
	//  * Strict skill-use gate: also require status_check_skilluse (silence/sleep/sit-etc).
	//  * LOS pre-cast check: require path_search_long no-wall to enemy target before
	//    picking ranged/area skills, so we don't waste a tick on a cast that will
	//    fail later inside unit_skilluse_id() against an obstructed mob.
	//  * Sticky-target / cooldown awareness: cooldown checked here too so the round-
	//    robin cursor advances past skills that are still on per-skill cooldown.
	const t_tick now_tick = gettick();
	const int min_sp_pct = battle_config.population_engine_shell_skill_min_sp_pct;
	const uint32 sp_floor = (min_sp_pct > 0 && sd->status.max_sp > 0)
		? static_cast<uint32>(sd->status.max_sp) * static_cast<uint32>(min_sp_pct) / 100u
		: 0u;
	const bool strict_gate = battle_config.population_engine_shell_skill_strict_gate != 0;
	const bool los_check   = battle_config.population_engine_shell_skill_los_check != 0;

	// PERF: hoist the LOS check out of the per-skill loop. The shell's origin and
	// the target's position do not change inside this function, so the result is
	// constant for every skill in the rotation. Calling path_search_long N times
	// per pick is an O(N * A*) hot-path cost that explodes at scale (5k+ shells
	// × N skills × every skill tick = thousands of A* searches per second).
	// One call per pick keeps the wall-rejection guarantee at constant cost.
	const bool need_los = los_check && target_bl && !ally_only && target_bl->id != sd->id;
	const bool los_ok   = !need_los ||
		path_search_long(nullptr, sd->m, sd->x, sd->y, target_bl->x, target_bl->y, CELL_CHKWALL);
	if (need_los && !los_ok) {
		return;
	}

	// PAI::ComboAwareness — when the AI flag is enabled, do a one-shot pre-pass that
	// promotes "combo finisher" skills (gated on `enemy_status: SC_*`) whose SC is
	// currently active on the target. This ensures the round-robin cursor doesn't
	// march past a primed Lightning Bolt (target frozen) just because it happens to
	// sit late in the YAML order. Without this, gated finishers only fire when the
	// cursor randomly lands on them, and the combo window often expires unused.
	const bool combo_aware = (battle_config.population_engine_ai & PAI::ComboAwareness) != 0;
	size_t combo_promote_idx = SIZE_MAX;
	if (combo_aware && target_bl && !ally_only) {
		const status_change *tsc = status_get_sc(target_bl);
		if (tsc != nullptr) {
			for (size_t i = 0; i < n; ++i) {
				const PopulationShellCombatSkill &sk = sd->pop.attack_skills[i];
				if (!sk.active || sk.skill_id == 0 || sk.target == 2)
					continue;
				if (sk.condition != static_cast<uint8_t>(PopSkillCondition::EnemyStatus))
					continue;
				if (sk.cond_sc_resolved < 0)
					continue;
				if (!tsc->hasSCE(static_cast<sc_type>(sk.cond_sc_resolved)))
					continue;
				// Promote the first matching finisher; later loop will validate the rest.
				combo_promote_idx = i;
				break;
			}
		}
		// Second pass: expanded-tree conditions (e.g. enemy_status wrapped in a boolean combinator).
		if (combo_promote_idx == SIZE_MAX) {
			for (size_t i = 0; i < n; ++i) {
				const PopulationShellCombatSkill &sk = sd->pop.attack_skills[i];
				if (!sk.active || sk.skill_id == 0 || sk.target == 2)
					continue;
				if (!sk.expanded)
					continue;
				if (!pop_skill_cond_satisfied(sd, sk, target_bl))
					continue;
				combo_promote_idx = i;
				break;
			}
		}
	}

	// Round-robin cursor: start from the last-used position so every skill in the
	// rotation gets equal time at the front. Without this, the first unconditional
	// Rate:10000 skill in the list monopolises every tick regardless of lower-rate
	// entries later in the list.  Combo-promoted starts override the cursor.
	// ally_only and ignore_rate passes use cursor=0 (forced picks, not rotation).
	const bool use_cursor = !ally_only && !ignore_rate && combo_promote_idx == SIZE_MAX;
	const size_t cursor_start = (combo_promote_idx != SIZE_MAX)
		? combo_promote_idx
		: (use_cursor ? (static_cast<size_t>(sd->pop.attack_skill_cursor) % n) : 0);

	for (size_t t = 0; t < n; ++t) {
		const size_t idx = (cursor_start + t) % n;
		const PopulationShellCombatSkill &sk = sd->pop.attack_skills[idx];
		if (!sk.active || sk.skill_id == 0)
			continue;
		// Ally-targeted skills are dispatched separately; skip in the enemy-attack rotation.
		if (!ally_only && sk.target == 2)
			continue;
		if (ally_only && sk.target != 2)
			continue;
		if (!ignore_rate && sk.rate < 10000) {
			if (sk.rate == 0) continue;  // rate:0 = permanently disabled slot
			if (static_cast<uint16_t>(rnd() % 10000) >= sk.rate) {
				// Rate gate failed — advance cursor past this slot and skip this tick.
				// This makes Rate a true frequency dial: Rate:7000 fires ~70% of ticks,
				// not "try this first, fall through to the next skill if it fails".
				if (use_cursor)
					sd->pop.attack_skill_cursor = static_cast<uint8_t>((idx + 1) % n);
				return;
			}
		}
		if (!pop_skill_cond_satisfied(sd, sk, target_bl)) {
			continue;
		}
		if (skill_isNotOk(sk.skill_id, *sd)) {
			continue;
		}
		// Strict gate: status_check_skilluse covers silenced/sleeping/sitting/etc.
		if (strict_gate && !status_check_skilluse(sd, target_bl, sk.skill_id, 0)) {
			continue;
		}
		// Per-skill cooldown gate (set after a successful cast in dispatchers).
		if (sk.cooldown_ms > 0) {
			auto cd_it = sd->pop.skill_next_use_tick.find(sk.skill_id);
			if (cd_it != sd->pop.skill_next_use_tick.end() && now_tick < cd_it->second) {
				continue;
			}
		}
		// YAML is authoritative for shells: if the player class doesn't have the skill
		// learned (e.g. Monk casting TF_HIDING), still allow the cast at the YAML level.
		const uint16_t plv = pc_checkskill(sd, sk.skill_id);
		if (plv > 0 && plv < sk.skill_lv) {
			continue;
		}
		const int sp_cost = skill_get_sp(sk.skill_id, sk.skill_lv);
		if (sp_cost > sd->status.sp) {
			continue;
		}
		// SP-reserve floor: don't pick a skill that drops us below the configured floor.
		if (sp_floor > 0 && static_cast<uint32>(sd->status.sp) - static_cast<uint32>(sp_cost) < sp_floor) {
			continue;
		}
		// LOS already validated once above for the whole rotation — no per-skill A* here.
		skill_id = sk.skill_id;
		skill_lv = sk.skill_lv;
		// Advance cursor past the skill we just picked so next tick starts one slot later.
		if (use_cursor)
			sd->pop.attack_skill_cursor = static_cast<uint8_t>((idx + 1) % n);
		return;
	}
	// Nothing found — advance cursor by 1 so next tick doesn't retry the same start.
	if (use_cursor && n > 0)
		sd->pop.attack_skill_cursor = static_cast<uint8_t>((cursor_start + 1) % n);
}

/// Returns true for skills that rAthena validates against real party membership
/// server-side (e.g. KN_DEVOTION checks sd->status.party_id != 0 in
/// skill_castend_nodamage_id).  Shells always have party_id == 0, so attempting
/// these skills wastes SP and plays a ghost animation with no effect.  Guard
/// before dispatch instead.
static bool population_skill_needs_party(uint16 skill_id)
{
	switch (skill_id) {
		case CR_DEVOTION:
		case ML_DEVOTION:
			return true;
		default:
			return false;
	}
}

/// Auto-unhide guard: shells that cast TF_HIDING via buff rotations would otherwise stay
/// hidden indefinitely (no engine-side logic ever ends SC_HIDING/SC_CLOAKING). Once the
/// threat clears (no incoming cast targeting the shell AND no recent damage within
/// `population_engine_shell_unhide_grace_ms` — default 4s), end the hide so the shell
/// resumes attacking.
static void population_shell_check_unhide(map_session_data *sd, t_tick current_tick)
{
	if (!sd) return;
	status_change *scc = status_get_sc(sd);
	if (!scc) return;
	const bool hiding   = scc->hasSCE(SC_HIDING);
	const bool cloaking = scc->hasSCE(SC_CLOAKING) || scc->hasSCE(SC_CLOAKINGEXCEED);
	if (!hiding && !cloaking) return;
	// Still being cast on? Stay hidden.
	bool incoming = false;
	map_foreachinrange(pop_being_cast_on_cb, sd, AREA_SIZE, BL_CHAR,
	                   &incoming, sd->id, static_cast<int>(sd->x), static_cast<int>(sd->y), 3);
	if (incoming) return;
	// Recently damaged? Stay hidden until grace window elapses.
	const t_tick grace_ms = 4000;
	if (sd->pop.last_attacked_tick != 0 &&
	    DIFF_TICK(current_tick, sd->pop.last_attacked_tick) < grace_ms)
		return;
	if (hiding)   status_change_end(sd, SC_HIDING);
	if (cloaking) {
		status_change_end(sd, SC_CLOAKING);
		status_change_end(sd, SC_CLOAKINGEXCEED);
	}
	// Drop stale active_buffs entries for hide skills so the buff loop can re-cast.
	// Without this, the long skill_get_time() expiration recorded at cast keeps the
	// already_active fallback true even after we manually ended the SC, freezing
	// re-hide for the rest of the original duration (Sin/Sin-X "fires once" bug).
	if (!sd->pop.active_buffs.empty()) {
		sd->pop.active_buffs.erase(
			std::remove_if(sd->pop.active_buffs.begin(), sd->pop.active_buffs.end(),
				[hiding, cloaking](const s_pe_active_buff &ab) {
					if (hiding && ab.skill_id == TF_HIDING)
						return true;
					if (cloaking && (ab.skill_id == AS_CLOAKING || ab.skill_id == GC_CLOAKINGEXCEED))
						return true;
					return false;
				}),
			sd->pop.active_buffs.end());
	}
}

static bool population_shell_cast_expired_self_buffs(map_session_data *sd, t_tick current_tick)
{
	if (!sd || sd->pop.buff_skills.empty())
		return false;

	status_change *scc = status_get_sc(sd);

	// SP-reserve floor (same rationale as in the attack picker — buffs shouldn't strand
	// the shell with no SP for offensive skills).
	const int min_sp_pct = battle_config.population_engine_shell_skill_min_sp_pct;
	const uint32 sp_floor = (min_sp_pct > 0 && sd->status.max_sp > 0)
		? static_cast<uint32>(sd->status.max_sp) * static_cast<uint32>(min_sp_pct) / 100u
		: 0u;
	const bool strict_gate = battle_config.population_engine_shell_skill_strict_gate != 0;

	for (const PopulationShellBuffSkill &bs : sd->pop.buff_skills) {
		// YAML-authoritative: when the class doesn't have the skill learned
		// (e.g. Monk/Champion using TF_HIDING), use the YAML level directly.
		const uint16_t plv = pc_checkskill(sd, bs.skill_id);
		const uint16_t use_lv = (plv > 0) ? std::min(bs.skill_lv, plv) : bs.skill_lv;

		if (skill_isNotOk(bs.skill_id, *sd))
			continue;
		// Strict gate: silence/sleep/sit/etc. (no target — pass nullptr).
		if (strict_gate && !status_check_skilluse(sd, nullptr, bs.skill_id, 0))
			continue;

		const int sp_cost = skill_get_sp(bs.skill_id, use_lv);
		if (sp_cost > 0 && sp_cost > sd->battle_status.sp)
			continue;
		if (sp_floor > 0 && sp_cost > 0 &&
		    static_cast<uint32>(sd->battle_status.sp) - static_cast<uint32>(sp_cost) < sp_floor)
			continue;

		// Per-skill cooldown gate (set after a successful cast below).
		if (bs.cooldown_ms > 0) {
			auto cd_it = sd->pop.skill_next_use_tick.find(bs.skill_id);
			if (cd_it != sd->pop.skill_next_use_tick.end() && current_tick < cd_it->second)
				continue;
		}

		// --- Ally-targeted (target == 2) ---
		if (bs.target == 2) {
			// Condition check finds the ally; skip cast if none qualifies.
			if (!pop_skill_cond_satisfied(sd, bs, nullptr))
				continue;
			const int16_t skill_range = static_cast<int16_t>(
				std::max(1, skill_get_range2(sd, bs.skill_id, use_lv, true)));
			map_session_data *ally = population_shell_find_ally_target(
				sd, bs.condition, bs.cond_value_num, bs.cond_sc_resolved, skill_range);
			if (!ally)
				continue;
			// Party-only skills (e.g. Devotion) are rejected server-side when party_id == 0.
			// Skip the cast entirely to avoid wasting SP with a ghost animation.
			if (population_skill_needs_party(bs.skill_id) && sd->status.party_id == 0)
				continue;
			// Skip if the ally already has the SC this skill applies. Without this gate,
			// support shells re-cast the same buff on the same ally every tick (since
			// the ally remains the closest valid match), spamming animation/SP forever.
			// Self-buffs already get this gate further below; ally-buffs need their own.
			const sc_type ally_sc_id = skill_get_sc(bs.skill_id);
			if (ally_sc_id != SC_NONE) {
				status_change *ally_sc = status_get_sc(ally);
				if (ally_sc && ally_sc->hasSCE(ally_sc_id))
					continue;
			}
			if (skill_get_inf(bs.skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
				int16_t tx = sd->x, ty = sd->y;
				population_shell_resolve_placement(sd, bs.around_range, tx, ty);
				if (unit_skilluse_pos(sd, tx, ty, bs.skill_id, use_lv)) {
					if (bs.cooldown_ms > 0) sd->pop.skill_next_use_tick[bs.skill_id] = current_tick + static_cast<t_tick>(bs.cooldown_ms);
					sd->pop.last_cast_skill_id = bs.skill_id;
					return true;
				}
			} else {
				if (unit_skilluse_id(sd, ally->id, bs.skill_id, use_lv)) {
					if (bs.cooldown_ms > 0) sd->pop.skill_next_use_tick[bs.skill_id] = current_tick + static_cast<t_tick>(bs.cooldown_ms);
					sd->pop.last_cast_skill_id = bs.skill_id;
					return true;
				}
			}
			continue;
		}

		// --- Self-targeted (target == 1) ---
		// Cast condition check (self-targeted: no enemy target_bl).
		if (!pop_skill_cond_satisfied(sd, bs, nullptr))
			continue;

		// Primary check: SC is currently active on this shell.
		const sc_type sc_id = skill_get_sc(bs.skill_id);
		bool already_active = (sc_id != SC_NONE && scc && scc->hasSCE(sc_id));
		// Fallback: dispatch-time tracking covers SCs that don't self-apply.
		// Examples: party AoE buffs (AL_ANGELUS, PR_MAGNIFICAT) apply their SC via a
		// party-member loop — shells with no party (party_id == 0) never receive the SC
		// on themselves, so hasSCE() above is always false and the skill would spam every
		// tick without this guard.  We consult active_buffs for ALL skills (not just
		// sc_id == SC_NONE) because the TF_HIDING / AS_CLOAKING early-removal case is
		// already handled: population_shell_check_unhide() explicitly erases those
		// active_buffs entries the moment it calls status_change_end(SC_HIDING/SC_CLOAKING),
		// so there is no risk of a stale entry permanently blocking re-hide.
		if (!already_active) {
			for (const auto &ab : sd->pop.active_buffs) {
				if (ab.skill_id == bs.skill_id && ab.expires_at > current_tick) {
					already_active = true;
					break;
				}
			}
		}
		if (already_active)
			continue;

		// Ground-targeted and trap skills must use position cast.
		if (skill_get_inf(bs.skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
			int16_t tx = sd->x, ty = sd->y;
			population_shell_resolve_placement(sd, bs.around_range, tx, ty);
			if (unit_skilluse_pos(sd, tx, ty, bs.skill_id, use_lv)) {
				if (bs.cooldown_ms > 0) sd->pop.skill_next_use_tick[bs.skill_id] = current_tick + static_cast<t_tick>(bs.cooldown_ms);
				sd->pop.last_cast_skill_id = bs.skill_id;
				return true;
			}
		} else {
			if (unit_skilluse_id(sd, sd->id, bs.skill_id, use_lv)) {
				if (bs.cooldown_ms > 0) sd->pop.skill_next_use_tick[bs.skill_id] = current_tick + static_cast<t_tick>(bs.cooldown_ms);
				// Record dispatch as a rate-limiter fallback for buffs whose SC may not self-apply.
				const t_tick duration = skill_get_time(bs.skill_id, use_lv);
				if (duration > 0) {
					sd->pop.active_buffs.erase(
						std::remove_if(sd->pop.active_buffs.begin(), sd->pop.active_buffs.end(),
							[&bs](const s_pe_active_buff &ab) { return ab.skill_id == bs.skill_id; }),
						sd->pop.active_buffs.end());
					sd->pop.active_buffs.emplace_back(bs.skill_id, use_lv, current_tick + duration, static_cast<uint32>(sd->id));
				}
				sd->pop.last_cast_skill_id = bs.skill_id;
				return true;
			}
		}
	}
	return false;
}

/// Cast one ally-targeted attack skill (target==2) on the best ally in range.
/// Picks the skill with the highest priority that passes conditions, finds the best
/// matching ally using population_shell_find_ally_target, and casts on them.
/// Returns true if a skill was dispatched (caller should set skill_cd and return).
static bool population_shell_cast_ally_attack_skill(map_session_data *sd, t_tick current_tick)
{
	if (!sd || sd->pop.attack_skills.empty())
		return false;

	const size_t n = sd->pop.attack_skills.size();
	for (size_t t = 0; t < n; ++t) {
		const size_t idx = t; // Rate is frequency dial: always evaluate all skills from index 0
		const PopulationShellCombatSkill &sk = sd->pop.attack_skills[idx];
		if (!sk.active || sk.skill_id == 0 || sk.target != 2)
			continue;
		if (sk.rate < 10000 && static_cast<uint16_t>(rnd() % 10000) >= sk.rate)
			continue;
		// Condition check (no enemy target_bl for ally skills).
		if (!pop_skill_cond_satisfied(sd, sk, nullptr))
			continue;
		if (skill_isNotOk(sk.skill_id, *sd))
			continue;
		// YAML-authoritative: allow cast even if the class hasn't learned it.
		const uint16_t plv = pc_checkskill(sd, sk.skill_id);
		if (plv > 0 && plv < sk.skill_lv)
			continue;
		const int sp_cost = skill_get_sp(sk.skill_id, sk.skill_lv);
		if (sp_cost > sd->status.sp)
			continue;

		// Per-skill cooldown gate.
		if (sk.cooldown_ms > 0) {
			auto cd_it = sd->pop.skill_next_use_tick.find(sk.skill_id);
			if (cd_it != sd->pop.skill_next_use_tick.end() && current_tick < cd_it->second)
				continue;
		}

		// Find the best ally for this skill (uses same scanning infrastructure as buff skills).
		const int16_t skill_range = static_cast<int16_t>(
			std::max(1, skill_get_range2(sd, sk.skill_id, sk.skill_lv, true)));
		map_session_data *ally = population_shell_find_ally_target(
			sd, sk.condition, sk.cond_value_num, sk.cond_sc_resolved, skill_range);
		if (!ally)
			continue;
		// Skip if the ally already carries the SC this skill would apply — without
		// this gate the shell re-casts every skill_cd even when the buff is active.
		const sc_type ally_sc_id2 = skill_get_sc(sk.skill_id);
		if (ally_sc_id2 != SC_NONE) {
			status_change *ally_scp = status_get_sc(ally);
			if (ally_scp && ally_scp->hasSCE(ally_sc_id2))
				continue;
		}
		// Party-only skills rejected server-side when party_id == 0 — skip pre-cast.
		if (population_skill_needs_party(sk.skill_id) && sd->status.party_id == 0)
			continue;

		bool used = false;
		if (skill_get_inf(sk.skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
			int16_t tx = sd->x, ty = sd->y;
			population_shell_resolve_placement(sd, sk.around_range, tx, ty);
			used = unit_skilluse_pos(sd, tx, ty, sk.skill_id, sk.skill_lv);
		} else
			used = unit_skilluse_id(sd, ally->id, sk.skill_id, sk.skill_lv);

		if (used) {
			if (sk.cooldown_ms > 0)
				sd->pop.skill_next_use_tick[sk.skill_id] = current_tick + static_cast<t_tick>(sk.cooldown_ms);
			// Set skill_cd from actual cast + after-cast delay (same as population_shell_try_attack)
			// so instant ally buffs like Suffragium don't block offensive skills for a full interval.
			const t_tick skill_delay = skill_get_delay(sk.skill_id, sk.skill_lv);
			const t_tick cast_time   = skill_get_cast(sk.skill_id, sk.skill_lv);
			const int min_d = battle_config.population_engine_shell_attack_skill_delay_ms;
			if (min_d > 0 && skill_delay < static_cast<t_tick>(min_d))
				sd->pop.skill_cd = current_tick + static_cast<t_tick>(min_d) + cast_time;
			else
				sd->pop.skill_cd = current_tick + skill_delay + cast_time;
			return true;
		}
	}
	return false;
}


static void population_shell_combat_process_tick(map_session_data *sd, t_tick current_tick, bool do_skills)
{
	if (sd == nullptr || !sd->state.active)
		return;
	// Engine is single-threaded (main map thread); async A* removed.
	s_population &pe = sd->pop;
	population_shell_reset_movement_tick_state(sd, current_tick);
	pe.movement_decision_trace_id++;

	population_shell_cleanup_expired_buffs(sd, current_tick);

	const bool flag_attack_only = (sd->pop.flags & PSF::AttackOnly) != 0
		|| sd->sc.getSCE(SC_BERSERK) != nullptr; // Frenzy: auto-attack only, no skills
	const bool flag_skill_only  = (sd->pop.flags & PSF::SkillOnly)  != 0;
	const PopulationRoleType shell_role = static_cast<PopulationRoleType>(sd->pop.role);
	const int32 pai = battle_config.population_engine_ai;

	// --- PANIC INTERRUPT: emergency hide dodge ---
	// If a nearby unit is RIGHT NOW casting on this shell (direct target or ground AoE
	// landing within 3 cells) and the shell has a hide-class skill in its buff list,
	// cancel any in-progress shell cast and force-dispatch the hide immediately.
	// Bypasses:
	//   - the buff-loop position (TF_HIDING may be last in the list)
	//   - the per-tick reactive_buff_cd rate limiter
	//   - the shell's own canact_tick post-cast act delay (cleared for the dodge)
	// Auto-skipped when SC_HIDING / SC_CLOAKING / SC_CLOAKINGEXCEED is already active.
	if (do_skills && !flag_attack_only && !sd->pop.buff_skills.empty()) {
		const status_change *scc_panic = status_get_sc(sd);
		const bool already_hiding = scc_panic && (scc_panic->getSCE(SC_HIDING)
		                                          || scc_panic->getSCE(SC_CLOAKING)
		                                          || scc_panic->getSCE(SC_CLOAKINGEXCEED));
		if (!already_hiding) {
			const PopulationShellBuffSkill *hide_bs = nullptr;
			for (const PopulationShellBuffSkill &b : sd->pop.buff_skills) {
				if (b.skill_id == TF_HIDING || b.skill_id == AS_CLOAKING) {
					hide_bs = &b;
					break;
				}
			}
			if (hide_bs) {
				// Per-skill cooldown gate (avoid hammering hide every tick if an enemy stays mid-cast).
				bool on_cd = false;
				if (hide_bs->cooldown_ms > 0) {
					auto cd_it = sd->pop.skill_next_use_tick.find(hide_bs->skill_id);
					if (cd_it != sd->pop.skill_next_use_tick.end() && current_tick < cd_it->second)
						on_cd = true;
				}
				if (!on_cd) {
					bool incoming = false;
					map_foreachinrange(pop_being_cast_on_cb, sd, AREA_SIZE, BL_CHAR,
					                   &incoming, sd->id, static_cast<int>(sd->x), static_cast<int>(sd->y), 3);
					if (incoming) {
						unit_data *ud = unit_bl2ud(sd);
						if (ud) {
							if (ud->skilltimer != INVALID_TIMER)
								unit_skillcastcancel(sd, 0);
							ud->canact_tick = current_tick; // emergency: clear post-cast act delay
						}
						const uint16_t plv = pc_checkskill(sd, hide_bs->skill_id);
						const uint16_t use_lv = (plv > 0) ? std::min(hide_bs->skill_lv, plv) : hide_bs->skill_lv;
						if (unit_skilluse_id(sd, sd->id, hide_bs->skill_id, use_lv)) {
							if (hide_bs->cooldown_ms > 0)
								sd->pop.skill_next_use_tick[hide_bs->skill_id] = current_tick + static_cast<t_tick>(hide_bs->cooldown_ms);
							// Tick budget consumed by the dodge — don't run the rest of the rotation this tick.
							return;
						}
					}
				}
			}
		}
	}

	// --- PAI::FleeOnLowHP + PSF::FleeOnLow ---
	// Squishy shells retreat when HP drops below 30%.  Walk away from the attacker
	// and cast any defensive self-buffs (Kyrie, Safety Wall, etc.) if available.
	if ((pai & PAI::FleeOnLowHP) || (sd->pop.flags & PSF::FleeOnLow)) {
		if (sd->battle_status.max_hp > 0 && shell_role != PopulationRoleType::Tank) {
			const int hp_pct = static_cast<int>(sd->battle_status.hp * 100 / sd->battle_status.max_hp);
			if (hp_pct < 30 && pe.target_id != 0) {
				// Try to cast defensive self-buffs first.
				if (!flag_attack_only && do_skills && current_tick >= sd->pop.reactive_buff_cd && !sd->pop.buff_skills.empty()) {
					if (population_shell_cast_expired_self_buffs(sd, current_tick)) {
						sd->pop.reactive_buff_cd = current_tick + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
						return; // Fleeing context: buff + retreat, no attack.
					}
				}
				// Flee: snap or walk in the opposite direction from the current target.
				block_list *tbl = map_id2bl(static_cast<int>(pe.target_id));
				if (tbl) {
					const struct map_data *fmd = map_getmapdata(sd->m);
					const int dx = sd->x - tbl->x;
					const int dy = sd->y - tbl->y;
					// Clamp to map bounds before checking passability.
					const int flee_x = fmd ? std::max(0, std::min(static_cast<int>(fmd->xs - 1),
						sd->x + (dx != 0 ? (dx > 0 ? 5 : -5) : 0))) : sd->x;
					const int flee_y = fmd ? std::max(0, std::min(static_cast<int>(fmd->ys - 1),
						sd->y + (dy != 0 ? (dy > 0 ? 5 : -5) : 0))) : sd->y;
					if (map_getcell(sd->m, flee_x, flee_y, CELL_CHKPASS)) {
						// Prefer Body Relocation (Snap) for instant escape when available.
						// The escape YAML entry has Target:1, so it lives in buff_skills; also
						// check attack_skills for completeness.
						bool snapped = false;
						const bool snap_ok = pc_checkskill(sd, MO_BODYRELOCATION) > 0
							&& !skill_isNotOk(MO_BODYRELOCATION, *sd);
						if (snap_ok) {
							auto try_snap = [&](uint16_t lv) {
								if (sd->spiritball < 1)
									pc_addspiritball(sd, 300000, 5);
								snapped = unit_skilluse_pos(sd, (short)flee_x, (short)flee_y,
									MO_BODYRELOCATION, lv > 0 ? lv : 1) != 0;
								if (snapped)
									pe.skill_cd = current_tick + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
							};
							for (const auto &bs : sd->pop.buff_skills) {
								if (bs.skill_id == MO_BODYRELOCATION) { try_snap(bs.skill_lv); break; }
							}
							if (!snapped) {
								for (const auto &cs : sd->pop.attack_skills) {
									if (cs.skill_id == MO_BODYRELOCATION) { try_snap(cs.skill_lv); break; }
								}
							}
						}
						if (!snapped && population_shell_can_emit_movement(sd, MovementOwner::Combat, "population_shell:flee_low_hp"))
							unit_walktoxy(sd, static_cast<short>(flee_x), static_cast<short>(flee_y), 4);
					}
				}
				// Drop target when fleeing at critical HP — re-acquire after recovery.
				if (hp_pct < 15) {
					population_shell_target_change(sd, 0);
					return;
				}
				return;
			}
		}
	}

	// --- PAI::BossAvoidance ---
	// Non-tank roles avoid targeting MVP/boss monsters.
	if ((pai & PAI::BossAvoidance) && pe.target_id != 0 && shell_role != PopulationRoleType::Tank) {
		TBL_MOB *target_md = map_id2md(static_cast<int>(pe.target_id));
		if (target_md && (target_md->status.mode & MD_MVP)) {
			population_shell_target_change(sd, 0);
			// Don't return — fall through to find a non-boss target.
		}
	}

	// --- PAI::TargetSwitch ---
	// If a closer enemy exists than the current target, switch to it.
	if ((pai & PAI::TargetSwitch) && pe.target_id != 0 && !sd->pop.mob_tracker.tracked_mobs.empty()) {
		int cur_dist = 999;
		block_list *cur_bl = map_id2bl(static_cast<int>(pe.target_id));
		if (cur_bl) cur_dist = distance_bl(sd, cur_bl);

		uint32 best_id = 0;
		int best_dist = cur_dist;
		// Attacker role: switch to closer targets more aggressively (1-cell margin vs default 3).
		const int switch_margin = (shell_role == PopulationRoleType::Attacker) ? 1 : 3;
		for (const auto &pair : sd->pop.mob_tracker.tracked_mobs) {
			if (pair.second.hp <= 0) continue;
			if (pair.first == static_cast<uint32>(pe.target_id)) continue;
			// Skip bosses if boss-avoidance is on and we're not a tank.
			if ((pai & PAI::BossAvoidance) && shell_role != PopulationRoleType::Tank) {
				TBL_MOB *md = map_id2md(pair.second.mob_id);
				if (md && (md->status.mode & MD_MVP)) continue;
			}
			const int dx = std::abs(static_cast<int>(sd->x) - pair.second.x);
			const int dy = std::abs(static_cast<int>(sd->y) - pair.second.y);
			const int d = std::max(dx, dy);
			if (d < best_dist - switch_margin) {
				best_dist = d;
				best_id = pair.first;
			}
		}
		if (best_id != 0)
			population_shell_target_change(sd, static_cast<int>(best_id));
	}

	// Re-snapshot tid after boss-avoidance and target-switch might have cleared pe.target_id.
	const uint32 tid_refreshed = static_cast<uint32>(pe.target_id);

	// Role: Tank — intercept mobs targeting nearby allies.
	// When idle (no current target), scan for mobs within 12 cells that are attacking a shell ally.
	// Redirecting aggro keeps squishier support/attacker shells safer.
	if (shell_role == PopulationRoleType::Tank && tid_refreshed == 0) {
		PopTankInterceptCtx tic{ sd, 0 };
		map_foreachinrange(pop_tank_intercept_cb, sd, 12, BL_MOB, &tic);
		if (tic.result_id != 0) {
			population_shell_target_change(sd, tic.result_id);
			// Fall through — tid will be re-evaluated in the chase/attack block below.
		}
	}

	// Re-snapshot after Tank intercept may have set a new target.
	const uint32 tid = static_cast<uint32>(pe.target_id);

	// Role: Support — if any nearby ally is below 50% HP, halt and let heal/buff CDs fire.
	// If the ally is more than 3 cells away, walk toward them first.
	if (shell_role == PopulationRoleType::Support && tid == 0) {
		PopAllySearchCtx hctx{};
		hctx.shell        = sd;
		hctx.hp_threshold = 50;
		hctx.best_hp_pct  = 101;
		hctx.result       = nullptr;
		map_foreachinrange(pop_ally_hp_scan_cb, sd, 12, BL_PC, &hctx);
		if (hctx.result != nullptr) {
			const int dist = distance_bl(sd, hctx.result);
			if (dist > 3 && !unit_is_walking(sd) &&
			    population_shell_can_emit_movement(sd, MovementOwner::Roam, "support:follow_ally"))
				unit_walktobl(sd, hctx.result, 3, 1);
			return; // Stay focused on injured ally — ally-attack skill fires on next tick.
		}
	}

	// Self-buff maintenance: reactive_buff_cd is independent from skill_cd so the shell
	// can cast a buff (Safety Wall, Kyrie, Blessing, etc.) and still attack in the same tick.
	if (!flag_attack_only && do_skills && current_tick >= sd->pop.reactive_buff_cd && !sd->pop.buff_skills.empty()) {
		if (population_shell_cast_expired_self_buffs(sd, current_tick)) {
			sd->pop.reactive_buff_cd = current_tick + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
			// No return: fall through to ally-skill and offensive-skill evaluation.
		}
	}

	// Ally-targeted attack skills (reactive heals, ally buffs with conditions).
	if (!flag_attack_only && do_skills && current_tick >= pe.skill_cd && battle_config.population_engine_shell_attackskill) {
		if (population_shell_cast_ally_attack_skill(sd, current_tick)) {
			// skill_cd already set inside cast_ally_attack_skill based on actual timing.
			return;
		}
	}

	population_shell_autoshadowspell_autoselect(sd);

	// Async A* path follower removed — movement is now driven directly by
	// unit_walktoxy / unit_walktobl which use rAthena's built-in BFS path search.
	constexpr bool path_computing = false;

	population_shell_status_check_reset(sd, current_tick);

	// Already chasing a valid mob; wait for pathing to finish before re-issuing walk.
	if (tid > 0 && !population_shell_check_target(sd, tid) &&
			population_shell_check_target_for_movement(sd, tid) && unit_is_walking(sd))
		return;

	if (tid > 0 && population_shell_check_target(sd, tid)) {
		uint16 skill_id = 0;
		uint16 skill_lv = 0;
		sd->pop.safetywall_kited_since = 0;  // target is attackable — kite resolved
		// Basic-attack chance: roll BEFORE evaluating the skill picker. Without this,
		// any rotation slot at Rate:10000 is selected every tick (round-robin still
		// guarantees a hit) and the shell never basic-attacks. SkillOnly opts out.
		const int basic_chance = battle_config.population_engine_shell_basic_attack_chance;
		const bool force_basic_this_tick =
			!flag_skill_only && basic_chance > 0 && (rnd() % 100) < basic_chance;
		// Two-tier timer: only evaluate skill picker on skill passes.
		// Movement-only passes still call try_attack for melee.
		if (!flag_attack_only && !force_basic_this_tick && do_skills && current_tick >= pe.skill_cd && battle_config.population_engine_shell_attackskill) {
			// Sphere-chain skills (Monk/Champion: CALLSPIRITS→FURY→ASURA) get priority
			// over the flat rotation — the rotation cannot model state prerequisites.
			block_list* target_bl = map_id2bl(static_cast<int>(tid));
			if (!population_shell_pick_sphere_chain_skill(sd, skill_id, skill_lv))
				population_shell_pick_attack_skill(sd, skill_id, skill_lv, target_bl);
			// SkillOnly fallback: if rate rolls failed, retry ignoring rates so the shell
			// doesn't stall. This guarantees at least one eligible skill fires per tick.
			if (skill_id == 0 && flag_skill_only)
				population_shell_pick_attack_skill(sd, skill_id, skill_lv, target_bl, true);
		}
		// skill_only: only act when a skill was picked; skip basic auto-attack.
		// attack_only wins if both flags are set (avoids paralysis).
		if (!flag_skill_only || flag_attack_only || skill_id != 0) {
			bool fired = population_shell_try_attack(sd, tid, skill_id, skill_lv);
			if (fired && skill_id != 0) {
				for (const auto &sk : sd->pop.attack_skills) {
					if (sk.skill_id == skill_id && sk.cooldown_ms > 0) {
						pe.skill_next_use_tick[skill_id] = current_tick + static_cast<t_tick>(sk.cooldown_ms);
						break;
					}
				}
			}
		}
		return;
	}

	// Safety Wall: when standing on the wall, plant in place and fight from this cell.
	// Mages/casters should not chase the enemy out of their own protection.
	const status_change *scc_sw = status_get_sc(sd);
	const bool on_safetywall = scc_sw && scc_sw->hasSCE(SC_SAFETYWALL);

	if (tid > 0 && population_shell_check_target_for_movement(sd, tid) &&
			!population_shell_check_target(sd, tid)) {
		// Out-of-range pursue pass: try long-range skills before walking.
		if (!flag_attack_only && do_skills && current_tick >= pe.skill_cd && battle_config.population_engine_shell_attackskill) {
			block_list* target_bl = map_id2bl(static_cast<int>(tid));
			if (target_bl) {
				uint16 skill_id = 0;
				uint16 skill_lv = 0;
				bool sphere_chain_picked = population_shell_pick_sphere_chain_skill(sd, skill_id, skill_lv);
				if (!sphere_chain_picked)
					population_shell_pick_attack_skill(sd, skill_id, skill_lv, target_bl);
				if (skill_id != 0) {
					bool fired = population_shell_try_attack(sd, tid, skill_id, skill_lv);
					if (fired) {
						for (const auto &sk : sd->pop.attack_skills) {
							if (sk.skill_id == skill_id && sk.cooldown_ms > 0) {
								pe.skill_next_use_tick[skill_id] = current_tick + static_cast<t_tick>(sk.cooldown_ms);
								break;
							}
						}
						return;
					}
				}
			}
		}
		// Safety Wall: do not chase the target off the wall cell.
		if (!on_safetywall) {
			sd->pop.safetywall_kited_since = 0;  // not on wall — reset kite timer
			if (population_shell_try_approach_combat_target(sd, tid))
				return;
		} else {
			// Target out of range while standing on Safety Wall.
			// Track how long we have been unable to reach them from this cell.
			if (sd->pop.safetywall_kited_since == 0)
				sd->pop.safetywall_kited_since = current_tick;
			if (DIFF_TICK(current_tick, sd->pop.safetywall_kited_since) > 4000) {
				// Kited off the wall for >4s with no ranged skill landing — abandon it.
				status_change_end(sd, SC_SAFETYWALL);
				sd->pop.safetywall_kited_since = 0;
				if (population_shell_try_approach_combat_target(sd, tid))
					return;
			}
		}
		// walktobl failed or inhibited by safety wall — skip this tick.
	}

	// Guard behavior: when idle (no target, not walking) return to spawn position.
	const bool is_guard = (static_cast<PopulationBehavior>(sd->pop.behavior) == PopulationBehavior::Guard);
	if (is_guard && !unit_is_walking(sd) && pe.path.empty() && tid == 0) {
		const int sx = sd->pop.spawn_x;
		const int sy = sd->pop.spawn_y;
		if (sx > 0 && sy > 0 && (sd->x != sx || sd->y != sy)) {
			if (population_shell_can_emit_movement(sd, MovementOwner::Roam, "population_shell:guard_return")) {
				if (!unit_walktoxy(sd, static_cast<short>(sx), static_cast<short>(sy), 4))
					if (!unit_walktoxy(sd, static_cast<short>(sx), static_cast<short>(sy), 1))
						pe.movement_emitted_this_tick = false;
			}
		}
		return;
	}

	if (!path_computing && !unit_is_walking(sd) && pe.path.empty()) {
		// Roam throttle: rate-limit roam re-launches so a shell whose chosen
		// destination is unreachable doesn't re-enter this branch every tick.
		constexpr t_tick PE_ROAM_PATH_RETRY_MS = 750;
		const bool roam_throttled = (pe.path_last_calc_tick > 0 &&
			DIFF_TICK(current_tick, pe.path_last_calc_tick) < PE_ROAM_PATH_RETRY_MS);

		// Forward LOS roam: when no valid mob in detection, walk to a path-validated
		// forward cell; else target the nearest valid tracked mob.
		if (!roam_throttled) {
			population_shell_update_mob_tracker(sd);
			const bool has_valid_near = population_shell_has_valid_mobs_in_detection(sd);

			uint32 mid3 = 0;
			int gx = 0, gy = 0;
			const int path_attempts = std::max(1, battle_config.population_engine_path_attempts);
			if (population_shell_movetype3_get_target(sd, sd->m, sd->x, sd->y, has_valid_near,
					path_attempts, mid3, gx, gy)) {
				if (mid3 > 0) {
					population_shell_target_change(sd, static_cast<int>(mid3));
					return;
				}
				// Forward roam: walk straight to the chosen cell using rAthena's
				// built-in pathing. Stamps path_last_calc_tick to honor the throttle
				// regardless of whether the walk command succeeds.
				MovementOwner owner = pe.movement_owner == MovementOwner::None ? MovementOwner::Roam : pe.movement_owner;
				pe.path_last_calc_tick = current_tick;
				if (population_shell_can_emit_movement(sd, owner, "population_shell:movetype3_forward")) {
					if (unit_walktoxy(sd, gx, gy, 4) || unit_walktoxy(sd, gx, gy, 1)) {
						pe.last_move = current_tick;
						return;
					}
					pe.movement_emitted_this_tick = false;
				}
			} else {
			}
		}

		uint32 mid = 0;
		int mx = 0;
		int my = 0;
		if (population_shell_simple_find_nearest_mob_and_pathfind(sd, mid, mx, my)) {
			population_shell_target_change(sd, static_cast<int>(mid));
			(void)mx;
			(void)my;
			return;
		}
		population_shell_try_roam_step(sd);
	}
}

} // namespace

/// Compute a placement position for ground/trap skills.
/// When around_range > 0, picks a random passable cell within that radius of
/// the shell's own position (mirrors mob_skill_db `around2`/`around3` behaviour).
/// Falls back to the provided base (x, y) unchanged when around_range == 0 or
/// no passable cell is found after a few tries.
void population_shell_resolve_placement(const map_session_data *sd,
	uint8_t around_range, int16_t &x, int16_t &y)
{
	if (around_range == 0)
		return;

	const struct map_data *md = map_getmapdata(sd->m);
	if (!md)
		return;

	const int r = static_cast<int>(around_range);
	for (int attempt = 0; attempt < 8; ++attempt) {
		const int ox = static_cast<int>(rnd() % (2 * r + 1)) - r;
		const int oy = static_cast<int>(rnd() % (2 * r + 1)) - r;
		const int16_t cx = static_cast<int16_t>(std::clamp(static_cast<int>(sd->x) + ox, 1, static_cast<int>(md->xs) - 1));
		const int16_t cy = static_cast<int16_t>(std::clamp(static_cast<int>(sd->y) + oy, 1, static_cast<int>(md->ys) - 1));
		if (!map_getcell(sd->m, cx, cy, CELL_CHKNOPASS)) {
			x = cx;
			y = cy;
			return;
		}
	}
	// All attempts hit walls — keep original base position.
}

static void population_shell_recalc_max_attack_skill_range(map_session_data *sd)
{
	if (!sd)
		return;
	if (sd->pop.attack_skills.empty()) {
		sd->pop.max_attack_skill_range = -1;
		return;
	}
	int best = -1;
	for (const PopulationShellCombatSkill &e : sd->pop.attack_skills) {
		if (!e.active || e.skill_id == 0)
			continue;
		const int r = skill_get_range2(sd, e.skill_id, e.skill_lv, true);
		if (r > best)
			best = r;
	}
	sd->pop.max_attack_skill_range = best;
}

/// Push one rotation entry if the PC knows the skill. When `require_attack_inf` is true,
/// only attack/ground/trap/self skills are accepted — used for generic tree scans.
/// YAML / built-in job tables skip that filter so explicit lists still rotate.
static void population_shell_push_attack_skill_candidate(map_session_data *sd, uint16_t skill_id, uint16_t yaml_level_cap,
	bool require_attack_inf, std::vector<PopulationShellCombatSkill> &out, std::unordered_set<uint16_t> &seen)
{
	if (sd == nullptr || skill_id == 0 || !skill_get_index(skill_id))
		return;
	if (skill_id == NV_BASIC || skill_id == NV_FIRSTAID)
		return;
	// Passive skills (INF_PASSIVE_SKILL = 0x00) cannot be cast at all — exclude from
	// every rotation pass including explicit YAML and job-default lists.
	const int inf = skill_get_inf(skill_id);
	if (inf == INF_PASSIVE_SKILL)
		return;
	const uint16_t slv = pc_checkskill(sd, skill_id);
	if (slv == 0)
		return;
	if (require_attack_inf) {
		if (!(inf & (INF_ATTACK_SKILL | INF_GROUND_SKILL | INF_TRAP_SKILL | INF_SELF_SKILL)))
			return;
		// In tree-scan fallback, exclude ALL NK_NODAMAGE skills — they provide no reliable
		// combat value and include debuff-only skills like PR_SIGNUM that pass INF_ATTACK_SKILL
		// but deal zero damage. Explicit YAML entries should be used to opt these back in.
		if (skill_get_nk(skill_id, NK_NODAMAGE))
			return;
	}
	uint16_t use_lv = slv;
	if (yaml_level_cap > 0)
		use_lv = std::min(slv, yaml_level_cap);
	if (use_lv == 0)
		return;
	if (require_attack_inf && !seen.insert(skill_id).second)
		return;
	PopulationShellCombatSkill row;
	row.active = true;
	row.skill_id = skill_id;
	row.skill_lv = use_lv;
	out.push_back(row);
}

/// Seed population shell attack list: population_skill_db.yml (Priority 0),
/// else db/population_engine.yml `Skills:` (Priority 1),
/// else learned skill tree scan (Priority 2).
static void population_shell_seed_attack_skills_if_empty(map_session_data *sd)
{
	if (sd == nullptr || !population_engine_is_population_pc(sd->id))
		return;

	const uint16_t base_job = population_engine_job_base_class(sd->status.class_);

	if (sd->pop.attack_skills.empty()) {
		std::vector<PopulationShellCombatSkill> cand;
		std::unordered_set<uint16_t> seen;
		cand.reserve(24);

		const PopulationEngine *pop_cfg = population_engine_resolve_equipment(sd->status.class_);
		bool preserve_order = false;

		// Priority 0: population_skill_db.yml per-job overrides (highest priority; replaces job defaults).
		{
			const std::vector<s_pop_skill_entry> *db_skills = population_skill_db().find(sd->status.class_);
			if (!db_skills || db_skills->empty())
				db_skills = population_skill_db().find(base_job);
			if (db_skills && !db_skills->empty()) {
				for (const s_pop_skill_entry &e : *db_skills) {
					if (e.state == 2)
						continue;
				const size_t before = cand.size();
					if (e.target == 1)
						continue;
					population_shell_push_attack_skill_candidate(sd, e.skill_id, e.skill_lv, false, cand, seen);
				if (cand.size() > before) {
					PopulationShellCombatSkill &cs = cand.back();
					cs.rate = e.rate;
					cs.condition = static_cast<uint8_t>(e.condition);
					cs.cond_value_num = e.cond_value_num;
					cs.cond_sc_resolved = population_shell_resolve_sc_name(e.cond_value_str);
					cs.target = (e.target == 2) ? 2u : 0u; // preserve ally-target flag
					cs.around_range = e.around_range;
					cs.around_target = e.around_target;
					cs.cooldown_ms  = e.cooldown_ms;
					cs.expanded     = e.expanded; // shared_ptr; no deep copy needed
				}
				}
				if (!cand.empty())
					preserve_order = true;
			}
		}

		if (cand.empty() && pop_cfg && !pop_cfg->shell_attack_skill_yaml.empty()) {
			for (const PopulationShellYamlSkill &e : pop_cfg->shell_attack_skill_yaml)
				population_shell_push_attack_skill_candidate(sd, e.skill_id, e.level_cap, false, cand, seen);
			if (!cand.empty())
				preserve_order = true;
		}
		// No tree-scan fallback: only use skills explicitly listed in population_skill_db.yml
		// or the profile's Skills: block. Shells with no entries auto-attack only.

		if (!cand.empty()) {
			if (!preserve_order) {
				std::sort(cand.begin(), cand.end(), [](const PopulationShellCombatSkill &a, const PopulationShellCombatSkill &b) {
					if (a.skill_lv != b.skill_lv)
						return a.skill_lv > b.skill_lv;
					return a.skill_id < b.skill_id;
				});
			}
			sd->pop.attack_skills = std::move(cand);
			sd->pop.attack_skill_cursor = 0;
			population_shell_recalc_max_attack_skill_range(sd);
		}
	}

	// Seed self-buff and ally-buff maintenance lists from population_skill_db.yml Target:1/2 entries.
	// Run independently of attack skill seeding so clearing buff skills re-seeds on next tick.
	if (sd->pop.buff_skills.empty()) {
		const std::vector<s_pop_skill_entry> *db_skills = population_skill_db().find(sd->status.class_);
		if (!db_skills || db_skills->empty())
			db_skills = population_skill_db().find(base_job);
		if (db_skills) {
			for (const s_pop_skill_entry &e : *db_skills) {
				// Target:1 = self-buff maintenance.
				// Target:2 = ally-targeted; handled exclusively via attack_skills /
				// cast_ally_attack_skill — do NOT also add to buff_skills or they fire twice.
				if (e.target != 1)
					continue;
				if (e.skill_id == 0)
					continue;
				// YAML-authoritative: do NOT gate on pc_checkskill here.
				// Cast-time logic (population_shell_cast_expired_self_buffs) falls back
				// to the YAML Level when the shell hasn't natively learned the skill,
				// allowing cross-class buffs like TF_HIDING on Monk/Champion/etc.
				bool dup = false;
				for (const PopulationShellBuffSkill &b : sd->pop.buff_skills)
					if (b.skill_id == e.skill_id && b.target == e.target) { dup = true; break; }
				if (dup)
					continue;
				PopulationShellBuffSkill bs;
				bs.skill_id   = e.skill_id;
				bs.skill_lv   = e.skill_lv;
				bs.condition  = static_cast<uint8_t>(e.condition);
				bs.cond_value_num = e.cond_value_num;
				bs.cond_sc_resolved = population_shell_resolve_sc_name(e.cond_value_str);
				bs.target     = e.target;
				bs.around_range = e.around_range;
				bs.around_target = e.around_target;
				bs.cooldown_ms  = e.cooldown_ms;
				bs.expanded     = e.expanded;
				sd->pop.buff_skills.push_back(bs);
			}
		}
	}
}

const char *population_combat_reject_code_name(PopulationCombatRejectCode code)
{
	switch (code) {
	case PopulationCombatRejectCode::NONE:
		return "NONE";
	case PopulationCombatRejectCode::UNKNOWN:
		return "UNKNOWN";
	case PopulationCombatRejectCode::INVALID_SESSION:
		return "INVALID_SESSION";
	case PopulationCombatRejectCode::NOT_ACTIVE_OR_WARPING:
		return "NOT_ACTIVE_OR_WARPING";
	case PopulationCombatRejectCode::NO_DURATION:
		return "NO_DURATION";
	case PopulationCombatRejectCode::SESSION_NOT_ACTIVE:
		return "SESSION_NOT_ACTIVE";
	case PopulationCombatRejectCode::FAKE_MISSING_CLIENT_ADDR:
		return "FAKE_MISSING_CLIENT_ADDR";
	case PopulationCombatRejectCode::BEHAVIOR_LIMIT:
		return "BEHAVIOR_LIMIT";
	case PopulationCombatRejectCode::INVALID_MAP:
		return "INVALID_MAP";
	case PopulationCombatRejectCode::MAP_TOWN_BLOCKED:
		return "MAP_TOWN_BLOCKED";
	case PopulationCombatRejectCode::MAP_PVP_BLOCKED:
		return "MAP_PVP_BLOCKED";
	case PopulationCombatRejectCode::MAP_GVG_BLOCKED:
		return "MAP_GVG_BLOCKED";
	case PopulationCombatRejectCode::MAP_BG_BLOCKED:
		return "MAP_BG_BLOCKED";
	case PopulationCombatRejectCode::OVERWEIGHT_BLOCKED:
		return "OVERWEIGHT_BLOCKED";
	case PopulationCombatRejectCode::LIMIT_IP:
		return "LIMIT_IP";
	case PopulationCombatRejectCode::LIMIT_MAC:
		return "LIMIT_MAC";
	case PopulationCombatRejectCode::LIMIT_GEPARD:
		return "LIMIT_GEPARD";
	case PopulationCombatRejectCode::MAP_INSTANCE_BLOCKED:
		return "MAP_INSTANCE_BLOCKED";
	case PopulationCombatRejectCode::MAP_WOE_BLOCKED:
		return "MAP_WOE_BLOCKED";
	default:
		return "UNMAPPED";
	}
}

/// Daily cycle: adjust town shell behavior based on server hour.
/// Returns the behavior the shell should currently use.
/// Only affects town shells (map_category == 1). Field/dungeon shells keep their configured behavior.
static void population_shell_apply_daily_cycle(map_session_data *sd)
{
	if (!battle_config.population_engine_daily_cycle)
		return;
	if (sd->pop.map_category != 1) // Only town shells
		return;

	time_t now = time(nullptr);
	struct tm *lt = localtime(&now);
	if (!lt) return;
	const int hour = lt->tm_hour;

	uint8 new_beh;
	if (hour >= 6 && hour < 18)
		new_beh = sd->pop.behavior_base; // Restore original configured behavior during daytime
	else if (hour >= 18 && hour < 22)
		new_beh = static_cast<uint8>(PopulationBehavior::Social);
	else
		new_beh = static_cast<uint8>(PopulationBehavior::Sit);

	// Only update if changed (avoid unnecessary state changes).
	if (sd->pop.behavior != new_beh) {
		const uint8 old_beh = sd->pop.behavior;
		sd->pop.behavior = new_beh;
		// Transition effects.
		if (new_beh == static_cast<uint8>(PopulationBehavior::Sit)) {
			pc_setsit(sd);
			clif_sitting(*sd);
		} else if (old_beh == static_cast<uint8>(PopulationBehavior::Sit)) {
			pc_setstand(sd, false);
			clif_standing(*sd);
		}
	}
}

/// Event-driven reactive cast: immediately attempt buff AND attack skills after the shell
/// receives damage, mirroring mob_skill_db closedattacked/longrangeattacked semantics
/// (fire on the damage event, not on the next poll tick). Only runs when in active combat.
///
/// Buff pass: always runs — covers self_targeted / melee_attacked / range_attacked gates
/// on Target:1 entries (Fog Wall, Safety Wall, Steel Body, Defender, Hiding, etc.).
///
/// Attack pass: runs only if the shell currently has a live enemy target AND skill_cd
/// has elapsed — covers Target:0 attack skills with melee_attacked/self_targeted gates
/// (Frostnova, Quagmire, Sightblaster, etc.) that the regular poll tick might miss.
void population_engine_shell_reactive_cast(map_session_data *sd)
{
	if (!sd || !sd->state.population_combat)
		return;
	const t_tick now = gettick();
	// --- Buff pass (Target:1 and Target:2 skills) ---
	if (!sd->pop.buff_skills.empty())
		population_shell_cast_expired_self_buffs(sd, now);
	// --- Attack pass (Target:0 skills with conditional gates) ---
	// Only fire if skill_cd allows it and there is a current enemy target.
	if (sd->pop.attack_skills.empty())
		return;
	if (sd->pop.skill_cd > now)
		return;
	if (sd->pop.target_id == 0)
		return;
	block_list *tbl = map_id2bl(static_cast<int>(sd->pop.target_id));
	if (!tbl || tbl->m != sd->m)
		return;
	uint16 skill_id = 0, skill_lv = 0;
	population_shell_pick_attack_skill(sd, skill_id, skill_lv, tbl);
	if (skill_id == 0)
		return;
	if (skill_get_inf(skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
		int16_t tx = tbl->x, ty = tbl->y;
		if (unit_skilluse_pos(sd, tx, ty, skill_id, skill_lv)) {
			sd->pop.skill_cd = now + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
			sd->pop.last_cast_skill_id = skill_id;
		}
	} else {
		if (unit_skilluse_id(sd, tbl->id, skill_id, skill_lv)) {
			sd->pop.skill_cd = now + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
			sd->pop.last_cast_skill_id = skill_id;
		}
	}
}

int population_engine_combat_per_tick(map_session_data *sd, bool do_skills)
{
	if (sd == nullptr)
		return -1;
	if (pc_isdead(sd))
		return 0;
	s_population &pe = sd->pop;
	population_shell_update_mob_tracker(sd);
	t_tick current_tick = gettick();

	// Daily cycle: adjust behavior for town shells based on server hour.
	population_shell_apply_daily_cycle(sd);

	// Sit/Vendor behaviors skip combat entirely — just maintain buffs.
	const auto cur_beh = static_cast<PopulationBehavior>(sd->pop.behavior);
	if (cur_beh == PopulationBehavior::Sit || cur_beh == PopulationBehavior::Vendor) {
		population_shell_status_checkmapchange(sd);
		return 0;
	}

	// Auto-unhide: ends SC_HIDING/SC_CLOAKING when threats clear so reactive Hide buff
	// rotations don't leave the shell permanently hidden. Runs for both arena and
	// non-arena combat paths.
	population_shell_check_unhide(sd, current_tick);

	// Arena mode: shells target real players on the map (player-vs-shells observation).
	if (sd->pop.arena_team > 0) {
		population_shell_reset_movement_tick_state(sd, current_tick);
		// Reset movement owner SM so stuck target-lock and timed-out states clear.
		population_shell_status_check_reset(sd, current_tick);
		const uint32 arena_tid = static_cast<uint32>(pe.target_id);
		// Validate current arena target.
		if (arena_tid > 0 && !population_shell_check_arena_target(sd, arena_tid))
			population_shell_target_change(sd, 0);
		// Find a new opponent if needed.
		if (!pe.target_id) {
			const unsigned int opp = population_shell_find_arena_opponent(sd);
			population_shell_target_change(sd, static_cast<int>(opp));
		}

		const bool flag_attack_only = (sd->pop.flags & PSF::AttackOnly) != 0
		|| sd->sc.getSCE(SC_BERSERK) != nullptr; // Frenzy: auto-attack only, no skills
		const bool flag_skill_only  = (sd->pop.flags & PSF::SkillOnly)  != 0;

		// 1. Maintenance buffs — reactive_buff_cd is independent so buffs don't block attacks.
		if (!flag_attack_only && do_skills && current_tick >= sd->pop.reactive_buff_cd
				&& !sd->pop.buff_skills.empty() && battle_config.population_engine_shell_attackskill) {
			if (population_shell_cast_expired_self_buffs(sd, current_tick)) {
				sd->pop.reactive_buff_cd = current_tick + std::max(1, battle_config.population_engine_shell_skill_interval_ms);
				// No return: fall through to ally-skill and attack in the same tick.
			}
		}
		if (!flag_attack_only && do_skills && current_tick >= pe.skill_cd) {
			// 2. Ally-targeted attack skills (Heal on ally HP%, Kyrie on injured ally, etc.).
			if (battle_config.population_engine_shell_attackskill) {
				if (population_shell_cast_ally_attack_skill(sd, current_tick)) {
					// skill_cd already set inside cast_ally_attack_skill based on actual timing.
					population_shell_status_checkmapchange(sd);
					return 0;
				}
			}
		}

		// 3. Offensive skills + basic attack against the player.
		if (pe.target_id) {
			uint16 skill_id = 0, skill_lv = 0;
			if (!flag_attack_only && do_skills && current_tick >= pe.skill_cd && battle_config.population_engine_shell_attackskill) {
				block_list *tbl = map_id2bl(static_cast<int>(pe.target_id));

				// Snap priority: if out of melee range and MO_BODYRELOCATION is
				// available and off cooldown, use it before the sphere chain so it
				// isn't starved by CALLSPIRITS every tick.
				if (tbl && !check_distance_bl(sd, tbl, 2)) {
					const uint16 snap_plv = pc_checkskill(sd, MO_BODYRELOCATION);
					if (snap_plv > 0 && !skill_isNotOk(MO_BODYRELOCATION, *sd)) {
						auto snap_cd_it = sd->pop.skill_next_use_tick.find(MO_BODYRELOCATION);
						const bool snap_cd_ok = snap_cd_it == sd->pop.skill_next_use_tick.end()
							|| current_tick >= snap_cd_it->second;
						if (snap_cd_ok) {
							skill_id = MO_BODYRELOCATION;
							// Use the YAML-configured level for this shell if available.
							for (const auto &cs : sd->pop.attack_skills)
								if (cs.skill_id == MO_BODYRELOCATION) { skill_lv = cs.skill_lv > 0 ? cs.skill_lv : 1; break; }
							if (skill_lv == 0) skill_lv = 1;
						}
					}
				}

				if (skill_id == 0) {
					bool sphere_picked = population_shell_pick_sphere_chain_skill(sd, skill_id, skill_lv);
					if (!sphere_picked)
						population_shell_pick_attack_skill(sd, skill_id, skill_lv, tbl);
					if (skill_id == 0 && flag_skill_only)
						population_shell_pick_attack_skill(sd, skill_id, skill_lv, tbl, true);
				}
			}
			if (!flag_skill_only || flag_attack_only || skill_id != 0) {
				bool arena_fired = population_shell_try_arena_attack(sd, static_cast<uint32>(pe.target_id), skill_id, skill_lv);
				// Enforce the YAML per-skill cooldown for snap when it fires via
				// the priority path (bypasses population_shell_pick_attack_skill).
				if (arena_fired && skill_id == MO_BODYRELOCATION) {
					uint32_t snap_cd_ms = 1000; // YAML default for Champion/Monk
					for (const auto &cs : sd->pop.attack_skills)
						if (cs.skill_id == MO_BODYRELOCATION && cs.cooldown_ms > 0) { snap_cd_ms = cs.cooldown_ms; break; }
					sd->pop.skill_next_use_tick[MO_BODYRELOCATION] = current_tick + static_cast<t_tick>(snap_cd_ms);
				}
			}
		}
		population_shell_status_checkmapchange(sd);
		return 0;
	}

	// Do not drop a chase target just because it is outside client sight yet — that prevented pathing.
	if (!pe.target_id) {
		unsigned int found_target = population_shell_check_target_alive(sd);
		if (found_target > 0) {
			population_shell_target_change(sd, found_target);
			// PAI::PackBehavior: share newly acquired target with nearby idle shells.
			if ((battle_config.population_engine_ai & PAI::PackBehavior) && found_target > 0) {
				const int detect_cells = std::max(1, battle_config.population_engine_shell_mdetection_cells);
				map_foreachinrange(pop_pack_share_target_cb, sd, detect_cells, BL_PC,
					sd->id, static_cast<int>(found_target));
			}
		} else
			population_shell_target_change(sd, 0);
	} else if (!population_shell_check_target(sd, pe.target_id)) {
		if (!population_shell_check_target_for_movement(sd, pe.target_id)) {
			unsigned int found_target = population_shell_check_target_alive(sd);
			if (found_target > 0)
				population_shell_target_change(sd, found_target);
			else
				population_shell_target_change(sd, 0);
		}
	}

	population_shell_combat_process_tick(sd, current_tick, do_skills);

	if (DIFF_TICK(gettick(), pe.last_move) > 3000) {
		sd->ud.canmove_tick = gettick();
	}

	population_shell_status_checkmapchange(sd);

	return 0;
}

bool population_engine_combat_changestate(map_session_data *sd, int flag)
{
	if (!sd) {
		ShowError("population_engine_combat_changestate: null session.\n");
		return false;
	}

	s_population &pe = sd->pop;
	switch (flag) {
	case 1: {
		if (!sd->state.active || sd->state.warping) {
			// Pack char_id into high bits, attempt counter (starting at 0) into low 8 bits.
			// On fire, we verify char_id matches to reject stale timers if the AID is reused.
			const intptr_t timer_cookie = (static_cast<intptr_t>(sd->status.char_id) << 8) | 0;
			add_timer(gettick() + PE_SHELL_DEFER_START_MS, population_engine_combat_defer_start, sd->id, timer_cookie);
			return false;
		}
		if (!pe.initialized) {
			pe.lastposition.map = sd->mapindex;
			pe.lastposition.x = sd->x;
			pe.lastposition.y = sd->y;
			pe.initialized = true;
			pe.unique_id = sd->status.char_id ? static_cast<uint32_t>(sd->status.char_id) : static_cast<uint32_t>(sd->id);
		}
		sd->state.population_combat = true;
		break;
	}
	case 2: {
		sd->state.population_combat = false;

		pe.session_guard = pe.session_guard + 1;
		pe.recently_cleared_targets.clear();
		pe.nav_state = LocalNavState::DirectAdvance;
		pe.nav_heading_x = 0;
		pe.nav_heading_y = 0;
		pe.next_nav_attempt_tick = 0;
		pe.blocked_heading_streak = 0;
		pe.nav_blocked_cells.fill(CANavBlockedCell());

		if (!status_isdead(*sd)) {
			if (!pe.manual_stop_requested) {
				if (pe.action_on_end == 1) {
					pc_setpos(sd, mapindex_name2id(sd->status.save_point.map), sd->status.save_point.x, sd->status.save_point.y, CLR_TELEPORT);
					pe.lastposition.x = sd->status.save_point.x;
					pe.lastposition.y = sd->status.save_point.y;
					pe.lastposition.map = sd->mapindex;

					if (sd->state.autotrade) {
						pc_delinvincibletimer(sd);
						clif_parse_LoadEndAck(0, sd);
					}
				}

				if (pe.action_on_end == 2) {
					if (session_isActive(sd->fd))
						clif_authfail_fd(sd->fd, 15);
					else
						map_quit(sd);
				}
			} else {
				pe.manual_stop_requested = false;
			}
		}

		return true;
	}
	default:
		ShowWarning("population_engine_combat_changestate: unknown flag %d\n", flag);
		break;
	}
	return true;
}

PopulationCombatStartResult population_engine_combat_start_session(map_session_data *sd, PopulationCombatStartMode mode, t_tick duration_override, int32 scstart_flags)
{
	PopulationCombatStartResult out;
	out.mode = mode;
		out.status_sc = 0; // Combat state driven by sd->state.population_combat
		if (!sd || !population_engine_is_population_pc(sd->id)) {
		out.reject_code = PopulationCombatRejectCode::INVALID_SESSION;
		return out;
	}

	// Already in combat — seed skills if somehow the list is empty, then return.
	if (sd->state.population_combat) {
		out.started = true;
		out.duration = INFINITE_TICK;
		out.reject_code = PopulationCombatRejectCode::NONE;
		population_shell_seed_attack_skills_if_empty(sd);
		return out;
	}

	(void)duration_override;
	(void)scstart_flags;
	out.duration = INFINITE_TICK;

	// Directly activate combat state.
	if (!population_engine_combat_changestate(sd, 1)) {
		const uint16_t raw = static_cast<uint16_t>(sd->pop.last_start_reject_code_raw);
		const uint16_t none = static_cast<uint16_t>(PopulationCombatRejectCode::NONE);
		const uint16_t unknown = static_cast<uint16_t>(PopulationCombatRejectCode::UNKNOWN);
		out.reject_code = static_cast<PopulationCombatRejectCode>(raw == none ? unknown : raw);
		out.started = false;
		return out;
	}

	out.started = sd->state.population_combat;
	if (out.started) {
		out.reject_code = PopulationCombatRejectCode::NONE;
		population_shell_seed_attack_skills_if_empty(sd);
	}
	return out;
}

void population_engine_combat_cleanup_player(map_session_data *sd)
{
	if (!sd)
		return;

	s_population &pe = sd->pop;
	if (population_engine_is_population_pc(sd->id)) {
		sd->pop.attack_skills.clear();
		sd->pop.attack_skill_cursor = 0;
		sd->pop.max_attack_skill_range = -1;
		sd->pop.buff_skills.clear();
		sd->pop.safetywall_kited_since = 0;
	}
	pe.session_guard = pe.session_guard + 1;
	pe.recently_cleared_targets.clear();
}

void do_init_population_engine_combat()
{
	static bool registered = false;
	if (!registered) {
		add_timer_func_list(population_engine_combat_defer_start, "population_engine_combat_defer_start");
		registered = true;
	}
}

void do_final_population_engine_combat()
{
}

TIMER_FUNC(population_engine_combat_defer_start)
{
	map_session_data *sd = BL_CAST(BL_PC, map_id2bl(id));
	if (!sd)
		return 0;
	// Decode cookie: high bits = char_id set at schedule time, low 8 bits = attempt counter.
	const uint32_t expected_char_id = static_cast<uint32_t>(static_cast<uintptr_t>(data) >> 8);
	const intptr_t attempt = static_cast<intptr_t>(static_cast<uintptr_t>(data) & 0xFF);
	// Guard: reject if the block-list ID was reused for a different fake PC after the original was freed.
	if (expected_char_id != 0 && sd->status.char_id != expected_char_id)
		return 0;
	if (attempt >= PE_SHELL_DEFER_MAX_ATTEMPTS) {
		ShowError("population_engine_combat_defer_start: giving up after %d attempts for bl_id %d\n", static_cast<int>(attempt), id);
		return 0;
	}
	if (!sd->state.active || sd->state.warping) {
		const intptr_t next_cookie = (static_cast<intptr_t>(expected_char_id) << 8) | (attempt + 1);
		add_timer(gettick() + PE_SHELL_DEFER_START_MS, population_engine_combat_defer_start, id, next_cookie);
		return 0;
	}
	population_engine_combat_start_session(sd, PopulationCombatStartMode::AutoCombat, -1, SCSTART_NOAVOID);
	return 0;
}

void population_engine_combat_shell_teardown(map_session_data *sd)
{
	if (!sd)
		return;
	population_engine_apply_shell_hat_effect(sd, false);
	// Deactivate combat state.
	if (sd->state.population_combat)
		population_engine_combat_changestate(sd, 2);
	population_engine_combat_cleanup_player(sd);
	sd->state.population_combat = false;
}

bool population_engine_combat_try_start(map_session_data *sd)
{
	if (!sd)
		return false;
	if (sd->m < 0 || sd->prev == nullptr || map_id2bl(sd->id) != sd) {
		ShowWarning("Population engine: shell not on map for fake PC '%s' (AID:%u)\n", sd->status.name, sd->status.account_id);
		return false;
	}

	s_population &pe = sd->pop;
	if (!pe.initialized) {
		pe.initialized = true;
		pe.unique_id = sd->status.char_id ? static_cast<uint32_t>(sd->status.char_id) : static_cast<uint32_t>(sd->id);
		pe.lastposition.map = sd->mapindex;
		pe.lastposition.x = sd->x;
		pe.lastposition.y = sd->y;
	}
	sd->state.population_combat = false;

	population_engine_apply_shell_hat_effect(sd, true);
	sd->pop.flags |= PSF::CombatActive;
	return true;
}

bool population_engine_combat_shell_ac_ok(const map_session_data *sd)
{
	if (!sd || !sd->state.active || sd->prev == nullptr || map_id2bl(sd->id) != sd)
		return false;
	return (sd->pop.flags & PSF::CombatActive) != 0;
}
