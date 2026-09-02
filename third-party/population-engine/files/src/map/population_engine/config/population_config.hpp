// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine: battle_config + db paths, and YAML database classes.
#pragma once

#include <cstdint>
#include <initializer_list>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "population_yaml_types.hpp"
#include <common/database.hpp>

/// Hat effect id from `population_engine_hat_effect` (0 = off). Caller validates HAT_EF range.
int population_config_shell_hat_effect_id();

#include "population_skill_db.hpp"
#include "population_spawn_db.hpp"

/// Full paths: `db_path` + "/" + file (same as db/population_*.yml when db_path is `db`).
std::string population_config_db_path_equipment_yaml();
std::string population_config_db_path_pvp_yaml();
std::string population_config_db_path_vendor_pop_yaml();
std::string population_config_db_path_shared_yaml();
std::string population_config_db_path_chat_yaml();
std::string population_config_db_path_names_yaml();
std::string population_config_db_path_skill_yaml();
std::string population_config_db_path_spawn_yaml();
std::string population_config_db_path_vendors_yaml();

// ---------------------------------------------------------------------------
// YAML database classes (merged from population_yaml_databases.hpp)
// ---------------------------------------------------------------------------

class PopulationNamesDatabase : public YamlDatabase {
	std::unordered_map<std::string, std::shared_ptr<PopulationNameProfile>> profiles;

public:
	PopulationNamesDatabase();
	void clear() override;
	const std::string getDefaultLocation() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
	const PopulationNameProfile* find_profile(const std::string& key) const;
	const PopulationNameProfile* find_profile_or_default(const std::string& key) const;
	size_t profile_count() const;
};

class PopulationChatDatabase : public YamlDatabase {
	std::unordered_map<std::string, std::vector<std::string>> categories_;
	std::unordered_map<std::string, std::vector<std::string>> profile_pools_;

public:
	PopulationChatDatabase();
	void clear() override;
	const std::string getDefaultLocation() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
	void loadingFinished() override;
	const std::vector<std::string>* pool_for_profile(const std::string& key) const;
	const std::vector<std::string>* lines_for_category(const std::string& category) const;
	size_t profile_count() const;
	size_t category_count() const;
};

/// Source enum used by sd->pop.db_source so runtime lookups can find the
/// correct database for a given shell. Each value matches one of the YAML
/// files loaded into a separate PopulationEngineDatabase instance.
enum class PopulationDbSource : uint8_t {
	Main   = 0, ///< db/population_engine.yml — town/field/dungeon shells
	Pvp    = 1, ///< db/population_pvp.yml      — PvP arena shells
	Vendor = 2, ///< db/population_vendor_pop.yml — vendor shells
};

class PopulationEngineDatabase : public TypesafeYamlDatabase<uint16_t, PopulationEngine> {
	bool m_validationError = false;
	std::unordered_map<std::string, PopulationGearSet> m_gear_sets;
	std::unordered_map<std::string, std::shared_ptr<PopulationEngine>> m_profiles;
	std::vector<uint16_t> m_arena_job_pool;
	/// Per-instance YAML basename. Set by the constructor; getDefaultLocation()
	/// returns db_path + "/" + this. Allows multiple instances of this class to
	/// load different YAML files (main, pvp, vendor, shared templates).
	std::string m_filename_basename;
	/// Optional shared template source. When set, GearSet: and Profile: lookups
	/// during parseBodyNode fall back to this database if not found locally.
	/// Used so the three job DBs can share gear sets / profiles defined in
	/// db/population_gear_sets.yml.
	const PopulationEngineDatabase* m_shared_source = nullptr;
	/// When true, parseBodyNode rejects Job: entries (used for the shared
	/// templates DB which should only contain GearSetName, Profile, ArenaJobPool).
	bool m_jobs_rejected = false;
	/// When true, loadingFinished() auto-fills m_arena_job_pool from every loaded
	/// job ID if the YAML did not provide an explicit ArenaJobPool block. Used by
	/// the PvP DB so the arena pool is implicitly the set of jobs in that file.
	bool m_auto_arena_pool = false;

	ryml::NodeRef warnAnchorForJob(const ryml::NodeRef& node);
	void markInvalidItem(const ryml::NodeRef& node, const char* yaml_key, uint16_t job_id, uint16_t bad_id);
	bool parseOptionalIntRange(const ryml::NodeRef& node, const std::string& key, int16_t& out_min, int16_t& out_max, uint16_t job_id);
	void readUInt16FirstKey(const ryml::NodeRef& node, std::initializer_list<const char*> keys, uint16_t& out);
	/// Parse an equipment slot pool from a YAML node.
	/// Accepts scalar 0 (empty), scalar item_id or AegisName (single item), or sequence of items.
	/// Validates each resolved item against required_flag (item_data.equip & required_flag must be true).
	/// Warns and skips entries that fail item_db lookup or slot validation.
	void parseEquipSlotPool(const ryml::NodeRef& node, std::initializer_list<const char*> keys,
	                        uint32_t required_flag, std::vector<uint16_t>& pool, uint16_t job_id);

	/// Look up a gear set by name. Falls back to m_shared_source if not local.
	const PopulationGearSet* find_gear_set(const std::string& name) const;
	/// Look up a profile template by name. Falls back to m_shared_source if not local.
	const PopulationEngine*  find_profile(const std::string& name) const;

public:
	/// Default ctor uses the main "population_engine.yml" filename.
	PopulationEngineDatabase();
	/// Use a non-default YAML basename (e.g. "population_pvp.yml").
	/// `auto_arena_pool` = true makes loadingFinished() seed m_arena_job_pool
	/// from every loaded job ID when no explicit ArenaJobPool block was parsed.
	explicit PopulationEngineDatabase(const char* yaml_basename, bool reject_jobs = false,
	                                  bool auto_arena_pool = false);
	const std::string getDefaultLocation() override;
	void clear() override;
	void loadingFinished() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
	const std::vector<uint16_t>& arena_job_pool() const { return m_arena_job_pool; }
	/// Return all loaded job IDs whose entry inherited from the named Profile.
	std::vector<uint16_t> jobs_with_profile(const std::string& profile_name);
	/// Set after construction; pass the shared-templates DB so parseBodyNode
	/// can fall back for unknown GearSet:/Profile: references.
	void set_shared_source(const PopulationEngineDatabase* src) { m_shared_source = src; }
};

class PopulationSkillDatabase : public YamlDatabase {
	std::unordered_map<uint16_t, std::vector<s_pop_skill_entry>> jobs_;

public:
	PopulationSkillDatabase();
	void clear() override;
	const std::string getDefaultLocation() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
	const std::vector<s_pop_skill_entry>* find(uint16_t job_id) const;
	size_t job_count() const;
};

class PopulationVendorDatabase : public YamlDatabase {
	std::unordered_map<std::string, PopulationVendorEntry> entries_;
	/// Derived index: Map name -> placement constraint, populated from per-vendor
	/// VendorPlacement: blocks during parseBodyNode. If multiple vendor entries name
	/// the same Map, the last one parsed wins (a warning is emitted).
	std::unordered_map<std::string, PopulationVendorPlacement> placements_by_map_;

public:
	PopulationVendorDatabase();
	void clear() override;
	const std::string getDefaultLocation() override;
	uint64 parseBodyNode(const ryml::NodeRef& node) override;
	const PopulationVendorEntry* find(const std::string& key) const;
	size_t entry_count() const;
	const PopulationVendorPlacement* vendor_placement_for_map(const std::string& map_name) const {
		auto it = placements_by_map_.find(map_name);
		return it != placements_by_map_.end() ? &it->second : nullptr;
	}
	bool any_vendor_placements() const { return !placements_by_map_.empty(); }
	const std::unordered_map<std::string, PopulationVendorPlacement>& vendor_placements() const { return placements_by_map_; }
};

PopulationNamesDatabase& population_names_db();
PopulationChatDatabase& population_chat_db();
PopulationEngineDatabase& population_engine_db();
PopulationEngineDatabase& population_pvp_db();
PopulationEngineDatabase& population_vendor_pop_db();
PopulationEngineDatabase& population_shared_db();
PopulationSkillDatabase& population_skill_db();
PopulationSpawnDatabase& population_spawn_db();
PopulationVendorDatabase& population_vendor_db();

/// Pick the right job DB for a shell based on its source tag.
PopulationEngineDatabase& population_engine_db_for(PopulationDbSource src);

/// Lookup `job_id` in main, then PvP, then vendor DB. Optionally reports which
/// DB owned the entry via `out_src` so the caller can tag the spawned shell.
class map_session_data;
std::shared_ptr<PopulationEngine> population_engine_find_any(uint16_t job_id, PopulationDbSource* out_src = nullptr);
/// Resolve the DB that owns this shell (sd->pop.db_source). Returns the main
/// DB for null/non-shell sd so existing call sites stay safe.
PopulationEngineDatabase& population_engine_db_for_shell(const map_session_data* sd);

const std::vector<std::string>& population_yaml_name_global_prefixes();
const std::vector<std::string>& population_yaml_name_syl_start();
const std::vector<std::string>& population_yaml_name_syl_mid();
const std::vector<std::string>& population_yaml_name_syl_end();
const std::vector<std::string>& population_yaml_name_adjectives();
const std::vector<std::string>& population_yaml_name_nouns();
bool population_yaml_name_hits_blocklist(const std::string& name_lower);
