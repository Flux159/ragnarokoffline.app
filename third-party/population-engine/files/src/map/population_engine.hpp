// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Population engine: main public API (implementation in population_engine.cpp).

#ifndef POPULATION_ENGINE_HPP
#define POPULATION_ENGINE_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

class map_session_data;

struct PopulationEngine;

/// Equipment YAML row for `sd->status.class_`, else same row for engine base-job fallback.
const PopulationEngine *population_engine_resolve_equipment(uint16_t job_id);
/// Swordman/Mage/… first class for `job_id` (same mapping as population spawn fallback).
uint16_t population_engine_job_base_class(uint16_t job_id);

struct PopulationEngineConfig {
	uint32_t num_units = 0;
	int16_t map_id = 0;
	int spawn_x = 0;
	int spawn_y = 0;
	bool spread_units = true;
};

struct PopulationEngineStats {
	uint32_t total_created = 0;
	uint32_t active_units = 0;
	uint32_t errors = 0;
	std::vector<int32_t> unit_ids;
	// Runtime metrics (accumulated since last engine start / reset).
	uint32_t chat_lines_emitted = 0;  ///< Ambient + reply chat lines sent.
	uint32_t name_retries = 0;        ///< Blocklist retries across all spawns.
	uint32_t walk_failures = 0;       ///< unit_walktoxy failures in wander timer.
};

void do_init_population_engine();
/// Load population_names.yml and population_engine.yml. Call after do_init_itemdb and do_init_pc (job_db + item_db).
/// Starts autosummon / chat / wander timers per `conf/battle/population_engine.conf`.
void do_init_population_engine_load_databases();
void do_final_population_engine();
/// Reload db/population_engine.yml and db/population_chat.yml. Returns false if equipment YAML could not be read/parsed.
/// If out_entry_count is non-null, set to the number of job profiles after reload (0 if strict mode discarded all).
bool population_engine_reload_equipment(uint32_t *out_entry_count = nullptr);
bool population_engine_start(const PopulationEngineConfig &config, PopulationEngineStats &stats);
void population_engine_stop();
PopulationEngineStats population_engine_get_stats();
bool population_engine_is_running();
bool population_engine_is_population_pc(int32_t id);
/// RAGNAROKMAC: true when a real (non-shell) player is standing on this map, or
/// when demand-driven population is off and every map counts as live.
bool population_engine_map_has_real_players(int16_t m);
/// Returns true if the shell has PSF::Mortal set (will take damage; default is immortal).
bool population_engine_shell_is_mortal(const map_session_data *sd);
/// Called from pc_dead when a mortal population shell reaches 0 HP. Schedules a respawn.
void population_engine_on_shell_death(map_session_data *sd);
/// Called from pc_damage whenever a population shell receives damage. Records gettick() and the
/// attacker id on sd->pop so reactive conditions (SelfTargeted, etc.) can detect non-mob attackers
/// (real PvP players, traps, etc.).
void population_engine_on_shell_damaged(map_session_data *sd, struct block_list *src);
/// Called after a population shell kills a real (non-shell) player. Shell may trash-talk.
void population_engine_on_shell_kills_player(map_session_data *killer_sd, map_session_data *victim_sd);
size_t population_engine_get_count();
/// Stop combat mode for a population shell (teardown hat effect, cleanup, set state=false).
/// Safe to call even if not in combat. Used by clif quit/restart paths.
void population_engine_combat_shell_stop(map_session_data *sd);
/// Whisper to a population PC: send one random chat line back to the sender (no fake-client packet).
void population_engine_on_whisper_to_population_pc(map_session_data *from_sd, map_session_data *bot_sd, const char *message);
/// Map chat: any population PC on the same map whose name appears in `message` (case-insensitive) may reply overhead.
void population_engine_on_global_chat_mention(map_session_data *from_sd, const char *message);

/// Arena PvP: spawn `shell_count` shells on `map_name` (must be a PvP map).
/// Shells target real (non-shell) players on the map so a player can observe AI behaviour.
/// Optional spawn_x/spawn_y set the spawn-center; 0 = random spread.
/// map_search_freecell validates walkability so shells never appear on blocked cells.
/// Optional job_override forces every shell to use that JOB_ id (0 = use ArenaJobPool / built-in mix).
/// team_id: 1 = enemy shells (target real players), 2 = allied shells (target team-1 shells).
/// Returns total shells spawned (0 on error).
int  population_engine_arena_start(const char* map_name, int shell_count,
                                   int spawn_x = 0, int spawn_y = 0,
                                   uint16_t job_override = 0, int team_id = 1);
/// Arena PvP: release all arena shells on `map_name`.
void population_engine_arena_stop(const char* map_name);

/// Arena PvP: returns the job-id pool used by population_engine_arena_start when
/// no explicit job_override is supplied. The pool is auto-derived from
/// db/population_pvp.yml entries (one entry per Profile.Jobs row).
std::vector<uint16_t> population_engine_arena_job_pool();

struct block_list;
/// Arena PvP: classify the relation between two block_list entities so that
/// `battle_check_target` can treat ally shells (team 2) as friendly to the
/// real player on the same map and to each other, and enemy shells (team 1)
/// as hostile to both. Returns:
///    +1 = allies (force BCT_PARTY, strip BCT_ENEMY)
///    -1 = enemies (force BCT_ENEMY)
///     0 = no opinion (caller falls through to normal party/guild logic)
/// Implementation lives in population_engine.cpp.
int population_engine_arena_relation(const block_list *s_bl, const block_list *t_bl);

/// Arena PvP: PC-only friendly check used by the population shell's own ally
/// target finder. Returns true when both PCs share the same effective arena
/// team on the same map (real player implicitly team 2). This is the standalone
/// hook used by the population engine's support behaviour — it does NOT touch
/// the autosupport subsystem.
bool population_engine_arena_is_ally(const map_session_data *a, const map_session_data *b);

#endif // POPULATION_ENGINE_HPP
