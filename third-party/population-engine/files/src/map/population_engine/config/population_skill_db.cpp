// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell skill database — YAML parser for db/population_skill_db.yml.

#include "population_config.hpp"

#include <cstdint>
#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/showmsg.hpp>

#include "../../skill.hpp"   // skill_name2id
#include "../expanded_ai/expanded_parser.hpp"

// ---------------------------------------------------------------------------
// Condition name → enum mapping
// ---------------------------------------------------------------------------

static const std::unordered_map<std::string, PopSkillCondition> s_cond_name_map = {
	{ "always",           PopSkillCondition::Always          },
	{ "hp_below",         PopSkillCondition::HpBelow         },
	{ "sp_below",         PopSkillCondition::SpBelow         },
	{ "hp_above",         PopSkillCondition::HpAbove         },
	{ "enemy_hp_below",   PopSkillCondition::EnemyHpBelow    },
	{ "enemy_hp_above",   PopSkillCondition::EnemyHpAbove    },
	{ "enemy_status",     PopSkillCondition::EnemyStatus     },
	{ "not_enemy_status", PopSkillCondition::NotEnemyStatus  },
	{ "self_status",      PopSkillCondition::SelfStatus      },
	{ "not_self_status",  PopSkillCondition::NotSelfStatus   },
	{ "distance_below",   PopSkillCondition::DistanceBelow   },
	{ "distance_above",   PopSkillCondition::DistanceAbove   },
	{ "enemy_count_nearby", PopSkillCondition::EnemyCountNearby },
	{ "map_zone",         PopSkillCondition::MapZone         },
	{ "melee_attacked",   PopSkillCondition::MeleeAttacked   },
	{ "range_attacked",   PopSkillCondition::RangeAttacked   },
	{ "ally_hp_below",    PopSkillCondition::AllyHpBelow     },
	{ "ally_status",      PopSkillCondition::AllyStatus      },
	{ "not_ally_status",  PopSkillCondition::NotAllyStatus   },
	{ "has_sphere",       PopSkillCondition::HasSphere       },
	{ "enemy_hidden",         PopSkillCondition::EnemyHidden        },
	{ "enemy_casting",        PopSkillCondition::EnemyCasting       },
	{ "enemy_casting_ground", PopSkillCondition::EnemyCastingGround },
	{ "cell_has_skill_unit",  PopSkillCondition::CellHasSkillUnit   },
	{ "self_targeted",        PopSkillCondition::SelfTargeted       },
	{ "enemy_element",        PopSkillCondition::EnemyElement       },
	{ "enemy_race",           PopSkillCondition::EnemyRace          },
	{ "ally_count_nearby",    PopSkillCondition::AllyCountNearby    },
	{ "enemy_is_boss",        PopSkillCondition::EnemyIsBoss        },
	{ "sp_above",             PopSkillCondition::SpAbove            },
	{ "self_being_cast_on",   PopSkillCondition::SelfBeingCastOn    },
	// Phase 3: combo / reactive conditions
	{ "after_skill",          PopSkillCondition::AfterSkill         },
	{ "damaged_gt",           PopSkillCondition::DamagedGt          },
	{ "skill_used",           PopSkillCondition::SkillUsed          },
};

// ---------------------------------------------------------------------------
// State / Target name → value mappings
// ---------------------------------------------------------------------------

static const std::unordered_map<std::string, uint16_t> s_state_map = {
	{ "any",        0 },
	{ "has_target", 1 },
	{ "no_target",  2 },
};

static const std::unordered_map<std::string, uint16_t> s_target_map = {
	{ "current", 0 },
	{ "self",    1 },
	{ "ally",    2 },
};

// ---------------------------------------------------------------------------
// CondValue name → value mappings (element / race / zone)
// ---------------------------------------------------------------------------

static const std::unordered_map<std::string, uint8_t> s_element_map = {
	{ "Neutral", 0 }, { "Water",  1 }, { "Earth", 2 }, { "Fire",  3 },
	{ "Wind",    4 }, { "Poison", 5 }, { "Holy",  6 }, { "Dark",  7 },
	{ "Ghost",   8 }, { "Undead", 9 },
};

static const std::unordered_map<std::string, uint8_t> s_race_map = {
	{ "Formless",  0 }, { "Undead",    1 }, { "Brute",  2 },
	{ "Plant",     3 }, { "Insect",    4 }, { "Fish",   5 },
	{ "Demon",     6 }, { "DemiHuman", 7 }, { "Angel",  8 },
	{ "Dragon",    9 },
};

static const std::unordered_map<std::string, uint8_t> s_zone_map = {
	{ "town",    1 }, { "field", 2 }, { "dungeon", 3 },
};

// ---------------------------------------------------------------------------
// PopulationSkillDatabase
// ---------------------------------------------------------------------------

PopulationSkillDatabase::PopulationSkillDatabase()
	: YamlDatabase("POPULATION_SKILL_DB", 1, 1)
{
}

void PopulationSkillDatabase::clear()
{
	this->jobs_.clear();
}

const std::string PopulationSkillDatabase::getDefaultLocation()
{
	return population_config_db_path_skill_yaml();
}

uint64 PopulationSkillDatabase::parseBodyNode(const ryml::NodeRef& node)
{
	uint16_t job_id = 0;
	if (!this->asUInt16(node, "JobId", job_id))
		return 0;

	if (!this->nodeExists(node, "Skills"))
		return 0;

	const ryml::NodeRef& skills_node = node[c4::to_csubstr("Skills")];
	if (!skills_node.is_seq())
		return 0;

	std::vector<s_pop_skill_entry> skills;
	for (const ryml::NodeRef& row : skills_node.children()) {
		if (!row.is_map())
			continue;

		uint16_t sid = 0;
		std::string skname;
		if (this->asString(row, "SkillId", skname)) {
			int64_t cst = 0;
			if (script_get_constant(skname.c_str(), &cst))
				sid = static_cast<uint16_t>(cst);
			else
				sid = skill_name2id(skname.c_str());
		}
		if (sid == 0) {
			if (!this->asUInt16(row, "SkillId", sid) || sid == 0)
				continue;
		}

		int32_t lv = 1;
		this->asInt32(row, "Level", lv);
		if (lv < 1) lv = 1;

		uint16_t rate = 10000;
		if (this->nodeExists(row, "Rate"))
			this->asUInt16(row, "Rate", rate);

		uint16_t state = 0, target = 0, around = 0;
		bool around_target = false;
		if (this->nodeExists(row, "State")) {
			std::string sv;
			this->asString(row, "State", sv);
			auto it = s_state_map.find(sv);
			if (it != s_state_map.end()) state = it->second;
			else this->asUInt16(row, "State", state);
		}
		if (this->nodeExists(row, "Target")) {
			std::string tv;
			this->asString(row, "Target", tv);
			auto it = s_target_map.find(tv);
			if (it != s_target_map.end()) target = it->second;
			else this->asUInt16(row, "Target", target);
		}
		if (this->nodeExists(row, "AroundRange"))  this->asUInt16(row, "AroundRange", around);
		if (this->nodeExists(row, "AroundTarget")) this->asBool(row,   "AroundTarget", around_target);

		uint32_t cooldown_ms = 0;
		if (this->nodeExists(row, "Cooldown")) {
			uint32_t cd = 0;
			this->asUInt32(row, "Cooldown", cd);
			cooldown_ms = cd;
		}

		s_pop_skill_entry e{};
		e.skill_id    = sid;
		e.skill_lv    = static_cast<uint16_t>(lv);
		e.rate        = rate;
		e.state       = static_cast<uint8_t>(state);
		e.target      = static_cast<uint8_t>(target);
		e.around_range = static_cast<uint8_t>(std::min(around, static_cast<uint16_t>(15)));
		e.around_target = around_target;
		e.cooldown_ms  = cooldown_ms;

		// Parse Condition. Three accepted shapes:
		//   1. scalar string  — legacy flat-enum token ("hp_below")
		//   2. sequence       — implicit AND of expanded tokens / nested maps
		//   3. map            — gate-keyed (AND/OR/NAND/...) expanded tree
		if (this->nodeExists(row, "Condition")) {
			const ryml::NodeRef& cond_node = row[c4::to_csubstr("Condition")];
			if (cond_node.is_seq() || cond_node.is_map()) {
				e.expanded = expanded_ai::parse_expanded_condition(cond_node);
				e.condition = PopSkillCondition::Expanded;
			} else {
				std::string cond_str;
				if (this->asString(row, "Condition", cond_str)) {
					auto it = s_cond_name_map.find(cond_str);
					if (it != s_cond_name_map.end()) {
						e.condition = it->second;
					} else {
						ShowWarning("population_skill_db: unknown Condition '%s' for skill %d -- using 'always'\n", cond_str.c_str(), sid);
					}
				} else {
					// Legacy numeric fallback (0=always, 1=hp_below, 2=sp_below)
					uint16_t cond_num = 0;
					this->asUInt16(row, "Condition", cond_num);
					if (cond_num == 1) e.condition = PopSkillCondition::HpBelow;
					else if (cond_num == 2) e.condition = PopSkillCondition::SpBelow;
				}
			}
		}

		// Parse CondValue — string for status/skill-name conditions, named string or numeric for element/race/zone, numeric for everything else
		if (this->nodeExists(row, "CondValue")) {
			const bool is_status_cond = (e.condition == PopSkillCondition::EnemyStatus   ||
			                             e.condition == PopSkillCondition::NotEnemyStatus ||
			                             e.condition == PopSkillCondition::SelfStatus     ||
			                             e.condition == PopSkillCondition::NotSelfStatus  ||
			                             e.condition == PopSkillCondition::AllyStatus     ||
			                             e.condition == PopSkillCondition::NotAllyStatus);
			// AfterSkill and SkillUsed take a skill name string (resolved at runtime to skill ID).
			const bool is_skill_name_cond = (e.condition == PopSkillCondition::AfterSkill ||
			                                 e.condition == PopSkillCondition::SkillUsed);
			const bool is_element_cond = (e.condition == PopSkillCondition::EnemyElement);
			const bool is_race_cond    = (e.condition == PopSkillCondition::EnemyRace);
			const bool is_zone_cond    = (e.condition == PopSkillCondition::MapZone);
			if (is_status_cond || is_skill_name_cond) {
				this->asString(row, "CondValue", e.cond_value_str);
			} else if (is_element_cond || is_race_cond || is_zone_cond) {
				std::string cv_str;
				this->asString(row, "CondValue", cv_str);
				bool resolved = false;
				if (is_element_cond) {
					auto it = s_element_map.find(cv_str);
					if (it != s_element_map.end()) { e.cond_value_num = it->second; resolved = true; }
				} else if (is_race_cond) {
					auto it = s_race_map.find(cv_str);
					if (it != s_race_map.end()) { e.cond_value_num = it->second; resolved = true; }
				} else {
					auto it = s_zone_map.find(cv_str);
					if (it != s_zone_map.end()) { e.cond_value_num = it->second; resolved = true; }
				}
				if (!resolved) {
					uint16_t cv = 0;
					this->asUInt16(row, "CondValue", cv);
					e.cond_value_num = static_cast<uint8_t>(cv);
				}
			} else {
				uint16_t cv = 0;
				this->asUInt16(row, "CondValue", cv);
				e.cond_value_num = static_cast<uint8_t>(cv);
			}
		}

		skills.push_back(std::move(e));
	}

	if (skills.empty())
		return 0;

	this->jobs_[job_id] = std::move(skills);
	return static_cast<uint64>(this->jobs_[job_id].size());
}

const std::vector<s_pop_skill_entry>* PopulationSkillDatabase::find(uint16_t job_id) const
{
	auto it = this->jobs_.find(job_id);
	return (it != this->jobs_.end()) ? &it->second : nullptr;
}

size_t PopulationSkillDatabase::job_count() const
{
	return this->jobs_.size();
}
