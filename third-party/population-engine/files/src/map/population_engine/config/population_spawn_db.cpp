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

	// RAGNAROKMAC: the append form of the three lists above.
	//
	// A plain `Towns:` in an imported file replaces the profile's list, which
	// is right for a mod that owns the profile and wrong for one that just
	// wants its island populated: adding one map to combat_pve would mean
	// restating the twenty it already has, and then silently keeping those
	// twenty when the shipped table changes. `TownsAdd:` adds to the list
	// instead. Duplicates are dropped, because the population of a category is
	// divided between its maps and a map named twice would take two shares.
	auto append_map_list = [&](const char* key, std::vector<std::string>& out) {
		const ryml::NodeRef& seq = node[c4::to_csubstr(key)];
		if (!seq.is_seq())
			return;
		for (const ryml::NodeRef& it : seq.children()) {
			if (!it.has_val()) continue;
			ryml::csubstr v = it.val();
			if (v.empty()) continue;
			std::string name(v.data(), v.size());
			if (std::find(out.begin(), out.end(), name) == out.end())
				out.emplace_back(std::move(name));
		}
	};

	// RAGNAROKMAC: and of the counts, for the same reason -- a mod that adds a
	// map without adding shells has only spread the existing ones thinner.
	auto add_count = [&](const char* key, int32_t& out) {
		if (!this->nodeExists(node, key))
			return;
		int32_t v = 0;
		if (this->asInt32(node, key, v))
			out = std::max(0, out + v);
	};

	if (this->nodeExists(node, "Towns"))
		parse_map_list("Towns", entry->towns);
	else if (!exists)
		entry->towns.clear();
	if (this->nodeExists(node, "TownsAdd"))
		append_map_list("TownsAdd", entry->towns);

	if (this->nodeExists(node, "TownsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "TownsPopulation", v))
			entry->towns_population = std::max(0, v);
	} else if (!exists) {
		entry->towns_population = 0;
	}
	add_count("TownsPopulationAdd", entry->towns_population);

	if (this->nodeExists(node, "TownsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "TownsMaxPerMap", v))
			entry->towns_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->towns_max_per_map = 0;
	}
	add_count("TownsMaxPerMapAdd", entry->towns_max_per_map);

	if (this->nodeExists(node, "Fields"))
		parse_map_list("Fields", entry->fields);
	else if (!exists)
		entry->fields.clear();
	if (this->nodeExists(node, "FieldsAdd"))
		append_map_list("FieldsAdd", entry->fields);

	if (this->nodeExists(node, "FieldsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "FieldsPopulation", v))
			entry->fields_population = std::max(0, v);
	} else if (!exists) {
		entry->fields_population = 0;
	}
	add_count("FieldsPopulationAdd", entry->fields_population);

	if (this->nodeExists(node, "FieldsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "FieldsMaxPerMap", v))
			entry->fields_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->fields_max_per_map = 0;
	}
	add_count("FieldsMaxPerMapAdd", entry->fields_max_per_map);

	if (this->nodeExists(node, "Dungeons"))
		parse_map_list("Dungeons", entry->dungeons);
	else if (!exists)
		entry->dungeons.clear();
	if (this->nodeExists(node, "DungeonsAdd"))
		append_map_list("DungeonsAdd", entry->dungeons);

	if (this->nodeExists(node, "DungeonsPopulation")) {
		int32_t v = 0;
		if (this->asInt32(node, "DungeonsPopulation", v))
			entry->dungeons_population = std::max(0, v);
	} else if (!exists) {
		entry->dungeons_population = 0;
	}
	add_count("DungeonsPopulationAdd", entry->dungeons_population);

	if (this->nodeExists(node, "DungeonsMaxPerMap")) {
		int32_t v = 0;
		if (this->asInt32(node, "DungeonsMaxPerMap", v))
			entry->dungeons_max_per_map = std::max(0, v);
	} else if (!exists) {
		entry->dungeons_max_per_map = 0;
	}
	add_count("DungeonsMaxPerMapAdd", entry->dungeons_max_per_map);

	if (!exists)
		this->put(profile_name, entry);
	return 1;
}
