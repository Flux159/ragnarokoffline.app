// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC: included by population_engine.cpp after the ordinary spawn/release paths.
// Snapshots are reservations, not characters: no SQL, map blocks, timers or stale sd pointers.
#include "population_shell_selling.hpp"

static PopulationShellReturns g_pop_shell_returns;
static uint32_t g_pop_shell_return_generation = 0;

static bool pop_shell_selling_eligible(map_session_data *sd)
{
	if (!sd || !battle_config.population_engine_loot_enable || !sd->pop.ambient_quota
		|| population_engine_shell_kind(sd->id) != POP_SHELL_AMBIENT
		|| sd->pop.hold.npc != 0 || pc_isdead(sd)
		|| sd->party_invite || sd->party_joining || sd->party_creating || sd->pop.accept_party_request
		|| sd->pop.arena_team != 0 || sd->pop.db_source != static_cast<uint8_t>(PopulationDbSource::Main)
		|| sd->m != sd->pop.spawn_map_id)
		return false;

	return true;
}

static PopulationShellReturn pop_shell_selling_snapshot(map_session_data *sd, int64_t now)
{
	PopulationShellReturn entry;
	entry.departed_id = sd->id;
	entry.map = sd->m;
	entry.category = sd->pop.map_category;
	entry.job = sd->status.class_;
	entry.level = sd->status.base_level;
	entry.job_level = sd->status.job_level;
	entry.sex = sd->status.sex == SEX_MALE ? 'M' : 'F';
	entry.name = sd->status.name;
	entry.hair = sd->status.hair;
	entry.hair_color = sd->status.hair_color;
	entry.cloth_color = sd->status.clothes_color;
	// Keep vehicles/pets, never transient hiding, invisibility or combat effects.
	entry.option = sd->sc.option & (OPTION_RIDING | OPTION_FALCON | OPTION_DRAGON
		| OPTION_WUG | OPTION_WUGRIDER | OPTION_MADOGEAR);
	for (const auto &item : sd->inventory.u.items_inventory) {
		// Read inventory once: a multi-slot hat/weapon must not be duplicated.
		if (item.nameid && item.equip && !(item.equip & EQP_AMMO))
			entry.gear.push_back({item.nameid, item.equip});
	}
	entry.ready_at = now + rnd_value(120000, 240000);
	return entry;
}

// DIAGNOSTIC-BEGIN: pop_shell_selling_timer
static TIMER_FUNC(pop_shell_selling_timer)
{
	auto *sd = map_id2sd(id);
	if (!sd || !population_engine_is_population_pc(sd->id) || !sd->pop.loot_selling_pending)
		return 0;
	sd->pop.loot_selling_pending = false;
	sd->pop.hold.despawn_pending = false;
	// A whisper may have recruited this shell since the lifecycle pass scheduled us.
	if (static_cast<uint32_t>(data) != g_pop_shell_return_generation
		|| !pop_shell_selling_eligible(sd)) return 0;
	// Replace the live shell with its reservation atomically on the map thread.
	g_pop_shell_returns.reserve(pop_shell_selling_snapshot(sd, tick));
	if (sd->prev) clif_clearunit_area(*sd, CLR_TELEPORT);
	population_engine_shell_release(sd);
	return 0;
}
// DIAGNOSTIC-END: pop_shell_selling_timer

bool population_shell_selling_depart(map_session_data *sd, int64_t now)
{
	if (!pop_shell_selling_eligible(sd) || sd->pop.hold.despawn_pending) return false;
	sd->pop.loot_selling_pending = true;
	sd->pop.hold.despawn_pending = true;
	pop_shell_stop_ai_action(sd);
	static bool named = false;
	if (!named) {
		add_timer_func_list(pop_shell_selling_timer, "pop_shell_selling_timer");
		named = true;
	}
	// The lifecycle pass is iterating the shell registry; release after it returns.
	add_timer(now + 1, pop_shell_selling_timer, sd->id, g_pop_shell_return_generation);
	return true;
}

// DIAGNOSTIC-BEGIN: population_shell_returns_clear
void population_shell_returns_clear()
{
	++g_pop_shell_return_generation; // Also invalidate departures already waiting on the map timer.
	g_pop_shell_returns.clear();
}
// DIAGNOSTIC-END: population_shell_returns_clear

void population_shell_returns_prune(bool under_pressure)
{
	if (!battle_config.population_engine_loot_enable) {
		population_shell_returns_clear();
		return;
	}
	g_pop_shell_returns.discard_if([under_pressure](const auto &entry) {
		return !population_engine_db().find(entry.job)
			|| (battle_config.population_engine_demand_spawn && (under_pressure
				? g_pop_occupied_maps.count(entry.map) == 0 : !pop_map_is_live(entry.map)));
	});
}

size_t population_shell_returns_fit(int16_t map, const std::vector<uint16_t> &jobs, size_t target, size_t live)
{
	return g_pop_shell_returns.fit(map, jobs, target, live);
}

size_t population_shell_returns_count(int16_t map, const std::vector<uint16_t> &jobs)
{
	return g_pop_shell_returns.count(map, jobs);
}

size_t population_shell_returns_fill(int16_t map, const std::vector<uint16_t> &jobs, size_t *budget)
{
	// Keep reservations through the normal grace period, but do not bring somebody
	// back on an empty map. Another active map may use the global live-shell budget.
	if (!population_engine_map_has_real_players(map)) return 0;
	size_t spawned = 0;
	while ((!budget || *budget > 0)
		&& g_population_engine_count.load() < static_cast<size_t>(battle_config.population_engine_max_count)) {
		const auto *pending = g_pop_shell_returns.next(map, jobs, gettick());
		if (!pending) break;
		const PopulationShellReturn entry = *pending;
		if (map_nick2sd(entry.name.c_str(), false) != nullptr) {
			// An online player/mod now owns the name; release this reservation.
			g_pop_shell_returns.complete(entry.departed_id);
			continue;
		}
		if (!autosummon_fill_map(map, 1, entry.job, budget, entry.category, true, &entry))
			break; // no free cell / failed spawn: retry on the next autosummon tick
		g_pop_shell_returns.complete(entry.departed_id);
		++spawned;
	}
	return spawned;
}

bool population_shell_returns_allow_fresh(int16_t map, size_t global_live, size_t global_cap)
{
	return g_pop_shell_returns.allow_fresh(map, global_live, global_cap);
}
