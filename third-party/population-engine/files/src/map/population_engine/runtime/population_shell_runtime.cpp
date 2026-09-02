// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell runtime helpers: movement, targeting, combat execution.
// Path/target state stored in sd->pop. Offensive skills in sd->pop.attack_skills.

#include "population_shell_runtime.hpp"

#include "../core/population_shell_state.hpp"
#include "../core/population_engine_core.hpp"
#include <algorithm>
#include <climits>
#include <cstdarg>
#include <unordered_set>
#include <vector>

#include <common/random.hpp>
#include <common/showmsg.hpp>
#include <common/socket.hpp>
#include <common/timer.hpp>

#include "../../battle.hpp"
#include "../../clif.hpp"
#include "../../itemdb.hpp"
#include "../../map.hpp"
#include "../../mob.hpp"
#include "../../path.hpp"
#include "../../population_engine.hpp"
#include "../../skill.hpp"
#include "../../status.hpp"
#include "../../unit.hpp"

#include "population_shell_ammo.hpp"

namespace {

bool shell_has_real_session(map_session_data *sd)
{
	if (!sd || sd->fd <= 0)
		return false;
	return session_isActive(sd->fd);
}

void shell_add_cleared_target_to_exclusion(map_session_data *sd, uint32 target_id, t_tick current_tick)
{
	if (!sd || target_id == 0)
		return;
	s_population &pe = sd->pop;
	pe.recently_cleared_targets[target_id] = current_tick;
}

bool shell_is_target_excluded(map_session_data *sd, uint32 target_id, t_tick current_tick)
{
	if (!sd || target_id == 0)
		return false;
	s_population &pe = sd->pop;
	auto it = pe.recently_cleared_targets.find(target_id);
	if (it == pe.recently_cleared_targets.end())
		return false;
	if (DIFF_TICK(current_tick, it->second) >= PE_SHELL_TARGET_EXCLUSION_MS) {
		pe.recently_cleared_targets.erase(it);
		return false;
	}
	return true;
}

void shell_cleanup_old_excluded_targets(map_session_data *sd, t_tick current_tick)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	auto it = pe.recently_cleared_targets.begin();
	while (it != pe.recently_cleared_targets.end()) {
		if (DIFF_TICK(current_tick, it->second) >= PE_SHELL_TARGET_EXCLUSION_MS)
			it = pe.recently_cleared_targets.erase(it);
		else
			++it;
	}
}

static bool shell_is_population_device_item(t_itemid nameid)
{
	// Rental / assistant device items: do not send to storage (50501/50507 match population combat inventory checks)
	return nameid == 50501 || nameid == 50507;
}

bool shell_find_nearby_walkable_cell(int16 map_id, int target_x, int target_y, int max_radius, int &out_x, int &out_y)
{
	if (map_getcell(map_id, target_x, target_y, CELL_CHKPASS)) {
		out_x = target_x;
		out_y = target_y;
		return true;
	}
	for (int radius = 1; radius <= max_radius; ++radius) {
		for (int dx = -radius; dx <= radius; ++dx) {
			for (int dy = -radius; dy <= radius; ++dy) {
				if (std::max(std::abs(dx), std::abs(dy)) != radius)
					continue;
				const int tx = target_x + dx;
				const int ty = target_y + dy;
				if (map_getcell(map_id, tx, ty, CELL_CHKPASS)) {
					out_x = tx;
					out_y = ty;
					return true;
				}
			}
		}
	}
	return false;
}

static bool shell_try_walktobl_command(map_session_data *sd, block_list *target_bl, int32 range, int easy_path, MovementOwner owner, const char *source)
{
	(void)source;
	if (!sd || !target_bl)
		return false;
	s_population &pe = sd->pop;
	if (!population_shell_can_emit_movement(sd, owner, source))
		return false;
	if (unit_walktobl(sd, target_bl, range, easy_path)) {
		pe.last_move = gettick();
		return true;
	}
	pe.movement_emitted_this_tick = false;
	pe.owner_noop_count++;
	return false;
}

} // namespace

void population_shell_reset_movement_tick_state(map_session_data *sd, t_tick current_tick)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	pe.movement_emit_tick = current_tick;
	pe.movement_emitted_this_tick = false;
	pe.movement_conflict_logged_this_tick = false;
	pe.movement_owner = MovementOwner::None;
}

bool population_shell_can_emit_movement(map_session_data *sd, MovementOwner owner, const char *source)
{
	(void)source;
	if (!sd)
		return false;
	// Respect cast-lock: shells without SA_FREECAST cannot move while casting, same as real players.
	if (!unit_can_move(sd))
		return false;
	s_population &pe = sd->pop;
	if (!battle_config.population_engine_shell_movement_owner_sm)
		return true;

	if (pe.movement_owner != MovementOwner::None && pe.movement_owner != owner) {
		// Combat movement preempts roam: a shell that spots a mob while wandering
		// should immediately pivot to chase instead of finishing the wander step.
		if (owner == MovementOwner::Combat && pe.movement_owner == MovementOwner::Roam) {
			pe.movement_owner = MovementOwner::Combat;
			// Fall through — allow the combat movement.
		} else {
			pe.owner_blocked_count++;
			if (!pe.movement_conflict_logged_this_tick) {
				pe.movement_conflict_logged_this_tick = true;
			}
			return false;
		}
	}
	if (pe.movement_emitted_this_tick) {
		// Combat movement can override a roam movement emitted earlier this tick.
		// This prevents wander-step waste when a mob appears mid-tick.
		if (owner == MovementOwner::Combat) {
			// Allow — combat takes priority; the walk engine will supersede the roam walk.
		} else {
			pe.owner_blocked_count++;
			if (!pe.movement_conflict_logged_this_tick) {
				pe.movement_conflict_logged_this_tick = true;
			}
			return false;
		}
	}
	pe.movement_emitted_this_tick = true;
	return true;
}

void population_shell_cleanup_expired_buffs(map_session_data *sd, t_tick current_tick)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	auto it = pe.active_buffs.begin();
	while (it != pe.active_buffs.end()) {
		if (it->expires_at <= current_tick)
			it = pe.active_buffs.erase(it);
		else
			++it;
	}
}

bool population_shell_autoshadowspell_autoselect(map_session_data *sd)
{
	if (!sd || sd->menuskill_id != SC_AUTOSHADOWSPELL)
		return false;

	uint16 skill_id = 0;
	auto check_skill = [&](int idx) {
		if (idx > 0 && sd->status.skill[idx].id > 0 && sd->status.skill[idx].flag == SKILL_FLAG_PLAGIARIZED &&
			skill_get_inf2(sd->status.skill[idx].id, INF2_ISAUTOSHADOWSPELL)) {
			skill_id = sd->status.skill[idx].id;
		}
	};

	check_skill(sd->reproduceskill_idx);
	if (skill_id == 0)
		check_skill(sd->cloneskill_idx);
	if (skill_id == 0)
		return false;

	skill_select_menu(*sd, skill_id);
	clif_menuskill_clear(sd);
	return true;
}

int population_shell_move_to_path(std::vector<std::tuple<int, int>> &path, map_session_data *sd, int /*recursion_depth*/)
{
	if (!sd)
		return 0;
	s_population &pe = sd->pop;
	if (path.empty() || pe.path_index < 0)
		return 0;
	if (pe.path_index >= static_cast<int>(path.size()))
		return 0;

	t_tick current_tick = gettick();

	if (pe.last_move == 0) {
		pe.last_move = current_tick;
		pe.lastposition.x = sd->x;
		pe.lastposition.y = sd->y;
	}

	static const t_tick STUCK_TIMEOUT = 3000;
	t_tick walk_tick = DIFF_TICK(current_tick, pe.last_move);

	bool position_unchanged = (sd->x == pe.lastposition.x && sd->y == pe.lastposition.y);
	if (position_unchanged)
		pe.path_exec_fail_count++;
	else {
		pe.path_exec_fail_count = 0;
		pe.lastposition.x = sd->x;
		pe.lastposition.y = sd->y;
	}

	if (position_unchanged && pe.path_exec_fail_count > 8) {
		path.clear();
		pe.path_index = 0;
		pe.path_exec_fail_count = 0;
		pe.last_move = 0;
		return 0;
	}
	if (pe.last_move > 0 && walk_tick > STUCK_TIMEOUT) {
		path.clear();
		pe.path_index = 0;
		pe.path_exec_fail_count = 0;
		pe.last_move = 0;
		return 0;
	}

	const auto &waypoint = path[pe.path_index];
	int target_x = std::get<0>(waypoint);
	int target_y = std::get<1>(waypoint);

	int dist_to_waypoint = distance_xy(sd->x, sd->y, target_x, target_y);
	if (dist_to_waypoint <= 1) {
		pe.path_index++;
		if (pe.path_index >= static_cast<int>(path.size()))
			return 0;
		const auto &next_waypoint = path[pe.path_index];
		target_x = std::get<0>(next_waypoint);
		target_y = std::get<1>(next_waypoint);
		dist_to_waypoint = distance_xy(sd->x, sd->y, target_x, target_y);
	}

	if (pe.path_index < static_cast<int>(path.size()) - 1) {
		if (dist_to_waypoint < 8 && dist_to_waypoint > 0) {
			int candidate = pe.path_index + 1;
			if (candidate < static_cast<int>(path.size())) {
				const auto &cand_wp = path[candidate];
				int16_t cx = std::get<0>(cand_wp), cy = std::get<1>(cand_wp);
				if (path_search(nullptr, sd->m, sd->x, sd->y, cx, cy, 0, CELL_CHKNOPASS)) {
					pe.path_index = candidate;
					target_x = cx;
					target_y = cy;
				}
			}
		}
	}

	bool waypoint_valid = path_search(nullptr, sd->m, sd->x, sd->y, target_x, target_y, 0, CELL_CHKNOPASS);
	if (!waypoint_valid) {
		int alt_x = target_x, alt_y = target_y;
		if (shell_find_nearby_walkable_cell(sd->m, target_x, target_y, 2, alt_x, alt_y)) {
			target_x = alt_x;
			target_y = alt_y;
			waypoint_valid = true;
		} else {
			pe.path_index++;
			if (pe.path_index >= static_cast<int>(path.size()))
				return 0;
			const auto &next_waypoint = path[pe.path_index];
			target_x = std::get<0>(next_waypoint);
			target_y = std::get<1>(next_waypoint);
			waypoint_valid = path_search(nullptr, sd->m, sd->x, sd->y, target_x, target_y, 0, CELL_CHKNOPASS);
		}
	}

	MovementOwner owner_for_path = pe.movement_owner == MovementOwner::None ? MovementOwner::Combat : pe.movement_owner;
	if (waypoint_valid && population_shell_can_emit_movement(sd, owner_for_path, "population_shell_move_to_path")) {
		if (unit_walktoxy(sd, target_x, target_y, 0) || unit_walktoxy(sd, target_x, target_y, 1)) {
			pe.last_move = current_tick;
			pe.last_move_fail = 0;
			pe.path_exec_fail_count = 0;
			return 1;
		}
		// Walk command failed but the movement slot is consumed for this tick.
		// Do NOT reset movement_emitted_this_tick — a second walk attempt would
		// violate the single-movement-per-tick invariant.
	}

	pe.path_index++;
	if (pe.path_index >= static_cast<int>(path.size()))
		return 0;
	return 1;
}

bool population_shell_status_check_reset(map_session_data *sd, t_tick last_tick)
{
	if (!sd)
		return false;
	if (unit_is_walking(sd))
		return false;

	s_population &pe = sd->pop;
	if (pe.target_id) {
		t_tick attack_ = DIFF_TICK(last_tick, pe.last_attack);
		if (attack_ > PE_SHELL_TARGET_ATTACK_TIMEOUT_MS) {
			population_shell_target_change(sd, 0);
			// BUG-1 fix: go through movement owner SM instead of raw walktoxy
			if (population_shell_can_emit_movement(sd, MovementOwner::Roam, "population_shell:status_check_reset_target")) {
				int x = sd->x + (rnd() % 3) - 1;
				int y = sd->y + (rnd() % 3) - 1;
				if ((x != sd->x || y != sd->y) && map_getcell(sd->m, x, y, CELL_CHKPASS))
					unit_walktoxy(sd, x, y, 4);
			}
			pe.last_attack = last_tick;
			return true;
		}
	}
	return false;
}

bool population_shell_check_target(map_session_data *sd, unsigned int id)
{
	if (!sd || id == 0)
		return false;
	block_list *bl = map_id2bl(id);
	if (!bl)
		return false;
	if (battle_config.ksprotection && mob_ksprotected(sd, bl))
		return false;
	if (status_isdead(*bl))
		return false;
	int battle_target_result = battle_check_target(sd, bl, BCT_ENEMY);
	bool can_use_skill = status_check_skilluse(sd, bl, 0, 0);
	if (battle_target_result <= 0 || !can_use_skill)
		return false;
	if (!unit_can_attack(sd, bl->id))
		return false;

	// Line-of-sight check (cheaper than full A* pathfinding).
	if (!path_search_long(nullptr, sd->m, sd->x, sd->y, bl->x, bl->y, CELL_CHKWALL))
		return false;
	if (distance_bl((block_list *)sd, bl) > AREA_SIZE)
		return false;

	TBL_MOB *md = map_id2md(bl->id);
	if (!md || md->type != BL_MOB || md->status.hp <= 0 || md->special_state.ai)
		return false;
	if (md->sc.option & (OPTION_HIDE | OPTION_CLOAK))
		return false;
	if (!battle_check_range(sd, bl, AREA_SIZE))
		return false;
	return true;
}

bool population_shell_check_target_for_movement(map_session_data *sd, unsigned int id)
{
	if (!sd || id == 0)
		return false;
	block_list *bl = map_id2bl(id);
	if (!bl || bl->m != sd->m)
		return false;
	if (status_isdead(*bl))
		return false;
	TBL_MOB *md = map_id2md(bl->id);
	if (!md || md->type != BL_MOB || md->status.hp <= 0 || md->special_state.ai)
		return false;
	if (md->sc.option & (OPTION_HIDE | OPTION_CLOAK))
		return false;
	if (battle_config.ksprotection && mob_ksprotected(sd, bl))
		return false;
	return battle_check_target(sd, bl, BCT_ENEMY) > 0;
}

int population_shell_mob_search_sub_cached(block_list *bl, va_list ap)
{
	auto *found_monsters = va_arg(ap, std::vector<unsigned int> *);
	int src_id = va_arg(ap, int);
	if (!bl || bl->type != BL_MOB)
		return 0;
	map_session_data *sd = map_id2sd(src_id);
	if (!sd)
		return 0;
	if (!population_shell_check_target(sd, bl->id))
		return 0;
	if (shell_is_target_excluded(sd, bl->id, gettick()))
		return 0;
	found_monsters->push_back(bl->id);
	return 1;
}

unsigned int population_shell_check_target_alive(map_session_data *sd)
{
	if (!sd)
		return 0;

	s_population &pe = sd->pop;

	// Sticky-target preference: if the shell currently has no target but recently
	// committed to one, try the sticky id first before scanning for a new nearest
	// mob. Prevents target ping-pong between equidistant enemies and matches the
	// commitment behavior found in autocombat (implemented standalone here).
	const t_tick now_for_sticky = gettick();
	if (sd->pop.sticky_target_id != 0 && pe.target_id == 0 &&
	    sd->pop.sticky_until > now_for_sticky) {
		if (population_shell_check_target(sd, sd->pop.sticky_target_id) &&
		    !shell_is_target_excluded(sd, sd->pop.sticky_target_id, now_for_sticky)) {
			population_shell_target_change(sd, sd->pop.sticky_target_id);
			return pe.target_id;
		}
		// Sticky target invalid (dead/oor/excluded) — fall through to fresh scan
		// and let the new pick re-stamp stickiness below.
		sd->pop.sticky_target_id = 0;
		sd->pop.sticky_until = 0;
	}

	if (!population_shell_check_target(sd, pe.target_id)) {
		if (pe.mobs.map != sd->mapindex) {
			pe.mobs.map = sd->mapindex;
			pe.detection_cache.cached_monsters.clear();
			pe.detection_cache.last_update = 0;
		}

		unsigned int target_id_ = 0;
		population_shell_target_change(sd, 0);

		t_tick current_tick = gettick();
		shell_cleanup_old_excluded_targets(sd, current_tick);

		const int cache_ms = battle_config.population_engine_shell_detection_cache_ms;
		bool can_use_cache = (pe.detection_cache.last_update > 0 &&
			DIFF_TICK(current_tick, pe.detection_cache.last_update) < cache_ms &&
			pe.detection_cache.last_x == sd->x && pe.detection_cache.last_y == sd->y &&
			pe.detection_cache.cache_radius >= battle_config.population_engine_shell_mdetection_cells);

		if (can_use_cache && !pe.detection_cache.cached_monsters.empty()) {
			for (unsigned int cached_id : pe.detection_cache.cached_monsters) {
				if (shell_is_target_excluded(sd, cached_id, current_tick))
					continue;
				block_list *cached_bl = map_id2bl(cached_id);
				if (!cached_bl || cached_bl->type != BL_MOB)
					continue;
				if (population_shell_check_target(sd, cached_id)) {
					population_shell_target_change(sd, cached_id);
					return pe.target_id;
				}
			}
			pe.detection_cache.cached_monsters.clear();
		}

		std::vector<unsigned int> found_monsters;
		found_monsters.reserve(15);
		const int max_mdetection = std::min<int32>(battle_config.population_engine_shell_mdetection_cells, 30);

		// Single scan at full detection radius — replaces the old radius=0..N expanding loop
		// which made N separate map_foreachinarea calls with pathfinding per mob.
		map_foreachinarea(population_shell_mob_search_sub_cached, sd->m,
			sd->x - max_mdetection, sd->y - max_mdetection,
			sd->x + max_mdetection, sd->y + max_mdetection,
			BL_MOB, &found_monsters, sd->id);

		if (!found_monsters.empty()) {
			// Sort by distance to prefer the closest mob.
			std::sort(found_monsters.begin(), found_monsters.end(),
				[sd](unsigned int a, unsigned int b) {
					block_list *ba = map_id2bl(a), *bb = map_id2bl(b);
					int da = ba ? distance_bl(sd, ba) : INT_MAX;
					int db = bb ? distance_bl(sd, bb) : INT_MAX;
					return da < db;
				});
			for (unsigned int mob_id : found_monsters) {
				if (population_shell_check_target(sd, mob_id)) {
					target_id_ = mob_id;
					population_shell_target_change(sd, target_id_);
					break;
				}
			}
		}

		pe.detection_cache.cached_monsters = std::move(found_monsters);
		pe.detection_cache.last_update = current_tick;
		pe.detection_cache.last_x = sd->x;
		pe.detection_cache.last_y = sd->y;
		pe.detection_cache.cache_radius = battle_config.population_engine_shell_mdetection_cells;
	}

	return pe.target_id;
}

void population_shell_target_change(map_session_data *sd, int id)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	unit_data *ud = unit_bl2ud(sd);
	if (ud)
		ud->target = id;

	if (pe.target_id > 0 && id == 0)
		pe.target_lost_tick = gettick();
	else if (id > 0) {
		pe.target_lost_tick = 0;
		pe.move_fail_count = 0;
		pe.attack_fail_count = 0;
		if (pe.target_id > 0 && pe.target_id != static_cast<uint32>(id))
			pe.last_target_switch_tick = gettick();
		// Stamp sticky-target commitment so the nearest-mob scan prefers this
		// id for the configured window even if a closer enemy spawns nearby.
		// Only log/refresh when committing to a genuinely new id; re-stamping the
		// same id every tick is just noise (and the timestamp already advances
		// every commitment so the window is still kept fresh on real switches).
		const int sticky_ms = battle_config.population_engine_shell_sticky_target_ms;
		if (sticky_ms > 0) {
			const uint32 new_sticky = static_cast<uint32>(id);
			if (sd->pop.sticky_target_id != new_sticky) {
			}
			sd->pop.sticky_target_id = new_sticky;
			sd->pop.sticky_until     = gettick() + static_cast<t_tick>(sticky_ms);
		}
	}

	pe.target_id = id;

	if (id == 0) {
		pe.path.clear();
		pe.path_index = 0;
		pe.path_last_calc_tick = 0;
	}

	if (id > 0) {
		pe.path.clear();
		pe.path_index = 0;
		pe.path_last_calc_tick = 0;

		block_list *bl_target = map_id2bl(pe.target_id);
		if (!bl_target || bl_target->type != BL_MOB)
			return;
		mob_data *md_target = (mob_data *)bl_target;
		switch (sd->status.weapon) {
		case W_BOW:
		case W_WHIP:
		case W_MUSICAL:
			population_shell_equip_best_arrow_for_target(sd, md_target);
			break;
		case W_REVOLVER:
		case W_RIFLE:
		case W_GATLING:
		case W_SHOTGUN:
		case W_GRENADE:
			population_shell_equip_best_bullet_for_target(sd, md_target);
			break;
		default:
			break;
		}
	}
}

bool population_shell_simple_find_nearest_mob_and_pathfind(map_session_data *sd, uint32 &out_mob_id, int &out_mob_x, int &out_mob_y)
{
	if (!sd)
		return false;

	t_tick current_tick = gettick();
	uint32 nearest_mob_id = 0;
	int nearest_mob_x = 0;
	int nearest_mob_y = 0;
	int nearest_dist_sq = INT_MAX;

	// Spatial scan within detection radius — avoids iterating every mob on the server.
	const int16 scan_cells = static_cast<int16>(
		battle_config.population_engine_shell_mdetection_cells > 0
		? battle_config.population_engine_shell_mdetection_cells : 30);

	struct FindCtx {
		map_session_data *sd;
		t_tick            tick;
		uint32            best_id;
		int               best_x, best_y, best_dist_sq;
	} ctx{ sd, current_tick, 0, 0, 0, INT_MAX };

	map_foreachinallrange(
		[](block_list *bl, va_list ap) -> int {
			FindCtx *c = va_arg(ap, FindCtx *);
			TBL_MOB *md = reinterpret_cast<TBL_MOB *>(bl);
			if (md->spawn_timer != INVALID_TIMER || md->status.hp <= 0)
				return 0;
			if (!population_shell_check_target_for_movement(c->sd, md->id))
				return 0;
			if (shell_is_target_excluded(c->sd, md->id, c->tick))
				return 0;
			int dx = md->x - c->sd->x;
			int dy = md->y - c->sd->y;
			int dist_sq = dx * dx + dy * dy;
			if (dist_sq < c->best_dist_sq) {
				c->best_dist_sq = dist_sq;
				c->best_id = md->id;
				c->best_x = md->x;
				c->best_y = md->y;
			}
			return 0;
		},
		sd, scan_cells, BL_MOB, &ctx);

	if (ctx.best_id > 0) {
		out_mob_id = ctx.best_id;
		out_mob_x = ctx.best_x;
		out_mob_y = ctx.best_y;
		return true;
	}
	return false;
}

void population_shell_update_mob_tracker(map_session_data *sd)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	t_tick current_tick = gettick();
	s_pe_mob_tracker &tracker = pe.mob_tracker;
	int32 scan_interval = battle_config.population_engine_shell_mobtracker_interval_ms > 0
		? battle_config.population_engine_shell_mobtracker_interval_ms
		: 1000;
	tracker.scan_interval = scan_interval;

	if (tracker.map_id != sd->m) {
		tracker.map_id = sd->m;
		tracker.tracked_mobs.clear();
		tracker.last_scan = 0;
	}
	if (DIFF_TICK(current_tick, tracker.last_scan) < tracker.scan_interval)
		return;
	tracker.last_scan = current_tick;

	// Spatial range scan: only mobs within detection radius on the same map.
	// Replaces the previous mapit_geteachmob() which walked EVERY mob on the server —
	// O(total_server_mobs) × N_bots × (1000ms / scan_interval) scans per second.
	// map_foreachinallrange is O(cells_in_radius²) and only touches this map's block grid.
	const int base_scan = battle_config.population_engine_shell_mdetection_cells > 0
		? battle_config.population_engine_shell_mdetection_cells : 30;
	// Movetype-3 shells scan a wider radius so the hotspot seeder can track mob
	// clusters beyond local detection range and seed A* navigation waypoints toward them.
	const int16 scan_cells = static_cast<int16>(std::min(base_scan * 2, 60));

	struct ScanCtx {
		std::unordered_set<uint32> *ids;
		s_pe_mob_tracker               *tracker;
		t_tick                       tick;
	} ctx{ nullptr, &tracker, current_tick };

	std::unordered_set<uint32> current_mob_ids;
	ctx.ids = &current_mob_ids;

	map_foreachinallrange(
		[](block_list *bl, va_list ap) -> int {
			ScanCtx *c = va_arg(ap, ScanCtx *);
			TBL_MOB *md = reinterpret_cast<TBL_MOB *>(bl);
			if (md->spawn_timer != INVALID_TIMER) return 0;
			if (md->status.hp <= 0)               return 0;
			if (md->sc.option & (OPTION_HIDE | OPTION_CLOAK)) return 0;
			if (md->special_state.ai)             return 0;

			c->ids->insert(md->id);
			auto &tracked          = c->tracker->tracked_mobs[md->id];
			tracked.mob_id         = md->id;
			tracked.mob_type_id    = md->mob_id;
			tracked.x              = md->x;
			tracked.y              = md->y;
			tracked.last_seen      = c->tick;
			tracked.hp             = md->status.hp;
			tracked.max_hp         = md->status.max_hp;
			tracked.target_id      = md->target_id;
			return 1;
		},
		sd, scan_cells, BL_MOB, &ctx);

	auto it_tracked = tracker.tracked_mobs.begin();
	while (it_tracked != tracker.tracked_mobs.end()) {
		if (current_mob_ids.find(it_tracked->first) == current_mob_ids.end())
			it_tracked = tracker.tracked_mobs.erase(it_tracked);
		else
			++it_tracked;
	}

	// Seed hotspots from tracked mob positions outside detection range so shells
	// have waypoints toward known mob clusters even when no mobs are visible locally.
	if (!tracker.tracked_mobs.empty()) {
		const int detection = battle_config.population_engine_shell_mdetection_cells > 0
			? battle_config.population_engine_shell_mdetection_cells : 30;
		const int detection_sq = detection * detection;
		auto &hotspots = sd->pop.type3_hotspots;
		const size_t HS_COUNT = hotspots.size();

		struct HSSeed { int x; int y; };
		HSSeed seeds[3]; int seed_count = 0;

		for (auto &[id, tmob] : tracker.tracked_mobs) {
			if (seed_count >= 3) break;
			const int dx = tmob.x - sd->x;
			const int dy = tmob.y - sd->y;
			if (dx * dx + dy * dy <= detection_sq) continue;
			bool too_close = false;
			for (int s = 0; s < seed_count; ++s) {
				const int sdx = tmob.x - seeds[s].x;
				const int sdy = tmob.y - seeds[s].y;
				if (sdx * sdx + sdy * sdy < 100) { too_close = true; break; }
			}
			if (!too_close) seeds[seed_count++] = {tmob.x, tmob.y};
		}

		for (int s = 0; s < seed_count; ++s) {
			const int sx = seeds[s].x, sy = seeds[s].y;
			int best_idx = -1, best_dist = INT_MAX, lowest_score_idx = 0;
			for (size_t i = 0; i < HS_COUNT; ++i) {
				auto &hs = hotspots[i];
				if (hs.score <= 0) { best_idx = static_cast<int>(i); break; }
				const int d = std::max(std::abs(hs.x - sx), std::abs(hs.y - sy));
				if (d < best_dist) { best_dist = d; best_idx = static_cast<int>(i); }
				if (hs.score < hotspots[lowest_score_idx].score) lowest_score_idx = static_cast<int>(i);
			}
			if (best_idx < 0) best_idx = lowest_score_idx;
			auto &slot = hotspots[best_idx];
			if (slot.score <= 0 || std::max(std::abs(slot.x - sx), std::abs(slot.y - sy)) <= 5 || slot.score < 3) {
				slot.x = sx; slot.y = sy;
				slot.score = slot.score > 0 ? std::min(slot.score + 1, 4) : 2;
				slot.last_seen_tick = current_tick;
			}
		}
	}
}

bool population_shell_has_valid_mobs_in_detection(map_session_data *sd)
{
	if (!sd)
		return false;
	const int det = battle_config.population_engine_shell_mdetection_cells;
	if (det <= 0)
		return false;
	population_shell_update_mob_tracker(sd);
	const t_tick now = gettick();
	s_pe_mob_tracker &tracker = sd->pop.mob_tracker;
	for (const auto &pair : tracker.tracked_mobs) {
		const s_pe_tracked_mob &tracked = pair.second;
		block_list *bl = map_id2bl(tracked.mob_id);
		if (!bl || bl->type != BL_MOB)
			continue;
		mob_data *md = (mob_data *)bl;
		if (md->m != sd->m || md->status.hp <= 0 || md->spawn_timer != INVALID_TIMER)
			continue;
		const int dx = md->x - sd->x;
		const int dy = md->y - sd->y;
		if (std::max(std::abs(dx), std::abs(dy)) > det)
			continue;
		if (shell_is_target_excluded(sd, tracked.mob_id, now))
			continue;
		if (!population_shell_check_target(sd, tracked.mob_id))
			continue;
		return true;
	}
	return false;
}

bool population_shell_movetype3_get_target(map_session_data *sd, int16 map_id, int16 player_x, int16 player_y,
	bool has_mobs_on_screen, int max_attempt, uint32 &out_mob_id, int &out_x, int &out_y)
{
	out_mob_id = 0;
	if (!sd)
		return false;

	if (!has_mobs_on_screen) {
		const int raw_max = battle_config.population_engine_shell_move_max > 0 ? battle_config.population_engine_shell_move_max : 20;
		const int min_distance = battle_config.population_engine_shell_move_min > 0 ? battle_config.population_engine_shell_move_min : 7;
		// Cap max distance to max_walk_path - 1 so unit_walktoxy never receives a target
		// it cannot path to purely due to step-count limit (Chebyshev dist == step count).
		const int max_distance = std::min(raw_max, battle_config.max_walk_path - 1);
		const int dir = unit_getdir(sd);
		const bool has_valid_dir = (dir >= DIR_NORTH && dir < DIR_MAX);

		// LOS-gated candidate check: path_search_long (Bresenham) confirms no wall
		// between shell and target. Cheaper than A* and guarantees unit_walktoxy succeeds
		// because a clear straight line means the walk path length <= Chebyshev distance.
		auto try_candidate = [&](int cx, int cy) -> bool {
			if (!map_getcell(map_id, cx, cy, CELL_CHKPASS))
				return false;
			if (map_getcell(map_id, cx, cy, CELL_CHKNPC))
				return false;
			if (!path_search_long(nullptr, map_id,
				static_cast<int16>(player_x), static_cast<int16>(player_y),
				static_cast<int16>(cx), static_cast<int16>(cy), CELL_CHKNOPASS))
				return false;
			out_x = cx;
			out_y = cy;
			return true;
		};

		auto wrap_dir = [](int d) -> int {
			while (d < 0)
				d += DIR_MAX;
			while (d >= DIR_MAX)
				d -= DIR_MAX;
			return d;
		};

		std::vector<int> preferred_dirs;
		preferred_dirs.reserve(DIR_MAX);
		if (has_valid_dir) {
			preferred_dirs.push_back(dir);
			for (int delta = 1; delta < DIR_MAX; ++delta) {
				preferred_dirs.push_back(wrap_dir(dir - delta));
				preferred_dirs.push_back(wrap_dir(dir + delta));
				if (preferred_dirs.size() >= static_cast<size_t>(DIR_MAX))
					break;
			}
		} else {
			for (int d = DIR_NORTH; d < DIR_MAX; ++d)
				preferred_dirs.push_back(d);
		}

		// Interleave all directions at each distance so attempts aren't exhausted
		// on the forward direction alone when it's walled off at long range.
		int attempts_left = std::max(1, max_attempt);
		for (int dist = max_distance; dist >= min_distance && attempts_left > 0; --dist) {
			for (int use_dir : preferred_dirs) {
				int test_x = player_x + dirx[use_dir] * dist;
				int test_y = player_y + diry[use_dir] * dist;
				if (try_candidate(test_x, test_y))
					return true;
				if (--attempts_left <= 0)
					break;
			}
		}

		const int short_step_max = std::min(3, std::max(1, max_distance));
		for (int use_dir : preferred_dirs) {
			for (int dist = short_step_max; dist >= 1; --dist) {
				int step_x = player_x + dirx[use_dir] * dist;
				int step_y = player_y + diry[use_dir] * dist;
				if (try_candidate(step_x, step_y))
					return true;
			}
		}
		return false;
	}

	population_shell_update_mob_tracker(sd);

	uint32 nearest_mob_id = 0;
	int nearest_dist_sq = INT_MAX;
	block_list *nearest_bl = nullptr;
	const t_tick now = gettick();

	for (const auto &tracked_pair : sd->pop.mob_tracker.tracked_mobs) {
		const s_pe_tracked_mob &tracked = tracked_pair.second;
		block_list *bl = map_id2bl(tracked.mob_id);
		if (!bl || bl->type != BL_MOB)
			continue;

		mob_data *md = (mob_data *)bl;
		if (md->status.hp <= 0 || md->spawn_timer != INVALID_TIMER)
			continue;
		if (battle_check_target(sd, bl, BCT_ENEMY) <= 0)
			continue;
		if (!unit_can_attack(sd, tracked.mob_id))
			continue;
		if (battle_config.ksprotection && mob_ksprotected(sd, bl))
			continue;
		if (!population_shell_check_target(sd, tracked.mob_id))
			continue;
		if (shell_is_target_excluded(sd, tracked.mob_id, now))
			continue;

		int dx = md->x - player_x;
		int dy = md->y - player_y;
		int dist_sq = dx * dx + dy * dy;
		if (dist_sq < nearest_dist_sq) {
			nearest_dist_sq = dist_sq;
			nearest_mob_id = tracked.mob_id;
			nearest_bl = bl;
		}
	}

	if (nearest_mob_id > 0 && nearest_bl) {
		out_mob_id = nearest_mob_id;
		out_x = nearest_bl->x;
		out_y = nearest_bl->y;
		return true;
	}

	return false;
}

void population_shell_safe_displaymessage_id(map_session_data *sd, int msg_id)
{
	if (!sd || !shell_has_real_session(sd))
		return;
	clif_displaymessage(sd->fd, msg_txt(sd, msg_id));
}

void population_shell_safe_updatestatus(map_session_data *sd, _sp type)
{
	if (!sd || !shell_has_real_session(sd))
		return;
	clif_updatestatus(*sd, type);
}

void population_shell_send_message_id(map_session_data *sd, const char *type, int msg_id, int delay, void *target)
{
	(void)delay;
	(void)target;
	if (!sd || !type)
		return;
	population_shell_safe_displaymessage_id(sd, msg_id);
}

void population_shell_status_checkmapchange(map_session_data *sd)
{
	if (!sd)
		return;
	s_population &pe = sd->pop;
	if (sd->mapindex != pe.lastposition.map) {
		if (sd->state.autotrade) {
			pc_delinvincibletimer(sd);
			clif_parse_LoadEndAck(0, sd);
		}
		pe.lastposition.map = sd->mapindex;
		pe.lastposition.x = sd->x;
		pe.lastposition.y = sd->y;
		// Clear persist-direction vector so movetype1 doesn't resume old heading after warp.
		pe.lastposition.dx = 0;
		pe.lastposition.dy = 0;
		pe.target_id = 0;
		pe.path.clear();
		pe.path_index = 0;
		pe.session_guard = pe.session_guard + 1;
		pe.detection_cache.cached_monsters.clear();
		pe.detection_cache.cached_items.clear();
		pe.detection_cache.last_update = 0;
		pe.mobs.map = sd->mapindex;
		pe.last_teleport = gettick();
	}
}

bool population_shell_try_attack(map_session_data *sd, uint32 target_id, uint16 skill_id, uint16 skill_lv)
{
	if (!sd || !target_id)
		return false;
	block_list *target_bl = map_id2bl(target_id);
	if (!target_bl)
		return false;
	if (!population_shell_check_target(sd, target_id))
		return false;
	mob_data *md_target = map_id2md(target_id);
	if (!md_target) {
		return false;
	}

	s_population &pe = sd->pop;
	const t_tick now = gettick();

	if (skill_id > 0) {
		if (skill_isNotOk(skill_id, *sd)) {
			pe.attack_fail_count++;
			if (pe.attack_fail_count >= PE_SHELL_ATTACK_FAIL_CLEAR_COUNT) {
				shell_add_cleared_target_to_exclusion(sd, target_id, now);
				population_shell_target_change(sd, 0);
				pe.last_skill_fail = 0;
				pe.last_failed_target = 0;
			}
			return false;
		}
		uint16 player_skill_lv = pc_checkskill(sd, skill_id);
		if (player_skill_lv < skill_lv) {
			pe.attack_fail_count++;
			return false;
		}
		int sp_cost = skill_get_sp(skill_id, skill_lv);
		if (sp_cost > sd->status.sp) {
			pe.attack_fail_count++;
			return false;
		}

		int skill_range = skill_get_range2(sd, skill_id, skill_lv, true);
		if (skill_range <= 0)
			skill_range = 14;

		// MO_BODYRELOCATION (Snap) is a gap-closer: bypass the standard range/path
		// gates and snap the shell toward the target.  unit_skilluse_pos with a
		// position scaled to within snap_range always passes the engine range check.
		const bool snap_mode = (skill_id == MO_BODYRELOCATION);

		bool in_range = snap_mode || check_distance_bl(sd, target_bl, skill_range);
		bool path_ok  = snap_mode || path_search_long(nullptr, sd->m, sd->x, sd->y, md_target->x, md_target->y, CELL_CHKWALL);
		if (!in_range || !path_ok) {
			if (shell_try_walktobl_command(sd, target_bl, skill_range, 1, MovementOwner::Combat, "population_shell:skill_approach"))
				return true;
			return false;
		}

		bool skill_used = false;
		if (snap_mode) {
			// Snap toward target.  Scale to at most skill_range Chebyshev steps so
			// the engine range check inside unit_skilluse_pos always passes.
			const int dx = md_target->x - sd->x;
			const int dy = md_target->y - sd->y;
			const int max_comp = std::max(std::abs(dx), std::abs(dy));
			if (max_comp <= PE_SHELL_ATTACK_APPROACH_CELLS) {
				return false; // already adjacent — no need to snap
			}
			int16_t snap_x, snap_y;
			if (max_comp <= skill_range) {
				snap_x = md_target->x;
				snap_y = md_target->y;
			} else {
				snap_x = (int16_t)(sd->x + dx * skill_range / max_comp);
				snap_y = (int16_t)(sd->y + dy * skill_range / max_comp);
			}
			// MO_BODYRELOCATION costs 1 spirit sphere; shells don't maintain them
			// passively, so add one before each cast (interval long enough to outlast
			// the cooldown — the cast itself will consume it).
			if (sd->spiritball < 1) {
				pc_addspiritball(sd, 300000, 5);
			}
			skill_used = unit_skilluse_pos(sd, snap_x, snap_y, skill_id, skill_lv);
		} else if (skill_get_inf(skill_id) & INF_ATTACK_SKILL)
			skill_used = unit_skilluse_id(sd, target_id, skill_id, skill_lv);
		else if (skill_get_inf(skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
			// Look up around_range and around_target from the shell's attack skill list.
			uint8_t around_r = 0;
			bool    around_tgt = false;
			for (const auto &cs : sd->pop.attack_skills)
				if (cs.skill_id == skill_id) { around_r = cs.around_range; around_tgt = cs.around_target; break; }
			int16_t tx = md_target->x, ty = md_target->y;
			// around_target=false (default, mob_skill_db around1-4): randomise around self.
			// around_target=true  (mob_skill_db around5-8): randomise around enemy — keep tx/ty.
			if (around_r > 0 && !around_tgt) { tx = sd->x; ty = sd->y; }
			population_shell_resolve_placement(sd, around_r, tx, ty);
			skill_used = unit_skilluse_pos(sd, tx, ty, skill_id, skill_lv);
		} else if (skill_get_inf(skill_id) & INF_SELF_SKILL) {
			// Self-skills (CALLSPIRITS, buffs) cast unconditionally — no proximity
			// requirement.  The shell does not need to stand next to its enemy to
			// buff itself.
			skill_used = unit_skilluse_id(sd, sd->id, skill_id, skill_lv);
		} else {
			skill_used = unit_skilluse_id(sd, target_id, skill_id, skill_lv);
		}

		if (!skill_used && sd->ud.stepaction && sd->ud.stepskill_id == skill_id)
			skill_used = true;

		if (skill_used) {
			t_tick last_tick = now;
			t_tick skill_delay = skill_get_delay(skill_id, skill_lv);
			t_tick cast_time = skill_get_cast(skill_id, skill_lv);
			int min_delay = battle_config.population_engine_shell_attack_skill_delay_ms;
			if (min_delay > 0 && skill_delay < min_delay)
				pe.skill_cd = last_tick + min_delay + cast_time;
			else
				pe.skill_cd = last_tick + skill_delay + cast_time;
			pe.last_attack = last_tick;
			pe.attack_fail_count = 0;
			sd->pop.last_cast_skill_id = skill_id; // AfterSkill condition tracking
		} else {
			pe.attack_fail_count++;
			if (pe.attack_fail_count >= PE_SHELL_ATTACK_FAIL_CLEAR_COUNT) {
				shell_add_cleared_target_to_exclusion(sd, target_id, now);
				population_shell_target_change(sd, 0);
				pe.last_skill_fail = 0;
				pe.last_failed_target = 0;
				return false;
			}
			if (pe.last_failed_target == target_id && pe.last_skill_fail > 0 &&
				DIFF_TICK(now, pe.last_skill_fail) < PE_SHELL_SKILL_FAIL_CLEAR_TARGET_MS) {
				shell_add_cleared_target_to_exclusion(sd, target_id, now);
				population_shell_target_change(sd, 0);
				pe.last_skill_fail = 0;
				pe.last_failed_target = 0;
				return false;
			}
			pe.last_skill_fail = now;
			pe.last_failed_target = target_id;
		}
		return skill_used;
	}

	status_data *sstatus = status_get_status_data(*sd);
	int32 range = sstatus->rhw.range;
	if (!check_distance_client_bl(sd, target_bl, range)) {
		if (shell_try_walktobl_command(sd, target_bl, range, 1, MovementOwner::Combat, "population_shell:melee_approach"))
			return true;
		return false;
	}
	if (unit_attack((block_list *)sd, target_id, 1) != 0) {
		pe.last_attack = gettick();
		pe.attack_fail_count = 0;
		return true;
	}
	pe.attack_fail_count++;
	return false;
}

// ============================================================
// Arena PvP helpers
// ============================================================
// Arena helpers — shells (pop.arena_team > 0) target real players.
// ============================================================

bool population_shell_check_arena_target(map_session_data *sd, unsigned int id)
{
	if (!sd || id == 0 || sd->pop.arena_team == 0)
		return false;
	block_list *bl = map_id2bl(id);
	if (!bl || bl->m != sd->m)
		return false;
	if (status_isdead(*bl))
		return false;
	if (sd->pop.arena_team == 2) {
		// Allied shells (team 2) target enemy arena shells (team 1).
		map_session_data *opp = BL_CAST(BL_PC, bl);
		if (!opp || !population_engine_is_population_pc(id))
			return false;
		if (opp->pop.arena_team != 1)
			return false;
	} else {
		// Enemy shells (team 1) target real (non-shell) players.
		if (!BL_CAST(BL_PC, bl))
			return false;
		if (population_engine_is_population_pc(id))
			return false;
	}
	if (!path_search_long(nullptr, sd->m, sd->x, sd->y, bl->x, bl->y, CELL_CHKWALL))
		return false;
	if (distance_bl((block_list *)sd, bl) > AREA_SIZE)
		return false;
	return true;
}

namespace {
struct ArenaOpponentCtx {
	map_session_data *attacker;
	unsigned int best_id = 0;
	int best_dist = INT_MAX;
};

// Callback for team-1 shells: finds the nearest real (non-shell) player.
static int32 arena_opponent_scan_cb(block_list *bl, va_list ap)
{
	map_session_data *opp = BL_CAST(BL_PC, bl);
	if (!opp)
		return 0;
	ArenaOpponentCtx *ctx = va_arg(ap, ArenaOpponentCtx*);
	if (population_engine_is_population_pc(bl->id))
		return 0;
	if (status_isdead(*bl))
		return 0;
	const int dist = distance_bl((block_list *)ctx->attacker, bl);
	if (dist < ctx->best_dist) {
		ctx->best_dist = dist;
		ctx->best_id   = bl->id;
	}
	return 0;
}

// Callback for team-2 shells: finds the nearest team-1 (enemy) arena shell.
static int32 arena_allied_scan_cb(block_list *bl, va_list ap)
{
	map_session_data *opp = BL_CAST(BL_PC, bl);
	if (!opp)
		return 0;
	ArenaOpponentCtx *ctx = va_arg(ap, ArenaOpponentCtx*);
	if (!population_engine_is_population_pc(bl->id))
		return 0;
	if (opp->pop.arena_team != 1)
		return 0;
	if (status_isdead(*bl))
		return 0;
	const int dist = distance_bl((block_list *)ctx->attacker, bl);
	if (dist < ctx->best_dist) {
		ctx->best_dist = dist;
		ctx->best_id   = bl->id;
	}
	return 0;
}
} // namespace

unsigned int population_shell_find_arena_opponent(map_session_data *sd)
{
	if (!sd || sd->pop.arena_team == 0)
		return 0;
	const int det = battle_config.population_engine_shell_mdetection_cells > 0
		? battle_config.population_engine_shell_mdetection_cells : 30;
	ArenaOpponentCtx ctx;
	ctx.attacker = sd;
	if (sd->pop.arena_team == 2)
		map_foreachinrange(arena_allied_scan_cb, sd, det, BL_PC, &ctx);
	else
		map_foreachinrange(arena_opponent_scan_cb, sd, det, BL_PC, &ctx);
	return ctx.best_id;
}

bool population_shell_try_arena_attack(map_session_data *sd, uint32 target_id, uint16 skill_id, uint16 skill_lv)
{
	if (!sd || !target_id || sd->pop.arena_team == 0)
		return false;
	block_list *target_bl = map_id2bl(target_id);
	if (!target_bl)
		return false;
	if (!population_shell_check_arena_target(sd, target_id))
		return false;

	s_population &pe = sd->pop;
	const t_tick now = gettick();

	if (skill_id > 0) {
		if (skill_isNotOk(skill_id, *sd)) {
			pe.attack_fail_count++;
			return false;
		}
		uint16 player_skill_lv = pc_checkskill(sd, skill_id);
		if (player_skill_lv < skill_lv) {
			pe.attack_fail_count++;
			return false;
		}
		int sp_cost = skill_get_sp(skill_id, skill_lv);
		if (sp_cost > sd->status.sp) {
			pe.attack_fail_count++;
			return false;
		}

		int skill_range = skill_get_range2(sd, skill_id, skill_lv, true);
		if (skill_range <= 0) skill_range = 14;

		const bool snap_mode = (skill_id == MO_BODYRELOCATION);

		bool in_range = snap_mode || check_distance_bl(sd, target_bl, skill_range);
		bool path_ok  = snap_mode || path_search_long(nullptr, sd->m, sd->x, sd->y, target_bl->x, target_bl->y, CELL_CHKWALL);
		if (!in_range || !path_ok) {
			if (shell_try_walktobl_command(sd, target_bl, skill_range, 1, MovementOwner::Combat, "population_shell:arena_skill_approach"))
				return true;
			return false;
		}

		bool skill_used = false;
		if (snap_mode) {
			const int dx = target_bl->x - sd->x;
			const int dy = target_bl->y - sd->y;
			const int max_comp = std::max(std::abs(dx), std::abs(dy));
			if (max_comp <= PE_SHELL_ATTACK_APPROACH_CELLS) {
				return false;
			}
			int16_t snap_x, snap_y;
			if (max_comp <= skill_range) {
				snap_x = static_cast<int16_t>(target_bl->x);
				snap_y = static_cast<int16_t>(target_bl->y);
			} else {
				snap_x = static_cast<int16_t>(sd->x + dx * skill_range / max_comp);
				snap_y = static_cast<int16_t>(sd->y + dy * skill_range / max_comp);
			}
			if (sd->spiritball < 1) {
				pc_addspiritball(sd, 300000, 5);
			}
			skill_used = unit_skilluse_pos(sd, snap_x, snap_y, skill_id, skill_lv);
		} else if (skill_get_inf(skill_id) & INF_ATTACK_SKILL)
			skill_used = unit_skilluse_id(sd, target_id, skill_id, skill_lv);
		else if (skill_get_inf(skill_id) & (INF_GROUND_SKILL | INF_TRAP_SKILL)) {
			uint8_t around_r = 0;
			bool    around_tgt = false;
			for (const auto &cs : sd->pop.attack_skills)
				if (cs.skill_id == skill_id) { around_r = cs.around_range; around_tgt = cs.around_target; break; }
			int16_t tx = static_cast<short>(target_bl->x), ty = static_cast<short>(target_bl->y);
			if (around_r > 0 && !around_tgt) { tx = sd->x; ty = sd->y; }
			population_shell_resolve_placement(sd, around_r, tx, ty);
			skill_used = unit_skilluse_pos(sd, tx, ty, skill_id, skill_lv);
		} else if (skill_get_inf(skill_id) & INF_SELF_SKILL) {
			// Self-skills (CALLSPIRITS, buffs) cast unconditionally — no proximity
			// requirement.  The shell does not need to stand next to its enemy to
			// buff itself.
			skill_used = unit_skilluse_id(sd, sd->id, skill_id, skill_lv);
		} else {
			skill_used = unit_skilluse_id(sd, target_id, skill_id, skill_lv);
		}

		if (!skill_used && sd->ud.stepaction && sd->ud.stepskill_id == skill_id)
			skill_used = true;

		if (skill_used) {
			t_tick last_tick = now;
			t_tick skill_delay = skill_get_delay(skill_id, skill_lv);
			t_tick cast_time   = skill_get_cast(skill_id, skill_lv);
			int min_delay = battle_config.population_engine_shell_attack_skill_delay_ms;
			if (min_delay > 0 && skill_delay < min_delay)
				pe.skill_cd = last_tick + min_delay + cast_time;
			else
				pe.skill_cd = last_tick + skill_delay + cast_time;
			pe.last_attack    = last_tick;
			pe.attack_fail_count = 0;
		} else {
			pe.attack_fail_count++;
		}
		return skill_used;
	}

	// Basic melee/ranged attack.
	status_data *sstatus = status_get_status_data(*sd);
	int32 range = sstatus->rhw.range;
	if (!check_distance_client_bl(sd, target_bl, range)) {
		if (shell_try_walktobl_command(sd, target_bl, range, 1, MovementOwner::Combat, "population_shell:arena_melee_approach"))
			return true;
		return false;
	}
	if (unit_attack((block_list *)sd, target_id, 1) != 0) {
		pe.last_attack = gettick();
		pe.attack_fail_count = 0;
		return true;
	}
	pe.attack_fail_count++;
	return false;
}

bool population_shell_try_approach_combat_target(map_session_data *sd, uint32 target_id)
{
	if (!sd || !target_id)
		return false;
	block_list *bl = map_id2bl(target_id);
	if (!bl)
		return false;
	if (!population_shell_check_target_for_movement(sd, target_id))
		return false;
	if (population_shell_check_target(sd, target_id))
		return false;

	int32 area = battle_config.area_size;
	if (area < 2)
		area = 14;
	int32 approach_cells = area - 1;
	if (sd->pop.max_attack_skill_range > 0)
		approach_cells = std::min(approach_cells, std::max<int32>(sd->pop.max_attack_skill_range, 1));

	// PAI::KiteRanged — ranged shells maintain max skill range instead of closing to melee.
	// When they're already within skill range, don't approach further.
	if ((battle_config.population_engine_ai & PAI::KiteRanged) &&
	    sd->pop.max_attack_skill_range >= 4 &&
	    check_distance_bl(sd, bl, sd->pop.max_attack_skill_range)) {
		return false; // Already in range — stop approaching.
	}

	s_population &pe = sd->pop;
	if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "population_shell:approach_target"))
		return false;
	if (unit_walktobl(sd, bl, approach_cells, 1)) {
		pe.last_move = gettick();
		return true;
	}
	pe.movement_emitted_this_tick = false;
	pe.owner_noop_count++;
	return false;
}
