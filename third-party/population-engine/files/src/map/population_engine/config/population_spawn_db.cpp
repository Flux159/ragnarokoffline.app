// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
#include "population_spawn_db.hpp"
#include "population_config.hpp"

#include <algorithm>

PopulationSpawnDatabase::PopulationSpawnDatabase()
	: TypesafeYamlDatabase("POPULATION_SPAWN_DB", 1, 1)
{
}

const std::string PopulationSpawnDatabase::getDefaultLocation()
{
	return population_config_db_path_spawn_yaml();
}

uint64 PopulationSpawnDatabase::parseBodyNode(const ryml::NodeRef& node)
{
	std::string profile_name;
	if (!this->asString(node, "Profile", profile_name) || profile_name.empty())
		return 0;

	std::shared_ptr<PopulationSpawnEntry> entry = this->find(profile_name);
	bool exists = entry != nullptr;
	if (!exists)
		entry = std::make_shared<PopulationSpawnEntry>();
	entry->profile_name = profile_name;

	auto parse_map_list = [&](const char* key, std::vector<std::string>& out) {
		const ryml::NodeRef& seq = node[c4::to_csubstr(key)];
		out.clear();
		if (!seq.is_seq())
			return;
		for (const ryml::NodeRef& it : seq.children()) {
			if (!it.has_val()) continue;
			ryml::csubstr v = it.val();
			if (!v.empty())
				out.emplace_back(v.data(), v.size());
		}
	};

	if (this->nodeExists(node, "Towns"))
		parse_map_list("Towns", entry->towns);
	else if (!exists)
		entry->towns.clear();

	if (this->nodeExists(node, "TownsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "TownsPopulation", v))
			entry->towns_population = std::max(0, v);
	} else if (!exists) {
		entry->towns_population = 0;
	}

	if (this->nodeExists(node, "TownsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "TownsMaxPerMap", v))
			entry->towns_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->towns_max_per_map = 0;
	}

	if (this->nodeExists(node, "Fields"))
		parse_map_list("Fields", entry->fields);
	else if (!exists)
		entry->fields.clear();

	if (this->nodeExists(node, "FieldsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "FieldsPopulation", v))
			entry->fields_population = std::max(0, v);
	} else if (!exists) {
		entry->fields_population = 0;
	}

	if (this->nodeExists(node, "FieldsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "FieldsMaxPerMap", v))
			entry->fields_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->fields_max_per_map = 0;
	}

	if (this->nodeExists(node, "Dungeons"))
		parse_map_list("Dungeons", entry->dungeons);
	else if (!exists)
		entry->dungeons.clear();

	if (this->nodeExists(node, "DungeonsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "DungeonsPopulation", v))
			entry->dungeons_population = std::max(0, v);
	} else if (!exists) {
		entry->dungeons_population = 0;
	}

	if (this->nodeExists(node, "DungeonsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "DungeonsMaxPerMap", v))
			entry->dungeons_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->dungeons_max_per_map = 0;
	}

	if (!exists)
		this->put(profile_name, entry);
	return 1;
}
