// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (temporary recruits): see population_companion_temporary.hpp.
//
// Not a translation unit of its own: population_engine.cpp includes it at its end, as it
// does population_companion_roam.cpp, so it reaches the engine's own helpers
// (population_engine_companion_holds_given_gear, population_engine_persist_companion_gear,
// pop_online_char, g_population_engine_pcs) and its SQL handle.
// The mark is the row's `temporary` column (v16); this file reads and writes it itself, so
// the engine's save and recall statements stay as they were.

bool population_companion_row_kept(uint32 owner_account, uint32 owner_char, uint32 index_)
{
	if (mmysql_handle == nullptr)
		return false;
	char q[200];
	snprintf(q, sizeof(q),
		"SELECT 1 FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		owner_account, owner_char, index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		// Unknown: read it as kept, so a recruit is never made temporary by a failed query.
		return true;
	}
	const bool kept = Sql_NumRows(mmysql_handle) > 0;
	Sql_FreeResult(mmysql_handle);
	return kept;
}

/// The companion's shell while it is live in the world, else nullptr.
static map_session_data *pop_temporary_live_shell(uint32 index_)
{
	for (map_session_data *shell : g_population_engine_pcs) {
		if (shell != nullptr && shell->status.char_id == POPULATION_ENGINE_CHAR_ID_BASE + index_)
			return shell;
	}
	return nullptr;
}

void population_companion_temporary_mark(map_session_data *owner, uint32 index_, bool fresh)
{
	if (!battle_config.population_engine_companion_recruit_temporary || !fresh || owner == nullptr
		|| mmysql_handle == nullptr)
		return;
	char q[200];
	snprintf(q, sizeof(q),
		"UPDATE `cp_companion_persistence` SET temporary=1"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		owner->status.account_id, owner->status.char_id, index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	if (owner->fd > 0)
		clif_displaymessage(owner->fd,
			"Companions: a recruit from the world helps you for now, and goes its own way when it leaves your party.");
	ShowInfo("population_engine: companion index %u is a temporary recruit\n", index_);
}

bool population_companion_temporary_drop(uint32 index_)
{
	if (mmysql_handle == nullptr || index_ == 0)
		return false;
	char q[240];
	snprintf(q, sizeof(q),
		"SELECT owner_account_id, owner_char_id, temporary, name FROM `cp_companion_persistence`"
		" WHERE shell_index=%u", index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	uint32 owner_account = 0, owner_char = 0;
	bool temporary = false;
	char name[NAME_LENGTH] = "";
	if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		owner_account = data != nullptr ? static_cast<uint32>(strtoul(data, nullptr, 10)) : 0;
		Sql_GetData(mmysql_handle, 1, &data, nullptr);
		owner_char = data != nullptr ? static_cast<uint32>(strtoul(data, nullptr, 10)) : 0;
		Sql_GetData(mmysql_handle, 2, &data, nullptr);
		temporary = data != nullptr && atoi(data) != 0;
		Sql_GetData(mmysql_handle, 3, &data, nullptr);
		safestrncpy(name, data != nullptr ? data : "", sizeof(name));
	}
	Sql_FreeResult(mmysql_handle);
	if (!temporary)
		return false;

	// The gear check below reads the owner's online character, so it needs that character to be
	// the row's owner. When it is not (logged out, or another character of the account), the
	// recruit is kept: its owner's next login drops it, once nothing of theirs is at stake.
	if (owner_char == 0 || pop_online_char(owner_account) != owner_char)
		return false;
	map_session_data *owner = map_id2sd(static_cast<int32>(owner_account));

	// What its owner gave it is never thrown away with it. A live companion's row is only a
	// record of its gear, so it is written first; the live mask is asked as well.
	map_session_data *live = pop_temporary_live_shell(index_);
	if (live != nullptr && live->state.active)
		population_engine_persist_companion_gear(live);
	const bool holds = population_engine_companion_holds_given_gear(owner_account, index_)
		|| (live != nullptr && live->pop.companion_given_mask != 0);
	if (holds) {
		if (owner != nullptr && owner->fd > 0) {
			char msg[NAME_LENGTH + 120];
			safesnprintf(msg, sizeof(msg),
				"Companions: %s still has gear you gave it. Take it back in the Gear tab, then dismiss it to let it go.",
				name);
			clif_displaymessage(owner->fd, msg);
		}
		return false;
	}

	snprintf(q, sizeof(q),
		"DELETE FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u AND temporary=1",
		owner_account, owner_char, index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	if (Sql_NumRowsAffected(mmysql_handle) == 0)
		return false;
	if (owner != nullptr)
		population_engine_push_companion_list(owner);
	ShowInfo("population_engine: temporary recruit index %u went its own way\n", index_);
	return true;
}

void population_companion_temporary_let_go(uint32 index_)
{
	if (map_session_data *shell = pop_temporary_live_shell(index_))
		pop_companion_set_owner(shell, nullptr);
}

void population_companion_temporary_drop_all(const map_session_data *owner)
{
	if (owner == nullptr || mmysql_handle == nullptr)
		return;
	char q[200];
	snprintf(q, sizeof(q),
		"SELECT shell_index FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND temporary=1",
		owner->status.account_id, owner->status.char_id);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	// Read every index before dropping any: the drop runs queries of its own on this handle.
	std::vector<uint32> indexes;
	while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		if (data != nullptr)
			indexes.push_back(static_cast<uint32>(strtoul(data, nullptr, 10)));
	}
	Sql_FreeResult(mmysql_handle);
	for (const uint32 index_ : indexes) {
		if (pop_temporary_live_shell(index_) == nullptr)
			population_companion_temporary_drop(index_);
	}
}
