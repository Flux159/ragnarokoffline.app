// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell runtime helpers (map main thread only).
#pragma once

#include <common/cbasetypes.hpp>
#include <common/timer.hpp>

#include <cstdint>
#include <tuple>
#include <vector>

#include "../../pc.hpp"

void population_shell_reset_movement_tick_state(map_session_data *sd, t_tick current_tick);
bool population_shell_can_emit_movement(map_session_data *sd, MovementOwner owner, const char *source);

void population_shell_cleanup_expired_buffs(map_session_data *sd, t_tick current_tick);
bool population_shell_autoshadowspell_autoselect(map_session_data *sd);

int population_shell_move_to_path(std::vector<std::tuple<int, int>> &path, map_session_data *sd, int recursion_depth = 0);
bool population_shell_status_check_reset(map_session_data *sd, t_tick last_tick);

bool population_shell_check_target(map_session_data *sd, unsigned int id);
bool population_shell_check_target_for_movement(map_session_data *sd, unsigned int id);
unsigned int population_shell_check_target_alive(map_session_data *sd);

bool population_shell_simple_find_nearest_mob_and_pathfind(map_session_data *sd, uint32 &out_mob_id, int &out_mob_x, int &out_mob_y);
/// Walk toward a mob that is valid to chase but not yet in attack/skill range (client sight).
bool population_shell_try_approach_combat_target(map_session_data *sd, uint32 target_id);
void population_shell_target_change(map_session_data *sd, int id);

void population_shell_update_mob_tracker(map_session_data *sd);
/// True if any mob within mdetection_cells passes full combat target checks (autocombat-style "valid in range").
bool population_shell_has_valid_mobs_in_detection(map_session_data *sd);
/// Movetype 3 (autocombat ASTAR_ASYNC): path-validated forward roam when `has_valid_mobs_in_detection` is false;
/// else nearest valid mob from tracker. On success: either `out_mob_id` set (chase) or `out_x`/`out_y` (forward step).
bool population_shell_movetype3_get_target(map_session_data *sd, int16 map_id, int16 player_x, int16 player_y,
	bool has_valid_mobs_in_detection, int max_pathfind_attempt, uint32 &out_mob_id, int &out_x, int &out_y);
void population_shell_safe_displaymessage_id(map_session_data *sd, int msg_id);
void population_shell_safe_updatestatus(map_session_data *sd, _sp type);
void population_shell_send_message_id(map_session_data *sd, const char *type, int msg_id, int delay, void *target);

void population_shell_status_checkmapchange(map_session_data *sd);

/// Skill or melee vs mob target (minimal antispam vs. AttackCommand).
bool population_shell_try_attack(map_session_data *sd, uint32 target_id, uint16 skill_id, uint16 skill_lv);

/// Arena PvP: check that `id` is a valid, living, opposing-team arena shell on the same map.
bool population_shell_check_arena_target(map_session_data *sd, unsigned int id);
/// Arena PvP: find the nearest living opposing-team arena shell within detection range. Returns 0 if none.
unsigned int population_shell_find_arena_opponent(map_session_data *sd);
/// Arena PvP: basic attack or skill attack against a PC target (bypasses mob-only checks).
bool population_shell_try_arena_attack(map_session_data *sd, uint32 target_id, uint16 skill_id, uint16 skill_lv);

/// Compute a placement position for ground/trap skills.
/// When around_range > 0, picks a random passable cell within that radius of the shell's
/// own position (mirrors mob_skill_db around2/around3 behaviour).  Falls back to the
/// provided base (x, y) when around_range == 0 or no passable cell is found.
void population_shell_resolve_placement(const map_session_data *sd, uint8_t around_range, int16_t &x, int16_t &y);
