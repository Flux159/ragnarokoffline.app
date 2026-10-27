// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC: shell control API (runtime/population_shell_control.cpp).
#ifndef POPULATION_SHELL_CONTROL_HPP
#define POPULATION_SHELL_CONTROL_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

class map_session_data;

// Script commands: src/custom/script.inc (patch 0027).
// A shell a script holds is skipped by the engine's combat, wander, chat,
// whisper-reply and drift passes; the script moves it with stock unit*
// commands. Companions and vendors are never handed out.

/// What population_engine_shell_kind reports.
enum PopulationShellKind : int {
	POP_SHELL_NONE      = 0, ///< not a shell (a real player, or nothing)
	POP_SHELL_AMBIENT   = 1,
	POP_SHELL_VENDOR    = 2, ///< vending stall or buying store
	POP_SHELL_COMPANION = 3, ///< recruited into a real player's party
};
/// population_engine_find_shells flags; with none, only live, free, ambient shells.
enum PopulationShellFindFlag : int {
	POP_FIND_VENDORS = 0x1,
	POP_FIND_HELD    = 0x2, ///< shells some script holds, the caller's own included
	POP_FIND_DEAD    = 0x4,
};
/// population_engine_shell_spawn flags.
enum PopulationShellSpawnFlag : int {
	POP_SPAWN_KEEP = 0x1, ///< once released, stay as an ambient shell instead of logging out
};
/// population_engine_shell_despawn styles.
enum PopulationShellDespawnStyle : int {
	POP_DESPAWN_LOGOUT  = 0, ///< vanish, as a player logging out
	POP_DESPAWN_FLYWING = 1, ///< the client's teleport-out effect (fly wing, butterfly wing)
};
int  population_engine_shell_kind(int32_t gid);
/// True while a script holds this shell (and the hold has not lapsed).
bool population_engine_shell_is_held(const map_session_data *sd);
/// Unit ids of the shells within `range` cells of (x, y) on map `m`, nearest
/// first; range < 0 searches the whole map. Returns how many were found.
size_t population_engine_find_shells(int16_t m, int16_t x, int16_t y, int range, int flags,
	std::vector<int32_t> &out);
/// Hold a shell for `ms` milliseconds on behalf of NPC `npc_id`. Holding a shell
/// the same NPC already holds extends the hold. False when the shell is not an
/// ambient shell, or another NPC holds it.
bool population_engine_shell_hold(int32_t gid, int32_t npc_id, int64_t ms);
/// Give a held shell back to the engine. Only the holding NPC may.
bool population_engine_shell_unhold(int32_t gid, int32_t npc_id);
/// Spawn one shell of `job` at (x, y) on `m`, held by `npc_id`. base_level <= 0 and
/// an empty name keep the job profile's own roll; sex is SEX_FEMALE, SEX_MALE or -1.
/// x = y = 0 picks a random cell. Returns the new shell's unit id, or 0.
int32_t population_engine_shell_spawn(int32_t npc_id, int16_t m, int16_t x, int16_t y,
	uint16_t job, int base_level, const char *name, int sex, int flags);
/// Take a shell out of the world on the next timer tick. Not for companions.
/// The engine's own call: a hold ending, whoever asked.
bool population_engine_shell_despawn(int32_t gid, int style);
/// population_despawn: the same, for NPC `npc_id`, which may remove only a shell
/// it holds or a free ambient one -- never a vendor (a player may be trading at
/// its stall) or a shell another NPC holds for its own scene.
bool population_engine_shell_despawn_for(int32_t gid, int32_t npc_id, int style);
/// While NPC `npc_id` holds the shell, a whisper to it runs `event` ("<npc>::<label>")
/// with the whisperer attached, instead of the canned reply. Empty clears it.
bool population_engine_shell_set_whisper_event(int32_t gid, int32_t npc_id, const char *event);
/// While NPC `npc_id` holds the shell, run `event` with the followed player attached
/// when the shell loses whoever it follows (pcfollow): @shell_gid, @shell_lost
/// (1 teleported, 2 left the map, 3 portal not reached, 4 out of reach). Empty clears it.
bool population_engine_shell_set_lost_event(int32_t gid, int32_t npc_id, const char *event);

// The engine's calls into it.

/// From the combat timer, before its stale sweep: finishes held shells' warps,
/// runs their follows and attack orders, and ends lapsed holds.
void population_shell_control_sweep();
/// From the stale collection, which the wander timer runs as well as the combat
/// timer: finishes a held shell's script warp before the sweep would, so a shell
/// still off the map grid is not released as stale.
void population_shell_control_place_held(map_session_data *sd);
/// From the whisper handler: true when the shell is held, and its script (or
/// nobody) has answered; false lets the engine answer as usual.
bool population_shell_control_whisper(map_session_data *from_sd, map_session_data *bot_sd, const char *message);

#endif // POPULATION_SHELL_CONTROL_HPP
