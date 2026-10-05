// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Population engine YAML database implementations and config path helpers.

#include "population_config.hpp"

#include <algorithm>
#include <cstdio>
#include <initializer_list>
#include <string>

#include <common/core.hpp>
#include <common/utils.hpp>
#include <common/showmsg.hpp>

#include "../../battle.hpp"
#include "../../itemdb.hpp"
#include "../../pc.hpp"
#include "../../script.hpp"
#include "../../skill.hpp"

// ---------------------------------------------------------------------------
// Config path helpers
// ---------------------------------------------------------------------------

namespace {

constexpr char kEquipmentYaml[]   = "population_engine.yml";
constexpr char kPvpYaml[]         = "population_pvp.yml";
constexpr char kVendorPopYaml[]   = "population_vendor_pop.yml";
constexpr char kSharedYaml[]      = "population_gear_sets.yml";
constexpr char kChatYaml[]        = "population_chat.yml";
constexpr char kNamesYaml[]       = "population_names.yml";
constexpr char kSkillYaml[]       = "population_skill_db.yml";
constexpr char kSpawnYaml[]       = "population_spawn.yml";
constexpr char kVendorsYaml[]     = "population_vendors.yml";

static std::string population_config_join_db(const char *basename)
{
	return std::string(db_path) + "/" + basename;
}

} // namespace

int population_config_shell_hat_effect_id()
{
	return battle_config.population_engine_hat_effect;
}

std::string population_config_db_path_equipment_yaml()
{
	return population_config_join_db(kEquipmentYaml);
}

std::string population_config_db_path_pvp_yaml()
{
	return population_config_join_db(kPvpYaml);
}

std::string population_config_db_path_vendor_pop_yaml()
{
	return population_config_join_db(kVendorPopYaml);
}

std::string population_config_db_path_shared_yaml()
{
	return population_config_join_db(kSharedYaml);
}

std::string population_config_db_path_chat_yaml()
{
	return population_config_join_db(kChatYaml);
}

std::string population_config_db_path_names_yaml()
{
	return population_config_join_db(kNamesYaml);
}

std::string population_config_db_path_skill_yaml()
{
	return population_config_join_db(kSkillYaml);
}

std::string population_config_db_path_spawn_yaml()
{
	return population_config_join_db(kSpawnYaml);
}

std::string population_config_db_path_vendors_yaml()
{
	return population_config_join_db(kVendorsYaml);
}

// ---------------------------------------------------------------------------
// YAML database implementations (merged from population_yaml_databases.cpp)
// ---------------------------------------------------------------------------

PopulationEngine::~PopulationEngine()
{
	if (this->script != nullptr) {
		script_free_code(this->script);
		this->script = nullptr;
	}
}

namespace {

/// Build a bonus-script-safe copy of a Script: block by removing statements whose
/// first token is a side-effect command.  These commands call status_calc_pc or
/// pc_equipitem internally; running them from pc_bonus_script would re-enter
/// status_calc_pc and trigger "Unable to restore stack! Double continuation!".
/// Side-effects are handled once at spawn time via run_script instead.
static std::string make_bonus_script_str(const std::string& src) {
	static const char* const kSideEffects[] = {
		"setriding", "setfalcon", "setcart",
		"setarrow",  "setkunai",  "setbullet",
		nullptr
	};

	std::string out;
	out.reserve(src.size());
	size_t pos = 0;
	while (pos <= src.size()) {
		size_t semi = src.find(';', pos);
		if (semi == std::string::npos) semi = src.size();

		// Find first non-whitespace character in this statement.
		size_t s = pos;
		while (s < semi && (src[s] == ' ' || src[s] == '\t' || src[s] == '\r' || src[s] == '\n'))
			++s;

		bool skip = false;
		for (int i = 0; kSideEffects[i] != nullptr && !skip; ++i) {
			const char* cmd = kSideEffects[i];
			size_t len = strlen(cmd);
			if (semi - s >= len && src.compare(s, len, cmd) == 0) {
				// Ensure it isn't a longer identifier (e.g. "setriding2")
				size_t after = s + len;
				if (after >= semi || !(isalnum((unsigned char)src[after]) || src[after] == '_'))
					skip = true;
			}
		}

		// Keep non-empty, non-skipped statements (plus their semicolon).
		if (!skip && s < semi) {
			out.append(src, pos, semi - pos);
			out += ';';
		}

		if (semi >= src.size()) break;
		pos = semi + 1;
	}
	return out;
}

std::vector<std::string> g_pop_name_prefixes;
std::vector<std::string> g_pop_name_syl_start;
std::vector<std::string> g_pop_name_syl_mid;
std::vector<std::string> g_pop_name_syl_end;
std::vector<std::string> g_pop_name_adjectives;
std::vector<std::string> g_pop_name_nouns;
std::vector<std::string> g_pop_name_blocklist_lower;

void population_names_clear_globals()
{
	g_pop_name_prefixes.clear();
	g_pop_name_syl_start.clear();
	g_pop_name_syl_mid.clear();
	g_pop_name_syl_end.clear();
	g_pop_name_adjectives.clear();
	g_pop_name_nouns.clear();
	g_pop_name_blocklist_lower.clear();
}

void population_append_string_list(const ryml::NodeRef& parent, const char* key, std::vector<std::string>& out, bool lower_for_match = false)
{
	if (parent.num_children() == 0 || !parent.has_child(c4::to_csubstr(key)))
		return;
	const ryml::NodeRef& seq = parent[c4::to_csubstr(key)];
	if (!seq.is_seq())
		return;
	for (const ryml::NodeRef& it : seq.children()) {
		ryml::csubstr v = it.val();
		if (v.empty())
			continue;
		std::string s(v.data(), v.size());
		if (lower_for_match) {
			std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });
		}
		out.push_back(std::move(s));
	}
}

void population_append_string_list_top(const ryml::NodeRef& node, const char* key, std::vector<std::string>& out)
{
	if (node.num_children() == 0 || !node.has_child(c4::to_csubstr(key)))
		return;
	population_append_string_list(node, key, out);
}

bool population_eq_parse_behavior_str(const std::string& raw, PopulationBehavior& out)
{
	std::string s = raw;
	std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });
	if (s == "none") {
		out = PopulationBehavior::None;
		return true;
	}
	if (s == "wander") {
		out = PopulationBehavior::Wander;
		return true;
	}
	if (s == "combat") {
		out = PopulationBehavior::Combat;
		return true;
	}
	if (s == "support") {
		out = PopulationBehavior::Support;
		return true;
	}
	if (s == "sit") {
		out = PopulationBehavior::Sit;
		return true;
	}
	if (s == "social") {
		out = PopulationBehavior::Social;
		return true;
	}
	if (s == "vendor") {
		out = PopulationBehavior::Vendor;
		return true;
	}
	if (s == "guard") {
		out = PopulationBehavior::Guard;
		return true;
	}
	return false;
}

bool population_parse_name_strategy(const std::string& strat, PopulationNameProfile::Strategy& out)
{
	if (strat == "syllables") { out = PopulationNameProfile::Strategy::Syllables; return true; }
	if (strat == "adjective_noun" || strat == "adj_noun") { out = PopulationNameProfile::Strategy::AdjectiveNoun; return true; }
	if (strat == "pick_one") { out = PopulationNameProfile::Strategy::PickOne; return true; }
	if (strat == "bot_index") { out = PopulationNameProfile::Strategy::BotIndex; return true; }
	if (strat == "prefix_number") { out = PopulationNameProfile::Strategy::PrefixNumber; return true; }
	return false;
}

/// Job class name -> e_job ID. Shared by ArenaJobPool parsing and the
/// Profile.Jobs: map expansion path. Names are accepted with or without
/// internal spaces ("Lord Knight" matches "LordKnight" because parseBodyNode
/// strips spaces before lookup).
static const std::unordered_map<std::string, uint16_t> kJobNameMap = {
	// Base classes
	{ "Novice",          0    }, { "Swordsman",       1    }, { "Mage",           2    },
	{ "Archer",          3    }, { "Acolyte",         4    }, { "Merchant",        5    },
	{ "Thief",           6    }, { "Knight",          7    }, { "Priest",          8    },
	{ "Wizard",          9    }, { "Blacksmith",      10   }, { "Hunter",          11   },
	{ "Assassin",        12   }, { "Crusader",        14   }, { "Monk",            15   },
	{ "Sage",            16   }, { "Rogue",           17   }, { "Alchemist",       18   },
	{ "Bard",            19   }, { "Dancer",          20   }, { "SuperNovice",     23   },
	{ "Gunslinger",      24   }, { "Ninja",           25   },
	// Transcendent
	{ "HighNovice",      4001 }, { "HighSwordsman",   4002 }, { "HighMage",        4003 },
	{ "HighArcher",      4004 }, { "HighAcolyte",     4005 }, { "HighMerchant",    4006 },
	{ "HighThief",       4007 }, { "LordKnight",      4008 }, { "HighPriest",      4009 },
	{ "HighWizard",      4010 }, { "Whitesmith",      4011 }, { "Sniper",          4012 },
	{ "AssassinCross",   4013 }, { "Paladin",         4015 }, { "Champion",        4016 },
	{ "Professor",       4017 }, { "Stalker",         4018 }, { "Creator",         4019 },
	{ "Clown",           4020 }, { "Gypsy",           4021 },
	// Taekwon / SL / extended
	{ "Taekwon",         4046 }, { "StarGladiator",   4047 }, { "StarGladiatorUnion", 4048 },
	{ "SoulLinker",      4049 },
	// 3rd jobs (4054-4072; _T variants omitted from spawn names - base only)
	{ "RuneKnight",      4054 }, { "Warlock",         4055 }, { "Ranger",          4056 },
	{ "ArchBishop",      4057 }, { "Mechanic",        4058 }, { "GuillotineCross", 4059 },
	{ "RoyalGuard",      4066 }, { "Sorcerer",        4067 }, { "Minstrel",        4068 },
	{ "Wanderer",        4069 }, { "Sura",            4070 }, { "Genetic",         4071 },
	{ "ShadowChaser",    4072 },
	// 4th jobs (4252-4264 main line, 4302-4308 extended)
	{ "DragonKnight",    4252 }, { "Meister",         4253 }, { "ShadowCross",     4254 },
	{ "ArchMage",        4255 }, { "Cardinal",        4256 }, { "Windhawk",        4257 },
	{ "ImperialGuard",   4258 }, { "Biolo",           4259 }, { "AbyssChaser",     4260 },
	{ "ElementalMaster", 4261 }, { "Inquisitor",      4262 }, { "Troubadour",      4263 },
	{ "Trouvere",        4264 }, { "SkyEmperor",      4302 }, { "SoulAscetic",     4303 },
	{ "Shinkiro",        4304 }, { "Shiranui",        4305 }, { "NightWatch",      4306 },
	{ "HyperNovice",     4307 }, { "SpiritHandler",   4308 },
};

PopulationNamesDatabase g_population_names_db;
PopulationChatDatabase g_population_chat_db;
// The shared template DB is constructed first so the three job DBs can be
// wired to it via set_shared_source() before any load() call.
PopulationEngineDatabase g_population_shared_db("population_gear_sets.yml", /*reject_jobs=*/true);
PopulationEngineDatabase g_population_engine_db;                                  // db/population_engine.yml
PopulationEngineDatabase g_population_pvp_db("population_pvp.yml", /*reject_jobs=*/false, /*auto_arena_pool=*/true);                // db/population_pvp.yml
PopulationEngineDatabase g_population_vendor_pop_db("population_vendor_pop.yml");  // db/population_vendor_pop.yml
PopulationSkillDatabase g_population_skill_db;
PopulationSpawnDatabase g_population_spawn_db;
PopulationVendorDatabase g_population_vendor_db;

struct PopulationDbWiring {
	PopulationDbWiring() {
		g_population_engine_db.set_shared_source(&g_population_shared_db);
		g_population_pvp_db.set_shared_source(&g_population_shared_db);
		g_population_vendor_pop_db.set_shared_source(&g_population_shared_db);
	}
};
PopulationDbWiring g_population_db_wiring;

} // namespace

/// RAGNAROKMAC (Phase 3): resolve a job name (as written in the YAML profiles,
/// spaces optional, case-insensitive) to its job id, or 0 when unknown. Shared by
/// the profile loader and the @companion draft command, so the command accepts
/// exactly the spellings the profiles do.
///
/// Defined here, after the anonymous namespace, on purpose: kJobNameMap itself is
/// static inside that namespace (internal linkage). Defining this alongside it
/// produced a symbol nothing else could link against - the command in
/// atcommand.inc failed at link time with "undefined reference".
uint16_t population_engine_job_id_from_name(const char *name)
{
	if (name == nullptr || name[0] == '\0')
		return 0;
	std::string key(name);
	key.erase(std::remove(key.begin(), key.end(), ' '), key.end());
	for (const auto &entry : kJobNameMap) {
		if (entry.first.size() != key.size())
			continue;
		bool same = true;
		for (size_t i = 0; i < key.size(); ++i) {
			if (std::tolower(static_cast<unsigned char>(entry.first[i])) !=
				std::tolower(static_cast<unsigned char>(key[i]))) {
				same = false;
				break;
			}
		}
		if (same)
			return entry.second;
	}
	return 0;
}

PopulationNamesDatabase& population_names_db()
{
	return g_population_names_db;
}

PopulationChatDatabase& population_chat_db()
{
	return g_population_chat_db;
}

PopulationEngineDatabase& population_engine_db()
{
	return g_population_engine_db;
}

PopulationEngineDatabase& population_pvp_db()
{
	return g_population_pvp_db;
}

PopulationEngineDatabase& population_vendor_pop_db()
{
	return g_population_vendor_pop_db;
}

PopulationEngineDatabase& population_shared_db()
{
	return g_population_shared_db;
}

PopulationEngineDatabase& population_engine_db_for(PopulationDbSource src)
{
	switch (src) {
		case PopulationDbSource::Pvp:    return g_population_pvp_db;
		case PopulationDbSource::Vendor: return g_population_vendor_pop_db;
		case PopulationDbSource::Main:
		default:                         return g_population_engine_db;
	}
}

std::shared_ptr<PopulationEngine> population_engine_find_any(uint16_t job_id, PopulationDbSource* out_src)
{
	if (auto p = g_population_engine_db.find(job_id)) {
		if (out_src) *out_src = PopulationDbSource::Main;
		return p;
	}
	if (auto p = g_population_pvp_db.find(job_id)) {
		if (out_src) *out_src = PopulationDbSource::Pvp;
		return p;
	}
	if (auto p = g_population_vendor_pop_db.find(job_id)) {
		if (out_src) *out_src = PopulationDbSource::Vendor;
		return p;
	}
	if (out_src) *out_src = PopulationDbSource::Main;
	return nullptr;
}

PopulationEngineDatabase& population_engine_db_for_shell(const map_session_data* sd)
{
	if (sd == nullptr)
		return g_population_engine_db;
	return population_engine_db_for(static_cast<PopulationDbSource>(sd->pop.db_source));
}

PopulationSkillDatabase& population_skill_db()
{
	return g_population_skill_db;
}

PopulationSpawnDatabase& population_spawn_db()
{
	return g_population_spawn_db;
}

PopulationVendorDatabase& population_vendor_db()
{
	return g_population_vendor_db;
}

// ---------------------------------------------------------------------------
// PopulationVendorDatabase implementation
// ---------------------------------------------------------------------------

PopulationVendorDatabase::PopulationVendorDatabase()
	: YamlDatabase("POPULATION_VENDORS_DB", 1)
{
}

void PopulationVendorDatabase::clear()
{
	entries_.clear();
	placements_by_map_.clear();
}

const std::string PopulationVendorDatabase::getDefaultLocation()
{
	return population_config_db_path_vendors_yaml();
}

uint64 PopulationVendorDatabase::parseBodyNode(const ryml::NodeRef& node)
{
	std::string key;
	// RAGNAROKMAC: a Market entry: spots plus a weighted list of themes.
	const bool is_market = this->nodeExists(node, "Market");
	if (is_market) {
		if (!this->asString(node, "Market", key) || key.empty())
			return 0;
	} else if (!this->asString(node, "VendorKey", key) || key.empty()) {
		return 0;
	}

	PopulationVendorEntry entry;
	entry.key = key;
	entry.is_market = is_market;
	if (is_market) {
		if (this->nodeExists(node, "Themes") && node[c4::to_csubstr("Themes")].is_seq()) {
			for (const ryml::NodeRef& tn : node[c4::to_csubstr("Themes")].children()) {
				PopulationMarketTheme t;
				if (!this->asString(tn, "Theme", t.key) || t.key.empty()) {
					this->invalidWarning(tn, "Market '%s': a Themes entry needs Theme; skipped.\n", key.c_str());
					continue;
				}
				int32_t v = 0;
				if (this->nodeExists(tn, "Weight") && this->asInt32(tn, "Weight", v)) t.weight = std::max(0, v);
				if (this->nodeExists(tn, "Min") && this->asInt32(tn, "Min", v)) t.min = std::max(0, v);
				if (this->nodeExists(tn, "Max") && this->asInt32(tn, "Max", v)) t.max = std::max(0, v);
				entry.themes.push_back(std::move(t));
			}
		}
		if (entry.themes.empty())
			this->invalidWarning(node, "Market '%s' has no Themes; it will stay empty.\n", key.c_str());
		if (!this->nodeExists(node, "Spawns"))
			this->invalidWarning(node, "Market '%s' has no Spawns; it will stay empty.\n", key.c_str());
	}

	if (this->nodeExists(node, "Title")) {
		std::string title;
		if (this->asString(node, "Title", title))
			entry.title = title;
	}

	if (this->nodeExists(node, "Type")) {
		std::string type_str;
		if (this->asString(node, "Type", type_str)) {
			std::transform(type_str.begin(), type_str.end(), type_str.begin(),
				[](unsigned char c) { return static_cast<char>(::tolower(c)); });
			if (type_str == "dynamic")
				entry.type = PopulationVendorType::Dynamic;
			else if (type_str == "pool") // RAGNAROKMAC
				entry.type = PopulationVendorType::Pool;
			else if (type_str == "static" || type_str.empty())
				entry.type = PopulationVendorType::Static;
			else
				this->invalidWarning(node[c4::to_csubstr("Type")],
					"VendorKey '%s': Type must be 'static', 'dynamic', or 'pool' (got '%s'); defaulting to static.\n",
					key.c_str(), type_str.c_str());
		}
	}

	if (this->nodeExists(node, "MaxSlots")) {
		int32_t max_slots = 12;
		if (this->asInt32(node, "MaxSlots", max_slots))
			entry.max_slots = std::max(1, std::min(12, max_slots));
	}

	if (this->nodeExists(node, "PriceMultiplier")) {
		uint32_t price_mult = 100;
		if (this->asUInt32(node, "PriceMultiplier", price_mult))
			entry.price_multiplier = price_mult;
	}

	// Dynamic-mode source pool: explicit map list (overrides SourceCategory).
	if (this->nodeExists(node, "SourceMaps")) {
		const ryml::NodeRef& sm_node = node[c4::to_csubstr("SourceMaps")];
		if (sm_node.is_seq()) {
			for (const ryml::NodeRef& mn : sm_node.children()) {
				std::string mname;
				if (ryml::read(mn, &mname) && !mname.empty())
					entry.source_maps.push_back(mname);
			}
		}
	}

	if (this->nodeExists(node, "SourceCategory")) {
		std::string cat;
		if (this->asString(node, "SourceCategory", cat)) {
			std::transform(cat.begin(), cat.end(), cat.begin(),
				[](unsigned char c) { return static_cast<char>(::tolower(c)); });
			if (cat == "dungeon" || cat == "field" || cat == "both")
				entry.source_category = cat;
			else
				this->invalidWarning(node[c4::to_csubstr("SourceCategory")],
					"VendorKey '%s': SourceCategory must be 'dungeon', 'field', or 'both' (got '%s').\n",
					key.c_str(), cat.c_str());
		}
	}

	if (this->nodeExists(node, "RandomizePerShell")) {
		bool rps = false;
		if (this->asBool(node, "RandomizePerShell", rps))
			entry.randomize_per_shell = rps;
	}

	// ItemFlags block: control which item types qualify for dynamic stock.
	if (this->nodeExists(node, "ItemFlags")) {
		const ryml::NodeRef& flags_node = node[c4::to_csubstr("ItemFlags")];
		if (flags_node.is_map()) {
			bool b;
			if (this->nodeExists(flags_node, "AllowEquipment") && this->asBool(flags_node, "AllowEquipment", b))
				entry.allow_equipment = b;
			if (this->nodeExists(flags_node, "AllowCards")     && this->asBool(flags_node, "AllowCards",     b))
				entry.allow_cards = b;
			if (this->nodeExists(flags_node, "AllowEtc")       && this->asBool(flags_node, "AllowEtc",       b))
				entry.allow_etc = b;
			if (this->nodeExists(flags_node, "AllowUsable")    && this->asBool(flags_node, "AllowUsable",    b))
				entry.allow_usable = b;
		}
	}

	// MaxAmount: [min, max] — randomize per-item stack size in dynamic mode.
	// Accepts a 2-element sequence [lo, hi] or a single scalar (treated as [1, n]).
	if (this->nodeExists(node, "MaxAmount")) {
		const ryml::NodeRef& ma_node = node[c4::to_csubstr("MaxAmount")];
		int32_t lo = 0, hi = 0;
		if (ma_node.is_seq()) {
			int idx = 0;
			for (const ryml::NodeRef& mn : ma_node.children()) {
				int32_t v = 0;
				if (!ryml::read(mn, &v)) continue;
				if (idx == 0) lo = v;
				else if (idx == 1) hi = v;
				++idx;
			}
		} else {
			int32_t v = 0;
			if (this->asInt32(node, "MaxAmount", v)) { lo = 1; hi = v; }
		}
		if (lo < 1) lo = 1;
		if (hi < lo) hi = lo;
		// Hard cap against MAX_AMOUNT (30000 in rAthena, but stay safe).
		if (hi > 30000) hi = 30000;
		entry.dyn_amount_min = lo;
		entry.dyn_amount_max = hi;
	}

	// Parse Stock: sequence (used by static vendors).
	if (entry.type == PopulationVendorType::Static && this->nodeExists(node, "Stock")) {
		const ryml::NodeRef& stock_node = node[c4::to_csubstr("Stock")];
		if (stock_node.is_seq()) {
			for (const ryml::NodeRef& sn : stock_node.children()) {
				PopulationVendorStock vs;

				// Item: AegisName or numeric ID.
				std::string item_str;
				if (this->asString(sn, "Item", item_str) && !item_str.empty()) {
					bool all_digits = !item_str.empty();
					for (char c : item_str)
						if (!std::isdigit(static_cast<unsigned char>(c))) { all_digits = false; break; }

					if (all_digits) {
						try {
							const unsigned long v = std::stoul(item_str);
							if (v == 0 || v > 65535UL) {
								this->invalidWarning(sn[c4::to_csubstr("Item")],
									"Invalid numeric item id '%s' in VendorKey '%s'.\n",
									item_str.c_str(), key.c_str());
								continue;
							}
							vs.nameid = static_cast<t_itemid>(v);
						} catch (...) {
							continue;
						}
					} else {
						auto idata = item_db.searchname(item_str.c_str());
						if (!idata) {
							this->invalidWarning(sn[c4::to_csubstr("Item")],
								"Unknown item AegisName '%s' in VendorKey '%s'.\n",
								item_str.c_str(), key.c_str());
							continue;
						}
						vs.nameid = static_cast<t_itemid>(idata->nameid);
					}
				} else {
					uint16_t item_id = 0;
					if (!this->asUInt16(sn, "Item", item_id) || item_id == 0)
						continue;
					vs.nameid = static_cast<t_itemid>(item_id);
				}

				if (!item_db.find(vs.nameid)) {
					this->invalidWarning(sn[c4::to_csubstr("Item")],
						"Item id %u not found in item_db (VendorKey '%s').\n",
						static_cast<unsigned>(vs.nameid), key.c_str());
					continue;
				}

				if (this->nodeExists(sn, "Amount")) {
					int16_t amount = 1;
					if (this->asInt16(sn, "Amount", amount))
						vs.amount = std::max(static_cast<int16_t>(1), amount);
				}

				if (this->nodeExists(sn, "Price")) {
					uint32_t price = 0;
					if (this->asUInt32(sn, "Price", price))
						vs.price = price;
				}

				entry.stock.push_back(vs);
			}
		}
	}

	// RAGNAROKMAC: Pool-type parsing. A Pool vendor carries a themed superset
	// in Pool: (same shape as Stock:), picks PickCount items per shell, and
	// optionally rotates every RotationHours (±RotationJitterMinutes).
	// TitleFromPool: lets each shell pick a shop title from a list so the
	// market reads like a dozen different players rather than one.
	auto parse_vendor_stock_item = [&](const ryml::NodeRef& sn, PopulationVendorStock& vs) -> bool {
		std::string item_str;
		if (this->asString(sn, "Item", item_str) && !item_str.empty()) {
			bool all_digits = true;
			for (char c : item_str)
				if (!std::isdigit(static_cast<unsigned char>(c))) { all_digits = false; break; }
			if (all_digits) {
				try {
					const unsigned long v = std::stoul(item_str);
					if (v == 0 || v > 65535UL) return false;
					vs.nameid = static_cast<t_itemid>(v);
				} catch (...) { return false; }
			} else {
				auto idata = item_db.searchname(item_str.c_str());
				if (!idata) {
					this->invalidWarning(sn[c4::to_csubstr("Item")],
						"Unknown item AegisName '%s' in VendorKey '%s' Pool.\n",
						item_str.c_str(), key.c_str());
					return false;
				}
				vs.nameid = static_cast<t_itemid>(idata->nameid);
			}
		} else {
			uint16_t item_id = 0;
			if (!this->asUInt16(sn, "Item", item_id) || item_id == 0) return false;
			vs.nameid = static_cast<t_itemid>(item_id);
		}
		if (!item_db.find(vs.nameid)) {
			this->invalidWarning(sn[c4::to_csubstr("Item")],
				"Item id %u not found in item_db (VendorKey '%s' Pool).\n",
				static_cast<unsigned>(vs.nameid), key.c_str());
			return false;
		}
		if (this->nodeExists(sn, "Amount")) {
			int16_t amount = 1;
			if (this->asInt16(sn, "Amount", amount))
				vs.amount = std::max(static_cast<int16_t>(1), amount);
		}
		if (this->nodeExists(sn, "Price")) {
			const ryml::NodeRef& pn = sn[c4::to_csubstr("Price")];
			if (pn.is_seq()) {
				// RAGNAROKMAC: Price: [min, max], rolled per shell.
				int64_t lo = 0, hi = 0;
				if (pn.num_children() == 2 && ryml::read(pn[0], &lo) && ryml::read(pn[1], &hi) && lo >= 1 && hi >= 1) {
					if (hi < lo) std::swap(lo, hi);
					vs.price = static_cast<uint32_t>(std::min<int64_t>(lo, MAX_ZENY));
					vs.price_max = static_cast<uint32_t>(std::min<int64_t>(hi, MAX_ZENY));
				} else {
					this->invalidWarning(pn, "VendorKey '%s': Price range must be [min, max], both 1 or more.\n", key.c_str());
				}
			} else {
				uint32_t price = 0;
				if (this->asUInt32(sn, "Price", price))
					vs.price = price;
			}
		}

		// RAGNAROKMAC: refine, forged element and cards, so a stall can sell what a
		// player's cart really holds (+7 Stiletto, Fire Stiletto, a carded Guard).
		std::shared_ptr<item_data> sid = item_db.find(vs.nameid);
		const bool is_gear = sid && (sid->type == IT_WEAPON || sid->type == IT_ARMOR);
		if (this->nodeExists(sn, "Refine")) {
			const ryml::NodeRef& rn = sn[c4::to_csubstr("Refine")];
			int32_t lo = 0, hi = 0;
			if (rn.is_seq() && rn.num_children() == 2) {
				ryml::read(rn[0], &lo);
				ryml::read(rn[1], &hi);
			} else if (this->asInt32(sn, "Refine", lo)) {
				hi = lo;
			}
			if (!is_gear || sid->flag.no_refine) {
				this->invalidWarning(rn, "VendorKey '%s': %s cannot be refined; Refine ignored.\n",
					key.c_str(), sid ? sid->name.c_str() : "item");
			} else {
				lo = std::max(0, std::min(MAX_REFINE, lo));
				hi = std::max(0, std::min(MAX_REFINE, hi));
				if (hi < lo) std::swap(lo, hi);
				vs.refine_min = static_cast<uint8_t>(lo);
				vs.refine_max = static_cast<uint8_t>(hi);
			}
		}
		if (this->nodeExists(sn, "Element")) {
			std::string ele;
			this->asString(sn, "Element", ele);
			std::transform(ele.begin(), ele.end(), ele.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });
			uint8_t e = 0;
			if (ele == "water" || ele == "ice") e = ELE_WATER;
			else if (ele == "earth") e = ELE_EARTH;
			else if (ele == "fire") e = ELE_FIRE;
			else if (ele == "wind") e = ELE_WIND;
			if (e == 0 || !sid || sid->type != IT_WEAPON) {
				this->invalidWarning(sn[c4::to_csubstr("Element")],
					"VendorKey '%s': Element must be Water, Earth, Fire or Wind on a weapon; ignored.\n", key.c_str());
			} else {
				vs.element = e;
			}
		}
		if (this->nodeExists(sn, "Stars")) {
			int32_t st = 0;
			if (this->asInt32(sn, "Stars", st))
				vs.stars = static_cast<uint8_t>(std::max(0, std::min(3, st)));
			if (vs.stars > 0 && (!sid || sid->type != IT_WEAPON))
				vs.stars = 0;
		}
		if (this->nodeExists(sn, "Cards")) {
			const ryml::NodeRef& cn = sn[c4::to_csubstr("Cards")];
			if (vs.element != 0 || vs.stars != 0) {
				this->invalidWarning(cn, "VendorKey '%s': a forged weapon has no card slots; Cards ignored.\n", key.c_str());
			} else if (cn.is_seq()) {
				for (const ryml::NodeRef& c : cn.children()) {
					std::string cname;
					c4::csubstr v = c.val();
					cname.assign(v.str, v.len);
					auto cdata = item_db.searchname(cname.c_str());
					if (!cdata || cdata->type != IT_CARD) {
						this->invalidWarning(c, "VendorKey '%s': '%s' is not a card; skipped.\n", key.c_str(), cname.c_str());
						continue;
					}
					if (sid && vs.cards.size() >= sid->slots) {
						this->invalidWarning(c, "VendorKey '%s': %s has only %u slot(s); extra card skipped.\n",
							key.c_str(), sid->name.c_str(), static_cast<unsigned>(sid->slots));
						continue;
					}
					vs.cards.push_back(static_cast<t_itemid>(cdata->nameid));
				}
			}
		}
		return true;
	};

	if (entry.type == PopulationVendorType::Pool && this->nodeExists(node, "Pool")) {
		const ryml::NodeRef& pool_node = node[c4::to_csubstr("Pool")];
		if (pool_node.is_seq()) {
			for (const ryml::NodeRef& sn : pool_node.children()) {
				PopulationVendorStock vs;
				if (parse_vendor_stock_item(sn, vs))
					entry.pool.push_back(vs);
			}
		}
	}

	// PickCount: [min, max] or a single scalar (treated as [n, n]).
	if (this->nodeExists(node, "PickCount")) {
		const ryml::NodeRef& pc_node = node[c4::to_csubstr("PickCount")];
		int32_t lo = 0, hi = 0;
		if (pc_node.is_seq()) {
			int idx = 0;
			for (const ryml::NodeRef& mn : pc_node.children()) {
				int32_t v = 0;
				if (!ryml::read(mn, &v)) continue;
				if (idx == 0) lo = v;
				else if (idx == 1) hi = v;
				++idx;
			}
		} else {
			int32_t v = 0;
			if (this->asInt32(node, "PickCount", v)) { lo = v; hi = v; }
		}
		if (lo < 1) lo = 1;
		if (hi < lo) hi = lo;
		if (hi > 12) hi = 12; // MC_VENDING lv10 cap
		if (lo > 12) lo = 12;
		entry.pick_count_min = lo;
		entry.pick_count_max = hi;
	}

	// RotationHours: 0 = never rotate. Internally stored as seconds.
	if (this->nodeExists(node, "RotationHours")) {
		int32_t h = 0;
		if (this->asInt32(node, "RotationHours", h) && h > 0) {
			if (h > 168) h = 168; // one week ceiling to keep t_tick arithmetic sane
			entry.rotation_sec = h * 3600;
		}
	}
	// RAGNAROKMAC: Buying: true -- a buying store instead of a vending stall.
	if (this->nodeExists(node, "Buying")) {
		bool b = false;
		if (this->asBool(node, "Buying", b))
			entry.buying = b;
	}

	// RAGNAROKMAC: Undercut: { Chance: pct, StepPct: [min, max] }.
	if (this->nodeExists(node, "Undercut")) {
		const ryml::NodeRef& un = node[c4::to_csubstr("Undercut")];
		int32_t chance = 0;
		if (this->nodeExists(un, "Chance") && this->asInt32(un, "Chance", chance))
			entry.undercut_chance = std::max(0, std::min(100, chance));
		int32_t lo = 1, hi = 5;
		if (this->nodeExists(un, "StepPct")) {
			const ryml::NodeRef& sn2 = un[c4::to_csubstr("StepPct")];
			if (sn2.is_seq() && sn2.num_children() == 2) {
				ryml::read(sn2[0], &lo);
				ryml::read(sn2[1], &hi);
			} else if (this->asInt32(un, "StepPct", lo)) {
				hi = lo;
			}
		}
		if (hi < lo) std::swap(lo, hi);
		entry.undercut_step_min = std::max(0, std::min(90, lo));
		entry.undercut_step_max = std::max(0, std::min(90, hi));
	}

	// RAGNAROKMAC: Callouts: { EverySeconds: [min, max], MapGapSeconds: n }.
	if (this->nodeExists(node, "Callouts")) {
		const ryml::NodeRef& cn = node[c4::to_csubstr("Callouts")];
		if (this->nodeExists(cn, "EverySeconds")) {
			const ryml::NodeRef& en = cn[c4::to_csubstr("EverySeconds")];
			int32_t lo = 0, hi = 0;
			if (en.is_seq() && en.num_children() == 2) {
				ryml::read(en[0], &lo);
				ryml::read(en[1], &hi);
			} else if (this->asInt32(cn, "EverySeconds", lo)) {
				hi = lo;
			}
			if (hi < lo) std::swap(lo, hi);
			entry.callout_min_sec = std::max(0, lo);
			entry.callout_max_sec = std::max(0, hi);
		}
		if (this->nodeExists(cn, "MapGapSeconds")) {
			int32_t g = 0;
			if (this->asInt32(cn, "MapGapSeconds", g))
				entry.callout_map_gap_sec = std::max(0, g);
		}
	}

	// RotationMinutes: the same in minutes, for short cycles (testing, busy
	// markets). Wins over RotationHours when both are given.
	if (this->nodeExists(node, "RotationMinutes")) {
		int32_t m = 0;
		if (this->asInt32(node, "RotationMinutes", m) && m > 0) {
			if (m > 168 * 60) m = 168 * 60;
			entry.rotation_sec = m * 60;
		}
	}

	// RotationJitterMinutes: per-shell ± offset so vendors don't rotate in lockstep.
	if (this->nodeExists(node, "RotationJitterMinutes")) {
		int32_t m = 0;
		if (this->asInt32(node, "RotationJitterMinutes", m) && m > 0) {
			if (m > 180) m = 180; // cap at 3 hours of jitter
			entry.rotation_jitter_sec = m * 60;
		}
	}

	// PriceJitterPct: per-item price variation (0-90). 0 = fixed price.
	if (this->nodeExists(node, "PriceJitterPct")) {
		int32_t j = 0;
		if (this->asInt32(node, "PriceJitterPct", j)) {
			if (j < 0) j = 0;
			if (j > 90) j = 90; // beyond this prices swing wildly; cap it
			entry.price_jitter_pct = j;
		}
	}

	// PriceMistakeOneIn: 1-in-N chance per item of a "fat-finger" (price / 10).
	// 0 = never. Keep N large (thousands) so it stays a rare surprise.
	if (this->nodeExists(node, "PriceMistakeOneIn")) {
		int32_t n = 0;
		if (this->asInt32(node, "PriceMistakeOneIn", n) && n > 0)
			entry.price_mistake_one_in = n;
	}

	// TitleFromPool: sequence of shop-title strings; shell picks one at spawn.
	if (this->nodeExists(node, "TitleFromPool")) {
		const ryml::NodeRef& tp_node = node[c4::to_csubstr("TitleFromPool")];
		if (tp_node.is_seq()) {
			for (const ryml::NodeRef& tn : tp_node.children()) {
				std::string t;
				if (ryml::read(tn, &t) && !t.empty())
					entry.title_pool.push_back(t);
			}
		}
	}

	// RAGNAROKMAC: StockTitles: signs that name what is for sale, used only when
	// a stall's own pick bears them out (Needs: all of these, Any: one of
	// these), with {item} and {price} filled from its stock. They join the
	// TitleFromPool signs at that moment. Older builds ignore the key and show
	// TitleFromPool alone, so a mod keeps item names out of that list.
	if (this->nodeExists(node, "StockTitles")) {
		const ryml::NodeRef& st_node = node[c4::to_csubstr("StockTitles")];
		if (st_node.is_seq()) {
			for (const ryml::NodeRef& tn : st_node.children()) {
				PopulationStockTitle st;
				if (!this->asString(tn, "Title", st.text) || st.text.empty()) {
					this->invalidWarning(tn, "VendorKey '%s': a StockTitles entry needs Title; skipped.\n", key.c_str());
					continue;
				}
				std::string unknown;
				auto read_items = [&](const char* field, std::vector<t_itemid>& out) {
					if (!this->nodeExists(tn, field))
						return;
					const ryml::NodeRef& ln = tn[c4::to_csubstr(field)];
					if (!ln.is_seq())
						return;
					for (const ryml::NodeRef& in : ln.children()) {
						std::string name;
						if (!ryml::read(in, &name) || name.empty())
							continue;
						if (auto idata = item_db.searchname(name.c_str()))
							out.push_back(static_cast<t_itemid>(idata->nameid));
						else if (unknown.empty())
							unknown = name;
					}
				};
				read_items("Needs", st.needs);
				read_items("Any", st.any);
				if (!unknown.empty()) {
					this->invalidWarning(tn, "VendorKey '%s': StockTitles \"%s\" names unknown item '%s'; skipped.\n",
						key.c_str(), st.text.c_str(), unknown.c_str());
					continue;
				}
				entry.stock_titles.push_back(std::move(st));
			}
		}
	}

	// RAGNAROKMAC: Spawns: makes this a *mod vendor*. Its shells come from the mod
	// vendor pass, never from VendorPlacement, so a mod cannot change where or how
	// many of the engine's own vendors (or another mod's) appear. Each block is
	// either fixed seats (Positions) or Count + Areas.
	const bool has_spawns = this->nodeExists(node, "Spawns");
	if (has_spawns) {
		const ryml::NodeRef& sp_node = node[c4::to_csubstr("Spawns")];
		if (!sp_node.is_seq()) {
			this->invalidWarning(sp_node, "VendorKey '%s': Spawns must be a list.\n", key.c_str());
		} else {
			auto read_area = [&](const ryml::NodeRef& an, PopulationModSpawnArea& out) -> bool {
				int16_t x1 = -1, y1 = -1, x2 = -1, y2 = -1;
				if (!this->nodeExists(an, "X1") || !this->asInt16(an, "X1", x1)) return false;
				if (!this->nodeExists(an, "Y1") || !this->asInt16(an, "Y1", y1)) return false;
				if (!this->nodeExists(an, "X2") || !this->asInt16(an, "X2", x2)) return false;
				if (!this->nodeExists(an, "Y2") || !this->asInt16(an, "Y2", y2)) return false;
				if (x1 < 0 || y1 < 0 || x2 < 0 || y2 < 0) return false;
				if (x1 > x2) std::swap(x1, x2);
				if (y1 > y2) std::swap(y1, y2);
				out.x1 = x1; out.y1 = y1; out.x2 = x2; out.y2 = y2;
				return true;
			};
			int idx = 0;
			for (const ryml::NodeRef& sn : sp_node.children()) {
				PopulationModSpawn sp;
				if (!this->asString(sn, "Map", sp.map) || sp.map.empty()) {
					this->invalidWarning(sn, "VendorKey '%s': a Spawns entry needs Map; skipped.\n", key.c_str());
					continue;
				}
				const bool has_pos = this->nodeExists(sn, "Positions");
				const bool has_cnt = this->nodeExists(sn, "Count") || this->nodeExists(sn, "Areas") || this->nodeExists(sn, "Area");
				if (has_pos == has_cnt) {
					this->invalidWarning(sn, "VendorKey '%s': a Spawns entry needs either Positions, or Count with Areas — not both, not neither; skipped.\n", key.c_str());
					continue;
				}
				if (has_pos) {
					const ryml::NodeRef& pn = sn[c4::to_csubstr("Positions")];
					if (pn.is_seq()) {
						for (const ryml::NodeRef& cell : pn.children()) {
							int32_t x = -1, y = -1;
							if (!cell.is_seq() || cell.num_children() != 2 ||
							    !ryml::read(cell[0], &x) || !ryml::read(cell[1], &y) || x < 0 || y < 0) {
								this->invalidWarning(cell, "VendorKey '%s': a Position must be [x, y]; skipped.\n", key.c_str());
								continue;
							}
							sp.positions.emplace_back(static_cast<int16_t>(x), static_cast<int16_t>(y));
						}
					}
					if (sp.positions.empty()) {
						this->invalidWarning(sn, "VendorKey '%s': Spawns entry on %s has no valid Positions; skipped.\n", key.c_str(), sp.map.c_str());
						continue;
					}
				} else {
					int32_t c = 0;
					if (!this->nodeExists(sn, "Count") || !this->asInt32(sn, "Count", c) || c < 1) {
						this->invalidWarning(sn, "VendorKey '%s': Spawns entry on %s needs Count >= 1; skipped.\n", key.c_str(), sp.map.c_str());
						continue;
					}
					sp.count = c;
					if (this->nodeExists(sn, "Areas")) {
						const ryml::NodeRef& an = sn[c4::to_csubstr("Areas")];
						if (an.is_seq()) {
							for (const ryml::NodeRef& a : an.children()) {
								PopulationModSpawnArea ar;
								if (read_area(a, ar)) sp.areas.push_back(ar);
								else this->invalidWarning(a, "VendorKey '%s': an Area needs X1, Y1, X2, Y2 >= 0; skipped.\n", key.c_str());
							}
						}
					} else {
						PopulationModSpawnArea ar;
						if (read_area(sn[c4::to_csubstr("Area")], ar)) sp.areas.push_back(ar);
					}
					if (sp.areas.empty()) {
						this->invalidWarning(sn, "VendorKey '%s': Spawns entry on %s has no valid Areas; skipped.\n", key.c_str(), sp.map.c_str());
						continue;
					}
				}
				if (this->nodeExists(sn, "MinSpacing")) {
					int32_t s = 0;
					if (this->asInt32(sn, "MinSpacing", s)) sp.min_spacing = std::max(0, s);
				}
				if (this->nodeExists(sn, "ScaleWithDensity")) {
					bool b = false;
					if (this->asBool(sn, "ScaleWithDensity", b)) sp.scale_with_density = b;
				}
				// RAGNAROKMAC: Fill: Lanes fills the Areas one at a time, in the
				// order listed, each shell beside another; Random (the default)
				// spreads them over all of them.
				if (this->nodeExists(sn, "Fill")) {
					std::string fill;
					if (this->asString(sn, "Fill", fill)) {
						std::transform(fill.begin(), fill.end(), fill.begin(), ::tolower);
						if (fill == "lanes")
							sp.fill_lanes = true;
						else if (fill != "random")
							this->invalidWarning(sn, "VendorKey '%s': Fill must be Lanes or Random; using Random.\n", key.c_str());
					}
				}
				// RAGNAROKMAC: LaneFillPct: N or [min, max] (1-100): with Fill: Lanes,
				// the share of a lane's usable cells its shells take before the next
				// lane opens, rolled per lane. 100, the default, fills each lane.
				if (this->nodeExists(sn, "LaneFillPct")) {
					const ryml::NodeRef& pn = sn[c4::to_csubstr("LaneFillPct")];
					int32_t lo = 100, hi = 100;
					bool ok = false;
					if (pn.is_seq() && pn.num_children() == 2)
						ok = ryml::read(pn[0], &lo) && ryml::read(pn[1], &hi);
					else if (pn.has_val())
						ok = ryml::read(pn, &lo) && ((hi = lo), true);
					if (ok) {
						if (lo > hi) std::swap(lo, hi);
						sp.lane_fill_min = std::max(1, std::min(100, static_cast<int>(lo)));
						sp.lane_fill_max = std::max(1, std::min(100, static_cast<int>(hi)));
					} else {
						this->invalidWarning(sn, "VendorKey '%s': LaneFillPct must be a number or [min, max]; using 100.\n", key.c_str());
					}
				}
				sp.spawn_id = key + "#" + sp.map + "#" + std::to_string(idx++);
				entry.spawns.push_back(std::move(sp));
			}
		}
		if (this->nodeExists(node, "VendorPlacement"))
			this->invalidWarning(node[c4::to_csubstr("VendorPlacement")],
				"VendorKey '%s': has Spawns, so its VendorPlacement is ignored (mod vendors place themselves).\n", key.c_str());
	}

	// VendorPlacement: optional per-vendor placement constraint (Map / MinSpacing /
	// MaxVendors / Area). Populates the derived placements_by_map_ index used by
	// the autosummon pass and the cell picker. If multiple vendor entries name the
	// same Map, the last one parsed wins (a warning is emitted).
	if (!has_spawns && this->nodeExists(node, "VendorPlacement")) {
		const ryml::NodeRef& vp_node = node[c4::to_csubstr("VendorPlacement")];
		auto parse_one_vp = [&](const ryml::NodeRef& entry_node) {
			std::string map_name;
			if (!this->asString(entry_node, "Map", map_name) || map_name.empty())
				return;
			PopulationVendorPlacement p;
			p.map = map_name;
			if (this->nodeExists(entry_node, "MinSpacing")) {
				int32_t s = 0;
				if (this->asInt32(entry_node, "MinSpacing", s)) p.min_spacing = std::max(0, s);
			}
			if (this->nodeExists(entry_node, "MaxVendors")) {
				int32_t mv = 0;
				if (this->asInt32(entry_node, "MaxVendors", mv)) p.max_vendors = std::max(0, mv);
			}
			if (this->nodeExists(entry_node, "Area")) {
				const ryml::NodeRef& area = entry_node[c4::to_csubstr("Area")];
				int16_t x1 = -1, y1 = -1, x2 = -1, y2 = -1;
				if (this->nodeExists(area, "X1")) this->asInt16(area, "X1", x1);
				if (this->nodeExists(area, "Y1")) this->asInt16(area, "Y1", y1);
				if (this->nodeExists(area, "X2")) this->asInt16(area, "X2", x2);
				if (this->nodeExists(area, "Y2")) this->asInt16(area, "Y2", y2);
				// Normalize swapped corners (e.g. user supplied Y1=149, Y2=46).
				if (x1 >= 0 && x2 >= 0 && x1 > x2) std::swap(x1, x2);
				if (y1 >= 0 && y2 >= 0 && y1 > y2) std::swap(y1, y2);
				p.area_x1 = x1; p.area_y1 = y1; p.area_x2 = x2; p.area_y2 = y2;
			}
			if (placements_by_map_.find(map_name) != placements_by_map_.end()) {
				const PopulationVendorPlacement &existing = placements_by_map_[map_name];
				const bool identical =
					existing.min_spacing == p.min_spacing &&
					existing.max_vendors == p.max_vendors &&
					existing.area_x1 == p.area_x1 && existing.area_y1 == p.area_y1 &&
					existing.area_x2 == p.area_x2 && existing.area_y2 == p.area_y2;
				if (!identical) {
					ShowWarning("VendorKey '%s': VendorPlacement Map '%s' already defined by another "
					            "vendor entry with different settings; overwriting (placements are "
					            "unioned per map).\n",
					            key.c_str(), map_name.c_str());
				}
			}
			placements_by_map_[map_name] = std::move(p);
		};
		if (vp_node.is_seq()) {
			for (const ryml::NodeRef& en : vp_node.children())
				parse_one_vp(en);
		} else if (vp_node.is_map()) {
			parse_one_vp(vp_node);
		}
	}

	entries_[key] = std::move(entry);
	return 1;
}

const PopulationVendorEntry* PopulationVendorDatabase::find(const std::string& key) const
{
	auto it = entries_.find(key);
	return it != entries_.end() ? &it->second : nullptr;
}

size_t PopulationVendorDatabase::entry_count() const
{
	return entries_.size();
}

const std::vector<std::string>& population_yaml_name_global_prefixes()
{
	return g_pop_name_prefixes;
}

const std::vector<std::string>& population_yaml_name_syl_start()
{
	return g_pop_name_syl_start;
}

const std::vector<std::string>& population_yaml_name_syl_mid()
{
	return g_pop_name_syl_mid;
}

const std::vector<std::string>& population_yaml_name_syl_end()
{
	return g_pop_name_syl_end;
}

const std::vector<std::string>& population_yaml_name_adjectives()
{
	return g_pop_name_adjectives;
}

const std::vector<std::string>& population_yaml_name_nouns()
{
	return g_pop_name_nouns;
}

bool population_yaml_name_hits_blocklist(const std::string& name_lower)
{
	for (const std::string& w : g_pop_name_blocklist_lower) {
		if (!w.empty() && name_lower.find(w) != std::string::npos)
			return true;
	}
	return false;
}

PopulationNamesDatabase::PopulationNamesDatabase()
	: YamlDatabase("POPULATION_NAMES_DB", 1, 1)
{
}

void PopulationNamesDatabase::clear()
{
	population_names_clear_globals();
	this->profiles.clear();
}

const std::string PopulationNamesDatabase::getDefaultLocation()
{
	return population_config_db_path_names_yaml();
}

uint64 PopulationNamesDatabase::parseBodyNode(const ryml::NodeRef& node)
{
	if (this->nodeExists(node, "GlobalLists")) {
		const ryml::NodeRef& gl = node["GlobalLists"];
		population_append_string_list(gl, "Prefixes", g_pop_name_prefixes);
		population_append_string_list(gl, "SyllablesStart", g_pop_name_syl_start);
		population_append_string_list(gl, "SyllablesMid", g_pop_name_syl_mid);
		population_append_string_list(gl, "SyllablesEnd", g_pop_name_syl_end);
		population_append_string_list(gl, "Adjectives", g_pop_name_adjectives);
		population_append_string_list(gl, "Nouns", g_pop_name_nouns);
		population_append_string_list(gl, "Blocklist", g_pop_name_blocklist_lower, true);
		return 1;
	}

	std::string profile_key;
	if (!this->asString(node, "Profile", profile_key))
		return 0;

	std::shared_ptr<PopulationNameProfile> prof = std::make_shared<PopulationNameProfile>();

	std::string strat;
	if (this->asString(node, "Strategy", strat))
		population_parse_name_strategy(strat, prof->strategy);

	this->asInt32(node, "MinLen", prof->min_len);
	this->asInt32(node, "MaxLen", prof->max_len);

	population_append_string_list_top(node, "SyllablesStart", prof->syllables_start);
	population_append_string_list_top(node, "SyllablesMid", prof->syllables_mid);
	population_append_string_list_top(node, "SyllablesEnd", prof->syllables_end);
	population_append_string_list_top(node, "Adjectives", prof->adjectives);
	population_append_string_list_top(node, "Nouns", prof->nouns);
	population_append_string_list_top(node, "Pool", prof->pool);

	this->profiles[profile_key] = prof;
	return 1;
}

const PopulationNameProfile* PopulationNamesDatabase::find_profile(const std::string& key) const
{
	auto it = this->profiles.find(key);
	if (it == this->profiles.end() || !it->second)
		return nullptr;
	return it->second.get();
}

const PopulationNameProfile* PopulationNamesDatabase::find_profile_or_default(const std::string& key) const
{
	if (!key.empty()) {
		const PopulationNameProfile* p = this->find_profile(key);
		if (p != nullptr)
			return p;
	}
	return this->find_profile("default");
}

size_t PopulationNamesDatabase::profile_count() const
{
	return this->profiles.size();
}

PopulationChatDatabase::PopulationChatDatabase()
	: YamlDatabase("POPULATION_CHAT_DB", 1, 1)
{
}

void PopulationChatDatabase::clear()
{
	this->categories_.clear();
	this->profile_pools_.clear();
}

const std::string PopulationChatDatabase::getDefaultLocation()
{
	return population_config_db_path_chat_yaml();
}

uint64 PopulationChatDatabase::parseBodyNode(const ryml::NodeRef& node)
{
	if (this->nodeExists(node, "ChatGlobal")) {
		const ryml::NodeRef& root = node["ChatGlobal"];
		if (!this->nodeExists(root, "Categories")) {
			this->invalidWarning(root, "ChatGlobal requires Categories map.\n");
			return 0;
		}
		const ryml::NodeRef& cats = root["Categories"];
		if (!cats.is_map()) {
			this->invalidWarning(cats, "ChatGlobal.Categories must be a map (category name -> list of lines).\n");
			return 0;
		}
		for (const auto& it : cats) {
			std::string catname;
			c4::from_chars(it.key(), &catname);
			if (catname.empty())
				continue;
			const ryml::NodeRef& seq = cats[it.key()];
			if (!seq.is_seq()) {
				this->invalidWarning(seq, "Category \"%s\" must be a sequence of strings.\n", catname.c_str());
				continue;
			}
			std::vector<std::string> lines;
			for (const ryml::NodeRef& ln : seq) {
				ryml::csubstr v = ln.val();
				if (v.empty())
					continue;
				lines.emplace_back(v.data(), v.size());
			}
			this->categories_[catname] = std::move(lines);
		}
		return 1;
	}

	std::string prof;
	if (!this->asString(node, "ChatProfile", prof) || prof.empty())
		return 0;

	std::vector<std::string> catrefs;
	population_append_string_list_top(node, "Categories", catrefs);
	if (catrefs.empty()) {
		this->invalidWarning(this->nodeExists(node, "Categories") ? node["Categories"] : node,
			"ChatProfile \"%s\" needs Categories: [ category names ].\n", prof.c_str());
		return 1;
	}

	std::vector<std::string> merged;
	for (const std::string& c : catrefs) {
		auto cit = this->categories_.find(c);
		if (cit == this->categories_.end()) {
			this->invalidWarning(node, "ChatProfile \"%s\" references unknown category \"%s\".\n", prof.c_str(), c.c_str());
			continue;
		}
		merged.insert(merged.end(), cit->second.begin(), cit->second.end());
	}
	if (!merged.empty()) {
		std::vector<std::string>& dest = this->profile_pools_[prof];
		dest.insert(dest.end(), merged.begin(), merged.end());
	} else if (!catrefs.empty()) {
		this->invalidWarning(node, "ChatProfile \"%s\" resolved to zero lines (unknown or empty categories).\n", prof.c_str());
	}
	return 1;
}

void PopulationChatDatabase::loadingFinished()
{
	for (const auto& p : this->profile_pools_) {
		if (p.second.empty())
			ShowWarning("Population chat: profile \"%s\" has no lines (check Categories / ChatGlobal).\n", p.first.c_str());
	}
}

const std::vector<std::string>* PopulationChatDatabase::pool_for_profile(const std::string& key) const
{
	auto it = this->profile_pools_.find(key);
	if (it == this->profile_pools_.end() || it->second.empty())
		return nullptr;
	return &it->second;
}

const std::vector<std::string>* PopulationChatDatabase::lines_for_category(const std::string& category) const
{
	auto it = this->categories_.find(category);
	if (it == this->categories_.end() || it->second.empty())
		return nullptr;
	return &it->second;
}

size_t PopulationChatDatabase::profile_count() const
{
	return this->profile_pools_.size();
}

size_t PopulationChatDatabase::category_count() const
{
	return this->categories_.size();
}

PopulationEngineDatabase::PopulationEngineDatabase()
	: TypesafeYamlDatabase("POPULATION_ENGINE_DB", 2, 1),
	  m_filename_basename("population_engine.yml")
{
}

PopulationEngineDatabase::PopulationEngineDatabase(const char* yaml_basename, bool reject_jobs, bool auto_arena_pool)
	: TypesafeYamlDatabase("POPULATION_ENGINE_DB", 2, 1),
	  m_filename_basename(yaml_basename != nullptr ? yaml_basename : "population_engine.yml"),
	  m_jobs_rejected(reject_jobs),
	  m_auto_arena_pool(auto_arena_pool)
{
}

const std::string PopulationEngineDatabase::getDefaultLocation()
{
	return population_config_join_db(this->m_filename_basename.c_str());
}

const PopulationGearSet* PopulationEngineDatabase::find_gear_set(const std::string& name) const
{
	auto it = this->m_gear_sets.find(name);
	if (it != this->m_gear_sets.end())
		return &it->second;
	if (this->m_shared_source != nullptr) {
		auto sit = this->m_shared_source->m_gear_sets.find(name);
		if (sit != this->m_shared_source->m_gear_sets.end())
			return &sit->second;
	}
	return nullptr;
}

const PopulationEngine* PopulationEngineDatabase::find_profile(const std::string& name) const
{
	auto it = this->m_profiles.find(name);
	if (it != this->m_profiles.end())
		return it->second.get();
	if (this->m_shared_source != nullptr) {
		auto sit = this->m_shared_source->m_profiles.find(name);
		if (sit != this->m_shared_source->m_profiles.end())
			return sit->second.get();
	}
	return nullptr;
}

void PopulationEngineDatabase::clear()
{
	TypesafeYamlDatabase<uint16_t, PopulationEngine>::clear();
	this->m_validationError = false;
	this->m_era_skipped = 0;
	this->m_gear_sets.clear();
	this->m_profiles.clear();
	this->m_vendor_by_key.clear();
	this->m_arena_job_pool.clear();
}

void PopulationEngineDatabase::loadingFinished()
{
#ifndef RENEWAL
	if (this->m_era_skipped > 0)
		ShowInfo("Population engine (%s): skipped %u entries for 3rd and 4th classes and their gear, which pre-renewal does not have.\n",
			this->m_filename_basename.c_str(), this->m_era_skipped);
#endif
	if (battle_config.population_engine_equipment_strict_load != 0 && this->m_validationError) {
		ShowError("Population engine equipment: strict load is on - discarding all entries after validation errors (see warnings above).\n");
		TypesafeYamlDatabase<uint16_t, PopulationEngine>::clear();
		this->m_validationError = false;
	}
	// Auto-derive the arena job pool from the loaded job IDs when this DB was
	// constructed with auto_arena_pool=true and the YAML did not provide an
	// explicit ArenaJobPool block. Used by the PvP DB so the arena pool always
	// matches the set of jobs declared in population_pvp.yml.
	if (this->m_auto_arena_pool && this->m_arena_job_pool.empty()) {
		for (auto it = this->begin(); it != this->end(); ++it)
			this->m_arena_job_pool.push_back(it->first);
	}
}

std::vector<uint16_t> PopulationEngineDatabase::jobs_with_profile(const std::string& profile_name)
{
	std::vector<uint16_t> out;
	if (profile_name.empty())
		return out;
	for (auto it = this->begin(); it != this->end(); ++it) {
		if (it->second && it->second->source_profile_name == profile_name)
			out.push_back(it->first);
	}
	return out;
}

ryml::NodeRef PopulationEngineDatabase::warnAnchorForJob(const ryml::NodeRef& node)
{
	if (this->nodeExists(node, "Job"))
		return node["Job"];
	return node;
}

void PopulationEngineDatabase::markInvalidItem(const ryml::NodeRef& node, const char* yaml_key, uint16_t job_id, uint16_t bad_id)
{
	this->m_validationError = true;
	if (this->nodeExists(node, std::string(yaml_key)))
		this->invalidWarning(node[c4::to_csubstr(yaml_key)],
			"Unknown or dummy item ID %u for \"%s\" (Job %hu). Using 0.\n",
			static_cast<unsigned>(bad_id), yaml_key, job_id);
	else
		this->invalidWarning(this->warnAnchorForJob(node),
			"Unknown or dummy item ID %u for \"%s\" (Job %hu). Using 0.\n",
			static_cast<unsigned>(bad_id), yaml_key, job_id);
}

void PopulationEngineDatabase::readUInt16FirstKey(const ryml::NodeRef& node, std::initializer_list<const char*> keys, uint16_t& out)
{
	for (const char* k : keys) {
		const std::string ks(k);
		if (this->nodeExists(node, ks)) {
			this->asUInt16(node, ks, out);
			return;
		}
	}
}

bool PopulationEngineDatabase::parseOptionalIntRange(const ryml::NodeRef& node, const std::string& key, int16_t& out_min, int16_t& out_max, uint16_t job_id)
{
	if (!this->nodeExists(node, key))
		return true;
	const ryml::NodeRef ch = node[c4::to_csubstr(key)];
	if (ch.is_seq() && ch.num_children() >= 2) {
		int32_t a = 0, b = 0;
		size_t idx = 0;
		for (const ryml::NodeRef& it : ch.children()) {
			if (idx == 0)
				it >> a;
			else if (idx == 1) {
				it >> b;
				break;
			}
			idx++;
		}
		out_min = static_cast<int16_t>(a);
		out_max = static_cast<int16_t>(b);
		if (out_min > out_max)
			std::swap(out_min, out_max);
		return true;
	}
	int32_t v = 0;
	if (this->asInt32(node, key, v)) {
		out_min = out_max = static_cast<int16_t>(v);
		return true;
	}
	this->m_validationError = true;
	this->invalidWarning(node[c4::to_csubstr(key)], "Invalid value for %s (Job %hu) - expected integer or [min, max].\n", key.c_str(), job_id);
	out_min = out_max = -1;
	return false;
}

void PopulationEngineDatabase::parseEquipSlotPool(
	const ryml::NodeRef& node,
	std::initializer_list<const char*> keys,
	uint32_t required_flag,
	std::vector<uint16_t>& pool,
	uint16_t job_id)
{
	const char* found_key = nullptr;
	for (const char* k : keys) {
		if (this->nodeExists(node, std::string(k))) {
			found_key = k;
			break;
		}
	}
	if (!found_key)
		return;

	pool.clear();
	const ryml::NodeRef n = node[c4::to_csubstr(found_key)];

	// Resolve one item entry from a scalar node (integer ID or AegisName string).
	// Returns 0 on failure; a warning has already been emitted.
	auto resolve_entry = [&](const ryml::NodeRef& item_node) -> uint16_t {
		if (!item_node.has_val())
			return 0;
		const ryml::csubstr raw = item_node.val();
		if (raw.empty())
			return 0;
		const std::string s(raw.data(), raw.size());

		uint16_t id = 0;
		// Check if fully numeric.
		bool all_digits = !s.empty();
		for (char c : s)
			if (!std::isdigit(static_cast<unsigned char>(c))) { all_digits = false; break; }

		if (all_digits) {
			try {
				const unsigned long v = std::stoul(s);
				if (v == 0 || v > 65535UL) return 0;
				id = static_cast<uint16_t>(v);
			} catch (...) { return 0; }
		} else {
			// AegisName string lookup.
			auto ptr = item_db.searchname(s.c_str());
			if (!ptr) {
				this->m_validationError = true;
				this->invalidWarning(item_node,
					"Unknown item name '%s' in equipment pool (Job %hu) - entry skipped.\n",
					s.c_str(), job_id);
				return 0;
			}
			id = static_cast<uint16_t>(ptr->nameid);
		}

		if (id == 0)
			return 0;

		// Existence check.
		const t_itemid tid = static_cast<t_itemid>(id);
		if (tid == UNKNOWN_ITEM_ID || !item_db.exists(tid)) {
			this->m_validationError = true;
			this->invalidWarning(item_node,
				"Item %u not found in item_db for equipment pool (Job %hu) - entry skipped.\n",
				static_cast<unsigned>(id), job_id);
			return 0;
		}

		// Slot-compatibility check.
		if (required_flag != 0) {
			auto ptr = item_db.find(tid);
			if (ptr && !(ptr->equip & required_flag)) {
				this->m_validationError = true;
				this->invalidWarning(item_node,
					"Item %u (equip:0x%04x) cannot be equipped in this slot (required 0x%04x, Job %hu) - entry skipped.\n",
					static_cast<unsigned>(id), ptr->equip, required_flag, job_id);
				return 0;
			}
		}

		return id;
	};

	if (n.is_seq()) {
		for (const ryml::NodeRef& child : n.children()) {
			const uint16_t id = resolve_entry(child);
			if (id != 0)
				pool.push_back(id);
		}
	} else {
		// Scalar: "0" or empty string means no item (leave pool empty).
		if (!n.has_val())
			return;
		const ryml::csubstr raw = n.val();
		if (raw.empty() || (raw.size() == 1 && raw[0] == '0'))
			return;
		const uint16_t id = resolve_entry(n);
		if (id != 0)
			pool.push_back(id);
	}
}

/// Copy all non-gear fields from a profile template into a job entry.
/// Called before per-job field parsing so job fields override profile defaults.
/// Gear slots, skip_arrow, grant_skill_tree, and shell_attack_skill_yaml are not inherited
/// because they are job-specific by nature (equip restrictions differ per job).
static void applyProfile(PopulationEngine* dst, const PopulationEngine& src)
{
	// Stats and levels — override only if profile set them (non-zero range implies explicit set).
	dst->str_min  = src.str_min;  dst->str_max  = src.str_max;
	dst->agi_min  = src.agi_min;  dst->agi_max  = src.agi_max;
	dst->vit_min  = src.vit_min;  dst->vit_max  = src.vit_max;
	dst->intl_min = src.intl_min; dst->intl_max = src.intl_max;
	dst->dex_min  = src.dex_min;  dst->dex_max  = src.dex_max;
	dst->luk_min  = src.luk_min;  dst->luk_max  = src.luk_max;
	dst->base_level_min = src.base_level_min; dst->base_level_max = src.base_level_max;
	dst->job_level_min  = src.job_level_min;  dst->job_level_max  = src.job_level_max;
	dst->pow_min  = src.pow_min;  dst->pow_max  = src.pow_max;
	dst->sta_min  = src.sta_min;  dst->sta_max  = src.sta_max;
	dst->wis_min  = src.wis_min;  dst->wis_max  = src.wis_max;
	dst->spl_min  = src.spl_min;  dst->spl_max  = src.spl_max;
	dst->con_min  = src.con_min;  dst->con_max  = src.con_max;
	dst->crt_min  = src.crt_min;  dst->crt_max  = src.crt_max;
	// Appearance
	dst->sex_override    = src.sex_override;
	dst->hair_min        = src.hair_min;        dst->hair_max        = src.hair_max;
	dst->hair_color_min  = src.hair_color_min;  dst->hair_color_max  = src.hair_color_max;
	dst->cloth_color_min = src.cloth_color_min; dst->cloth_color_max = src.cloth_color_max;
	// Identity
	dst->name_profile = src.name_profile;
	dst->name_prefix  = src.name_prefix;
	dst->name_suffix  = src.name_suffix;
	dst->chat_profile = src.chat_profile;
	// Behavior
	dst->behavior         = src.behavior;
	dst->town_behavior    = src.town_behavior;
	dst->field_behavior   = src.field_behavior;
	dst->dungeon_behavior = src.dungeon_behavior;
	dst->guard_range      = src.guard_range;
	// Vendor
	dst->vendor_message  = src.vendor_message;
	dst->vendor_key      = src.vendor_key;
	dst->placement_bound = src.placement_bound; // RAGNAROKMAC
	// Flags and role
	dst->flags     = src.flags;
	dst->role_type = src.role_type;
	// Script is NOT copied here. parseBodyNode composes script_str by
	// appending the profile's script_str and the job entry's Script: text,
	// then compiles + filters into bonus_script_str.
}

uint64 PopulationEngineDatabase::parseBodyNode(const ryml::NodeRef& node)
{

	// Arena job pool — may appear as a top-level entry.
	if (this->nodeExists(node, "ArenaJobPool")) {
		// Job name -> ID lookup uses the file-scope kJobNameMap shared with the
		// Profile.Jobs: expansion path. Names accept either numeric IDs or
		// unambiguous class strings (case-sensitive, spaces stripped).
		const ryml::NodeRef& arr = node["ArenaJobPool"];
		if (arr.is_seq()) {
			this->m_arena_job_pool.clear();
			for (const ryml::NodeRef& jn : arr) {
				uint16_t jid = 0;
				// Try numeric first.
				if (!ryml::read(jn, &jid)) {
					// Fall back to name string.
					std::string name;
					if (ryml::read(jn, &name)) {
						// Strip spaces to make "Lord Knight" match "LordKnight".
						name.erase(std::remove(name.begin(), name.end(), ' '), name.end());
						auto it = kJobNameMap.find(name);
						if (it != kJobNameMap.end())
							jid = it->second;
						else
							this->invalidWarning(node, "ArenaJobPool: unknown job name '%s' — entry skipped.\n", name.c_str());
					}
				}
				if (jid > 0) {
					if (!job_db.exists(jid))
						this->invalidWarning(node, "ArenaJobPool: job ID %hu not in job_db — entry skipped.\n", jid);
					else
						this->m_arena_job_pool.push_back(jid);
				}
			}
		}
		return 1;
	}
	// Gear set definition — must appear before job entries that reference them.
	if (this->nodeExists(node, "GearSetName")) {
		std::string name;
		if (!this->asString(node, "GearSetName", name) || name.empty())
			return 0;
#ifndef RENEWAL
		// RAGNAROKMAC: a set only 3rd and 4th classes wear, which pre-renewal does not have. Its
		// items are renewal-only, and each one logged an unknown item on every start-up.
		bool renewal_only = false;
		if (this->nodeExists(node, "RenewalOnly") && this->asBool(node, "RenewalOnly", renewal_only) && renewal_only) {
			++this->m_era_skipped;
			return 1;
		}
#endif
		PopulationGearSet gs;
		// RAGNAROKMAC: a pre-renewal server takes a slot from the set's PreRenewal block when the
		// block has it. Most sets are built from renewal-only items (the Paradise/Eden gear), which
		// the pre-renewal item db lacks; every one was skipped there, and a slot with nothing left
		// spawned empty (#325). Renewal ignores the block.
#ifndef RENEWAL
		const bool has_pre = this->nodeExists(node, "PreRenewal");
		const ryml::NodeRef pre_node = has_pre ? node[c4::to_csubstr("PreRenewal")] : node;
#endif
		auto slot = [&](std::initializer_list<const char*> keys, uint32_t flag, std::vector<uint16_t>& pool) {
#ifndef RENEWAL
			if (has_pre) {
				for (const char* k : keys) {
					if (this->nodeExists(pre_node, std::string(k))) {
						this->parseEquipSlotPool(pre_node, keys, flag, pool, 0);
						return;
					}
				}
			}
#endif
			this->parseEquipSlotPool(node, keys, flag, pool, 0);
		};
		slot({"Weapon",     "weapon"     }, EQP_HAND_R,                        gs.weapon_pool);
		slot({"Shield",     "shield"     }, EQP_HAND_L,                        gs.shield_pool);
		slot({"HeadTop",    "head_top"   }, EQP_HEAD_TOP|EQP_COSTUME_HEAD_TOP, gs.head_top_pool);
		slot({"HeadMid",    "head_mid"   }, EQP_HEAD_MID|EQP_COSTUME_HEAD_MID, gs.head_mid_pool);
		slot({"HeadBottom", "head_bottom"}, EQP_HEAD_LOW|EQP_COSTUME_HEAD_LOW, gs.head_bottom_pool);
		slot({"Armor",      "armor"      }, EQP_ARMOR,                         gs.armor_pool);
		slot({"Garment",    "garment"    }, EQP_GARMENT|EQP_COSTUME_GARMENT,   gs.garment_pool);
		slot({"Shoes",      "shoes"      }, EQP_SHOES,                         gs.shoes_pool);
		slot({"AccL",       "acc_l"      }, EQP_ACC_L,                         gs.acc_l_pool);
		slot({"AccR",       "acc_r"      }, EQP_ACC_R,                         gs.acc_r_pool);
		if (this->nodeExists(node, "Arrow")) {
			bool arrow = true;
			if (this->asBool(node, "Arrow", arrow))
				gs.skip_arrow = !arrow;
		}
		m_gear_sets[name] = std::move(gs);
		return 1;
	}

	// Profile definition — named template for non-gear fields.
	// Detected by: has "Profile:" key and no "Job:" key.
	// Must appear in the YAML before any job entry that references it (like GearSetName).
	if (this->nodeExists(node, "Profile") && !this->nodeExists(node, "Job")) {
		std::string prof_name;
		if (!this->asString(node, "Profile", prof_name) || prof_name.empty()) {
			this->invalidWarning(node, "Population profile entry has empty or missing Profile name; skipped.\n");
			return 0;
		}
		auto prof = std::make_shared<PopulationEngine>();
		// Stats/levels (profile values become defaults; job entry overrides if it specifies them).
		this->parseOptionalIntRange(node, "Str",          prof->str_min,        prof->str_max,        0);
		this->parseOptionalIntRange(node, "Agi",          prof->agi_min,        prof->agi_max,        0);
		this->parseOptionalIntRange(node, "Vit",          prof->vit_min,        prof->vit_max,        0);
		this->parseOptionalIntRange(node, "Int",          prof->intl_min,       prof->intl_max,       0);
		this->parseOptionalIntRange(node, "Dex",          prof->dex_min,        prof->dex_max,        0);
		this->parseOptionalIntRange(node, "Luk",          prof->luk_min,        prof->luk_max,        0);
		this->parseOptionalIntRange(node, "Pow",          prof->pow_min,        prof->pow_max,        0);
		this->parseOptionalIntRange(node, "Sta",          prof->sta_min,        prof->sta_max,        0);
		this->parseOptionalIntRange(node, "Wis",          prof->wis_min,        prof->wis_max,        0);
		this->parseOptionalIntRange(node, "Spl",          prof->spl_min,        prof->spl_max,        0);
		this->parseOptionalIntRange(node, "Con",          prof->con_min,        prof->con_max,        0);
		this->parseOptionalIntRange(node, "Crt",          prof->crt_min,        prof->crt_max,        0);
		this->parseOptionalIntRange(node, "BaseLevel",    prof->base_level_min, prof->base_level_max, 0);
		this->parseOptionalIntRange(node, "JobLevel",     prof->job_level_min,  prof->job_level_max,  0);
		this->parseOptionalIntRange(node, "Hair",         prof->hair_min,       prof->hair_max,       0);
		this->parseOptionalIntRange(node, "HairColor",    prof->hair_color_min, prof->hair_color_max, 0);
		this->parseOptionalIntRange(node, "ClothesColor", prof->cloth_color_min,prof->cloth_color_max,0);
		// Identity
		if (this->nodeExists(node, "NameProfile")) this->asString(node, "NameProfile", prof->name_profile);
		if (this->nodeExists(node, "NamePrefix"))  this->asString(node, "NamePrefix",  prof->name_prefix);
		if (this->nodeExists(node, "NameSuffix"))  this->asString(node, "NameSuffix",  prof->name_suffix);
		if (this->nodeExists(node, "ChatProfile")) this->asString(node, "ChatProfile", prof->chat_profile);
		if (this->nodeExists(node, "Sex")) {
			std::string sx;
			if (this->asString(node, "Sex", sx)) {
				if      (sx == "M" || sx == "m") prof->sex_override = 1;
				else if (sx == "F" || sx == "f") prof->sex_override = 0;
			}
		}
		// Behavior
		auto parse_beh = [&](const char* key, PopulationBehavior& out) {
			if (!this->nodeExists(node, key)) return;
			std::string bh;
			if (this->asString(node, key, bh)) {
				PopulationBehavior parsed;
				if (population_eq_parse_behavior_str(bh, parsed))
					out = parsed;
			}
		};
		parse_beh("Behavior",        prof->behavior);
		parse_beh("TownBehavior",    prof->town_behavior);
		parse_beh("FieldBehavior",   prof->field_behavior);
		parse_beh("DungeonBehavior", prof->dungeon_behavior);
		if (this->nodeExists(node, "GuardRange")) {
			uint16_t gr = 0;
			if (this->asUInt16(node, "GuardRange", gr))
				prof->guard_range = static_cast<uint8_t>(std::min<uint16_t>(gr, 255));
		}
		if (this->nodeExists(node, "VendorMessage")) this->asString(node, "VendorMessage", prof->vendor_message);
		if (this->nodeExists(node, "VendorKey"))     this->asString(node, "VendorKey",     prof->vendor_key);
		if (this->nodeExists(node, "PlacementBound")) this->asBool(node, "PlacementBound", prof->placement_bound); // RAGNAROKMAC
		// Role
		if (this->nodeExists(node, "Role")) {
			std::string rs;
			if (this->asString(node, "Role", rs)) {
				if      (rs == "tank")     prof->role_type = PopulationRoleType::Tank;
				else if (rs == "support")  prof->role_type = PopulationRoleType::Support;
				else if (rs == "attacker") prof->role_type = PopulationRoleType::Attacker;
				else if (rs == "none")     prof->role_type = PopulationRoleType::None;
			}
		}
		// Flags
		if (this->nodeExists(node, "Flags")) {
			const ryml::NodeRef flags_node = node[c4::to_csubstr("Flags")];
			if (flags_node.is_seq()) {
				prof->flags = 0;
				for (const ryml::NodeRef& fn : flags_node.children()) {
					std::string fname;
					if (!ryml::read(fn, &fname)) continue;
					if      (fname == "mortal")      prof->flags |= PSF::Mortal;
					else if (fname == "immortal")    prof->flags &= ~PSF::Mortal;
					else if (fname == "attack_only") prof->flags |= PSF::AttackOnly;
					else if (fname == "skill_only")  prof->flags |= PSF::SkillOnly;
				}
			}
		}
		// Script — stored as raw string; each job entry compiles its own copy.
		const bool profHasScript = this->nodeExists(node, "Script");
		if (profHasScript) {
			std::string src;
			if (this->asString(node, "Script", src) && !src.empty()) {
				prof->script_str       = src;
				prof->bonus_script_str = make_bonus_script_str(src);
			}
		}
		m_profiles[prof_name] = prof; // keep shared_ptr; expansion below reads from it

		// Profile.Jobs: { JobName: GearSetName, ... } — synthesize one Job entry
		// per map key so we don't need redundant `- Job:` blocks. The value can
		// be a GearSet name string, the bool `true` (no equipment), or `false`
		// (skip this job). Job IDs unknown to kJobNameMap are warned and skipped.
		if (this->nodeExists(node, "Jobs")) {
			const ryml::NodeRef& jobs_node = node[c4::to_csubstr("Jobs")];
			if (jobs_node.is_map()) {
				for (const ryml::NodeRef& jn : jobs_node.children()) {
					if (!jn.has_key())
						continue;
					ryml::csubstr key_csub = jn.key();
					std::string job_name(key_csub.data(), key_csub.size());
					// Strip spaces so "Lord Knight" matches "LordKnight".
					std::string job_name_nosp = job_name;
					job_name_nosp.erase(std::remove(job_name_nosp.begin(), job_name_nosp.end(), ' '),
					                    job_name_nosp.end());
					uint16_t job_id = 0;
					auto kit = kJobNameMap.find(job_name_nosp);
					if (kit == kJobNameMap.end()) {
						this->invalidWarning(jn, "Profile '%s' Jobs: unknown job name '%s' — skipped.\n",
							prof_name.c_str(), job_name.c_str());
						continue;
					}
					job_id = kit->second;
					if (!job_db.exists(job_id)) {
#ifndef RENEWAL
						// RAGNAROKMAC: a 3rd or 4th class, which pre-renewal does not have.
						++this->m_era_skipped;
#else
						this->invalidWarning(jn, "Profile '%s' Jobs: job ID %hu not in job_db — skipped.\n",
							prof_name.c_str(), job_id);
#endif
						continue;
					}

					// Decode the value: bool false => skip; bool true / null => no gearset; string => gearset name.
					std::string gear_set_name;
					bool include = true;
					if (jn.has_val()) {
						bool bv = false;
						if (ryml::read(jn, &bv)) {
							include = bv;
						} else {
							ryml::read(jn, &gear_set_name);
						}
					}
					if (!include)
						continue;

					// Build the synthetic Job entry. Replaces any prior entry for this
					// job (last-profile-wins) so reloads remain idempotent.
					auto equipment = std::make_shared<PopulationEngine>();
					applyProfile(equipment.get(), *prof);
					equipment->source_profile_name = prof_name;

					if (!gear_set_name.empty()) {
						const PopulationGearSet* gs_ptr = this->find_gear_set(gear_set_name);
						if (gs_ptr != nullptr) {
							const PopulationGearSet& gs = *gs_ptr;
							equipment->weapon_pool      = gs.weapon_pool;
							equipment->shield_pool      = gs.shield_pool;
							equipment->head_top_pool    = gs.head_top_pool;
							equipment->head_mid_pool    = gs.head_mid_pool;
							equipment->head_bottom_pool = gs.head_bottom_pool;
							equipment->armor_pool       = gs.armor_pool;
							equipment->garment_pool     = gs.garment_pool;
							equipment->shoes_pool       = gs.shoes_pool;
							equipment->acc_l_pool       = gs.acc_l_pool;
							equipment->acc_r_pool       = gs.acc_r_pool;
							equipment->skip_arrow       = gs.skip_arrow;
						} else {
							this->invalidWarning(jn,
								"Profile '%s' Jobs: unknown GearSet '%s' for job %hu — equipment will be empty.\n",
								prof_name.c_str(), gear_set_name.c_str(), job_id);
						}
					}

					// Compile the profile script (if any) into the synthetic entry.
					if (!prof->script_str.empty()) {
						const int line_no = this->getLineNumber(jn);
						equipment->script = parse_script(prof->script_str.c_str(),
							this->getCurrentFile().c_str(), line_no, SCRIPT_IGNORE_EXTERNAL_BRACKETS);
						if (equipment->script == nullptr) {
							this->m_validationError = true;
							this->invalidWarning(jn,
								"Profile '%s' script parse failed for Job %hu — script ignored.\n",
								prof_name.c_str(), job_id);
						} else {
							equipment->script_str       = prof->script_str;
							equipment->bonus_script_str = prof->bonus_script_str;
						}
					}

					// RAGNAROKMAC: a placement-bound vendor is resolved by its
					// VendorKey, not its job, so keep it out of the global job map
					// — that is what lets several vendors share a sprite job and
					// leaves the engine's own ambient vendors untouched. Its Jobs:
					// entry becomes purely the shell's sprite.
					equipment->sprite_job = job_id;
					if (equipment->placement_bound && !equipment->vendor_key.empty())
						this->m_vendor_by_key[equipment->vendor_key] = equipment;
					else
						this->put(job_id, equipment);
				}
			} else if (!jobs_node.is_seed()) {
				this->invalidWarning(jobs_node,
					"Profile '%s' Jobs: must be a YAML map (JobName: GearSetName).\n",
					prof_name.c_str());
			}
		}
		return 1;
	}

	// Shared-templates DB does not accept Job entries. Warn and skip if a Job
	// entry sneaks into db/population_gear_sets.yml — those belong in one of
	// the per-source job YAMLs (population_engine.yml / population_pvp.yml /
	// population_vendor_pop.yml).
	if (this->m_jobs_rejected && this->nodeExists(node, "Job")) {
		this->invalidWarning(this->warnAnchorForJob(node),
			"Job entry found in shared-templates DB '%s' - move it to one of "
			"population_engine.yml / population_pvp.yml / population_vendor_pop.yml.\n",
			this->m_filename_basename.c_str());
		return 0;
	}

	uint16_t job_id;

	if (!this->asUInt16(node, "Job", job_id)) {
		std::string key;
		if (this->asString(node, "Key", key)) {
			try {
				job_id = static_cast<uint16_t>(std::stoi(key));
			} catch (...) {
				return 0;
			}
		} else {
			return 0;
		}
	}

	if (!job_db.exists(job_id)) {
		this->m_validationError = true;
		this->invalidWarning(this->warnAnchorForJob(node),
			"Unknown Job ID %hu - entry skipped (not in job_db).\n", job_id);
		return 0;
	}

	std::shared_ptr<PopulationEngine> equipment = this->find(job_id);
	bool exists = equipment != nullptr;

	if (!exists) {
		equipment = std::make_shared<PopulationEngine>();
	}

	// Resolve Profile: inheritance. Looked up on every parse (including reloads)
	// so changes to the profile propagate to all dependent job entries on reloaddb.
	// applyProfile resets profile-owned fields to the profile's values; per-job
	// fields parsed below override them. Profile script is composed separately.
	const PopulationEngine* prof_ptr = nullptr;
	bool from_profile = false;
	if (this->nodeExists(node, "Profile")) {
		std::string prof_name;
		if (this->asString(node, "Profile", prof_name) && !prof_name.empty()) {
			prof_ptr = this->find_profile(prof_name);
			if (prof_ptr != nullptr) {
				applyProfile(equipment.get(), *prof_ptr);
				equipment->source_profile_name = prof_name;
				from_profile = true;
			} else {
				this->invalidWarning(node[c4::to_csubstr("Profile")],
					"Unknown Profile '%s' for Job %hu; ignored.\n", prof_name.c_str(), job_id);
			}
		}
	}

	// Inherit gear slot pools from a named gear set (GearSet: name).
	// Individual slot keys in this entry override the inherited values.
	if (this->nodeExists(node, "GearSet")) {
		std::string gs_name;
		if (this->asString(node, "GearSet", gs_name) && !gs_name.empty()) {
			const PopulationGearSet* gs_ptr = this->find_gear_set(gs_name);
			if (gs_ptr != nullptr) {
				const PopulationGearSet& gs = *gs_ptr;
				equipment->weapon_pool      = gs.weapon_pool;
				equipment->shield_pool      = gs.shield_pool;
				equipment->head_top_pool    = gs.head_top_pool;
				equipment->head_mid_pool    = gs.head_mid_pool;
				equipment->head_bottom_pool = gs.head_bottom_pool;
				equipment->armor_pool       = gs.armor_pool;
				equipment->garment_pool     = gs.garment_pool;
				equipment->shoes_pool       = gs.shoes_pool;
				equipment->acc_l_pool       = gs.acc_l_pool;
				equipment->acc_r_pool       = gs.acc_r_pool;
				equipment->skip_arrow       = gs.skip_arrow;
			} else {
				this->invalidWarning(node[c4::to_csubstr("GearSet")],
					"Unknown GearSet \"%s\" for Job %hu; ignoring.\n", gs_name.c_str(), job_id);
			}
		}
	}

	// Equipment slot pools — scalar 0 = empty, scalar id/name = fixed item, sequence = random pick per spawn.
	// Each entry is validated: item must exist in item_db and match the slot's equip flag.
	this->parseEquipSlotPool(node, { "Weapon",     "weapon"      }, EQP_HAND_R,   equipment->weapon_pool,     job_id);
	this->parseEquipSlotPool(node, { "Shield",     "shield"      }, EQP_HAND_L,   equipment->shield_pool,     job_id);
	this->parseEquipSlotPool(node, { "HeadTop",    "head_top"    }, EQP_HEAD_TOP|EQP_COSTUME_HEAD_TOP, equipment->head_top_pool,    job_id);
	this->parseEquipSlotPool(node, { "HeadMid",    "head_mid"    }, EQP_HEAD_MID|EQP_COSTUME_HEAD_MID, equipment->head_mid_pool,    job_id);
	this->parseEquipSlotPool(node, { "HeadBottom", "head_bottom" }, EQP_HEAD_LOW|EQP_COSTUME_HEAD_LOW, equipment->head_bottom_pool, job_id);
	this->parseEquipSlotPool(node, { "Armor",      "armor"       }, EQP_ARMOR,                         equipment->armor_pool,       job_id);
	this->parseEquipSlotPool(node, { "Garment",    "garment"     }, EQP_GARMENT|EQP_COSTUME_GARMENT,   equipment->garment_pool,     job_id);
	this->parseEquipSlotPool(node, { "Shoes",      "shoes"       }, EQP_SHOES,     equipment->shoes_pool,      job_id);
	this->parseEquipSlotPool(node, { "AccL",       "acc_l"       }, EQP_ACC_L,     equipment->acc_l_pool,      job_id);
	this->parseEquipSlotPool(node, { "AccR",       "acc_r"       }, EQP_ACC_R,     equipment->acc_r_pool,      job_id);
	// Effective script source = profile.script_str (if any) + job entry's Script: text (if any), appended.
	// Accept "Script:" (preferred) or legacy "InitScript:" as aliases on the job entry.
	// Supports bonus bStr/bAgi/etc. and setriding/setfalcon/setcart/setarrow.
	// status_calc_pc is called after the script runs, so bonus commands take effect.
	const bool hasScript     = this->nodeExists(node, "Script");
	const bool hasInitScript = this->nodeExists(node, "InitScript");
	const char* active_key   = hasScript ? "Script" : (hasInitScript ? "InitScript" : nullptr);

	std::string job_src;
	if (active_key != nullptr) {
		this->asString(node, active_key, job_src);
	}

	std::string combined;
	if (from_profile && prof_ptr != nullptr && !prof_ptr->script_str.empty())
		combined = prof_ptr->script_str;
	if (!job_src.empty()) {
		if (!combined.empty() && combined.back() != '\n')
			combined += '\n';
		combined += job_src;
	}

	// Always reset; recompile from the composed source if non-empty.
	if (equipment->script != nullptr) {
		script_free_code(equipment->script);
		equipment->script = nullptr;
	}
	equipment->script_str.clear();
	equipment->bonus_script_str.clear();

	if (!combined.empty()) {
		const int line_no = (active_key != nullptr)
			? this->getLineNumber(node[c4::to_csubstr(active_key)])
			: 0;
		equipment->script = parse_script(combined.c_str(), this->getCurrentFile().c_str(),
			line_no, SCRIPT_IGNORE_EXTERNAL_BRACKETS);
		if (equipment->script == nullptr) {
			this->m_validationError = true;
			if (active_key != nullptr)
				this->invalidWarning(node[c4::to_csubstr(active_key)],
					"Script parse failed for Job %hu - Script ignored.\n", job_id);
			else
				this->invalidWarning(this->warnAnchorForJob(node),
					"Profile script parse failed for Job %hu - Script ignored.\n", job_id);
		} else {
			equipment->script_str = combined;
			equipment->bonus_script_str = make_bonus_script_str(combined);
		}
	}
	if (this->nodeExists(node, "Arrow")) {
		bool arrow = true;
		if (this->asBool(node, "Arrow", arrow))
			equipment->skip_arrow = !arrow;
	} else if (exists) {
		equipment->skip_arrow = false;
	}

	this->parseOptionalIntRange(node, "Str", equipment->str_min, equipment->str_max, job_id);
	this->parseOptionalIntRange(node, "Agi", equipment->agi_min, equipment->agi_max, job_id);
	this->parseOptionalIntRange(node, "Vit", equipment->vit_min, equipment->vit_max, job_id);
	this->parseOptionalIntRange(node, "Int", equipment->intl_min, equipment->intl_max, job_id);
	this->parseOptionalIntRange(node, "Dex", equipment->dex_min, equipment->dex_max, job_id);
	this->parseOptionalIntRange(node, "Luk", equipment->luk_min, equipment->luk_max, job_id);
	this->parseOptionalIntRange(node, "BaseLevel", equipment->base_level_min, equipment->base_level_max, job_id);
	this->parseOptionalIntRange(node, "JobLevel", equipment->job_level_min, equipment->job_level_max, job_id);
	this->parseOptionalIntRange(node, "Hair", equipment->hair_min, equipment->hair_max, job_id);
	this->parseOptionalIntRange(node, "HairColor", equipment->hair_color_min, equipment->hair_color_max, job_id);
	this->parseOptionalIntRange(node, "ClothesColor", equipment->cloth_color_min, equipment->cloth_color_max, job_id);

	if (this->nodeExists(node, "Sex")) {
		std::string sx;
		if (this->asString(node, "Sex", sx)) {
			if (sx == "M" || sx == "m")
				equipment->sex_override = 1;
			else if (sx == "F" || sx == "f")
				equipment->sex_override = 0;
			else {
				this->invalidWarning(node[c4::to_csubstr("Sex")], "Sex must be M or F (Job %hu); using auto.\n", job_id);
				equipment->sex_override = -1;
			}
		}
	} else if (!exists && !from_profile) {
		equipment->sex_override = -1;
	}

	if (this->nodeExists(node, "NameProfile"))
		this->asString(node, "NameProfile", equipment->name_profile);
	else if (!exists && !from_profile)
		equipment->name_profile.clear();
	if (this->nodeExists(node, "NamePrefix"))
		this->asString(node, "NamePrefix", equipment->name_prefix);
	else if (!exists && !from_profile)
		equipment->name_prefix.clear();
	if (this->nodeExists(node, "NameSuffix"))
		this->asString(node, "NameSuffix", equipment->name_suffix);
	else if (!exists && !from_profile)
		equipment->name_suffix.clear();

	if (this->nodeExists(node, "ChatProfile"))
		this->asString(node, "ChatProfile", equipment->chat_profile);
	else if (!exists && !from_profile)
		equipment->chat_profile.clear();

	if (this->nodeExists(node, "Skills")) {
		const ryml::NodeRef sknode = node[c4::to_csubstr("Skills")];
		if (sknode.is_seq()) {
			equipment->shell_attack_skill_yaml.clear();
			for (const ryml::NodeRef& row : sknode.children()) {
				if (!row.is_map())
					continue;
				uint16_t sid = 0;
				std::string skname;
				int64_t cst = 0;
				if (this->asString(row, "Skill", skname) && script_get_constant(skname.c_str(), &cst))
					sid = static_cast<uint16_t>(cst);
				if (sid == 0 && !this->asUInt16(row, "SkillId", sid))
					continue;
				int32_t skill_lv = 10;
				if (this->nodeExists(row, "Level")) {
					if (!this->asInt32(row, "Level", skill_lv))
						skill_lv = 10;
				} else if (this->nodeExists(row, "Number")) {
					// Deprecated alias for Level (same meaning: target skill level)
					if (!this->asInt32(row, "Number", skill_lv))
						skill_lv = 10;
				}
				if (skill_lv < 1)
					skill_lv = 1;
				if (skill_lv > MAX_SKILL_LEVEL)
					skill_lv = MAX_SKILL_LEVEL;
				PopulationShellYamlSkill row_skill;
				row_skill.skill_id = sid;
				row_skill.level_cap = static_cast<uint16_t>(skill_lv);
				equipment->shell_attack_skill_yaml.push_back(row_skill);
			}
		} else {
			bool sk = true;
			if (this->asBool(node, "Skills", sk))
				equipment->grant_skill_tree = sk;
			equipment->shell_attack_skill_yaml.clear();
		}
	} else if (!exists) {
		equipment->grant_skill_tree = true;
		equipment->shell_attack_skill_yaml.clear();
	}

	if (this->nodeExists(node, "Behavior")) {
		std::string bh;
		if (this->asString(node, "Behavior", bh)) {
			PopulationBehavior parsed;
			if (population_eq_parse_behavior_str(bh, parsed))
				equipment->behavior = parsed;
			else {
				this->m_validationError = true;
				this->invalidWarning(node[c4::to_csubstr("Behavior")],
					"Behavior must be none/wander/combat/support/sit/social/vendor/guard (Job %hu); using combat.\n", job_id);
				equipment->behavior = PopulationBehavior::Combat;
			}
		}
	} else if (!exists && !from_profile) {
		equipment->behavior = PopulationBehavior::Combat;
	}

	// Per-map-category behavior overrides (optional).
	for (auto& [yaml_key, field_ref] : {
			std::pair<const char*, PopulationBehavior*>{"TownBehavior",    &equipment->town_behavior},
			std::pair<const char*, PopulationBehavior*>{"FieldBehavior",   &equipment->field_behavior},
			std::pair<const char*, PopulationBehavior*>{"DungeonBehavior", &equipment->dungeon_behavior},
	}) {
		if (this->nodeExists(node, yaml_key)) {
			std::string bh;
			if (this->asString(node, yaml_key, bh)) {
				PopulationBehavior parsed;
				if (population_eq_parse_behavior_str(bh, parsed))
					*field_ref = parsed;
				else
					this->invalidWarning(node[c4::to_csubstr(yaml_key)],
						"%s must be none/wander/combat/support/sit/social/vendor/guard (Job %hu); ignoring.\n", yaml_key, job_id);
			}
		} else if (!exists && !from_profile) {
			*field_ref = PopulationBehavior::None;
		}
	}

	if (this->nodeExists(node, "GuardRange")) {
		uint16_t gr = 0;
		if (this->asUInt16(node, "GuardRange", gr))
			equipment->guard_range = static_cast<uint8_t>(std::min<uint16_t>(gr, 255));
	} else if (!exists && !from_profile) {
		equipment->guard_range = 0;
	}

	// Role: combat role for party coordination.
	if (this->nodeExists(node, "Role")) {
		std::string role_str;
		if (this->asString(node, "Role", role_str)) {
			if      (role_str == "tank")     equipment->role_type = PopulationRoleType::Tank;
			else if (role_str == "support")  equipment->role_type = PopulationRoleType::Support;
			else if (role_str == "attacker") equipment->role_type = PopulationRoleType::Attacker;
			else if (role_str == "none")     equipment->role_type = PopulationRoleType::None;
			else
				this->invalidWarning(node[c4::to_csubstr("Role")],
					"Role must be none/tank/support/attacker (Job %hu); ignoring.\n", job_id);
		}
	} else if (!exists && !from_profile) {
		equipment->role_type = PopulationRoleType::None;
	}

	if (this->nodeExists(node, "VendorMessage")) {
		this->asString(node, "VendorMessage", equipment->vendor_message);
	} else if (!exists && !from_profile) {
		equipment->vendor_message.clear();
	}

	if (this->nodeExists(node, "VendorKey")) {
		this->asString(node, "VendorKey", equipment->vendor_key);
	} else if (!exists && !from_profile) {
		equipment->vendor_key.clear();
	}

	// Auto-promote behavior to Vendor when a VendorKey is set but no explicit
	// Behavior / TownBehavior was provided. Without this the placement-driven
	// autosummon pass cannot identify vendor jobs and merchant shells in towns
	// would behave as Combat by default.
	if (!equipment->vendor_key.empty() &&
	    equipment->behavior      == PopulationBehavior::Combat &&
	    equipment->town_behavior == PopulationBehavior::None) {
		equipment->town_behavior = PopulationBehavior::Vendor;
	}

	if (this->nodeExists(node, "Flags")) {
		const ryml::NodeRef flags_node = node[c4::to_csubstr("Flags")];
		if (flags_node.is_seq()) {
			if (!exists && !from_profile)
				equipment->flags = 0;
			for (const ryml::NodeRef& fv : flags_node.children()) {
				const ryml::csubstr v = fv.val();
				if (v.empty())
					continue;
				const std::string fname(v.data(), v.size());
				if (fname == "mortal")           equipment->flags |= PSF::Mortal;
				else if (fname == "immortal")    equipment->flags &= ~PSF::Mortal;
				else if (fname == "attack_only") equipment->flags |= PSF::AttackOnly;
				else if (fname == "skill_only")  equipment->flags |= PSF::SkillOnly;
				else
					this->invalidWarning(fv,
						"Unknown flag '%s' for job %hu; valid flags: mortal, immortal, attack_only, skill_only.\n",
						fname.c_str(), job_id);
			}
		} else {
			this->invalidWarning(flags_node, "Flags must be a sequence of flag names (job %hu).\n", job_id);
		}
	} else if (!exists && !from_profile) {
		equipment->flags = 0;
	}

	if (!exists) {
		this->put(job_id, equipment);
	}

	return 1;
}

// ---------------------------------------------------------------------------
// RAGNAROKMAC: mod price tables
// ---------------------------------------------------------------------------
//
// db/import/population_vendor_prices/<prefix>.csv, one row per item:
//
//     Id,Name,Min,Max
//     985,Elunium,240000,285000
//
// Id decides; Name is for people reading the file, and is looked up (Aegis or
// display name) only when Id is empty. Max may be left out. Min 0 (or empty)
// means "no price set yet": the row is skipped and the YAML price stands, so
// a table can list every item and be filled in over time. Fields may be
// quoted, and ";" works as the separator too (Excel writes it in some
// locales). Lines starting with # are comments.
//
// A table prices only the vendors whose VendorKey starts with "<prefix>/", so
// a mod's file (prontera-vendors.csv -> prontera-vendors/*) never touches
// another mod's vendors or the engine's own. A row wins over the YAML Price of
// every plain stock line of that item; lines with a refine, element or cards
// keep their YAML price. Read at load and on every reload.

static std::vector<std::string> s_pop_price_files;
std::unordered_map<std::string, std::unordered_map<t_itemid, PopMarketRow>> g_pop_market_tables;

static void pop_collect_price_file(const char* path) {
	const size_t n = strlen(path);
	if (n > 4 && strcmpi(path + n - 4, ".csv") == 0)
		s_pop_price_files.emplace_back(path);
}

static std::string pop_trim(const std::string& s) {
	const size_t a = s.find_first_not_of(" \t\r\n\"");
	if (a == std::string::npos)
		return "";
	const size_t b = s.find_last_not_of(" \t\r\n\"");
	return s.substr(a, b - a + 1);
}

void PopulationVendorDatabase::loadingFinished() {
	const std::string dir = std::string(db_path) + "/import/population_vendor_prices";
	if (check_filepath(dir.c_str()) != 1)
		return; // no mod ships a price table
	s_pop_price_files.clear();
	g_pop_market_tables.clear();
	findfile(dir.c_str(), ".csv", pop_collect_price_file);
	std::sort(s_pop_price_files.begin(), s_pop_price_files.end());

	for (const std::string& file : s_pop_price_files) {
		std::string base = file.substr(file.find_last_of("/\\") + 1);
		base.resize(base.size() - 4);
		const std::string prefix = base + "/";

		FILE* fp = fopen(file.c_str(), "r");
		if (fp == nullptr) {
			ShowWarning("Population engine: cannot read price table '%s'.\n", file.c_str());
			continue;
		}
		std::unordered_map<t_itemid, std::pair<uint32_t, uint32_t>> prices;
		auto& market = g_pop_market_tables[prefix];
		char buf[1024];
		int line = 0;
		while (fgets(buf, sizeof(buf), fp) != nullptr) {
			++line;
			const std::string row = pop_trim(buf);
			if (row.empty() || row[0] == '#' || row.compare(0, 2, "//") == 0)
				continue;
			// Split on , or ; outside double quotes ("" inside quotes is a quote).
			std::vector<std::string> col;
			std::string cur;
			bool quoted = false;
			for (size_t i = 0; i < row.size(); ++i) {
				const char c = row[i];
				if (c == '"') {
					if (quoted && i + 1 < row.size() && row[i + 1] == '"') { cur += '"'; ++i; }
					else quoted = !quoted;
				} else if ((c == ',' || c == ';') && !quoted) {
					col.push_back(pop_trim(cur));
					cur.clear();
				} else {
					cur += c;
				}
			}
			col.push_back(pop_trim(cur));
			if (strcmpi(col[0].c_str(), "id") == 0)
				continue; // the header row
			if (col.size() < 3) {
				ShowWarning("Population engine: %s:%d: expected Id,Name,Min,Max; skipped.\n", file.c_str(), line);
				continue;
			}
			t_itemid id = 0;
			if (!col[0].empty()) {
				id = static_cast<t_itemid>(strtoul(col[0].c_str(), nullptr, 10));
				if (!item_db.exists(id)) id = 0;
			} else if (auto idata = item_db.searchname(col[1].c_str())) {
				id = idata->nameid;
			}
			if (id == 0) {
				ShowWarning("Population engine: %s:%d: unknown item '%s%s'; skipped.\n", file.c_str(), line,
					col[0].c_str(), col[0].empty() ? col[1].c_str() : "");
				continue;
			}
			const uint32_t lo = static_cast<uint32_t>(strtoul(col[2].c_str(), nullptr, 10));
			uint32_t hi = col.size() > 3 && !col[3].empty() ? static_cast<uint32_t>(strtoul(col[3].c_str(), nullptr, 10)) : lo;
			// RAGNAROKMAC: BuyersPerDay and SellersPerDay (columns 6 and 7, after
			// Source) are for the customers who visit players' stalls. Whole
			// numbers, so a locale's decimal comma cannot split a row.
			PopMarketRow mrow;
			if (col.size() > 5 && !col[5].empty())
				mrow.buyers_day = static_cast<int32_t>(strtol(col[5].c_str(), nullptr, 10));
			if (col.size() > 6 && !col[6].empty())
				mrow.sellers_day = static_cast<int32_t>(strtol(col[6].c_str(), nullptr, 10));
			if (lo == 0) {
				if (mrow.buyers_day >= 0 || mrow.sellers_day >= 0)
					market[id] = mrow;
				continue; // 0 (or empty) = no price set yet; the YAML price stands
			}
			if (hi < lo) hi = lo;
			prices[id] = { std::min<uint32_t>(lo, MAX_ZENY), std::min<uint32_t>(hi, MAX_ZENY) };
			mrow.lo = prices[id].first;
			mrow.hi = prices[id].second;
			market[id] = mrow;
		}
		fclose(fp);

		size_t applied = 0;
		for (auto& kv : entries_) {
			if (kv.first.compare(0, prefix.size(), prefix) != 0)
				continue;
			for (std::vector<PopulationVendorStock>* list : { &kv.second.pool, &kv.second.stock }) {
				for (PopulationVendorStock& vs : *list) {
					if (vs.refine_max != 0 || vs.element != 0 || vs.stars != 0 || !vs.cards.empty())
						continue;
					auto it = prices.find(vs.nameid);
					if (it == prices.end())
						continue;
					vs.price = it->second.first;
					vs.price_max = it->second.second > it->second.first ? it->second.second : 0;
					++applied;
				}
			}
		}
		ShowStatus("Population engine: price table '%s': %zu items, %zu stall lines priced.\n",
			file.c_str(), prices.size(), applied);
	}
}
