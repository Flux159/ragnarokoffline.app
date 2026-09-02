// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Per-profile autosummon spawn lists (db/population_spawn.yml).
// Access via population_spawn_db() (declared in population_config.hpp).
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <common/database.hpp>

/// One autosummon entry: which maps to fill and how many shells per category.
/// Keyed by Profile name (matches a Profile: defined in population_engine.yml);
/// the spawn loader resolves the profile to the list of jobs that inherit
/// from it and distributes shells across them at autosummon time.
struct PopulationSpawnEntry {
	std::string profile_name;
	std::vector<std::string> towns;
	int32_t towns_population = 0;
	int32_t towns_max_per_map = 0; ///< Hard cap per individual town map (0 = no cap).
	std::vector<std::string> fields;
	int32_t fields_population = 0;
	int32_t fields_max_per_map = 0; ///< Hard cap per individual field map (0 = no cap).
	std::vector<std::string> dungeons;
	int32_t dungeons_population = 0;
	int32_t dungeons_max_per_map = 0; ///< Hard cap per individual dungeon map (0 = no cap).
};

class PopulationSpawnDatabase : public TypesafeYamlDatabase<std::string, PopulationSpawnEntry> {
public:
	PopulationSpawnDatabase();
	const std::string getDefaultLocation() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
};
