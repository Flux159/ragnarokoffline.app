// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC: temporary identities reserve ambient population slots while selling.
#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

struct PopulationShellReturn {
	struct Gear { uint32_t item_id; uint32_t position; };
	uint32_t departed_id = 0;
	int16_t map = -1;
	uint8_t category = 0;
	uint16_t job = 0, level = 0, job_level = 0;
	char sex = 'F';
	uint8_t hair = 0;
	uint16_t hair_color = 0, cloth_color = 0;
	uint32_t option = 0;
	std::string name;
	// Worn item ids and slots, including costumes. No bag contents or ammunition.
	std::vector<Gear> gear;
	int64_t ready_at = 0;
};

inline bool population_shell_needs_unload(bool collected, bool blocked, int64_t weight,
	int64_t loot_limit, int free_slots)
{
	// Provisioned gear/ammo alone must never put a fresh shell into a selling loop.
	return collected && (blocked || free_slots <= 1 || weight * 10 >= loot_limit * 9);
}

class PopulationShellReturns {
	std::vector<PopulationShellReturn> entries;

	static bool matches(const PopulationShellReturn &entry, int16_t map, const std::vector<uint16_t> &jobs)
	{
		return entry.map == map && std::find(jobs.begin(), jobs.end(), entry.job) != jobs.end();
	}

public:
	bool empty() const { return entries.empty(); }
	void clear() { entries.clear(); }
	void reserve(PopulationShellReturn entry) { entries.push_back(std::move(entry)); }

	bool allow_fresh(int16_t map, size_t global_live, size_t global_cap) const
	{
		if (global_live >= global_cap) return false;
		const size_t reserved = std::count_if(entries.begin(), entries.end(),
			[map](const auto &entry) { return entry.map == map; });
		return reserved < global_cap - global_live;
	}

	size_t count(int16_t map, const std::vector<uint16_t> &jobs) const
	{
		return std::count_if(entries.begin(), entries.end(), [&](const auto &entry) { return matches(entry, map, jobs); });
	}

	template<class Predicate> void discard_if(Predicate discard)
	{
		entries.erase(std::remove_if(entries.begin(), entries.end(), discard), entries.end());
	}

	// Keep the oldest returns that still fit the current target, including a target of zero.
	size_t fit(int16_t map, const std::vector<uint16_t> &jobs, size_t target, size_t live)
	{
		const size_t room = target > live ? target - live : 0;
		size_t kept = 0;
		discard_if([&](const auto &entry) { return matches(entry, map, jobs) && kept++ >= room; });
		return std::min(kept, room);
	}

	const PopulationShellReturn *next(int16_t map, const std::vector<uint16_t> &jobs, int64_t now) const
	{
		for (const auto &entry : entries)
			if (matches(entry, map, jobs) && entry.ready_at <= now)
				return &entry;
		return nullptr;
	}

	void complete(uint32_t id)
	{
		discard_if([id](const auto &entry) { return entry.departed_id == id; });
	}
};
