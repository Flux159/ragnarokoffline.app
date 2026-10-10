// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Population engine: main public API (implementation in population_engine.cpp).

#ifndef POPULATION_ENGINE_HPP
#define POPULATION_ENGINE_HPP

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

class map_session_data;

struct PopulationEngine;

/// Equipment YAML row for `sd->status.class_`, else same row for engine base-job fallback.
const PopulationEngine *population_engine_resolve_equipment(uint16_t job_id);
/// Swordman/Mage/… first class for `job_id` (same mapping as population spawn fallback).
uint16_t population_engine_job_base_class(uint16_t job_id);
uint16_t population_engine_job_id_from_name(const char *name);
// RAGNAROKMAC: hired companions (population_engine_companion_hire).
int population_engine_job_tier(uint16_t job_id);
int population_engine_companion_hire_mode();
const char *population_engine_hire_job_name(uint16_t job_id);
std::vector<uint16_t> population_engine_companion_hire_jobs(map_session_data *owner);
int64_t population_engine_companion_hire_zeny(const map_session_data *owner);
uint32_t population_engine_companion_hire(map_session_data *owner, uint16_t job_id,
	const char *name_hint, bool from_npc, std::string &msg, char sex = '\0');
/// 'M' or 'F' for a job that is only ever one sex (Bard, Dancer, Kagerou...), else '\0'.
char population_engine_job_required_sex(uint16_t job_id);
void population_engine_companion_terms(map_session_data *owner, int fd);

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

/// Goal 1: snapshot a recruited companion so it survives a server restart. Called from the party.cpp recruit success branch (after the shell's party_id is set). `peer` is the inviting/invited peer resolved before party_invite_account was cleared — normally the recruiting player.
void population_engine_persist_recruited_companion(map_session_data *sd, map_session_data *peer = nullptr);
/// Goal 1: re-spawn an owner's persisted companions after login restores membership. Returns count recalled.
int population_engine_recall_companions(map_session_data *owner, uint32_t only_index = 0);
/// A real character is leaving the map server: save and despawn the companions it owns.
void population_engine_on_owner_quit(map_session_data *owner);
/// True when `shell` is a companion of exactly this character (account AND char id).
bool population_engine_companion_owned_by(const map_session_data *shell, const map_session_data *player);
void population_engine_reassert_companions(int32_t party_id);
bool population_engine_persist_companion_row(map_session_data *sd, const map_session_data *owner);
void population_engine_push_companion_list(map_session_data *owner);
void population_engine_push_companion_list_for_shell(map_session_data *shell);
/// Goal 3: flag a companion's persistence row active(1)/inactive(0).
void population_engine_set_companion_active(uint32_t owner_account, uint32_t index_, bool active);
/// Goal 3: mark a shell's persistence row inactive when it is EXPELLED from a party
/// (called from the party_member_withdraw map-side handler).
void population_engine_deactivate_expelled_companion(int32_t party_id, uint32_t account_id, uint32_t char_id);
/// Goal 3 friend list: toggle the favorite flag on a saved companion by name.
bool population_engine_companion_set_favorite(uint32_t owner_account, const char* name_, bool favorite);
/// Goal 3 friend list: find a saved companion by name; reports its index and active flag.
bool population_engine_companion_find(uint32_t owner_account, const char* name_,
	uint32_t* out_index, bool* out_active);
/// Phase 3c: can this JOB's granted skill tree give a companion the homunculus its class entitles
/// it to? The attach gate asks the live shell (`pc_checkskill`); the panel must answer the same
/// question for a BENCHED companion, so it asks the tree (`Inherit` is flattened at load).
bool population_engine_class_can_have_homunculus(uint16_t class_);
/// Phase 3c: the panel's per-companion pet switch. 1 = on, 0 = off, -1 = flip.
/// @return 1 when the state changed, 0 when it already was so, -1 when rejected (message in out_msg).
int population_engine_companion_set_homunculus(uint32_t owner_account, const char* name_, int want,
	char* out_msg, size_t out_msg_len);
/// Rebirth: the player's explicit choice for a maxed 2nd-class companion (never automatic, because
/// entering a transcendent class unequips gear the companion can no longer wear).
/// @param mode 0 = High Novice with a level reset to 1/1; 1 = straight to the transcendent class.
/// @return 1 on success, 0 when it is not ready yet, -1 when rejected (message in out_msg).
int population_engine_companion_rebirth(uint32_t owner_account, const char* name_, int mode,
	char* out_msg, size_t out_msg_len);
/// Goal 2: re-snapshot a summoned companion's current equipment + stats into its
/// persistence row (debounced by the caller). Called on shell equipment changes.
void population_engine_persist_companion_gear(map_session_data *sd);
/// Goal 2 trade: true when target is a summoned companion owned by player,
/// same map, within trade distance — eligible for auto-accepted trade.
bool population_engine_companion_can_trade_with(const map_session_data *player, const map_session_data *target);
/// Goal 2 trade: after items land in the companion's inventory, equip equipment
/// and return non-equipment items to the owner (companions are not mules).
void population_engine_companion_equip_traded(map_session_data *owner, map_session_data *shell);
/// Goal 2 trade: record the companion's inventory just before the trade's items move, so
/// population_engine_companion_equip_traded can tell what the trade brought in.
void population_engine_companion_trade_snapshot(map_session_data *shell);
/// Goal 2: unequip every worn item on the shell and hand each piece to the owner (or drop at feet when overweight). Returns count moved, -1 on bad args.
int population_engine_companion_return_gear(map_session_data *owner, map_session_data *shell, uint32_t slot_mask = 0);
int population_engine_companion_set_rest_thresholds(uint32_t owner_account, int16_t below, int16_t until);
int population_engine_companion_set_heal_thresholds(uint32_t owner_account, int16_t heal_at, int16_t emergency_at);
/// RAGNAROKMAC (roam): one companion (`name`) or all of them (empty) roam or follow; runtime/population_companion_roam.cpp.
int population_engine_companion_set_roam(uint32_t owner_account, const char *name, bool roam, char *out_msg, size_t out_msg_len);
/// Skill selector: replace one saved companion's skill choice.
///
/// @param owner_account  owner whose saved list to search
/// @param name_          the companion's name
/// @param spec           comma/space separated skill ids or names, or the
///                       literal "auto" to go back to the class preset list
/// @param out_msg        receives a human-readable result/why-not
/// @param out_msg_len    size of out_msg
/// @return number of skills selected, or -1 when the arguments were rejected.
///         "auto" reports 0 with a message, not an error.
int population_engine_companion_set_skill_override(uint32_t owner_account, const char* name_,
	const char* spec, char* out_msg, size_t out_msg_len);
/// Skill selector: list the skills this companion's CURRENT class may use, and
/// which of them are currently selected. Answered through the chat channel as
/// @CPSK|... lines so the panel never parses prose (see the @CP rule).
void population_engine_companion_skill_list(uint32_t owner_account, const char* name_, int fd);
/// Skill selector UI: flip one skill in a companion's selection.
/// `verb` is "toggle" (flip), "only" (select just this) or "all" (select every
/// legal skill); `skill_token` is an id or name, unused for "all".
/// @return the selected count, or -1 when rejected (message in out_msg).
int population_engine_companion_toggle_skill(uint32_t owner_account, const char* name_,
	const char* verb, const char* skill_token, char* out_msg, size_t out_msg_len);
/// Skill selector: split a stored/typed preset string into skill ids on `out`.
/// Accepts numeric ids and server skill names, comma and/or space separated.
/// Returns the number parsed (0 for an empty string). Whether that means "auto"
/// is the CALLER's call and depends on the column being NULL, not on the count:
/// NULL = never chosen (auto), empty string = a chosen empty selection.
size_t population_engine_companion_parse_skill_override(const char* stored,
	std::vector<uint16_t>& out);
/// RAGNAROKMAC: `sex` is 'M' or 'F' when the player chose one, '\0' to choose as an
/// ambient spawn does. A job with a sex of its own (Bard, Dancer...) keeps it either way.
uint32_t population_engine_companion_draft(map_session_data *owner, uint16_t job_id, int quality, const char *name_hint,
	char sex = '\0');
void population_engine_companion_list_raw(uint32_t owner_account, int fd);
/// Goal 3 friend list: print the owner's saved companions to their chat (fd = client fd).
void population_engine_companion_list(uint32_t owner_account, int fd);
/// Goal 3 friend list: permanently delete one saved companion's row, by shell index (irreversible).
bool population_engine_companion_delete(uint32_t owner_account, uint32_t shell_index);
/// Whether a saved companion's row records gear its owner gave it.
bool population_engine_companion_holds_given_gear(uint32_t owner_account, uint32_t shell_index);
/// True while this real player's party has fewer than four recruited companions.
bool population_engine_can_recruit_companion(const map_session_data *owner);
/// Return the real player who should receive a recruited companion's loot.
/// Only succeeds for an active owner in the same party and on the same map;
/// ambient population shells therefore never redirect their drops.
map_session_data *population_engine_companion_loot_owner(map_session_data *shell);
/// True for a population shell recruited into a party, wherever its owner is.
/// Party item sharing skips these: nobody can open a shell's inventory.
bool population_engine_is_recruited_companion(const map_session_data *sd);
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
/// Party chat command channel for recruited companions. Only the real party
/// leader can change party-wide engagement modes or named shell roles.
void population_engine_on_party_chat(map_session_data *from_sd, const char *message);

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

/// RAGNAROKMAC: set how many shells the mod vendors whose VendorKey starts with
/// `prefix` keep in total, split across their Spawns blocks by their YAML counts.
/// A negative total goes back to the YAML counts. Script: population_vendor_count.
void population_engine_set_mod_vendor_total(const char* prefix, int total);
/// RAGNAROKMAC: rotation in minutes (0 = never) for those vendors; script: population_vendor_rotation.
void population_engine_set_mod_vendor_rotation(const char* prefix, int minutes);
/// RAGNAROKMAC: callouts on/off and their pace for those vendors; script: population_vendor_callouts.
void population_engine_set_mod_vendor_callouts(const char* prefix, int on, int min_sec, int max_sec);
/// RAGNAROKMAC: whether those vendors wait for room under the population limit
/// (the default) or spawn anyway; script: population_vendor_limit.
void population_engine_set_mod_vendor_limit(const char* prefix, int respect);
/// RAGNAROKMAC: those vendors' price level in percent (100 = as listed);
/// script: population_vendor_price.
void population_engine_set_mod_vendor_price(const char* prefix, int pct);
/// RAGNAROKMAC: @vendorinfo [theme|market] -- inspect mod vendor stalls in game.
void population_engine_vendorinfo(map_session_data* sd, const char* arg);

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
// images rebuild trigger
