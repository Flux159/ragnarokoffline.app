// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (roam): see population_companion_roam.hpp.
//
// Not a translation unit of its own: population_engine.cpp includes it at its end, as it
// does population_shell_control.cpp, so it reaches the engine's own helpers
// (pop_is_companion, pop_online_char, pop_companion_owner_session) and the combat file's
// roam step. The setting is the row's `roam` column (v14); this file reads and writes it
// itself, so the engine's save and recall statements stay as they were.

bool population_companion_roams(const map_session_data *sd)
{
	// Settings -> Population -> Companion roaming. Off, a companion saved as roaming follows; its
	// row keeps the choice for when the setting is on again.
	return battle_config.population_engine_companion_roam && sd != nullptr && sd->pop.companion_roam
		&& pop_is_companion(sd);
}

uint32 population_companion_roam_target(map_session_data *sd, uint32 desired)
{
	if (!population_companion_roams(sd))
		return desired;
	// Hunting waits for the end of a rest, as a field shell's does: a monster in sight is no
	// reason to get up, or a roamer on a busy field stood up seconds after every sit. Only
	// what hits it or a party member near it gets it up.
	const bool resting = sd->pop.resting;
	// Its own fight only: the owner's target, or a threat to the owner, may be anywhere on the map.
	if (desired != 0) {
		block_list *bl = map_id2bl(static_cast<int32>(desired));
		if (bl != nullptr && bl->m == sd->m && check_distance_bl(sd, bl, AREA_SIZE)
			&& (!resting || desired == sd->pop.last_attacker_id || desired == pop_companion_party_threat(sd)))
			return desired;
	}
	if (sd->pop.companion_mode != PopulationCompanionMode::Attack || resting)
		return 0;
	// Attack mode hunts as a field shell does: keep the monster it is on, else find one near itself.
	const uint32 current = static_cast<uint32>(sd->pop.target_id);
	if (current != 0) {
		block_list *bl = map_id2bl(static_cast<int32>(current));
		if (bl != nullptr && check_distance_bl(sd, bl, AREA_SIZE)
			&& (population_shell_check_target(sd, current) || population_shell_check_target_for_movement(sd, current)))
			return current;
	}
	return population_shell_check_target_alive(sd);
}

void population_companion_roam_step(map_session_data *sd, t_tick tick)
{
	if (!population_companion_roams(sd) || pc_issit(sd) || unit_is_walking(sd) || !unit_can_move(sd))
		return;
	// The field shells' throttle: an unreachable pick is not retried every tick.
	s_population &pe = sd->pop;
	if (pe.path_last_calc_tick > 0 && DIFF_TICK(tick, pe.path_last_calc_tick) < 750)
		return;
	pe.path_last_calc_tick = tick;
	// Forward roam first, which keeps a heading, then the random step; both are the field shells' own.
	uint32 mob = 0;
	int gx = 0, gy = 0;
	if (population_shell_movetype3_get_target(sd, sd->m, sd->x, sd->y, false,
			std::max(1, battle_config.population_engine_path_attempts), mob, gx, gy)
		&& population_shell_can_emit_movement(sd, MovementOwner::Roam, "companion:roam")) {
		if (unit_walktoxy(sd, gx, gy, 4) || unit_walktoxy(sd, gx, gy, 1)) {
			pe.last_move = tick;
			return;
		}
		pe.movement_emitted_this_tick = false;
	}
	population_shell_try_roam_step(sd);
}

/// Write the roam column: one row (`index_` != 0) or every row of the owner.
static void pop_companion_roam_save(uint32_t owner_account, uint32_t owner_char, uint32_t index_, bool roam)
{
	if (mmysql_handle == nullptr)
		return;
	char q[256];
	if (index_ != 0)
		snprintf(q, sizeof(q), "UPDATE `cp_companion_persistence` SET roam=%d"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			roam ? 1 : 0, owner_account, owner_char, index_);
	else
		snprintf(q, sizeof(q), "UPDATE `cp_companion_persistence` SET roam=%d"
			" WHERE owner_account_id=%u AND owner_char_id=%u",
			roam ? 1 : 0, owner_account, owner_char);
	if (Sql_Query(mmysql_handle, "%s", q) != SQL_SUCCESS)
		Sql_ShowDebug(mmysql_handle);
}

/// Start or stop roaming, from a standstill: no formation walk, no follow walk half done.
static void pop_companion_roam_set_live(map_session_data *sd, bool roam)
{
	if (sd->pop.companion_roam == roam)
		return;
	sd->pop.companion_roam = roam;
	sd->pop.companion_formation_active = false;
	if (unit_is_walking(sd))
		unit_stop_walking(sd, USW_FIXPOS);
}

void population_companion_roam_recalled(map_session_data *sd)
{
	if (!population_companion_roams(sd))
		return;
	pop_companion_roam_set_live(sd, false);
	pop_companion_roam_save(sd->pop.companion_owner_account, sd->pop.companion_owner_char,
		sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE, false);
	population_engine_push_companion_list_for_shell(sd);
}

void population_companion_roam_restore(map_session_data *owner)
{
	if (owner == nullptr || mmysql_handle == nullptr)
		return;
	char q[256];
	snprintf(q, sizeof(q), "SELECT shell_index FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND roam=1",
		owner->status.account_id, owner->status.char_id);
	if (Sql_Query(mmysql_handle, "%s", q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	std::vector<uint32_t> roaming;
	while (Sql_NextRow(mmysql_handle) == SQL_SUCCESS) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		if (data != nullptr)
			roaming.push_back(static_cast<uint32_t>(strtoul(data, nullptr, 10)));
	}
	Sql_FreeResult(mmysql_handle);
	for (map_session_data *sd : g_population_engine_pcs) {
		if (sd == nullptr || !pop_companion_owned_by(sd, owner))
			continue;
		const uint32_t index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;
		sd->pop.companion_roam = std::find(roaming.begin(), roaming.end(), index_) != roaming.end();
	}
}

/// `@companion roam [<name>] on|off`: a name sets that companion, none sets all of them.
/// Summoned or not: a benched companion keeps the setting for its next summon.
int population_engine_companion_set_roam(uint32_t owner_account, const char *name_, bool roam,
	char *out_msg, size_t out_msg_len)
{
	const uint32_t owner_char = pop_online_char(owner_account);
	if (mmysql_handle == nullptr || owner_char == 0)
		return -1;
	if (!battle_config.population_engine_companion_roam) {
		safesnprintf(out_msg, out_msg_len, "Companion roaming is off. Turn it on in the app's settings (Population).");
		return -1;
	}
	uint32_t index_ = 0;
	const bool all = name_ == nullptr || !name_[0];
	if (!all && !population_engine_companion_find(owner_account, name_, &index_, nullptr)) {
		safesnprintf(out_msg, out_msg_len, "No saved companion named %s.", name_);
		return -1;
	}
	pop_companion_roam_save(owner_account, owner_char, index_, roam);
	int applied = 0;
	for (map_session_data *sd : g_population_engine_pcs) {
		if (sd == nullptr || !pop_is_companion(sd))
			continue;
		if (sd->pop.companion_owner_account != owner_account || sd->pop.companion_owner_char != owner_char)
			continue;
		if (!all && sd->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		pop_companion_roam_set_live(sd, roam);
		++applied;
	}
	if (all)
		safesnprintf(out_msg, out_msg_len, "Companions: %s (on %d companion(s)).",
			roam ? "roaming the map" : "following you", applied);
	else
		safesnprintf(out_msg, out_msg_len, "%s: %s.", name_, roam ? "roaming the map" : "following you");
	if (map_session_data *owner_sd = map_charid2sd(owner_char); owner_sd != nullptr)
		population_engine_push_companion_list(owner_sd);
	return applied;
}

void population_companion_on_down(map_session_data *sd)
{
	if (sd == nullptr)
		return;
	char msg[CHAT_SIZE_MAX];
	safesnprintf(msg, sizeof(msg), "%s : I'm down! (%s %d, %d)",
		sd->status.name, mapindex_id2name(sd->mapindex), sd->x, sd->y);
	party_send_message(sd, msg, strlen(msg) + 1);
	sd->pop.companion_was_dead = true;
	population_engine_push_companion_list_for_shell(sd);
}

void population_companion_watch_life(map_session_data *sd)
{
	if (sd == nullptr || !sd->pop.companion_was_dead || pc_isdead(sd))
		return;
	sd->pop.companion_was_dead = false;
	population_engine_push_companion_list_for_shell(sd);
}
