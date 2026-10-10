// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (companion strategies): db/population_strategy.yml. See the header for
// where the engine calls in, and docs/mods/companion-strategies.md for the format.
//
// Unity build: population_engine_factory.cpp includes this file LAST, after
// population_engine_combat.cpp and the expanded-condition parser. It uses three of the
// combat file's own checks (pop_skill_weapon_ok, pop_skill_state_ok,
// population_shell_resolve_sc_name) so a rule refuses a cast exactly where the skill
// rotation would; they are internal to that file and only visible here because of
// that order.
//
// Everything runs on the map server's main thread. No randomness: the same situation
// gives the same decision, so a rule set can be reasoned about and traced.

#include "population_strategy.hpp"

#include <algorithm>
#include <cctype>
#include <climits>
#include <cstdarg>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <set>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <common/database.hpp>
#include <common/showmsg.hpp>
#include <common/strlib.hpp>

#include "../../battle.hpp"
#include "../../clif.hpp"
#include "../../itemdb.hpp"
#include "../../map.hpp"
#include "../../mob.hpp"
#include "../../party.hpp"
#include "../../pc.hpp"
#include "../../script.hpp"
#include "../../skill.hpp"
#include "../../status.hpp"
#include "../../unit.hpp"
#include "../../population_engine.hpp"
#include "../expanded_ai/expanded_parser.hpp"
#include "../runtime/population_shell_runtime.hpp"

namespace pop_strategy {

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

enum class Event : uint8 {
	None, PartyChat, PartyMemberDied, Casts, Signal, EncounterEnded, TargetLost, HpBelow, OwnerHpBelow,
	WeightAbove, EquipBroken, ItemBelow, StatusGained,
};
enum class Target : uint8 { Enemy, Self, Owner, Event, Source, AllyLowestHp, DeadAlly };
enum class From : uint8 { Anyone, Owner, Leader };
enum class At : uint8 { Party, Self, Owner, Anyone };
/// Who cast it (casts' By:) or whose ground units count (Field's Owner:).
enum class Who : uint8 { Self, Party, Monster, Enemy, Anyone };
enum class Move : uint8 { None, EventCell, EventUnit, Field, Reachable, Sight };
enum class Retreat : uint8 { None, Away, Owner };

/// Requires: what a companion must (and must not) have for a rule or a build to exist for it.
struct Requirements {
	std::vector<uint16> skills;
	std::vector<uint16> lacks;
	std::vector<t_itemid> items;
	int32 base_level = 0;
	uint8 roles = 0;             ///< a bit per PopulationRoleType the companion may have (0 = any)
};

/// Who, among the party, a selector means.
enum class Member : uint8 { Any, Party, Owner, Self, Tank, Support, Attacker };

/// Target: { Enemy: ... } / { Ally: ... }: the monster or party member a rule picks for itself.
struct Selector {
	enum class Kind : uint8 { None, Enemy, Ally } kind = Kind::None;
	enum class Pick : uint8 { Attacking, TargetOf, Nearest, LowestHp, Boss, Slaves, Casting, Missing, Having, Hidden,
		Attacked, Dead } pick = Pick::Nearest;
	bool boss_only = false;      ///< Enemy selectors and Count: bosses only
	Member who = Member::Party;  ///< Enemy attacking/target_of: whose attacker or whose target
	bool not_self = false;       ///< leave the companion itself out
	Member prefer = Member::Any; ///< Enemy attacking: monsters on this member first
	uint8 roles = 0;             ///< Ally: only members with one of these roles (a bit per PopulationRoleType; 0 = any)
	bool not_owner = false;      ///< Ally: leave the owner out (buff the party, not the player it follows)
	std::vector<uint16> skills;  ///< Enemy casting: only these casts (empty = any)
	std::vector<uint32> mobs;    ///< Enemy: only these monsters, by mob id (empty = any)
	std::vector<int32> jobs;     ///< Ally: only these jobs (each with its family and base class)
	int16 status = -1;           ///< Ally missing: lacking this status
	int32 expiring_ms = 0;       ///< Ally missing: or having it with less than this left (0: only lacking)
	int16 range = 0;             ///< 0 = the cast's range, or AREA_SIZE without a cast
	int8 race = -1;              ///< Enemy: only monsters of this race (RC_*)
	int8 element = -1;           ///< Enemy: only monsters of this element (ELE_*), as they are now
};

struct Rule {
	uint32 uid = 0;
	std::string name;
	int32 priority = 0;

	Requirements req;

	// On: an event opens a window (within_ms) in which the rule may fire once.
	Event event = Event::None;
	int32 ev_value = 0;
	t_itemid ev_item = 0;
	int16 ev_slot = -1;          ///< EQI_* for equip_broken; -1 = any worn slot
	uint16 ev_skill = 0;         ///< monster_casts: only this skill (0 = any)
	int16 ev_status = -1;        ///< status_gained
	At ev_at = At::Party;
	bool ev_at_set = false;
	Who ev_by = Who::Monster;      ///< casts: whose casts to watch
	From ev_from = From::Anyone;
	std::string ev_match;        ///< party_chat: lower-case text the line must contain
	std::string ev_signal;       ///< signal: its name, lower-case
	uint32 ev_mob = 0;           ///< encounter_ended: only this monster (0 = any)
	uint8 ev_reason = 0;         ///< encounter_ended / target_lost: 0 any, 1 died, 2 vanished
	int8 ev_boss = -1;           ///< encounter_ended / target_lost: 1 only a boss, 0 only an ordinary monster
	bool ev_signal_self = false; ///< signal: also hear its own (From: anyone)
	uint32 within_ms = 3000;

	// When: the engine's own condition trees (population_skill_db.yml syntax).
	std::shared_ptr<expanded_ai::ExpandedCondition> when;
	// Charges: a counter a status keeps (Cicada's blocks left). Absent status = 0.
	int16 charge_sc = -1;
	uint8 charge_val = 2;        ///< which of the status's values (1-4) holds the count
	int32 charge_below = -1, charge_atleast = -1;
	// Field: ground units of a skill still standing within field_range (0 = its own cell),
	// placed by field_owner (default: the companion itself).
	uint16 field_skill = 0;
	int16 field_range = 5;
	Who field_owner = Who::Self;
	bool field_at_target = false;  ///< count around the rule's target (the boss in its Pneuma), not the companion
	// Count: monsters matching count_sel within count_range of the companion or the rule's target.
	bool has_count = false;
	Selector count_sel;
	bool count_around_target = false;
	int16 count_range = 5;
	int32 count_below = -1, count_atleast = -1;
	// Enemy: { Element, Race, Size, Boss } -- what the monster the rule is about must be.
	std::vector<int32> enemy_elements, enemy_races, enemy_sizes;
	int8 enemy_boss = -1;
	int8 reach = -1;             ///< Reach: 1 only if the monster can reach the companion, 0 only if it cannot
	int32 field_below = -1, field_atleast = -1;

	// Actions. Cast and Retreat end the turn; Say and Switch do not.
	uint16 cast_skill = 0;
	/// Cast: [A, B, C]: the one the target is weakest to, by rAthena's element table, among
	/// those the companion knows and has the SP for; ties go to list order. cast_skill is the first.
	std::vector<uint16> cast_options;
	uint16 cast_lv = 0;          ///< 0 = the level the companion knows
	Target target = Target::Enemy;
	Selector sel;                ///< overrides target when sel.kind != None
	Selector absent;             ///< Absent: the rule applies only while this finds nobody
	Selector present;            ///< Present: the rule applies only while this finds someone
	bool set_target = false;     ///< make the chosen monster the companion's combat target
	std::string say;
	bool say_area = false;
	Retreat retreat = Retreat::None;
	int16 distance = 5;
	std::string switch_to;
	std::string signal;          ///< tell the party's companions (On: signal), lower-case
	bool hold = false;           ///< stand still and end the turn
	bool sit = false;            ///< sit down (regenerating faster) while the rule applies
	int16 keep_distance = 0;     ///< step out to at least this many cells from the monster (0 = off)
	int16 keep_max = 0;          ///< and back in to at most this many (0 = no limit): stay in range of it
	// Kite: away from the monster on the companion, within reach of an anchor (the rule's
	// target, else the owner), but not on top of it.
	bool kite = false;
	int16 kite_away = 4;         ///< at least this far from the monster
	int16 kite_within = 7;       ///< at most this far from the anchor
	int16 kite_gap = 3;          ///< and no closer to the anchor than this
	// Leave: step off ground units of leave_skill (0 = any) placed by leave_owner.
	bool leave = false;
	uint16 leave_skill = 0;
	Who leave_owner = Who::Enemy;
	int16 leave_within = 8;
	// MoveTo: the cell an event's cast aims at, or the nearest cell of a ground field.
	Move move = Move::None;
	uint16 move_skill = 0;
	Who move_owner = Who::Anyone;
	int16 move_within = 8;
	int16 move_depth = 0;        ///< MoveTo Field: that many cells inside the field's edge (0 = any cell of it)
	int16 move_range = 9;        ///< MoveTo Sight: a cell at most this far from the target
	bool consume = false;        ///< take the skill's ItemCost from the inventory, as a player pays it
	// Aim: where a ground Cast lands, when not at the target's feet. aim_cells cells from the
	// companion (or from the target) along the line between the two; aim_lead takes the target
	// to be where its walk will have brought it when the cast lands.
	bool aim = false;
	int16 aim_cells = 0;
	bool aim_from_target = false;
	bool aim_lead = false;
	/// UseItem: an item from the companion's own bag, used as a player uses it (its script, its
	/// delay, one taken). A list uses the first one it carries. The rule exists only for a
	/// companion that carries one of them. use_item is the first of the list.
	t_itemid use_item = 0;
	std::vector<t_itemid> use_items;

	uint32 cooldown_ms = 0;
	bool one_per_party = false;
	// InStrategy / InFight: ms in the plan's active strategy, and in the companion's current
	// fight, measured from timestamps (a companion that took no turns still sees time pass).
	int32 instrategy_below = -1, instrategy_atleast = -1;
	int32 infight_below = -1, infight_atleast = -1;
	/// Claim: a party-wide claim on the target under this name while the rule acts, so other
	/// companions' rules with the same claim take another target (one Lex per boss, crowd
	/// control spread). Held claim_ms after the last action.
	std::string claim;
	uint32 claim_ms = 5000;
};
using RulePtr = std::shared_ptr<Rule>;

struct Strategy {
	std::vector<RulePtr> rules;
	std::vector<uint16> ban;     ///< added to the plan's Ban while this strategy is active
	int8 rotation = -1;          ///< -1: the plan's Rotation; 0/1: overrides it while active
	std::vector<std::string> disable; ///< added to the plan's Disable while this strategy is active
	bool has_allow = false;      ///< Allow: given (an empty list allows nothing)
	std::vector<uint16> allow;   ///< narrows the plan's Allow while this strategy is active
	int8 attack = -1;            ///< -1: the plan's Attack; 0/1: overrides it while active
};

/// Who a plan is for: recruited companions (the default), the regular shells around the
/// world, or both.
enum class Audience : uint8 { Companions, Shells, All };

/// What one (monster, job, build) has. Rules outside any strategy apply in all of them.
struct Plan {
	Audience audience = Audience::Companions;
	Requirements req;            ///< a Build: only companions that meet these use the plan
	std::vector<RulePtr> rules;
	std::map<std::string, Strategy> strategies;
	std::string start;
	std::vector<uint16> ban;
	/// The normal skill rotation: -1 = the default, which is off for a plan about a particular
	/// monster (the plan says what to cast) and no opinion for a broad one (All, Boss, a race or
	/// an element); 0/1 = set.
	int8 rotation = -1;
	/// Rules of the other plans that apply, by Name, that do not run while this plan applies:
	/// a boss's plan putting a role's rule aside.
	std::vector<std::string> disable;
	/// Allow: the only skills the engine may use on its own while this plan applies -- the
	/// rotation, its heals and buffs. Every plan that applies must allow a skill, so a more
	/// specific plan can only narrow. No Allow: all. Rules are not bound by it (Ban binds them).
	bool has_allow = false;
	std::vector<uint16> allow;
	/// Every skill this plan's own rules cast (sorted): its Allow and Ban never stop those.
	std::vector<uint16> own;
	/// Attack: false -- no plain attacks while this plan applies (the engine's skill_only);
	/// -1 = no say. The most specific plan that says anything decides.
	int8 attack = -1;
	/// Exact: true -- only the jobs named and their own family (High and Baby), not the
	/// classes built on them: Job: Acolyte without the Priests and Monks.
	bool exact = false;
};


struct Targeting {
	int32 priority = 0;
	bool ignore = false;
	int32 max_attackers = 0;     ///< 0 = no cap; else the owner and party companions on it, at most
};

/// Catalysts (`Consume: true`). A recruited companion now pays its item costs through rAthena,
/// as a player does (population_shell_inventory, patch 0033): pop_skill_state_ok passes a skill
/// over when its items are not in the bag, and rAthena takes them when the cast lands. This
/// switch would pay a second time, so it stays off.
constexpr bool kPayCatalysts = false;

constexpr uint32 kAllMobs = 0;
/// Mob: Boss, every boss-class monster: the plan applies while one is near (the nearest).
constexpr uint32 kBossMobs = UINT32_MAX;
constexpr int32 kAllJobs = -1;
/// Mob: { Race, Element }: a kind of monster, read from the one the companion fights. A field
/// left out matches any. Kept clear of monster ids by the top bit.
constexpr uint32 kCategory = 0x80000000u;
static uint32 category_key(int32 race, int32 element)
{
	return kCategory | (static_cast<uint32>(race + 1) << 8) | static_cast<uint32>(element + 1);
}
static bool is_category(uint32 mob)
{
	return mob != kBossMobs && (mob & kCategory) != 0;
}
/// "PHREEONI", "Boss", "All" or "Race 1, Element any": a plan's monster, for warnings.
static std::string mob_label(uint32 mob)
{
	if (mob == kAllMobs)
		return "All";
	if (mob == kBossMobs)
		return "Boss";
	if (mob & kCategory) {
		const int32 race = static_cast<int32>((mob >> 8) & 0xff) - 1, element = static_cast<int32>(mob & 0xff) - 1;
		return "Race " + (race < 0 ? std::string("any") : std::to_string(race)) + ", Element "
			+ (element < 0 ? std::string("any") : std::to_string(element));
	}
	const std::shared_ptr<s_mob_db> db = mob_db.find(mob);
	return db != nullptr ? db->sprite : std::to_string(mob);
}

/// A plan about one particular monster, rather than a broad one (All, Boss, a race or element).
static bool is_particular(uint32 mob)
{
	return mob != kAllMobs && mob != kBossMobs && !is_category(mob);
}
/// (mob id, a category, kBossMobs or kAllMobs; job id or kAllJobs; build name or "" for every build)
using PlanKey = std::tuple<uint32, int32, std::string>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

static std::string lower(std::string s)
{
	for (char &c : s)
		c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
	return s;
}

static std::string upper(std::string s)
{
	for (char &c : s)
		c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
	return s;
}

static bool is_number(const std::string &s)
{
	return !s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
}

static std::string scalar(const ryml::NodeRef &node)
{
	if (!node.has_val())
		return std::string();
	const ryml::csubstr v = node.val();
	return std::string(v.data(), v.size());
}

static std::string key_of(const ryml::NodeRef &node)
{
	if (!node.has_key())
		return std::string();
	const ryml::csubstr k = node.key();
	return std::string(k.data(), k.size());
}

/// A scalar or a sequence of scalars, as a list.
static std::vector<std::string> scalars(const ryml::NodeRef &node)
{
	std::vector<std::string> out;
	if (node.is_seq()) {
		for (const ryml::NodeRef &it : node.children())
			if (it.has_val())
				out.push_back(scalar(it));
	} else if (node.has_val()) {
		out.push_back(scalar(node));
	}
	return out;
}

/// A number written in a mod's table, up to `max`. False for anything longer or larger: the
/// name then names nothing, where std::stoul would throw (and stop the map server) on a long
/// one and a cast would wrap a large one round to another id (65537 to skill 1).
static bool number_upto(const std::string &name, uint64 max, uint64 &out)
{
	if (name.empty() || name.size() > 20)
		return false;
	uint64 v = 0;
	for (const char c : name) {
		if (c < '0' || c > '9')
			return false;
		if (v > (max - static_cast<uint64>(c - '0')) / 10)
			return false;
		v = v * 10 + static_cast<uint64>(c - '0');
	}
	out = v;
	return true;
}

static uint16 skill_of(const std::string &name)
{
	if (is_number(name)) {
		uint64 id = 0;
		return number_upto(name, UINT16_MAX, id) && skill_db.find(static_cast<uint16>(id)) != nullptr ? static_cast<uint16>(id) : 0;
	}
	return skill_name2id(name.c_str());
}

static uint32 mob_of(const std::string &name)
{
	if (is_number(name)) {
		uint64 id = 0;
		return number_upto(name, INT32_MAX, id) && mob_db.find(static_cast<uint32>(id)) != nullptr ? static_cast<uint32>(id) : 0;
	}
	const std::shared_ptr<s_mob_db> db = mobdb_search_aegisname(name.c_str());
	return db != nullptr ? db->id : 0;
}

static t_itemid item_of(const std::string &name)
{
	if (is_number(name)) {
		uint64 id = 0;
		return number_upto(name, UINT32_MAX, id) && item_db.exists(static_cast<t_itemid>(id)) ? static_cast<t_itemid>(id) : 0;
	}
	const std::shared_ptr<item_data> id = item_db.search_aegisname(name.c_str());
	return id != nullptr ? id->nameid : 0;
}

/// "Priest", "High_Priest", "JOB_PRIEST" or 8. -2 when it names nothing, -3 when it names a
/// job this server's era does not have (a 4th class in pre-renewal): a list may name it anyway.
static int32 job_of(const std::string &name)
{
	if (lower(name) == "all")
		return kAllJobs;
	int64 value = 0;
	uint64 number = 0;
	if (is_number(name)) {
		if (!number_upto(name, UINT16_MAX, number))
			return -2;
		value = static_cast<int64>(number);
	} else if (!script_get_constant(upper("JOB_" + name).c_str(), &value) && !script_get_constant(name.c_str(), &value))
		return -2;
	return job_db.exists(static_cast<uint16>(value)) ? static_cast<int32>(value) : -3;
}

/// The job's family, named by its plain 2nd class: Priest for a High Priest, Arch Bishop,
/// Cardinal or Baby Priest. A 1st class is its own family. -1 when there is none.
static int32 job_family(int32 class_, int32 sex)
{
	return pc_mapid2jobid(pc_jobid2mapid(static_cast<uint16>(class_)) & MAPID_SECONDMASK, sex);
}

/// Whether a member's job is `job`: the job itself, its family (Job: Priest takes in a High
/// Priest) or its 1st class (Job: Acolyte takes in Priests and Monks alike).
static bool job_matches(const map_session_data *sd, int32 job)
{
	const int32 c = sd->status.class_;
	return c == job || job_family(c, sd->status.sex) == job || population_engine_job_base_class(c) == job;
}

/// "Undead", "DemiHuman" or "RC_UNDEAD". -2 when it names no race.
static int32 race_of(const std::string &name)
{
	int64 value = 0;
	if (!script_get_constant(upper("RC_" + name).c_str(), &value) && !script_get_constant(upper(name).c_str(), &value))
		return -2;
	return value >= RC_FORMLESS && value < RC_ALL ? static_cast<int32>(value) : -2;
}

/// "Fire", "Ghost" or "ELE_FIRE". -2 when it names no element.
static int32 element_of(const std::string &name)
{
	int64 value = 0;
	if (!script_get_constant(upper("ELE_" + name).c_str(), &value) && !script_get_constant(upper(name).c_str(), &value))
		return -2;
	return value >= ELE_NEUTRAL && value < ELE_ALL ? static_cast<int32>(value) : -2;
}

static int16 slot_of(const std::string &name)
{
	static const std::map<std::string, int16> slots = {
		{ "any", -1 }, { "weapon", EQI_HAND_R }, { "shield", EQI_HAND_L }, { "armor", EQI_ARMOR },
		{ "garment", EQI_GARMENT }, { "shoes", EQI_SHOES }, { "head_top", EQI_HEAD_TOP },
		{ "head_mid", EQI_HEAD_MID }, { "head_low", EQI_HEAD_LOW },
		{ "accessory_left", EQI_ACC_L }, { "accessory_right", EQI_ACC_R },
	};
	const auto it = slots.find(lower(name));
	return it != slots.end() ? it->second : -2;
}

static bool member_of(const std::string &name, Member &out)
{
	static const std::map<std::string, Member> members = {
		{ "any", Member::Any }, { "party", Member::Party }, { "owner", Member::Owner }, { "self", Member::Self },
		{ "tank", Member::Tank }, { "support", Member::Support }, { "attacker", Member::Attacker },
	};
	const auto it = members.find(lower(name));
	if (it == members.end())
		return false;
	out = it->second;
	return true;
}

static int8 role_of(const std::string &name)
{
	const std::string r = lower(name);
	if (r == "none") return static_cast<int8>(PopulationRoleType::None);
	if (r == "tank") return static_cast<int8>(PopulationRoleType::Tank);
	if (r == "support") return static_cast<int8>(PopulationRoleType::Support);
	if (r == "attacker") return static_cast<int8>(PopulationRoleType::Attacker);
	return -2;
}

static bool who_of(const std::string &name, Who &out)
{
	static const std::map<std::string, Who> whos = {
		{ "self", Who::Self }, { "party", Who::Party }, { "monster", Who::Monster },
		{ "enemy", Who::Enemy }, { "anyone", Who::Anyone },
	};
	const auto it = whos.find(lower(name));
	if (it == whos.end())
		return false;
	out = it->second;
	return true;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class StrategyDatabase : public YamlDatabase {
public:
	std::map<PlanKey, Plan> plans;
	std::unordered_map<uint32, Targeting> targeting;
	/// Encounter: true -- these monsters' plans apply while one is near, whatever the companion targets.
	std::unordered_set<uint32> encounter;
	size_t rule_count = 0;
	bool uses_chat = false;
	bool limits_rotation = false;
	bool for_shells = false;     ///< some plan is For: shells or all, so regular shells take turns
	bool revives = false;        ///< some rule casts Resurrection (or Death Valley) itself
	uint8 boss_plans = 0;        ///< who has Mob: Boss plans (1 companions, 2 shells): their turns look for a boss
	uint8 category_plans = 0;    ///< who has Mob: { Race, Element } plans (as boss_plans)
	bool limits_skills = false;  ///< some plan or strategy has an Allow or a Ban
	bool limits_attack = false;  ///< some plan or strategy says Attack

	StrategyDatabase() : YamlDatabase("POPULATION_STRATEGY_DB", 1) {}

	void clear() override
	{
		this->plans.clear();
		this->targeting.clear();
		this->encounter.clear();
		this->rule_count = 0;
		this->uses_chat = false;
		this->limits_rotation = false;
		this->for_shells = false;
		this->revives = false;
		this->boss_plans = 0;
		this->category_plans = 0;
		this->limits_skills = false;
		this->limits_attack = false;
	}

	const std::string getDefaultLocation() override
	{
		return std::string(db_path) + "/population_strategy.yml";
	}

	uint64 parseBodyNode(const ryml::NodeRef &node) override;
	uint64 parseEntry(const ryml::NodeRef &node);
	void loadingFinished() override;

private:
	uint32 next_uid_ = 1;

	void warn_unknown_keys(const ryml::NodeRef &node, std::initializer_list<const char *> known, const char *what);
	bool parse_requires(const ryml::NodeRef &node, Requirements &req);
	bool parse_selector(const ryml::NodeRef &node, Selector &sel);
	RulePtr parse_rule(const ryml::NodeRef &node, bool &remove);
	bool parse_event(const ryml::NodeRef &node, Rule &rule);
	void merge_rules(const ryml::NodeRef &seq, std::vector<RulePtr> &into);
	void merge_job(const ryml::NodeRef &node, const std::vector<uint32> &mobs);
};

void StrategyDatabase::warn_unknown_keys(const ryml::NodeRef &node, std::initializer_list<const char *> known, const char *what)
{
	for (const ryml::NodeRef &child : node.children()) {
		const std::string key = key_of(child);
		if (std::none_of(known.begin(), known.end(), [&](const char *k) { return key == k; }))
			this->invalidWarning(child, "Unknown key '%s' in %s, ignored.\n", key.c_str(), what);
	}
}

bool StrategyDatabase::parse_event(const ryml::NodeRef &node, Rule &rule)
{
	static const std::map<std::string, Event> events = {
		{ "party_chat", Event::PartyChat }, { "party_member_died", Event::PartyMemberDied },
		{ "monster_casts", Event::Casts }, { "casts", Event::Casts }, { "signal", Event::Signal },
		{ "encounter_ended", Event::EncounterEnded }, { "target_lost", Event::TargetLost }, { "hp_below", Event::HpBelow },
		{ "owner_hp_below", Event::OwnerHpBelow }, { "weight_above", Event::WeightAbove },
		{ "equip_broken", Event::EquipBroken }, { "item_below", Event::ItemBelow },
		{ "status_gained", Event::StatusGained },
	};
	std::string name;
	if (node.is_map()) {
		this->warn_unknown_keys(node, { "Event", "By", "Name", "Mob", "Reason", "Boss", "Value", "Item", "Slot", "Skill", "Status", "At", "Match",
			"From", "Within" }, "On");
		if (!this->asString(node, "Event", name))
			return false;
	} else {
		name = scalar(node);
	}
	const auto it = events.find(lower(name));
	if (it == events.end()) {
		this->invalidWarning(node, "Unknown event '%s'.\n", name.c_str());
		return false;
	}
	rule.event = it->second;
	if (!node.is_map()) {
		if (rule.event == Event::Signal)
			this->invalidWarning(node, "signal needs a Name: On: { Event: signal, Name: ... }.\n");
		return rule.event != Event::ItemBelow && rule.event != Event::StatusGained && rule.event != Event::Signal;
	}
	if (this->nodeExists(node, "Mob")) {
		std::string mob;
		this->asString(node, "Mob", mob);
		if (rule.event != Event::EncounterEnded || (rule.ev_mob = mob_of(mob)) == 0) {
			this->invalidWarning(node["Mob"], "Mob belongs to encounter_ended and must name a monster.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "Reason")) {
		std::string reason;
		this->asString(node, "Reason", reason);
		reason = lower(reason);
		if (rule.event != Event::EncounterEnded && rule.event != Event::TargetLost) {
			this->invalidWarning(node["Reason"], "Reason belongs to encounter_ended and target_lost.\n");
			return false;
		}
		if (reason == "died") rule.ev_reason = 1;
		else if (reason == "vanished") rule.ev_reason = 2;
		else if (reason != "any") {
			this->invalidWarning(node["Reason"], "Reason is died, vanished or any.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "Boss")) {
		bool boss = false;
		if (rule.event != Event::EncounterEnded && rule.event != Event::TargetLost) {
			this->invalidWarning(node["Boss"], "Boss belongs to encounter_ended and target_lost.\n");
			return false;
		}
		if (!this->asBool(node, "Boss", boss))
			return false;
		rule.ev_boss = boss ? 1 : 0;
	}
	if (this->nodeExists(node, "Name")) {
		this->asString(node, "Name", rule.ev_signal);
		rule.ev_signal = lower(rule.ev_signal);
	}
	if (rule.event == Event::Signal && rule.ev_signal.empty()) {
		this->invalidWarning(node, "signal needs a Name.\n");
		return false;
	}

	if (this->nodeExists(node, "Value"))
		this->asInt32(node, "Value", rule.ev_value);
	if (this->nodeExists(node, "Within"))
		this->asUInt32(node, "Within", rule.within_ms);
	if (this->nodeExists(node, "Item")) {
		std::string item;
		this->asString(node, "Item", item);
		if ((rule.ev_item = item_of(item)) == 0) {
			this->invalidWarning(node["Item"], "Unknown item '%s'.\n", item.c_str());
			return false;
		}
	}
	if (this->nodeExists(node, "Slot")) {
		std::string slot;
		this->asString(node, "Slot", slot);
		if ((rule.ev_slot = slot_of(slot)) == -2) {
			this->invalidWarning(node["Slot"], "Unknown slot '%s'.\n", slot.c_str());
			return false;
		}
	}
	if (this->nodeExists(node, "Skill")) {
		std::string skill;
		this->asString(node, "Skill", skill);
		if ((rule.ev_skill = skill_of(skill)) == 0) {
			this->invalidWarning(node["Skill"], "Unknown skill '%s'.\n", skill.c_str());
			return false;
		}
	}
	if (this->nodeExists(node, "Status")) {
		std::string status;
		this->asString(node, "Status", status);
		if ((rule.ev_status = population_shell_resolve_sc_name(status)) < 0) {
			this->invalidWarning(node["Status"], "Unknown status '%s'.\n", status.c_str());
			return false;
		}
	}
	if (this->nodeExists(node, "By")) {
		std::string by;
		this->asString(node, "By", by);
		if (rule.event != Event::Casts || !who_of(by, rule.ev_by)) {
			this->invalidWarning(node["By"], "By belongs to casts: self, party, monster, enemy or anyone.\n");
			return false;
		}
		if (lower(name) == "monster_casts" && rule.ev_by != Who::Monster) {
			this->invalidWarning(node["By"], "monster_casts is casts with By: monster.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "At")) {
		rule.ev_at_set = true;
		std::string at;
		this->asString(node, "At", at);
		at = lower(at);
		if (at == "party") rule.ev_at = At::Party;
		else if (at == "self") rule.ev_at = At::Self;
		else if (at == "owner") rule.ev_at = At::Owner;
		else if (at == "anyone") rule.ev_at = At::Anyone;
		else {
			this->invalidWarning(node["At"], "At must be party, self, owner or anyone.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "From") && rule.event == Event::Signal) {
		// A companion does not hear its own signal unless asked to.
		std::string from;
		this->asString(node, "From", from);
		from = lower(from);
		if (from == "anyone") rule.ev_signal_self = true;
		else if (from != "others") {
			this->invalidWarning(node["From"], "A signal's From is others (default) or anyone.\n");
			return false;
		}
	} else if (this->nodeExists(node, "From")) {
		std::string from;
		this->asString(node, "From", from);
		from = lower(from);
		if (from == "anyone") rule.ev_from = From::Anyone;
		else if (from == "owner") rule.ev_from = From::Owner;
		else if (from == "leader") rule.ev_from = From::Leader;
		else {
			this->invalidWarning(node["From"], "From must be anyone, owner or leader.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "Match")) {
		this->asString(node, "Match", rule.ev_match);
		rule.ev_match = lower(rule.ev_match);
	}
	if (rule.event == Event::Casts && !rule.ev_at_set)
		rule.ev_at = rule.ev_by == Who::Monster || rule.ev_by == Who::Enemy ? At::Party : At::Anyone;
	if (rule.event == Event::ItemBelow && rule.ev_item == 0) {
		this->invalidWarning(node, "item_below needs Item.\n");
		return false;
	}
	if (rule.event == Event::StatusGained && rule.ev_status < 0) {
		this->invalidWarning(node, "status_gained needs Status.\n");
		return false;
	}
	return true;
}

/// Requires: { Skills, Lacks, Items, BaseLevel }. False (and a warning) on a name that resolves to nothing.
bool StrategyDatabase::parse_requires(const ryml::NodeRef &node, Requirements &req)
{
	this->warn_unknown_keys(node, { "Skills", "Lacks", "Items", "BaseLevel", "Role" }, "Requires");
	// A list takes any of them: [support, none] is "a support, or one with no duty given".
	if (this->nodeExists(node, "Role")) {
		for (const std::string &name : scalars(node["Role"])) {
			const int8 role = role_of(name);
			if (role == -2) {
				this->invalidWarning(node["Role"], "Role must be tank, support, attacker or none.\n");
				return false;
			}
			req.roles |= static_cast<uint8>(1u << role);
		}
	}
	auto skills = [&](const char *key, std::vector<uint16> &out) {
		if (!this->nodeExists(node, key))
			return true;
		for (const std::string &s : scalars(node[c4::to_csubstr(key)])) {
			const uint16 id = skill_of(s);
			if (id == 0) {
				this->invalidWarning(node[c4::to_csubstr(key)], "Unknown skill '%s'; skipped.\n", s.c_str());
				return false;
			}
			out.push_back(id);
		}
		return true;
	};
	if (!skills("Skills", req.skills) || !skills("Lacks", req.lacks))
		return false;
	if (this->nodeExists(node, "Items")) {
		for (const std::string &s : scalars(node["Items"])) {
			const t_itemid id = item_of(s);
			if (id == 0) {
				this->invalidWarning(node["Items"], "Unknown item '%s'; skipped.\n", s.c_str());
				return false;
			}
			req.items.push_back(id);
		}
	}
	if (this->nodeExists(node, "BaseLevel"))
		this->asInt32(node, "BaseLevel", req.base_level);
	return true;
}

/// Target: { Enemy: attacking, Who: party, NotSelf: true, Prefer: support, Job, Range: n }
/// Target: { Ally: lowest_hp | nearest | missing, Role, Job, Status, NotSelf, Range }
/// On an Enemy: attacking or target_of selector, Job is the member's: "what is hitting a Priest".
bool StrategyDatabase::parse_selector(const ryml::NodeRef &node, Selector &sel)
{
	this->warn_unknown_keys(node, { "Enemy", "Ally", "Who", "NotSelf", "NotOwner", "Prefer", "Role", "Job", "Status",
		"Skill", "Mob", "Range", "Boss", "Race", "Element", "Expiring" }, "Target");
	std::string pick;
	if (this->nodeExists(node, "Enemy")) {
		static const std::map<std::string, Selector::Pick> picks = {
			{ "attacking", Selector::Pick::Attacking }, { "target_of", Selector::Pick::TargetOf },
			{ "nearest", Selector::Pick::Nearest }, { "lowest_hp", Selector::Pick::LowestHp },
			{ "boss", Selector::Pick::Boss }, { "slaves", Selector::Pick::Slaves }, { "casting", Selector::Pick::Casting },
			{ "hidden", Selector::Pick::Hidden },
		};
		this->asString(node, "Enemy", pick);
		const auto it = picks.find(lower(pick));
		if (it == picks.end()) {
			this->invalidWarning(node["Enemy"], "Enemy is attacking, target_of, nearest, lowest_hp, boss, slaves, casting or hidden; the rule is skipped.\n");
			return false;
		}
		sel.kind = Selector::Kind::Enemy;
		sel.pick = it->second;
		if (sel.pick == Selector::Pick::TargetOf)
			sel.who = Member::Owner;
	} else if (this->nodeExists(node, "Ally")) {
		static const std::map<std::string, Selector::Pick> picks = {
			{ "lowest_hp", Selector::Pick::LowestHp }, { "nearest", Selector::Pick::Nearest },
			{ "missing", Selector::Pick::Missing }, { "having", Selector::Pick::Having },
			{ "attacked", Selector::Pick::Attacked }, { "dead", Selector::Pick::Dead },
		};
		this->asString(node, "Ally", pick);
		const auto it = picks.find(lower(pick));
		if (it == picks.end()) {
			this->invalidWarning(node["Ally"], "Ally is lowest_hp, nearest, missing, having, attacked or dead; the rule is skipped.\n");
			return false;
		}
		sel.kind = Selector::Kind::Ally;
		sel.pick = it->second;
	} else {
		this->invalidWarning(node, "A Target map needs Enemy or Ally; the rule is skipped.\n");
		return false;
	}
	auto member = [&](const char *key, Member &out) {
		if (!this->nodeExists(node, key))
			return true;
		std::string m;
		this->asString(node, key, m);
		if (!member_of(m, out)) {
			this->invalidWarning(node[c4::to_csubstr(key)], "%s is party, owner, self, tank, support, attacker or any; the rule is skipped.\n", key);
			return false;
		}
		return true;
	};
	if (!member("Who", sel.who) || !member("Prefer", sel.prefer))
		return false;
	if (this->nodeExists(node, "NotSelf"))
		this->asBool(node, "NotSelf", sel.not_self);
	if (this->nodeExists(node, "Boss"))
		this->asBool(node, "Boss", sel.boss_only);
	// A list takes any of them, as Requires' Role does: [attacker, support] is "anyone but the tank".
	if (this->nodeExists(node, "Role")) {
		if (sel.kind != Selector::Kind::Ally) {
			this->invalidWarning(node["Role"], "Role narrows an Ally selector (an Enemy one has Who and Prefer); the rule is skipped.\n");
			return false;
		}
		for (const std::string &name : scalars(node["Role"])) {
			const int8 role = role_of(name);
			if (role == -2) {
				this->invalidWarning(node["Role"], "Role is tank, support, attacker or none, or a list of them ('%s'); the rule is skipped.\n", name.c_str());
				return false;
			}
			sel.roles |= static_cast<uint8>(1u << role);
		}
	}
	if (this->nodeExists(node, "NotOwner")) {
		if (sel.kind != Selector::Kind::Ally) {
			this->invalidWarning(node["NotOwner"], "NotOwner belongs to an Ally selector; the rule is skipped.\n");
			return false;
		}
		this->asBool(node, "NotOwner", sel.not_owner);
	}
	// Mob: the monster an Enemy selector means, as an entry names it -- one or a list. Boss, Race
	// and Element cannot tell a boss from its miniboss slaves (Dark Lord's Dark Illusions).
	if (this->nodeExists(node, "Mob")) {
		if (sel.kind != Selector::Kind::Enemy) {
			this->invalidWarning(node["Mob"], "Mob narrows an Enemy selector; the rule is skipped.\n");
			return false;
		}
		for (const std::string &name : scalars(node["Mob"])) {
			const uint32 id = mob_of(name);
			if (id == 0) {
				this->invalidWarning(node["Mob"], "Unknown monster '%s'; the rule is skipped.\n", name.c_str());
				return false;
			}
			sel.mobs.push_back(id);
		}
	}
	// Skill: which casts an Enemy: casting selector means -- one skill or a list.
	if (this->nodeExists(node, "Skill")) {
		if (sel.kind != Selector::Kind::Enemy || sel.pick != Selector::Pick::Casting) {
			this->invalidWarning(node["Skill"], "Skill belongs to Enemy: casting; the rule is skipped.\n");
			return false;
		}
		for (const std::string &name : scalars(node["Skill"])) {
			const uint16 id = skill_of(name);
			if (id == 0) {
				this->invalidWarning(node["Skill"], "Unknown skill '%s'; the rule is skipped.\n", name.c_str());
				return false;
			}
			sel.skills.push_back(id);
		}
	}
	if (this->nodeExists(node, "Job")) {
		std::vector<std::string> names = scalars(node["Job"]);
		for (const std::string &name : names) {
			const int32 job = job_of(name);
			if (job == -2 || job == kAllJobs) {
				this->invalidWarning(node["Job"], "Unknown job '%s'; the rule is skipped.\n", name.c_str());
				return false;
			}
			if (job >= 0)
				sel.jobs.push_back(job);
		}
		if (sel.jobs.empty()) {
			this->invalidWarning(node["Job"], "No job in Job exists on this server; the rule is skipped.\n");
			return false;
		}
	}
	if (this->nodeExists(node, "Status")) {
		std::string status;
		this->asString(node, "Status", status);
		if ((sel.status = population_shell_resolve_sc_name(status)) < 0) {
			this->invalidWarning(node["Status"], "Unknown status '%s'; the rule is skipped.\n", status.c_str());
			return false;
		}
	}
	// Race and Element narrow an Enemy pick: { Enemy: attacking, Race: Undead } is what Heal hurts.
	for (const char *key : { "Race", "Element" }) {
		if (!this->nodeExists(node, key))
			continue;
		std::string name;
		this->asString(node, key, name);
		const bool race = key[0] == 'R';
		const int32 v = race ? race_of(name) : element_of(name);
		if (v == -2 || sel.kind != Selector::Kind::Enemy) {
			this->invalidWarning(node[c4::to_csubstr(key)], v == -2 ? "Unknown %s '%s'; the rule is skipped.\n"
				: "%s narrows an Enemy selector ('%s'); the rule is skipped.\n", key, name.c_str());
			return false;
		}
		(race ? sel.race : sel.element) = static_cast<int8>(v);
	}
	if (sel.kind == Selector::Kind::Ally && (sel.pick == Selector::Pick::Missing || sel.pick == Selector::Pick::Having) && sel.status < 0) {
		this->invalidWarning(node, "Ally: missing and Ally: having need a Status; the rule is skipped.\n");
		return false;
	}
	if (this->nodeExists(node, "Expiring")) {
		// Expiring: ms -- Ally: missing also picks a member whose status has less than that left.
		if (sel.kind != Selector::Kind::Ally || sel.pick != Selector::Pick::Missing) {
			this->invalidWarning(node["Expiring"], "Expiring belongs to Ally: missing; the rule is skipped.\n");
			return false;
		}
		this->asInt32(node, "Expiring", sel.expiring_ms);
	}
	if (this->nodeExists(node, "Range")) {
		this->asInt16(node, "Range", sel.range);
		sel.range = static_cast<int16>(cap_value(static_cast<int>(sel.range), 0, AREA_SIZE));
	}
	return true;
}

RulePtr StrategyDatabase::parse_rule(const ryml::NodeRef &node, bool &remove)
{
	remove = false;
	if (!node.is_map()) {
		this->invalidWarning(node, "A rule must be a map.\n");
		return nullptr;
	}
	this->warn_unknown_keys(node, { "Name", "Priority", "Remove", "Requires", "On", "When", "Charges", "Field",
		"Enemy", "Count", "Reach", "Absent", "Present", "Cast", "Level", "Target", "Aim", "Consume", "UseItem", "Say", "Channel", "Retreat", "Distance", "Hold", "Sit", "KeepDistance", "Kite", "MoveTo", "Leave", "Switch", "Signal", "SetTarget", "Cooldown", "Claim", "InStrategy", "InFight",
		"OnePerParty" }, "a rule");

	auto rule = std::make_shared<Rule>();
	rule->uid = this->next_uid_++;
	if (this->nodeExists(node, "Name"))
		this->asString(node, "Name", rule->name);
	if (this->nodeExists(node, "Remove"))
		this->asBool(node, "Remove", remove);
	if (remove) {
		if (rule->name.empty())
			this->invalidWarning(node, "Remove needs the Name of the rule to remove.\n");
		return rule;
	}
	if (this->nodeExists(node, "Priority"))
		this->asInt32(node, "Priority", rule->priority);

	if (this->nodeExists(node, "Requires") && !this->parse_requires(node["Requires"], rule->req))
		return nullptr;

	if (this->nodeExists(node, "On") && !this->parse_event(node["On"], *rule))
		return nullptr;
	if (this->nodeExists(node, "When"))
		rule->when = expanded_ai::parse_expanded_condition(node["When"]);

	// Below: n / AtLeast: n, shared by Charges and Field. One of them is required.
	auto threshold = [&](const ryml::NodeRef &n, int32 &below, int32 &atleast) {
		if (this->nodeExists(n, "Below"))
			this->asInt32(n, "Below", below);
		if (this->nodeExists(n, "AtLeast"))
			this->asInt32(n, "AtLeast", atleast);
		if (below < 0 && atleast < 0) {
			this->invalidWarning(n, "Needs Below or AtLeast.\n");
			return false;
		}
		return true;
	};
	for (const char *key : { "InStrategy", "InFight" }) {
		if (!this->nodeExists(node, key))
			continue;
		const ryml::NodeRef n = node[c4::to_csubstr(key)];
		this->warn_unknown_keys(n, { "Below", "AtLeast" }, key);
		const bool strategy = key[2] == 'S';
		if (!threshold(n, strategy ? rule->instrategy_below : rule->infight_below,
				strategy ? rule->instrategy_atleast : rule->infight_atleast))
			return nullptr;
	}
	if (this->nodeExists(node, "Charges")) {
		const ryml::NodeRef c = node["Charges"];
		this->warn_unknown_keys(c, { "Status", "Value", "Below", "AtLeast" }, "Charges");
		std::string status;
		if (!this->asString(c, "Status", status) || (rule->charge_sc = population_shell_resolve_sc_name(status)) < 0) {
			this->invalidWarning(c, "Charges needs a known Status; the rule is skipped.\n");
			return nullptr;
		}
		if (this->nodeExists(c, "Value")) {
			uint16 v = 2;
			this->asUInt16(c, "Value", v);
			rule->charge_val = static_cast<uint8>(cap_value(static_cast<int>(v), 1, 4));
		}
		if (!threshold(c, rule->charge_below, rule->charge_atleast))
			return nullptr;
	}
	if (this->nodeExists(node, "Field")) {
		const ryml::NodeRef f = node["Field"];
		this->warn_unknown_keys(f, { "Skill", "Owner", "At", "Range", "Below", "AtLeast" }, "Field");
		if (this->nodeExists(f, "At")) {
			std::string at;
			this->asString(f, "At", at);
			at = lower(at);
			if (at == "target") rule->field_at_target = true;
			else if (at != "self") {
				this->invalidWarning(f["At"], "Field's At is self (default) or target; the rule is skipped.\n");
				return nullptr;
			}
		}
		if (this->nodeExists(f, "Owner")) {
			std::string owner;
			this->asString(f, "Owner", owner);
			if (!who_of(owner, rule->field_owner)) {
				this->invalidWarning(f["Owner"], "Owner must be self, party, monster, enemy or anyone; the rule is skipped.\n");
				return nullptr;
			}
		}
		std::string skill;
		if (!this->asString(f, "Skill", skill) || (rule->field_skill = skill_of(skill)) == 0) {
			this->invalidWarning(f, "Field needs a known Skill; the rule is skipped.\n");
			return nullptr;
		}
		if (this->nodeExists(f, "Range"))
			this->asInt16(f, "Range", rule->field_range);
		rule->field_range = static_cast<int16>(cap_value(static_cast<int>(rule->field_range), 0, AREA_SIZE));
		if (!threshold(f, rule->field_below, rule->field_atleast))
			return nullptr;
	}

	if (this->nodeExists(node, "Count")) {
		const ryml::NodeRef c = node["Count"];
		this->warn_unknown_keys(c, { "Enemy", "Who", "NotSelf", "Boss", "Race", "Element", "Skill", "Mob", "Around", "Range", "Below", "AtLeast" },
			"Count");
		static const std::map<std::string, Selector::Pick> picks = {
			{ "any", Selector::Pick::Nearest }, { "attacking", Selector::Pick::Attacking },
			{ "boss", Selector::Pick::Boss }, { "slaves", Selector::Pick::Slaves }, { "casting", Selector::Pick::Casting },
			{ "hidden", Selector::Pick::Hidden },
		};
		std::string pick = "any";
		if (this->nodeExists(c, "Enemy"))
			this->asString(c, "Enemy", pick);
		const auto it = picks.find(lower(pick));
		if (it == picks.end()) {
			this->invalidWarning(c, "Count's Enemy is any, attacking, boss, slaves, casting or hidden; the rule is skipped.\n");
			return nullptr;
		}
		rule->count_sel.kind = Selector::Kind::Enemy;
		rule->count_sel.pick = it->second;
		if (this->nodeExists(c, "Who")) {
			std::string who;
			this->asString(c, "Who", who);
			if (!member_of(who, rule->count_sel.who)) {
				this->invalidWarning(c["Who"], "Who is party, owner, self, tank, support, attacker or any; the rule is skipped.\n");
				return nullptr;
			}
		}
		if (this->nodeExists(c, "NotSelf"))
			this->asBool(c, "NotSelf", rule->count_sel.not_self);
		if (this->nodeExists(c, "Boss"))
			this->asBool(c, "Boss", rule->count_sel.boss_only);
		for (const char *key : { "Race", "Element" }) {
			if (!this->nodeExists(c, key))
				continue;
			std::string name;
			this->asString(c, key, name);
			const bool race = key[0] == 'R';
			const int32 v = race ? race_of(name) : element_of(name);
			if (v == -2) {
				this->invalidWarning(c[c4::to_csubstr(key)], "Unknown %s '%s'; the rule is skipped.\n", key, name.c_str());
				return nullptr;
			}
			(race ? rule->count_sel.race : rule->count_sel.element) = static_cast<int8>(v);
		}
		if (this->nodeExists(c, "Mob")) {
			for (const std::string &name : scalars(c["Mob"])) {
				const uint32 id = mob_of(name);
				if (id == 0) {
					this->invalidWarning(c["Mob"], "Unknown monster '%s'; the rule is skipped.\n", name.c_str());
					return nullptr;
				}
				rule->count_sel.mobs.push_back(id);
			}
		}
		if (this->nodeExists(c, "Skill")) {
			if (rule->count_sel.pick != Selector::Pick::Casting) {
				this->invalidWarning(c["Skill"], "Skill belongs to Enemy: casting; the rule is skipped.\n");
				return nullptr;
			}
			for (const std::string &name : scalars(c["Skill"])) {
				const uint16 id = skill_of(name);
				if (id == 0) {
					this->invalidWarning(c["Skill"], "Unknown skill '%s'; the rule is skipped.\n", name.c_str());
					return nullptr;
				}
				rule->count_sel.skills.push_back(id);
			}
		}
		if (this->nodeExists(c, "Around")) {
			std::string around;
			this->asString(c, "Around", around);
			around = lower(around);
			if (around == "target") rule->count_around_target = true;
			else if (around != "self") {
				this->invalidWarning(c["Around"], "Count's Around is self (default) or target; the rule is skipped.\n");
				return nullptr;
			}
		}
		if (this->nodeExists(c, "Range"))
			this->asInt16(c, "Range", rule->count_range);
		rule->count_range = static_cast<int16>(cap_value(static_cast<int>(rule->count_range), 0, AREA_SIZE));
		if (!threshold(c, rule->count_below, rule->count_atleast))
			return nullptr;
		rule->has_count = true;
	}
	// Absent: "no Priest alive any more", a selector that must find nobody; Present: "someone
	// lies dead within reach", one that must find someone.
	for (const char *key : { "Absent", "Present" }) {
		if (!this->nodeExists(node, key))
			continue;
		const ryml::NodeRef g = node[c4::to_csubstr(key)];
		if (!g.is_map()) {
			this->invalidWarning(g, "%s takes a selector, like { Ally: dead }; the rule is skipped.\n", key);
			return nullptr;
		}
		if (!this->parse_selector(g, std::string(key) == "Absent" ? rule->absent : rule->present))
			return nullptr;
	}
	if (this->nodeExists(node, "Reach")) {
		bool reach = false;
		if (!this->asBool(node, "Reach", reach))
			return nullptr; // a typo must not quietly become Reach: false
		rule->reach = reach ? 1 : 0;
	}
	if (this->nodeExists(node, "Enemy")) {
		const ryml::NodeRef e = node["Enemy"];
		this->warn_unknown_keys(e, { "Element", "Race", "Size", "Boss" }, "Enemy");
		// Names as rAthena's constants spell them without the prefix: Holy, Ghost; Demon, DemiHuman.
		auto constants = [&](const char *key, const char *prefix, std::vector<int32> &out) {
			if (!this->nodeExists(e, key))
				return true;
			for (const std::string &n : scalars(e[c4::to_csubstr(key)])) {
				int64 v = 0;
				if (!script_get_constant(upper(std::string(prefix) + n).c_str(), &v)) {
					this->invalidWarning(e[c4::to_csubstr(key)], "Unknown %s '%s'; the rule is skipped.\n", key, n.c_str());
					return false;
				}
				out.push_back(static_cast<int32>(v));
			}
			return true;
		};
		if (!constants("Element", "ELE_", rule->enemy_elements) || !constants("Race", "RC_", rule->enemy_races))
			return nullptr;
		if (this->nodeExists(e, "Size")) {
			for (const std::string &n : scalars(e["Size"])) {
				const std::string z = lower(n);
				if (z == "small") rule->enemy_sizes.push_back(SZ_SMALL);
				else if (z == "medium") rule->enemy_sizes.push_back(SZ_MEDIUM);
				else if (z == "large" || z == "big") rule->enemy_sizes.push_back(SZ_BIG);
				else {
					this->invalidWarning(e["Size"], "Size is small, medium or large; the rule is skipped.\n");
					return nullptr;
				}
			}
		}
		if (this->nodeExists(e, "Boss")) {
			bool boss = false;
			if (!this->asBool(e, "Boss", boss))
				return nullptr;
			rule->enemy_boss = boss ? 1 : 0;
		}
	}

	if (this->nodeExists(node, "Cast")) {
		std::string skill;
		for (const std::string &s : scalars(node["Cast"])) {
			const uint16 id = skill_of(s);
			if (id == 0) {
				this->invalidWarning(node["Cast"], "Unknown skill '%s'; the rule is skipped.\n", s.c_str());
				return nullptr;
			}
			if (std::find(rule->cast_options.begin(), rule->cast_options.end(), id) == rule->cast_options.end())
				rule->cast_options.push_back(id);
			if (skill.empty())
				skill = s;
		}
		if (rule->cast_options.empty()) {
			this->invalidWarning(node["Cast"], "Cast names no skill; the rule is skipped.\n");
			return nullptr;
		}
		rule->cast_skill = rule->cast_options.front();
		if (rule->cast_options.size() == 1)
			rule->cast_options.clear();
		if (this->nodeExists(node, "Level"))
			this->asUInt16(node, "Level", rule->cast_lv);
		if (this->nodeExists(node, "Consume"))
			this->asBool(node, "Consume", rule->consume);
		if (rule->consume) {
			const std::shared_ptr<s_skill_db> sk = skill_db.find(rule->cast_skill);
			if (sk == nullptr || std::none_of(std::begin(sk->require.amount), std::end(sk->require.amount),
					[](int32 a) { return a > 0; }))
				this->invalidWarning(node["Consume"], "%s has no ItemCost; Consume does nothing.\n", skill.c_str());
		}
	}
	if (this->nodeExists(node, "Target") && node["Target"].is_map()) {
		if (!this->parse_selector(node["Target"], rule->sel))
			return nullptr;
	} else if (this->nodeExists(node, "Target")) {
		static const std::map<std::string, Target> targets = {
			{ "enemy", Target::Enemy }, { "self", Target::Self }, { "owner", Target::Owner },
			{ "event", Target::Event }, { "source", Target::Source },
			{ "ally_lowest_hp", Target::AllyLowestHp }, { "dead_ally", Target::DeadAlly },
		};
		std::string t;
		this->asString(node, "Target", t);
		const auto it = targets.find(lower(t));
		if (it == targets.end()) {
			this->invalidWarning(node["Target"], "Unknown Target '%s'; the rule is skipped.\n", t.c_str());
			return nullptr;
		}
		rule->target = it->second;
	}
	if (this->nodeExists(node, "Say")) {
		this->asString(node, "Say", rule->say);
		if (this->nodeExists(node, "Channel")) {
			std::string ch;
			this->asString(node, "Channel", ch);
			rule->say_area = lower(ch) == "area";
		}
	}
	if (this->nodeExists(node, "Retreat")) {
		std::string r;
		this->asString(node, "Retreat", r);
		r = lower(r);
		if (r == "away") rule->retreat = Retreat::Away;
		else if (r == "owner") rule->retreat = Retreat::Owner;
		else {
			this->invalidWarning(node["Retreat"], "Retreat must be away or owner; the rule is skipped.\n");
			return nullptr;
		}
		if (this->nodeExists(node, "Distance"))
			this->asInt16(node, "Distance", rule->distance);
		rule->distance = static_cast<int16>(cap_value(static_cast<int>(rule->distance), 2, 14));
	}
	if (this->nodeExists(node, "Hold"))
		this->asBool(node, "Hold", rule->hold);
	if (this->nodeExists(node, "Sit"))
		this->asBool(node, "Sit", rule->sit);
	if (this->nodeExists(node, "Leave")) {
		const ryml::NodeRef l = node["Leave"];
		if (l.is_map()) {
			this->warn_unknown_keys(l, { "Field", "Owner", "Within" }, "Leave");
			if (this->nodeExists(l, "Field")) {
				std::string skill;
				this->asString(l, "Field", skill);
				if ((rule->leave_skill = skill_of(skill)) == 0) {
					this->invalidWarning(l["Field"], "Unknown skill '%s'; the rule is skipped.\n", skill.c_str());
					return nullptr;
				}
			}
			if (this->nodeExists(l, "Owner")) {
				std::string owner;
				this->asString(l, "Owner", owner);
				if (!who_of(owner, rule->leave_owner)) {
					this->invalidWarning(l["Owner"], "Owner must be self, party, monster, enemy or anyone; the rule is skipped.\n");
					return nullptr;
				}
			}
			if (this->nodeExists(l, "Within"))
				this->asInt16(l, "Within", rule->leave_within);
			rule->leave_within = static_cast<int16>(cap_value(static_cast<int>(rule->leave_within), 1, AREA_SIZE));
			rule->leave = true;
		} else {
			this->asBool(node, "Leave", rule->leave);
		}
	}
	if (this->nodeExists(node, "MoveTo")) {
		const ryml::NodeRef m = node["MoveTo"];
		if (m.is_map()) {
			this->warn_unknown_keys(m, { "Field", "Owner", "Within", "Depth", "Sight", "Range" }, "MoveTo");
			std::string skill;
			if (this->nodeExists(m, "Sight")) {
				// { Sight: target, Within, Range }: to the nearest cell with a clear line to the rule's target.
				std::string of;
				this->asString(m, "Sight", of);
				if (lower(of) != "target" || this->nodeExists(m, "Field")) {
					this->invalidWarning(m, "MoveTo's Sight is target, and takes Within and Range; the rule is skipped.\n");
					return nullptr;
				}
				if (this->nodeExists(m, "Within"))
					this->asInt16(m, "Within", rule->move_within);
				rule->move_within = static_cast<int16>(cap_value(static_cast<int>(rule->move_within), 1, AREA_SIZE));
				if (this->nodeExists(m, "Range"))
					this->asInt16(m, "Range", rule->move_range);
				rule->move_range = static_cast<int16>(cap_value(static_cast<int>(rule->move_range), 1, AREA_SIZE));
				rule->move = Move::Sight;
			} else if (!this->asString(m, "Field", skill) || (rule->move_skill = skill_of(skill)) == 0) {
				this->invalidWarning(m, "MoveTo needs a known Field skill; the rule is skipped.\n");
				return nullptr;
			}
			if (this->nodeExists(m, "Owner")) {
				std::string owner;
				this->asString(m, "Owner", owner);
				if (!who_of(owner, rule->move_owner)) {
					this->invalidWarning(m["Owner"], "Owner must be self, party, monster, enemy or anyone; the rule is skipped.\n");
					return nullptr;
				}
			}
			if (this->nodeExists(m, "Within"))
				this->asInt16(m, "Within", rule->move_within);
			rule->move_within = static_cast<int16>(cap_value(static_cast<int>(rule->move_within), 1, AREA_SIZE));
			if (this->nodeExists(m, "Depth"))
				this->asInt16(m, "Depth", rule->move_depth);
			rule->move_depth = static_cast<int16>(cap_value(static_cast<int>(rule->move_depth), 0, 7));
			if (rule->move != Move::Sight)
				rule->move = Move::Field;
		} else if (lower(scalar(m)) == "event_cell") {
			rule->move = Move::EventCell;
		} else if (lower(scalar(m)) == "event") {
			rule->move = Move::EventUnit;
		} else if (lower(scalar(m)) == "reachable") {
			rule->move = Move::Reachable;
		} else {
			this->invalidWarning(m, "MoveTo is event, event_cell, reachable, { Field: <skill> } or { Sight: target }; the rule is skipped.\n");
			return nullptr;
		}
	}
	if (this->nodeExists(node, "Kite")) {
		const ryml::NodeRef k = node["Kite"];
		if (k.is_map()) {
			this->warn_unknown_keys(k, { "Away", "Within", "Gap" }, "Kite");
			if (this->nodeExists(k, "Away"))
				this->asInt16(k, "Away", rule->kite_away);
			if (this->nodeExists(k, "Within"))
				this->asInt16(k, "Within", rule->kite_within);
			if (this->nodeExists(k, "Gap"))
				this->asInt16(k, "Gap", rule->kite_gap);
			rule->kite = true;
		} else if (!this->asBool(node, "Kite", rule->kite)) {
			return nullptr;
		}
		rule->kite_away = static_cast<int16>(cap_value(static_cast<int>(rule->kite_away), 1, AREA_SIZE));
		rule->kite_within = static_cast<int16>(cap_value(static_cast<int>(rule->kite_within), 1, AREA_SIZE));
		rule->kite_gap = static_cast<int16>(cap_value(static_cast<int>(rule->kite_gap), 0, rule->kite_within));
	}
	if (this->nodeExists(node, "KeepDistance")) {
		const ryml::NodeRef k = node["KeepDistance"];
		if (k.is_map()) {
			// { Min, Max }: a band. Too close: step out; too far: come back within reach.
			this->warn_unknown_keys(k, { "Min", "Max" }, "KeepDistance");
			if (this->nodeExists(k, "Min"))
				this->asInt16(k, "Min", rule->keep_distance);
			if (this->nodeExists(k, "Max"))
				this->asInt16(k, "Max", rule->keep_max);
		} else {
			this->asInt16(node, "KeepDistance", rule->keep_distance);
		}
		rule->keep_distance = static_cast<int16>(cap_value(static_cast<int>(rule->keep_distance), 0, 14));
		rule->keep_max = static_cast<int16>(cap_value(static_cast<int>(rule->keep_max), 0, AREA_SIZE));
		if (rule->keep_distance <= 0 || (rule->keep_max > 0 && rule->keep_max < rule->keep_distance)) {
			this->invalidWarning(k, "KeepDistance needs Min above 0, and Max at least Min; the rule is skipped.\n");
			return nullptr;
		}
	}
	if (this->nodeExists(node, "Aim")) {
		// Aim: { Cells: 3, From: self | target, Lead: true } -- a ground Cast's cell.
		const ryml::NodeRef a = node["Aim"];
		if (!a.is_map()) {
			this->invalidWarning(a, "Aim is a map: { Cells, From, Lead }; the rule is skipped.\n");
			return nullptr;
		}
		this->warn_unknown_keys(a, { "Cells", "From", "Lead" }, "Aim");
		if (rule->cast_skill == 0 || !(skill_get_inf(rule->cast_skill) & INF_GROUND_SKILL)) {
			this->invalidWarning(a, "Aim belongs to a Cast of a ground skill; the rule is skipped.\n");
			return nullptr;
		}
		if (this->nodeExists(a, "Cells"))
			this->asInt16(a, "Cells", rule->aim_cells);
		rule->aim_cells = static_cast<int16>(cap_value(static_cast<int>(rule->aim_cells), 0, AREA_SIZE));
		if (this->nodeExists(a, "From")) {
			std::string from;
			this->asString(a, "From", from);
			from = lower(from);
			if (from == "target") rule->aim_from_target = true;
			else if (from != "self") {
				this->invalidWarning(a["From"], "Aim's From is self (default) or target; the rule is skipped.\n");
				return nullptr;
			}
		}
		if (this->nodeExists(a, "Lead"))
			this->asBool(a, "Lead", rule->aim_lead);
		if (rule->aim_cells == 0 && !rule->aim_lead) {
			this->invalidWarning(a, "Aim needs Cells, Lead, or both; the rule is skipped.\n");
			return nullptr;
		}
		rule->aim = true;
	}
	if (this->nodeExists(node, "UseItem")) {
		for (const std::string &item : scalars(node["UseItem"])) {
			const t_itemid id = item_of(item);
			if (id == 0) {
				this->invalidWarning(node["UseItem"], "Unknown item '%s'; the rule is skipped.\n", item.c_str());
				return nullptr;
			}
			rule->use_items.push_back(id);
		}
		if (rule->use_items.empty()) {
			this->invalidWarning(node["UseItem"], "UseItem needs an item or a list of them; the rule is skipped.\n");
			return nullptr;
		}
		rule->use_item = rule->use_items.front();
	}
	if (this->nodeExists(node, "Switch"))
		this->asString(node, "Switch", rule->switch_to);
	if (this->nodeExists(node, "Signal")) {
		this->asString(node, "Signal", rule->signal);
		rule->signal = lower(rule->signal);
	}
	if (this->nodeExists(node, "SetTarget"))
		this->asBool(node, "SetTarget", rule->set_target);
	if (rule->set_target && rule->sel.kind != Selector::Kind::Enemy && rule->target != Target::Source && rule->target != Target::Enemy) {
		this->invalidWarning(node, "SetTarget needs a monster: Target: { Enemy: ... } or source; the rule is skipped.\n");
		return nullptr;
	}
	if (this->nodeExists(node, "Cooldown"))
		this->asUInt32(node, "Cooldown", rule->cooldown_ms);
	if (this->nodeExists(node, "OnePerParty"))
		this->asBool(node, "OnePerParty", rule->one_per_party);
	if (this->nodeExists(node, "Claim")) {
		// Claim: lex, or Claim: { Name: lex, For: 10000 }
		const ryml::NodeRef c = node["Claim"];
		if (c.is_map()) {
			this->warn_unknown_keys(c, { "Name", "For" }, "Claim");
			if (this->nodeExists(c, "Name"))
				this->asString(c, "Name", rule->claim);
			if (this->nodeExists(c, "For"))
				this->asUInt32(c, "For", rule->claim_ms);
		} else {
			this->asString(node, "Claim", rule->claim);
		}
		rule->claim = lower(rule->claim);
		if (rule->claim.empty()) {
			this->invalidWarning(c, "Claim needs a name; the rule is skipped.\n");
			return nullptr;
		}
	}

	const int moves = (rule->cast_skill != 0) + (rule->retreat != Retreat::None) + rule->hold + rule->sit
		+ (rule->keep_distance > 0) + (rule->move != Move::None) + rule->leave + rule->kite + (rule->use_item != 0);
	if (moves == 0 && rule->say.empty() && rule->switch_to.empty() && rule->signal.empty() && !rule->set_target) {
		this->invalidWarning(node, "A rule needs Cast, UseItem, Retreat, KeepDistance, Kite, MoveTo, Leave, Hold, Sit, Say, Switch, Signal or SetTarget; the rule is skipped.\n");
		return nullptr;
	}
	if (moves > 1) {
		this->invalidWarning(node, "A rule takes only one of Cast, UseItem, Retreat, KeepDistance, Kite, MoveTo, Leave, Hold and Sit; the rule is skipped.\n");
		return nullptr;
	}
	if (rule->move == Move::EventCell && rule->event != Event::Casts) {
		this->invalidWarning(node, "MoveTo: event_cell needs On: casts; the rule is skipped.\n");
		return nullptr;
	}
	if (rule->move == Move::EventUnit && rule->event == Event::None) {
		this->invalidWarning(node, "MoveTo: event needs an On: event; the rule is skipped.\n");
		return nullptr;
	}
	if ((rule->target == Target::Event || rule->target == Target::Source) && rule->event == Event::None) {
		this->invalidWarning(node, "Target event/source needs an On: event; the rule is skipped.\n");
		return nullptr;
	}
	// An item used on every turn its condition holds would empty the bag before the effect shows.
	if (rule->use_item != 0 && rule->cooldown_ms == 0)
		rule->cooldown_ms = 1000;
	// A line said on every turn its condition holds would flood the chat; a signal sent every
	// turn would set every listener off again and again.
	if (!rule->say.empty() && rule->event == Event::None && rule->cooldown_ms == 0)
		rule->cooldown_ms = 10000;
	if (!rule->signal.empty() && rule->event == Event::None && rule->cooldown_ms == 0)
		rule->cooldown_ms = 5000;
	// An event rule that speaks or signals gets a short one too: two `On: signal` rules that
	// signal each other would otherwise go back and forth every tick, and with Say flood
	// party chat. Long enough to stop that, short enough to still answer the event.
	if ((!rule->say.empty() || !rule->signal.empty()) && rule->event != Event::None && rule->cooldown_ms == 0)
		rule->cooldown_ms = 2000;
	return rule;
}

/// A later rule with the same Name replaces the earlier one; Remove deletes it.
void StrategyDatabase::merge_rules(const ryml::NodeRef &seq, std::vector<RulePtr> &into)
{
	if (!seq.is_seq()) {
		this->invalidWarning(seq, "Rules must be a list.\n");
		return;
	}
	for (const ryml::NodeRef &row : seq.children()) {
		bool remove = false;
		RulePtr rule = this->parse_rule(row, remove);
		if (rule == nullptr)
			continue;
		auto same = into.end();
		if (!rule->name.empty())
			same = std::find_if(into.begin(), into.end(), [&](const RulePtr &r) { return r->name == rule->name; });
		if (remove) {
			if (same != into.end())
				into.erase(same);
		} else if (same != into.end()) {
			*same = rule;
		} else {
			into.push_back(rule);
		}
	}
}

void StrategyDatabase::merge_job(const ryml::NodeRef &node, const std::vector<uint32> &mobs)
{
	this->warn_unknown_keys(node, { "Job", "Build", "For", "Requires", "Remove", "Reset", "Rotation", "Ban", "Start", "Rules",
		"Strategies", "Disable", "Allow", "Attack", "Exact" }, "a job entry");
	// Allow: [..]: the skill list, by name; an unknown one is a warning, and Allow: [] allows nothing.
	auto allow_list = [&](const ryml::NodeRef &n, std::vector<uint16> &out) {
		out.clear();
		for (const std::string &s : scalars(n)) {
			const uint16 id = skill_of(s);
			if (id == 0)
				this->invalidWarning(n, "Unknown skill '%s' in Allow.\n", s.c_str());
			else if (std::find(out.begin(), out.end(), id) == out.end())
				out.push_back(id);
		}
		std::sort(out.begin(), out.end());
	};
	bool has_audience = false;
	Audience audience = Audience::Companions;
	if (this->nodeExists(node, "For")) {
		std::string f;
		this->asString(node, "For", f);
		f = lower(f);
		if (f == "companions") audience = Audience::Companions;
		else if (f == "shells") audience = Audience::Shells;
		else if (f == "all") audience = Audience::All;
		else {
			this->invalidWarning(node["For"], "For is companions (default), shells or all; entry skipped.\n");
			return;
		}
		has_audience = true;
	}
	// Job: Priest is the whole family (High Priest, Arch Bishop, ...); a list is several. A job
	// this era lacks is passed over, so one list serves renewal and pre-renewal.
	if (!this->nodeExists(node, "Job")) {
		this->invalidWarning(node, "A job entry needs Job; entry skipped.\n");
		return;
	}
	std::vector<int32> jobs;
	for (const std::string &name : scalars(node["Job"])) {
		const int32 job = job_of(name);
		if (job == -2)
			this->invalidWarning(node["Job"], "Unknown job '%s'; skipped.\n", name.c_str());
		else if (job != -3 && std::find(jobs.begin(), jobs.end(), job) == jobs.end())
			jobs.push_back(job);
	}
	if (jobs.empty())
		return;

	// A Build is one way to play the job: its own rules and strategies, used by the companions
	// that meet its Requires (a combo Monk Lacks Asura Strike, an Asura Monk has it).
	std::string build;
	if (this->nodeExists(node, "Build"))
		this->asString(node, "Build", build);
	Requirements req;
	if (this->nodeExists(node, "Requires") && !this->parse_requires(node["Requires"], req))
		return;
	if (build.empty() && this->nodeExists(node, "Requires"))
		this->invalidWarning(node["Requires"], "Requires on a job entry needs a Build name.\n");

	bool remove = false, reset = false;
	if (this->nodeExists(node, "Remove"))
		this->asBool(node, "Remove", remove);
	if (this->nodeExists(node, "Reset"))
		this->asBool(node, "Reset", reset);

	for (const uint32 mob : mobs) for (const int32 job : jobs) {
		const PlanKey key(mob, job, build);
		if (remove) {
			this->plans.erase(key);
			continue;
		}
		if (reset)
			this->plans[key] = Plan();
		Plan &plan = this->plans[key];
		if (this->nodeExists(node, "Requires"))
			plan.req = req;
		if (has_audience)
			plan.audience = audience;

		if (this->nodeExists(node, "Rotation")) {
			bool rotation = true;
			if (this->asBool(node, "Rotation", rotation))
				plan.rotation = rotation ? 1 : 0;
		}
		if (this->nodeExists(node, "Start"))
			this->asString(node, "Start", plan.start);
		if (this->nodeExists(node, "Disable"))
			for (const std::string &n : scalars(node["Disable"]))
				if (std::find(plan.disable.begin(), plan.disable.end(), n) == plan.disable.end())
					plan.disable.push_back(n);
		if (this->nodeExists(node, "Allow")) {
			plan.has_allow = true;
			allow_list(node["Allow"], plan.allow);
		}
		if (this->nodeExists(node, "Attack")) {
			bool attack = true;
			if (this->asBool(node, "Attack", attack))
				plan.attack = attack ? 1 : 0;
		}
		if (this->nodeExists(node, "Exact"))
			this->asBool(node, "Exact", plan.exact);
		if (this->nodeExists(node, "Ban")) {
			for (const std::string &s : scalars(node["Ban"])) {
				const uint16 id = skill_of(s);
				if (id == 0)
					this->invalidWarning(node["Ban"], "Unknown skill '%s' in Ban.\n", s.c_str());
				else if (std::find(plan.ban.begin(), plan.ban.end(), id) == plan.ban.end())
					plan.ban.push_back(id);
			}
		}
		// Merged by name into what earlier files gave this plan (Remove: true deletes one).
		if (this->nodeExists(node, "Rules"))
			this->merge_rules(node["Rules"], plan.rules);
		if (this->nodeExists(node, "Strategies")) {
			const ryml::NodeRef list = node["Strategies"];
			if (!list.is_seq()) {
				this->invalidWarning(list, "Strategies must be a list.\n");
				continue;
			}
			for (const ryml::NodeRef &s : list.children()) {
				this->warn_unknown_keys(s, { "Name", "Remove", "Rules", "Ban", "Rotation", "Disable", "Allow", "Attack" },
					"a strategy");
				std::string name;
				if (!this->asString(s, "Name", name) || name.empty())
					continue;
				bool drop = false;
				if (this->nodeExists(s, "Remove"))
					this->asBool(s, "Remove", drop);
				if (drop) {
					plan.strategies.erase(name);
					continue;
				}
				Strategy &strategy = plan.strategies[name];
				if (this->nodeExists(s, "Rules"))
					this->merge_rules(s["Rules"], strategy.rules);
				if (this->nodeExists(s, "Disable"))
					for (const std::string &n : scalars(s["Disable"]))
						if (std::find(strategy.disable.begin(), strategy.disable.end(), n) == strategy.disable.end())
							strategy.disable.push_back(n);
				if (this->nodeExists(s, "Allow")) {
					strategy.has_allow = true;
					allow_list(s["Allow"], strategy.allow);
				}
				if (this->nodeExists(s, "Attack")) {
					bool attack = true;
					if (this->asBool(s, "Attack", attack))
						strategy.attack = attack ? 1 : 0;
				}
				// While this strategy is active: "no magic while it reflects", "melee only in Pneuma".
				if (this->nodeExists(s, "Rotation")) {
					bool rotation = true;
					if (this->asBool(s, "Rotation", rotation)) // a typo leaves the plan's Rotation in charge
						strategy.rotation = rotation ? 1 : 0;
				}
				if (this->nodeExists(s, "Ban")) {
					for (const std::string &b : scalars(s["Ban"])) {
						const uint16 id = skill_of(b);
						if (id == 0)
							this->invalidWarning(s["Ban"], "Unknown skill '%s' in Ban.\n", b.c_str());
						else if (std::find(strategy.ban.begin(), strategy.ban.end(), id) == strategy.ban.end())
							strategy.ban.push_back(id);
					}
				}
			}
		}
	}
}

/// One entry, guarded. ryml reports a node of the wrong shape (a list where a map belongs:
/// `Requires: [AL_HEAL]`) by throwing, from deep inside a lookup, and YamlDatabase lets it
/// through -- so a mistake in any mod's table would stop the map server at boot or reload.
/// Here it is that entry's warning, and the rest of the table loads.
uint64 StrategyDatabase::parseBodyNode(const ryml::NodeRef &node)
{
	try {
		return this->parseEntry(node);
	} catch (const std::exception &e) {
		this->invalidWarning(node, "This entry is shaped wrong (%s) and is skipped; check its lists and maps against the reference.\n", e.what());
		return 0;
	}
}

uint64 StrategyDatabase::parseEntry(const ryml::NodeRef &node)
{
	this->warn_unknown_keys(node, { "Mob", "Mobs", "Encounter", "Targeting", "Jobs" }, "an entry");
	std::vector<std::string> names;
	std::vector<uint32> mobs;
	// { Race: Undead, Element: Ghost }: every monster of that kind; both given, both must hold.
	auto category = [&](const ryml::NodeRef &m) {
		this->warn_unknown_keys(m, { "Race", "Element" }, "Mob");
		int32 race = -1, element = -1;
		std::string name;
		if (this->nodeExists(m, "Race") && this->asString(m, "Race", name) && (race = race_of(name)) == -2) {
			this->invalidWarning(m["Race"], "Unknown race '%s'; skipped.\n", name.c_str());
			return;
		}
		if (this->nodeExists(m, "Element") && this->asString(m, "Element", name) && (element = element_of(name)) == -2) {
			this->invalidWarning(m["Element"], "Unknown element '%s'; skipped.\n", name.c_str());
			return;
		}
		if (race < 0 && element < 0)
			this->invalidWarning(m, "A kind of monster needs Race or Element; skipped.\n");
		else
			mobs.push_back(category_key(race, element));
	};
	const char *key = this->nodeExists(node, "Mob") ? "Mob" : this->nodeExists(node, "Mobs") ? "Mobs" : nullptr;
	if (key != nullptr) {
		const ryml::NodeRef m = node[c4::to_csubstr(key)];
		if (m.is_map()) {
			category(m);
		} else if (m.is_seq()) {
			for (const ryml::NodeRef &it : m.children()) {
				if (it.is_map())
					category(it);
				else if (it.has_val())
					names.push_back(scalar(it));
			}
		} else {
			names = scalars(m);
		}
	}
	if (names.empty() && mobs.empty()) {
		this->invalidWarning(node, "An entry needs Mob or Mobs.\n");
		return 0;
	}
	for (const std::string &n : names) {
		if (lower(n) == "all") {
			mobs.push_back(kAllMobs);
			continue;
		}
		if (lower(n) == "boss") {
			mobs.push_back(kBossMobs);
			continue;
		}
		const uint32 id = mob_of(n);
		if (id == 0)
			this->invalidWarning(node, "Unknown monster '%s'; skipped.\n", n.c_str());
		else
			mobs.push_back(id);
	}
	if (mobs.empty())
		return 0;

	if (this->nodeExists(node, "Encounter")) {
		bool encounter = false;
		this->asBool(node, "Encounter", encounter);
		for (const uint32 mob : mobs) {
			if (!is_particular(mob))
				this->invalidWarning(node["Encounter"], "Encounter needs a monster, not All, Boss or a kind of monster.\n");
			else if (encounter)
				this->encounter.insert(mob);
			else
				this->encounter.erase(mob);
		}
	}

	if (this->nodeExists(node, "Targeting")) {
		const ryml::NodeRef t = node["Targeting"];
		this->warn_unknown_keys(t, { "Priority", "Ignore", "MaxAttackers" }, "Targeting");
		for (const uint32 mob : mobs) {
			if (!is_particular(mob)) {
				this->invalidWarning(t, "Targeting needs a monster, not All, Boss or a kind of monster.\n");
				continue;
			}
			Targeting &tg = this->targeting[mob];
			if (this->nodeExists(t, "Priority"))
				this->asInt32(t, "Priority", tg.priority);
			if (this->nodeExists(t, "Ignore"))
				this->asBool(t, "Ignore", tg.ignore);
			if (this->nodeExists(t, "MaxAttackers"))
				this->asInt32(t, "MaxAttackers", tg.max_attackers);
		}
	}
	if (this->nodeExists(node, "Jobs")) {
		const ryml::NodeRef jobs = node["Jobs"];
		if (!jobs.is_seq()) {
			this->invalidWarning(jobs, "Jobs must be a list.\n");
			return 0;
		}
		for (const ryml::NodeRef &j : jobs.children())
			this->merge_job(j, mobs);
	}
	return 1;
}

void StrategyDatabase::loadingFinished()
{
	auto by_priority = [](const RulePtr &a, const RulePtr &b) { return a->priority > b->priority; };
	auto note = [&](const RulePtr &r) {
		++this->rule_count;
		if (r->cast_skill == ALL_RESURRECTION || r->cast_skill == WM_DEADHILLHERE)
			this->revives = true;
		if (r->event == Event::PartyChat)
			this->uses_chat = true;
	};
	for (auto &entry : this->plans) {
		Plan &plan = entry.second;
		std::stable_sort(plan.rules.begin(), plan.rules.end(), by_priority);
		for (const RulePtr &r : plan.rules)
			note(r);
		for (auto &s : plan.strategies) {
			std::stable_sort(s.second.rules.begin(), s.second.rules.end(), by_priority);
			for (const RulePtr &r : s.second.rules)
				note(r);
		}
		if (plan.rotation == 0 || (plan.rotation < 0 && is_particular(std::get<0>(entry.first))) || !plan.ban.empty())
			this->limits_rotation = true;
		const uint8 audience = plan.audience == Audience::Companions ? 1 : plan.audience == Audience::Shells ? 2 : 3;
		if (std::get<0>(entry.first) == kBossMobs)
			this->boss_plans |= audience;
		if (is_category(std::get<0>(entry.first)))
			this->category_plans |= audience;
		// What its own rules cast: its Allow and Ban never stop those.
		plan.own.clear();
		auto own = [&](const RulePtr &r) {
			if (r->cast_skill != 0)
				plan.own.push_back(r->cast_skill);
			plan.own.insert(plan.own.end(), r->cast_options.begin(), r->cast_options.end());
		};
		for (const RulePtr &r : plan.rules)
			own(r);
		for (const auto &s : plan.strategies)
			for (const RulePtr &r : s.second.rules)
				own(r);
		std::sort(plan.own.begin(), plan.own.end());
		plan.own.erase(std::unique(plan.own.begin(), plan.own.end()), plan.own.end());
		if (plan.has_allow || !plan.ban.empty())
			this->limits_skills = this->limits_rotation = true;
		if (plan.attack >= 0)
			this->limits_attack = true;
		for (const auto &st : plan.strategies)
			if (st.second.attack >= 0)
				this->limits_attack = true;
		for (const auto &st : plan.strategies)
			if (st.second.has_allow || !st.second.ban.empty())
				this->limits_skills = this->limits_rotation = true;
		if (plan.audience != Audience::Companions)
			this->for_shells = true;
		for (const auto &st : plan.strategies)
			if (st.second.rotation >= 0 || !st.second.ban.empty())
				this->limits_rotation = true;

		// A strategy is only reachable through Start or a Switch; name both checks here,
		// once, rather than having a rule silently switch to nothing in game.
		const auto check = [&](const std::string &name, const char *what) {
			if (!name.empty() && plan.strategies.find(name) == plan.strategies.end())
				ShowWarning("population_strategy: %s '%s' names no strategy of monster %s, job %d, build '%s'.\n",
					what, name.c_str(), mob_label(std::get<0>(entry.first)).c_str(), std::get<1>(entry.first),
					std::get<2>(entry.first).c_str());
		};
		check(plan.start, "Start");
		for (const RulePtr &r : plan.rules)
			check(r->switch_to, "Switch");
		for (auto &s : plan.strategies)
			for (const RulePtr &r : s.second.rules)
				check(r->switch_to, "Switch");
		if (!plan.strategies.empty() && plan.start.empty())
			ShowWarning("population_strategy: monster %s, job %d, build '%s' has strategies but no Start; none is active until a Switch.\n",
				mob_label(std::get<0>(entry.first)).c_str(), std::get<1>(entry.first), std::get<2>(entry.first).c_str());
	}
	// Disable names rules of other plans; a name no rule has is a typo that disables nothing.
	std::unordered_set<std::string> names;
	for (const auto &entry : this->plans) {
		for (const RulePtr &r : entry.second.rules)
			names.insert(r->name);
		for (const auto &s : entry.second.strategies)
			for (const RulePtr &r : s.second.rules)
				names.insert(r->name);
	}
	for (const auto &entry : this->plans) {
		std::vector<std::string> all = entry.second.disable;
		for (const auto &s : entry.second.strategies)
			all.insert(all.end(), s.second.disable.begin(), s.second.disable.end());
		for (const std::string &n : all)
			if (names.count(n) == 0)
				ShowWarning("population_strategy: Disable '%s' (monster %s, job %d, build '%s') names no rule.\n",
					n.c_str(), mob_label(std::get<0>(entry.first)).c_str(), std::get<1>(entry.first), std::get<2>(entry.first).c_str());
	}
	YamlDatabase::loadingFinished();
}

static StrategyDatabase g_db;

// ---------------------------------------------------------------------------
// Runtime state (companions only; keyed by block id, checked against char id)
// ---------------------------------------------------------------------------

struct RuleState {
	bool seen = false;          ///< level events: the first look is a baseline, not an edge
	bool level = false;
	t_tick last_poll = 0;
	t_tick pending_until = 0;   ///< an event happened; the rule may fire until then
	int32 subject = 0;          ///< who the event is about
	int32 source = 0;           ///< monster_casts: the caster
	uint16 subject_skill = 0;   ///< casts: what is being cast
	int16 cell_x = -1, cell_y = -1; ///< casts: where it will land (a ground skill's cell, else the target's)
	t_tick cooldown_until = 0;
	uint64 chat_seen = 0;       ///< newest party-chat line this rule has looked at
	uint64 signal_seen = 0;     ///< newest signal this rule has looked at
	uint64 occurrence_seen = 0; ///< newest encounter_ended / target_lost this rule has looked at
	std::vector<int32> marks;   ///< who was dead / who was casting at the last look
};

struct PlanState {
	bool started = false;
	std::string active;
	int32 fight = 0;            ///< the monster a monster-specific plan's strategy belongs to
	t_tick entered = 0;         ///< when the active strategy became active (InStrategy)
};

/// Something that happened to the companion's fight: an encounter ended, its target was lost.
struct Occurrence {
	uint64 seq;
	t_tick tick;
	Event kind;
	uint32 mob_id;
	int32 instance;
	bool died;                  ///< died, or still alive but gone (teleported, out of sight, another map)
	bool boss;                  ///< it was boss-class (read while it was still there)
};

struct ShellState {
	uint32 char_id = 0;
	// For encounter_ended / target_lost: what the last turn saw.
	std::vector<std::pair<uint32, int32>> last_encounters; ///< (mob id, instance)
	std::unordered_set<int32> last_bosses; ///< the boss-class ones among last_encounters and last_target
	int32 last_target = 0;
	uint32 last_target_mob = 0;
	t_tick last_seen = 0;
	std::deque<Occurrence> occurrences;
	std::unordered_map<uint32, RuleState> rules;
	std::map<PlanKey, PlanState> plans;
	bool trace = false;
	uint32 tracer_char = 0;     ///< a regular shell's trace goes to this player (a companion's to its owner)
	t_tick hold_until = 0;      ///< a rule is positioning the companion: following waits until then
	t_tick fight_since = 0;     ///< InFight: when the current fight began
	t_tick last_engaged = 0;    ///< the last turn it had a target or a monster's plan
	bool sat = false;           ///< a Sit rule sat it down: stood up again when none applies
	int32 forced_target = 0;    ///< SetTarget: this monster, until forced_until
	t_tick forced_until = 0;
	std::string last_trace;
	t_tick last_trace_tick = 0;
	t_tick touched = 0;
};

struct ChatLine {
	uint64 seq;
	t_tick tick;
	int32 speaker;
	uint32 account_id;
	uint32 char_id;
	bool leader;
	std::string text;           ///< lower-case
};

static std::unordered_map<int32, ShellState> g_shells;
static std::unordered_map<int32, std::deque<ChatLine>> g_chat; ///< party id -> recent lines
static uint64 g_chat_seq = 0;

struct SignalLine {
	uint64 seq;
	t_tick tick;
	int32 sender;
	std::string name;
};
static std::unordered_map<int32, std::deque<SignalLine>> g_signals; ///< party id -> recent signals
static uint64 g_signal_seq = 0;
static uint64 g_occurrence_seq = 0;
/// OnePerParty: (party, rule, target) -> (who claimed it, until when)
static std::map<std::tuple<int32, uint32, int32>, std::pair<int32, t_tick>> g_claims;
/// Claim: (party, claim name, target) -> (the companion holding it, until).
static std::map<std::tuple<int32, std::string, int32>, std::pair<int32, t_tick>> g_named_claims;

/// Whether another companion of the party holds `name` on `target` right now; `holder`, if
/// given, gets that companion's id (for the trace).
static bool claimed_by_other(const map_session_data *sd, const std::string &name, int32 target, t_tick tick,
	int32 *holder = nullptr)
{
	if (sd->status.party_id <= 0)
		return false;
	const auto it = g_named_claims.find(std::make_tuple(sd->status.party_id, name, target));
	if (it == g_named_claims.end() || it->second.first == sd->id || DIFF_TICK(tick, it->second.second) >= 0)
		return false;
	if (holder != nullptr)
		*holder = it->second.first;
	return true;
}
static t_tick g_next_prune = 0;

/// Bumped whenever the table is loaded, reloaded or cleared: anything holding pointers into it
/// (the rotation's plan cache) must look again.
static uint32 g_generation = 0;

static void reset_runtime()
{
	++g_generation;
	g_shells.clear();
	g_chat.clear();
	g_signals.clear();
	g_claims.clear();
	g_named_claims.clear();
}

static void prune(t_tick tick)
{
	if (DIFF_TICK(tick, g_next_prune) < 0)
		return;
	g_next_prune = tick + 30000;
	for (auto it = g_shells.begin(); it != g_shells.end();) {
		const map_session_data *sd = map_id2sd(it->first);
		if (sd == nullptr || sd->status.char_id != it->second.char_id || DIFF_TICK(tick, it->second.touched) > 60000)
			it = g_shells.erase(it);
		else
			++it;
	}
	for (auto it = g_claims.begin(); it != g_claims.end();)
		it = DIFF_TICK(tick, it->second.second) >= 0 ? g_claims.erase(it) : std::next(it);
	for (auto it = g_named_claims.begin(); it != g_named_claims.end();)
		it = DIFF_TICK(tick, it->second.second) >= 0 ? g_named_claims.erase(it) : std::next(it);
	for (auto it = g_chat.begin(); it != g_chat.end();)
		it = it->second.empty() ? g_chat.erase(it) : std::next(it);
	for (auto it = g_signals.begin(); it != g_signals.end();) {
		while (!it->second.empty() && DIFF_TICK(tick, it->second.front().tick) > 10000)
			it->second.pop_front();
		it = it->second.empty() ? g_signals.erase(it) : std::next(it);
	}
}

static ShellState &shell_state(map_session_data *sd, t_tick tick)
{
	ShellState &st = g_shells[sd->id];
	if (st.char_id != sd->status.char_id) {
		st = ShellState();
		st.char_id = sd->status.char_id;
	}
	st.touched = tick;
	return st;
}

static const char *label(const Rule &r, char *buf, size_t size)
{
	if (!r.name.empty())
		return r.name.c_str();
	safesnprintf(buf, size, "#%u", r.uid);
	return buf;
}

/// A line to the owner, if they asked for it ("<name> trace"). Repeats within 3 s are dropped.
static void trace(map_session_data *sd, ShellState &st, t_tick tick, const char *fmt, ...)
{
	if (!st.trace)
		return;
	map_session_data *owner = st.tracer_char != 0 ? map_charid2sd(static_cast<int32>(st.tracer_char))
		: population_engine_companion_loot_owner(sd);
	if (owner == nullptr)
		return;
	char body[CHAT_SIZE_MAX];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(body, sizeof(body), fmt, ap);
	va_end(ap);
	if (st.last_trace == body && DIFF_TICK(tick, st.last_trace_tick) < 3000)
		return;
	st.last_trace = body;
	st.last_trace_tick = tick;
	char line[CHAT_SIZE_MAX + NAME_LENGTH + 8];
	safesnprintf(line, sizeof(line), "[%s] %s", sd->status.name, body);
	clif_displaymessage(owner->fd, line);
	// The same line in the map-server log, with a prefix to filter on.
	ShowInfo("[strategy] %s\n", line);
}

static int hp_pct(const block_list *bl)
{
	const int32 max = status_get_max_hp(bl);
	return max > 0 ? static_cast<int>(static_cast<int64>(status_get_hp(bl)) * 100 / max) : 100;
}

/// Party members on the shell's map (the owner and other companions included, the shell not).
struct SyntheticPartyScan {
	map_session_data *sd;
	std::vector<map_session_data *> *out;
};

static int32 synthetic_party_cb(block_list *bl, va_list ap)
{
	SyntheticPartyScan *scan = va_arg(ap, SyntheticPartyScan *);
	map_session_data *m = BL_CAST(BL_PC, bl);
	if (m != nullptr && m != scan->sd && m->status.party_id == scan->sd->status.party_id
			&& m->state.active && !m->state.warping)
		scan->out->push_back(m);
	return 0;
}

static std::vector<map_session_data *> party_members(map_session_data *sd)
{
	std::vector<map_session_data *> out;
	// Regular shells share a synthetic party per map (0x70000000 | map) that rAthena's party
	// table does not know; for them, the party is the shells of that party within sight.
	if (sd->status.party_id >= 0x70000000) {
		SyntheticPartyScan scan{ sd, &out };
		map_foreachinrange(synthetic_party_cb, sd, AREA_SIZE, BL_PC, &scan);
		return out;
	}
	const party_data *p = sd->status.party_id > 0 ? party_search(sd->status.party_id) : nullptr;
	if (p == nullptr)
		return out;
	for (const party_member_data &m : p->data) {
		if (m.sd != nullptr && m.sd != sd && m.sd->m == sd->m && m.sd->state.active && !m.sd->state.warping)
			out.push_back(m.sd);
	}
	return out;
}

static bool is_party(const map_session_data *sd, int32 id)
{
	if (id == sd->id)
		return true;
	const map_session_data *other = map_id2sd(id);
	return other != nullptr && sd->status.party_id > 0 && other->status.party_id == sd->status.party_id;
}

static int32 item_count(const map_session_data *sd, t_itemid nameid)
{
	int32 n = 0;
	for (int i = 0; i < MAX_INVENTORY; ++i)
		if (sd->inventory.u.items_inventory[i].nameid == nameid)
			n += sd->inventory.u.items_inventory[i].amount;
	return n;
}

static bool equip_broken(const map_session_data *sd, int16 slot)
{
	static const int16 worn[] = { EQI_HAND_R, EQI_HAND_L, EQI_ARMOR, EQI_GARMENT, EQI_SHOES,
		EQI_HEAD_TOP, EQI_HEAD_MID, EQI_HEAD_LOW, EQI_ACC_L, EQI_ACC_R };
	for (const int16 eqi : worn) {
		if (slot >= 0 && eqi != slot)
			continue;
		const int16 idx = sd->equip_index[eqi];
		if (idx >= 0 && sd->inventory.u.items_inventory[idx].attribute != 0)
			return true;
	}
	return false;
}

static bool threshold_ok(int32 value, int32 below, int32 atleast)
{
	return (below < 0 || value < below) && (atleast < 0 || value >= atleast);
}

/// The counter a status keeps in one of its values (Cicada: val2 = blocks left); 0 without it.
static int32 status_charges(const map_session_data *sd, int16 sc, uint8 val)
{
	const status_change_entry *sce = sd->sc.getSCE(static_cast<sc_type>(sc));
	if (sce == nullptr)
		return 0;
	switch (val) {
	case 1: return sce->val1;
	case 3: return sce->val3;
	case 4: return sce->val4;
	default: return sce->val2;
	}
}

/// Whether a ground unit or a cast's caster counts as `who` for this companion.
static bool is_who(const map_session_data *sd, int32 id, Who who)
{
	switch (who) {
	case Who::Self:    return id == sd->id;
	case Who::Party:   return is_party(sd, id);
	case Who::Monster: return map_id2md(id) != nullptr;
	case Who::Enemy:   return !is_party(sd, id);
	case Who::Anyone:  return true;
	}
	return false;
}

struct FieldScan {
	const map_session_data *sd;
	uint16 skill_id;
	Who owner;
	int32 count;
	std::vector<std::pair<int16, int16>> *cells; ///< where they stand, when asked
};

static int32 field_cb(block_list *bl, va_list ap)
{
	FieldScan *scan = va_arg(ap, FieldScan *);
	const skill_unit *unit = reinterpret_cast<const skill_unit *>(bl);
	if (!unit->alive || unit->group == nullptr || (scan->skill_id != 0 && unit->group->skill_id != scan->skill_id)
			|| !is_who(scan->sd, unit->group->src_id, scan->owner))
		return 0;
	++scan->count;
	if (scan->cells != nullptr)
		scan->cells->emplace_back(bl->x, bl->y);
	return 0;
}

/// Ground units of `skill_id` placed by `owner` within `range` of the companion (0 = its own
/// cell): Blaze Shield's pillars, a party Sage's Land Protector, a monster's Storm Gust.
static int32 field_units(map_session_data *sd, uint16 skill_id, Who owner, int16 range,
	std::vector<std::pair<int16, int16>> *cells = nullptr, block_list *center = nullptr)
{
	FieldScan scan{ sd, skill_id, owner, 0, cells };
	map_foreachinrange(field_cb, center != nullptr ? center : sd, range, BL_SKILL, &scan);
	return scan.count;
}

/// The plain ItemCost a player would pay for this skill at this level. Shells are exempt from
/// item costs (patch 0001, skill_get_requirement), so Consume: true pays it here instead. The
/// special cases rAthena makes for a few skills (gemstone-saving partners, the Mistress card)
/// are not repeated.
static std::vector<std::pair<t_itemid, int32>> item_cost(uint16 skill_id, uint16 lv)
{
	std::vector<std::pair<t_itemid, int32>> out;
	const std::shared_ptr<s_skill_db> sk = skill_db.find(skill_id);
	if (sk == nullptr)
		return out;
	if (sk->require.itemid_level_dependent) {
		const int i = cap_value(static_cast<int>(lv), 1, MAX_SKILL_ITEM_REQUIRE) - 1;
		if (sk->require.itemid[i] != 0 && sk->require.amount[i] > 0)
			out.emplace_back(sk->require.itemid[i], sk->require.amount[i]);
		return out;
	}
	for (int i = 0; i < MAX_SKILL_ITEM_REQUIRE; ++i)
		if (sk->require.itemid[i] != 0 && sk->require.amount[i] > 0)
			out.emplace_back(sk->require.itemid[i], sk->require.amount[i]);
	return out;
}

static bool can_pay(const map_session_data *sd, const std::vector<std::pair<t_itemid, int32>> &cost)
{
	return std::all_of(cost.begin(), cost.end(), [&](const auto &c) { return item_count(sd, c.first) >= c.second; });
}

static void pay(map_session_data *sd, const std::vector<std::pair<t_itemid, int32>> &cost)
{
	for (const auto &c : cost) {
		int32 left = c.second;
		for (int i = 0; i < MAX_INVENTORY && left > 0; ++i) {
			const item &it = sd->inventory.u.items_inventory[i];
			if (it.nameid != c.first || it.amount <= 0)
				continue;
			const int32 take = std::min<int32>(left, it.amount);
			pc_delitem(sd, i, take, 0, 1, LOG_TYPE_CONSUME);
			left -= take;
		}
	}
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

struct PlanRef {
	PlanKey key;
	const Plan *plan;
	int32 instance;   ///< the monster this plan is for right now (0 for All): its fight
};

struct Turn {
	map_session_data *sd;
	map_session_data *owner;    ///< null when not on the companion's map
	block_list *enemy;          ///< the current combat target, if any
	t_tick tick;
	ShellState *st;
	bool target_set = false;    ///< a higher-priority rule already chose the target this turn
	bool sitting = false;       ///< a Sit rule applied this turn
	const std::string *claim = nullptr; ///< while a Claim rule picks its target: skip what others hold
	int32 claim_passed = 0;     ///< the last target a selector passed over for a claim...
	int32 claim_holder = 0;     ///< ...and who holds it (for the trace)
	const std::vector<PlanRef> *plans = nullptr; ///< the plans that apply this turn
};

struct CastScan {
	map_session_data *sd;
	map_session_data *owner;
	const Rule *rule;
	std::vector<std::tuple<int32, int32, uint16, int16, int16>> hits; ///< (caster, victim, skill, x, y)
};

static int32 victim_near_cell(map_session_data *sd, int16 x, int16 y)
{
	int32 best = 0;
	int best_d = 4; // a ground spell this close to someone is aimed at them
	auto consider = [&](map_session_data *m) {
		const int d = std::max(std::abs(m->x - x), std::abs(m->y - y));
		if (d < best_d || (d == best_d && best != 0 && m->id < best)) {
			best_d = d;
			best = m->id;
		}
	};
	consider(sd);
	for (map_session_data *m : party_members(sd))
		consider(m);
	return best;
}

/// One unit's cast, if it is a cast this rule watches.
static void consider_cast(CastScan *scan, block_list *bl)
{
	const unit_data *ud = unit_bl2ud(bl);
	if (ud == nullptr || ud->skilltimer == INVALID_TIMER || ud->skill_id == 0)
		return;
	if (scan->rule->ev_skill != 0 && ud->skill_id != scan->rule->ev_skill)
		return;
	if (!is_who(scan->sd, bl->id, scan->rule->ev_by))
		return;
	int32 victim = 0;
	int16 x = bl->x, y = bl->y;
	const bool ground = (skill_get_inf(ud->skill_id) & INF_GROUND_SKILL) != 0;
	if (ground) {
		x = ud->skillx;
		y = ud->skilly;
		victim = victim_near_cell(scan->sd, x, y);
	} else if (ud->skilltarget != 0 && ud->skilltarget != bl->id) {
		victim = ud->skilltarget;
		if (const block_list *v = map_id2bl(victim); v != nullptr) {
			x = v->x;
			y = v->y;
		}
	}
	// A cast at the caster itself (a summon, Power Up, a heal) is aimed at nobody: with At left
	// at its default it still counts, or "when it summons" could never match. A ground spell far
	// from everyone is aimed at nobody too, and does not.
	const bool at_itself = victim == 0 && !ground;
	switch (scan->rule->ev_at) {
	case At::Self:   if (victim != scan->sd->id) return; break;
	case At::Owner:  if (scan->owner == nullptr || victim != scan->owner->id) return; break;
	case At::Party:
		if (at_itself && !scan->rule->ev_at_set)
			break;
		if (victim == 0 || !is_party(scan->sd, victim)) return;
		break;
	case At::Anyone: break;
	}
	scan->hits.emplace_back(bl->id, victim, ud->skill_id, x, y);
}

static int32 cast_cb(block_list *bl, va_list ap)
{
	consider_cast(va_arg(ap, CastScan *), bl);
	return 0;
}

static void fire(Turn &t, const Rule &rule, RuleState &rs, int32 subject, int32 source, uint16 skill, const char *what,
	int16 x = -1, int16 y = -1)
{
	rs.pending_until = t.tick + static_cast<t_tick>(rule.within_ms);
	rs.subject = subject;
	rs.source = source;
	rs.subject_skill = skill;
	rs.cell_x = x;
	rs.cell_y = y;
	char buf[16];
	trace(t.sd, *t.st, t.tick, "event %s -> rule %s", what, label(rule, buf, sizeof(buf)));
}

/// Look at what a rule's On: watches, and open its window on a change.
static void poll_event(Turn &t, const Rule &rule, RuleState &rs)
{
	map_session_data *sd = t.sd;
	// A rule not looked at for a while compares against stale state: start again from now.
	const bool baseline = !rs.seen || DIFF_TICK(t.tick, rs.last_poll) > 2000;
	rs.last_poll = t.tick;
	auto level = [&](bool now, int32 subject, const char *what) {
		if (baseline) {
			rs.seen = true;
			rs.level = now;
			return;
		}
		if (now && !rs.level)
			fire(t, rule, rs, subject, 0, 0, what);
		rs.level = now;
	};

	switch (rule.event) {
	case Event::None:
		return;
	case Event::HpBelow:
		level(hp_pct(sd) < rule.ev_value, sd->id, "hp_below");
		return;
	case Event::OwnerHpBelow:
		level(t.owner != nullptr && hp_pct(t.owner) < rule.ev_value, t.owner ? t.owner->id : 0, "owner_hp_below");
		return;
	case Event::WeightAbove:
		level(sd->max_weight > 0 && static_cast<uint64>(sd->weight) * 100 / sd->max_weight > static_cast<uint64>(std::max(0, rule.ev_value)),
			sd->id, "weight_above");
		return;
	case Event::EquipBroken:
		level(equip_broken(sd, rule.ev_slot), sd->id, "equip_broken");
		return;
	case Event::ItemBelow:
		level(item_count(sd, rule.ev_item) < rule.ev_value, sd->id, "item_below");
		return;
	case Event::StatusGained:
		level(sd->sc.getSCE(static_cast<sc_type>(rule.ev_status)) != nullptr, sd->id, "status_gained");
		return;
	case Event::PartyMemberDied: {
		std::vector<int32> dead;
		for (map_session_data *m : party_members(sd))
			if (pc_isdead(m))
				dead.push_back(m->id);
		std::sort(dead.begin(), dead.end());
		if (!baseline) {
			for (const int32 id : dead) {
				if (!std::binary_search(rs.marks.begin(), rs.marks.end(), id)) {
					fire(t, rule, rs, id, 0, 0, "party_member_died");
					break;
				}
			}
		}
		rs.seen = true;
		rs.marks = std::move(dead);
		return;
	}
	case Event::Casts: {
		CastScan scan{ sd, t.owner, &rule, {} };
		switch (rule.ev_by) {
		case Who::Self:
			consider_cast(&scan, sd);
			break;
		case Who::Party:
			consider_cast(&scan, sd);
			for (map_session_data *m : party_members(sd))
				consider_cast(&scan, m);
			break;
		case Who::Monster:
			map_foreachinrange(cast_cb, sd, AREA_SIZE, BL_MOB, &scan);
			break;
		case Who::Enemy:
		case Who::Anyone:
			map_foreachinrange(cast_cb, sd, AREA_SIZE, BL_MOB | BL_PC, &scan);
			break;
		}
		std::sort(scan.hits.begin(), scan.hits.end());
		std::vector<int32> casting;
		for (const auto &h : scan.hits) {
			casting.push_back(std::get<0>(h));
			// A cast already under way when the rule is first looked at still counts: it
			// has not landed yet, which is the whole point of reacting to it.
			if (!std::binary_search(rs.marks.begin(), rs.marks.end(), std::get<0>(h)) && rs.pending_until <= t.tick) {
				char what[64];
				safesnprintf(what, sizeof(what), "casts %s", skill_get_desc(std::get<2>(h)));
				fire(t, rule, rs, std::get<1>(h), std::get<0>(h), std::get<2>(h), what, std::get<3>(h), std::get<4>(h));
			}
		}
		rs.seen = true;
		rs.marks = std::move(casting);
		return;
	}
	case Event::PartyChat: {
		const auto it = g_chat.find(sd->status.party_id);
		if (it == g_chat.end())
			return;
		for (const ChatLine &line : it->second) {
			if (line.seq <= rs.chat_seen)
				continue;
			rs.chat_seen = line.seq;
			if (DIFF_TICK(t.tick, line.tick) > static_cast<t_tick>(rule.within_ms))
				continue;
			if (rule.ev_from == From::Owner && (line.account_id != sd->pop.companion_owner_account
					|| line.char_id != sd->pop.companion_owner_char))
				continue;
			if (rule.ev_from == From::Leader && !line.leader)
				continue;
			if (!rule.ev_match.empty() && line.text.find(rule.ev_match) == std::string::npos)
				continue;
			fire(t, rule, rs, line.speaker, 0, 0, "party_chat");
		}
		return;
	}
	case Event::EncounterEnded:
	case Event::TargetLost:
		for (const Occurrence &o : t.st->occurrences) {
			if (o.seq <= rs.occurrence_seen)
				continue;
			rs.occurrence_seen = o.seq;
			if (o.kind != rule.event || DIFF_TICK(t.tick, o.tick) > static_cast<t_tick>(rule.within_ms))
				continue;
			if (rule.ev_mob != 0 && o.mob_id != rule.ev_mob)
				continue;
			if ((rule.ev_reason == 1 && !o.died) || (rule.ev_reason == 2 && o.died))
				continue;
			if (rule.ev_boss >= 0 && o.boss != (rule.ev_boss == 1))
				continue;
			char what[64];
			safesnprintf(what, sizeof(what), "%s (%s)", rule.event == Event::EncounterEnded ? "encounter_ended" : "target_lost",
				o.died ? "died" : "vanished");
			fire(t, rule, rs, o.instance, o.instance, 0, what);
		}
		return;
	case Event::Signal: {
		const auto it = g_signals.find(sd->status.party_id);
		if (it == g_signals.end())
			return;
		for (const SignalLine &sig : it->second) {
			if (sig.seq <= rs.signal_seen)
				continue;
			rs.signal_seen = sig.seq;
			if (DIFF_TICK(t.tick, sig.tick) > static_cast<t_tick>(rule.within_ms) || sig.name != rule.ev_signal)
				continue;
			if (sig.sender == sd->id && !rule.ev_signal_self)
				continue;
			char what[64];
			safesnprintf(what, sizeof(what), "signal %s", sig.name.c_str());
			fire(t, rule, rs, sig.sender, 0, 0, what);
		}
		return;
	}
	}
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

enum class Outcome : uint8 { Skipped, Done, Switched, Acted };

static block_list *same_map_bl(const map_session_data *sd, int32 id)
{
	block_list *bl = id != 0 ? map_id2bl(id) : nullptr;
	return bl != nullptr && bl->m == sd->m ? bl : nullptr;
}

static bool member_is(Turn &t, int32 id, Member m)
{
	map_session_data *sd = t.sd;
	switch (m) {
	case Member::Any:   return true;
	case Member::Party: return id != 0 && is_party(sd, id);
	case Member::Owner: return t.owner != nullptr && id == t.owner->id;
	case Member::Self:  return id == sd->id;
	default: break;
	}
	const map_session_data *who = map_id2sd(id);
	if (who == nullptr || !is_party(sd, id))
		return false;
	const int8 want = m == Member::Tank ? static_cast<int8>(PopulationRoleType::Tank)
		: m == Member::Support ? static_cast<int8>(PopulationRoleType::Support) : static_cast<int8>(PopulationRoleType::Attacker);
	return who->pop.role == want;
}

struct MobScan {
	std::vector<mob_data *> mobs;
};

static int32 mob_scan_cb(block_list *bl, va_list ap)
{
	MobScan *scan = va_arg(ap, MobScan *);
	mob_data *md = reinterpret_cast<mob_data *>(bl);
	if (!status_isdead(*md))
		scan->mobs.push_back(md);
	return 0;
}

/// Whether rAthena counts a monster as held where it stands, for its "rude attacked check"
/// (mob.cpp, mob_ai_sub_hard): it cannot move now, and that is one of the holds the check names
/// rather than the pause every attack and cast brings (unit_can_move is false through those too:
/// read alone, a boss in the middle of a fight looked unreachable on most turns). A monster that
/// never walks (Amon Ra) is not held by that either: rAthena goes on to ask for a path.
static bool mob_held(mob_data *md)
{
	if (status_has_mode(&md->status, MD_CANMOVE) && unit_can_move(md))
		return false;
	if (DIFF_TICK(gettick(), md->ud.canmove_tick) <= 0)
		return false;
	return (battle_config.mob_ai & 0x2) != 0 || md->sc.getSCE(SC_SPIDERWEB) != nullptr || md->sc.getSCE(SC_BITE) != nullptr
		|| md->sc.getSCE(SC_VACUUM_EXTREME) != nullptr || md->sc.getSCE(SC_THORNSTRAP) != nullptr
		|| md->sc.getSCE(SC__MANHOLE) != nullptr || md->walktoxy_fail_count > 0;
}

/// Whether a monster could fight back against a companion standing at (x, y): it can hit from
/// where it stands, or it is not held and there is a path within its chase range. The question
/// rAthena's rude attacked check asks, the same way.
static bool mob_reaches_cell(mob_data *md, int16 x, int16 y)
{
	const int d = std::max(std::abs(md->x - x), std::abs(md->y - y));
	if (d <= md->status.rhw.range)
		return true;
	if (mob_held(md))
		return false;
	return d <= md->db->range3 && unit_can_reach_pos(md, x, y, 0);
}

static bool mob_reaches(mob_data *md, map_session_data *sd)
{
	if (battle_check_range(md, sd, md->status.rhw.range))
		return true;
	if (mob_held(md))
		return false;
	return unit_can_reach_bl(md, sd, md->db->range3, 0, nullptr, nullptr);
}

/// Whether a monster has an answer to being hit by `sd` from where it cannot fight back: a
/// `rudeattacked` skill for the state it will be in when rAthena weighs the hit (mobskill_use's
/// own test). rAthena does nothing else on a rude attack, so without one there is nothing to
/// avoid. A monster busy with someone else stays in the state it is in: Dark Lord teleports for
/// it only while idle or walking, never while it fights the tank. One that is after the
/// companion itself (or after nobody) gives up a target it cannot reach and is idle by then.
static bool mob_answers_rude(const mob_data *md, const map_session_data *sd)
{
	if (md->db == nullptr || md->state.skillstate == MSS_DEAD)
		return false;
	const bool drops_target = md->target_id == 0 || md->target_id == sd->id;
	for (const auto &ms : md->db->skill) {
		if (ms == nullptr || ms->cond1 != MSC_RUDEATTACKED)
			continue;
		if (ms->state == md->state.skillstate || ms->state == MSS_ANY
				|| (ms->state == MSS_ANYTARGET && md->target_id != 0 && md->state.skillstate != MSS_LOOT))
			return true;
		if (drops_target && (ms->state == MSS_IDLE || ms->state == MSS_WALK))
			return true;
	}
	return false;
}

/// MaxAttackers: how many of the party are on this monster ahead of the companion. The owner
/// always counts; companions count in order of their id, so the lower ids keep their places and
/// two companions never take turns at the same slot.
static int32 attackers_ahead(const map_session_data *sd, const map_session_data *owner, const mob_data *md)
{
	int32 n = 0;
	if (owner != nullptr) {
		const unit_data *ud = unit_bl2ud(const_cast<map_session_data *>(owner));
		if (ud != nullptr && ud->target == md->id)
			++n;
	}
	const party_data *p = sd->status.party_id > 0 ? party_search(sd->status.party_id) : nullptr;
	for (int i = 0; p != nullptr && i < MAX_PARTY; ++i) {
		const map_session_data *m = p->data[i].sd;
		if (m != nullptr && m != sd && m->id < sd->id && population_engine_is_recruited_companion(m)
				&& m->pop.target_id == md->id)
			++n;
	}
	return n;
}

static bool at_cap(const map_session_data *sd, const map_session_data *owner, const mob_data *md)
{
	const auto it = g_db.targeting.find(md->mob_id);
	return it != g_db.targeting.end() && it->second.max_attackers > 0
		&& attackers_ahead(sd, owner, md) >= it->second.max_attackers;
}

/// Whether a monster is one an Enemy selector (or a Count) means; `rank` orders the matches (lower first).
static bool enemy_matches(Turn &t, const Selector &sel, const mob_data *md, int &rank)
{
	map_session_data *sd = t.sd;
	rank = 0;
	if (sel.boss_only && status_get_class_(md) != CLASS_BOSS)
		return false;
	if (!sel.mobs.empty() && std::find(sel.mobs.begin(), sel.mobs.end(), md->mob_id) == sel.mobs.end())
		return false;
	block_list *bl = const_cast<mob_data *>(md);
	if (sel.race >= 0 && status_get_race(bl) != sel.race)
		return false;
	if (sel.element >= 0 && status_get_element(bl) != sel.element)
		return false;
	switch (sel.pick) {
	case Selector::Pick::Attacking:
		if (md->target_id == 0 || !member_is(t, md->target_id, sel.who) || (sel.not_self && md->target_id == sd->id))
			return false;
		if (!sel.jobs.empty()) {
			const map_session_data *victim = map_id2sd(md->target_id);
			if (victim == nullptr || std::none_of(sel.jobs.begin(), sel.jobs.end(), [&](int32 j) { return job_matches(victim, j); }))
				return false;
		}
		rank = sel.prefer != Member::Any && member_is(t, md->target_id, sel.prefer) ? 0 : 1;
		return true;
	case Selector::Pick::LowestHp: rank = hp_pct(md); return true;
	case Selector::Pick::Boss:     return status_get_class_(md) == CLASS_BOSS;
	case Selector::Pick::Slaves:   return md->master_id != 0;
	case Selector::Pick::Casting:
		return md->ud.skilltimer != INVALID_TIMER && (sel.skills.empty()
			|| std::find(sel.skills.begin(), sel.skills.end(), md->ud.skill_id) != sel.skills.end());
	// Hiding, Cloaking, Chase Walk -- and a Hode's burrow, which is Hiding too.
	case Selector::Pick::Hidden:   return (md->sc.option & (OPTION_HIDE | OPTION_CLOAK | OPTION_CHASEWALK)) != 0;
	default:                       return true;
	}
}

/// Count: the monsters matching `sel` within `range` of `center` (the companion, or the rule's target).
static int32 count_enemies(Turn &t, const Selector &sel, block_list *center, int16 range)
{
	MobScan scan;
	map_foreachinrange(mob_scan_cb, center, range, BL_MOB, &scan);
	int32 n = 0;
	int rank = 0;
	for (const mob_data *md : scan.mobs)
		if (md != center && enemy_matches(t, sel, md, rank))
			++n;
	return n;
}

/// Target: { Enemy: ... }. Deterministic: the preferred ones first, then the nearest, then the lowest id.
static block_list *select_enemy(Turn &t, const Selector &sel, int range)
{
	map_session_data *sd = t.sd;
	if (sel.pick == Selector::Pick::TargetOf) {
		// Assist: the monster the owner (or the party's tank, support, attacker) is fighting.
		std::vector<map_session_data *> members = party_members(sd);
		members.push_back(sd);
		for (map_session_data *m : members) {
			if (!member_is(t, m->id, sel.who) || (sel.not_self && m == sd))
				continue;
			if (!sel.jobs.empty() && std::none_of(sel.jobs.begin(), sel.jobs.end(), [&](int32 j) { return job_matches(m, j); }))
				continue;
			int32 id = population_engine_is_population_pc(m->id) ? m->pop.target_id : 0;
			if (id == 0) {
				const unit_data *ud = unit_bl2ud(m);
				if (ud != nullptr)
					id = ud->target > 0 ? ud->target : (ud->skilltimer != INVALID_TIMER ? ud->skilltarget : 0);
			}
			mob_data *md = id != 0 ? map_id2md(id) : nullptr;
			if (md != nullptr && !sel.mobs.empty() && std::find(sel.mobs.begin(), sel.mobs.end(), md->mob_id) == sel.mobs.end())
				continue;
			if (md != nullptr && md->m == sd->m && !status_isdead(*md) && check_distance_bl(sd, md, range)) {
				if (t.claim != nullptr && claimed_by_other(sd, *t.claim, md->id, t.tick, &t.claim_holder)) {
					t.claim_passed = md->id;
					continue;
				}
				return md;
			}
		}
		return nullptr;
	}
	MobScan scan;
	map_foreachinrange(mob_scan_cb, sd, static_cast<int16>(range), BL_MOB, &scan);
	mob_data *best = nullptr;
	std::tuple<int, int, int, int32> best_key;
	for (mob_data *md : scan.mobs) {
		if (!population_shell_check_target(sd, md->id) && !population_shell_check_target_for_movement(sd, md->id))
			continue;
		int rank = 0; // lower is better
		if (!enemy_matches(t, sel, md, rank) || at_cap(sd, t.owner, md))
			continue;
		if (t.claim != nullptr && claimed_by_other(sd, *t.claim, md->id, t.tick, &t.claim_holder)) {
			t.claim_passed = md->id;
			continue;
		}
		const auto key = std::make_tuple(rank, distance_bl(sd, md), 0, md->id);
		if (best == nullptr || key < best_key) {
			best = md;
			best_key = key;
		}
	}
	return best;
}

/// How long a status has left, in ms. One without a timer (it lasts until removed) never lapses.
static int64 status_left_ms(const status_change_entry *sce, t_tick now)
{
	if (sce == nullptr)
		return 0;
	const TimerData *td = sce->timer != INVALID_TIMER ? get_timer(sce->timer) : nullptr;
	return td != nullptr ? std::max<int64>(0, DIFF_TICK(td->tick, now)) : INT64_MAX;
}

/// Target: { Ally: ... }: the companion itself counts unless NotSelf.
/// `skill`: the rule's Cast, if any. A member it cannot help is passed over (pop_ally_skill_refused
/// in the combat file: an undead-armoured ally for Heal, Resurrection, Sanctuary ...), so the rule
/// picks the next one rather than losing every cast on the same member.
static block_list *select_ally(Turn &t, const Selector &sel, int range, uint16 skill = 0)
{
	map_session_data *sd = t.sd;
	// Ally: attacked -- who the monsters in sight are on; a boss counts three times.
	std::unordered_map<int32, int> threat;
	if (sel.pick == Selector::Pick::Attacked) {
		MobScan scan;
		map_foreachinrange(mob_scan_cb, sd, AREA_SIZE, BL_MOB, &scan);
		for (const mob_data *md : scan.mobs)
			if (md->target_id != 0)
				threat[md->target_id] += status_get_class_(md) == CLASS_BOSS ? 3 : 1;
	}
	std::vector<map_session_data *> members = party_members(sd);
	if (!sel.not_self)
		members.push_back(sd);
	map_session_data *best = nullptr;
	std::tuple<int, int, int32> best_key;
	for (map_session_data *m : members) {
		// Ally: dead picks the fallen, nearest first; every other pick, the living.
		if (pc_isdead(m) != (sel.pick == Selector::Pick::Dead) || !check_distance_bl(sd, m, range))
			continue;
		if (sel.not_owner && m == t.owner)
			continue;
		if (sel.roles != 0 && (!population_engine_is_population_pc(m->id)
				|| (sel.roles & (1u << static_cast<uint8>(m->pop.role))) == 0))
			continue;
		if (!sel.jobs.empty() && std::none_of(sel.jobs.begin(), sel.jobs.end(), [&](int32 j) { return job_matches(m, j); }))
			continue;
		if (skill != 0 && pop_ally_skill_refused(sd, m, skill))
			continue;
		// A cast at a member nobody can see (Hiding, Cloaking, a GM's @hide) is refused every time.
		if (skill != 0 && m != sd && (m->sc.option & (OPTION_HIDE | OPTION_CLOAK | OPTION_CHASEWALK | OPTION_INVISIBLE)) != 0)
			continue;
		if (t.claim != nullptr && claimed_by_other(sd, *t.claim, m->id, t.tick, &t.claim_holder)) {
			t.claim_passed = m->id;
			continue;
		}
		int rank = 0;
		if (sel.pick == Selector::Pick::LowestHp) {
			rank = hp_pct(m);
			if (rank >= 100)
				continue;
		} else if (sel.pick == Selector::Pick::Missing) {
			// Missing, or (Expiring) about to lapse: renewed before the gap, not after it.
			const status_change_entry *sce = m->sc.getSCE(static_cast<sc_type>(sel.status));
			if (sce != nullptr && !(sel.expiring_ms > 0 && status_left_ms(sce, t.tick) < sel.expiring_ms))
				continue;
		} else if (sel.pick == Selector::Pick::Having && m->sc.getSCE(static_cast<sc_type>(sel.status)) == nullptr) {
			continue;
		} else if (sel.pick == Selector::Pick::Attacked) {
			const auto it = threat.find(m->id);
			if (it == threat.end())
				continue;
			rank = -it->second; // the most threatened first
		}
		const auto key = std::make_tuple(rank, distance_bl(sd, m), m->id);
		if (best == nullptr || key < best_key) {
			best = m;
			best_key = key;
		}
	}
	return best;
}

static block_list *resolve_target(Turn &t, const Rule &rule, const RuleState &rs, int range)
{
	map_session_data *sd = t.sd;
	if (rule.sel.kind == Selector::Kind::Enemy)
		return select_enemy(t, rule.sel, rule.sel.range > 0 ? rule.sel.range : range);
	if (rule.sel.kind == Selector::Kind::Ally)
		return select_ally(t, rule.sel, rule.sel.range > 0 ? rule.sel.range : range, rule.cast_skill);
	switch (rule.target) {
	case Target::Enemy:  return t.enemy;
	case Target::Self:   return sd;
	case Target::Owner:  return t.owner;
	case Target::Event:  return same_map_bl(sd, rs.subject);
	case Target::Source: return same_map_bl(sd, rs.source);
	case Target::AllyLowestHp: {
		block_list *best = nullptr;
		int best_hp = 100;
		std::vector<map_session_data *> members = party_members(sd);
		members.push_back(sd);
		for (map_session_data *m : members) {
			if (pc_isdead(m) || !check_distance_bl(sd, m, range)
					|| (rule.cast_skill != 0 && pop_ally_skill_refused(sd, m, rule.cast_skill)))
				continue;
			const int hp = hp_pct(m);
			if (hp < best_hp || (hp == best_hp && best != nullptr && m->id < best->id)) {
				best_hp = hp;
				best = m;
			}
		}
		return best;
	}
	case Target::DeadAlly: {
		block_list *best = nullptr;
		int best_d = range + 1;
		for (map_session_data *m : party_members(sd)) {
			if (!pc_isdead(m) || (rule.cast_skill != 0 && pop_ally_skill_refused(sd, m, rule.cast_skill)))
				continue;
			const int d = distance_bl(sd, m);
			if (d < best_d || (d == best_d && best != nullptr && m->id < best->id)) {
				best_d = d;
				best = m;
			}
		}
		return best;
	}
	}
	return nullptr;
}

static void say(Turn &t, const Rule &rule, const RuleState &rs, block_list *target)
{
	map_session_data *sd = t.sd;
	std::string text = rule.say;
	auto put = [&](const char *key, const std::string &value) {
		for (size_t at = text.find(key); at != std::string::npos; at = text.find(key, at + value.size()))
			text.replace(at, strlen(key), value);
	};
	put("{name}", sd->status.name);
	put("{owner}", t.owner ? t.owner->status.name : "");
	put("{target}", t.enemy ? status_get_name(*t.enemy) : "");
	put("{ally}", target ? status_get_name(*target) : "");
	put("{skill}", rs.subject_skill ? skill_get_desc(rs.subject_skill) : "");
	put("{hp}", std::to_string(hp_pct(sd)));

	char line[CHAT_SIZE_MAX];
	safesnprintf(line, sizeof(line), "%s : %s", sd->status.name, text.c_str());
	if (rule.say_area || sd->status.party_id <= 0)
		clif_GlobalMessage(*sd, line, AREA_CHAT_WOC);
	else
		// From the shell, so it never comes back through the party-chat hook: that hook
		// only sees packets from real clients.
		party_send_message(sd, line, strlen(line) + 1);
}

/// Cast the rule's skill, refusing it wherever the rotation would. A reason on failure.
static bool plans_allow(const map_session_data *sd, const std::vector<PlanRef> &plans, uint16 skill, bool by_rule);

/// Cast: [list]: the skill the target is weakest to (see Rule::cast_options), among those the
/// plans allow. 0 when none can be cast.
static uint16 best_against(const map_session_data *sd, const Rule &rule, block_list *target,
	const std::vector<PlanRef> *plans)
{
	const int def_ele = target != nullptr && target != sd ? status_get_element(target) : ELE_NONE;
	const int def_lv = target != nullptr && target != sd ? status_get_element_level(target) : 0;
	uint16 best = 0;
	int best_mult = 0;
	for (const uint16 id : rule.cast_options) {
		uint16 lv = pc_checkskill(const_cast<map_session_data *>(sd), id);
		if (lv == 0 || !population_shell_skill_selected(sd, id) || (plans != nullptr && !plans_allow(sd, *plans, id, true)))
			continue;
		if (rule.cast_lv > 0)
			lv = std::min<uint16>(lv, rule.cast_lv);
		if (skill_get_sp(id, lv) > static_cast<int32>(sd->battle_status.sp))
			continue;
		const int ele = skill_get_ele(id, lv);
		const int mult = CHK_ELEMENT(ele) && CHK_ELEMENT(def_ele) ? elemental_attribute_db.getAttribute(def_lv, ele, def_ele) : 100;
		if (mult > best_mult) {
			best = id;
			best_mult = mult;
		}
	}
	return best;
}

// --- Why a cast was not made, for the trace ---------------------------------
// A plan's author can only act on a refusal that says what it was: step closer (out of range),
// aim elsewhere (the cell is taken), wait (a cooldown), stock the bag (a catalyst), or drop the
// rule. Each reason is worked out only once the cast has been refused.

static std::string g_cast_why;

static const char *why(const char *fmt, ...)
{
	char buf[160];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf), fmt, ap);
	va_end(ap);
	g_cast_why = buf;
	return g_cast_why.c_str();
}

/// What the skill costs that the companion does not have (skill_get_requirement, which already
/// leaves out what a shell is excused from); nullptr when it has all of it.
static const char *why_requirement(map_session_data *sd, uint16 id, uint16 lv)
{
	const s_skill_condition req = skill_get_requirement(sd, id, lv);
	if (req.sp > 0 && static_cast<uint32>(req.sp) > sd->battle_status.sp)
		return why("not enough SP: needs %d, has %u", req.sp, sd->battle_status.sp);
	if (req.hp > 0 && static_cast<uint32>(req.hp) >= sd->battle_status.hp)
		return why("not enough HP: needs more than %d, has %u", req.hp, sd->battle_status.hp);
	if (req.zeny > 0 && sd->status.zeny < req.zeny)
		return why("not enough zeny: needs %d", req.zeny);
	if (req.spiritball > 0 && sd->spiritball < req.spiritball)
		return why("not enough spirit spheres: needs %d, has %d", req.spiritball, static_cast<int>(sd->spiritball));
	if (req.weapon != 0 && !pc_check_weapontype(sd, req.weapon))
		return why("the wrong weapon for it");
	if (req.ammo != 0) {
		const int16 idx = sd->equip_index[EQI_AMMO];
		if (idx < 0 || sd->inventory_data[idx] == nullptr || !(req.ammo & (1 << sd->inventory_data[idx]->subtype)))
			return why("no ammunition of the kind it needs");
		if (sd->inventory.u.items_inventory[idx].amount < req.ammo_qty)
			return why("not enough ammunition: needs %d, has %d", req.ammo_qty,
				static_cast<int>(sd->inventory.u.items_inventory[idx].amount));
	}
	for (int i = 0; i < MAX_SKILL_ITEM_REQUIRE; ++i) {
		if (req.itemid[i] == 0)
			continue;
		const int16 idx = pc_search_inventory(sd, req.itemid[i]);
		if (idx < 0 || sd->inventory.u.items_inventory[idx].amount < req.amount[i])
			return why("a catalyst is missing: %d %s", std::max(1, req.amount[i]), itemdb_name(req.itemid[i]));
	}
	return nullptr;
}

/// Why pop_skill_state_ok (the combat file) said no: its checks, in its order.
static const char *why_state(map_session_data *sd, uint16 id, uint16 lv)
{
	const std::shared_ptr<s_skill_db> skill = skill_db.find(id);
	if (skill == nullptr)
		return why("no such skill");
	const int l = cap_value(static_cast<int>(lv), 1, MAX_SKILL_LEVEL);
	if (skill->require.spiritball[l - 1] > 0 && sd->spiritball < skill->require.spiritball[l - 1])
		return why("not enough spirit spheres: needs %d, has %d", skill->require.spiritball[l - 1], static_cast<int>(sd->spiritball));
	if (skill->require.ap[l - 1] > 0 && sd->battle_status.ap < static_cast<uint32>(skill->require.ap[l - 1]))
		return why("not enough AP: needs %d, has %u", skill->require.ap[l - 1], sd->battle_status.ap);
	if (!status_check_skilluse(sd, nullptr, id, 0))
		return why("its own state forbids it (silenced, stunned, hidden, or a status that stops skills)");
	if (!population_shell_inventory_can_pay_skill(sd, id, lv)) {
		const char *what = why_requirement(sd, id, lv);
		return what != nullptr ? what : why("a catalyst is missing");
	}
	static const std::map<int32, const char *> states = {
		{ ST_HIDDEN, "hidden" }, { ST_RIDING, "riding" }, { ST_FALCON, "with a falcon" }, { ST_CART, "with a cart" },
		{ ST_SHIELD, "holding a shield" }, { ST_RECOVER_WEIGHT_RATE, "under its weight limit" },
		{ ST_WATER, "standing in water" }, { ST_RIDINGDRAGON, "riding a dragon" }, { ST_WUG, "with a warg" },
		{ ST_RIDINGWUG, "riding a warg" }, { ST_MADO, "in a Madogear" }, { ST_ELEMENTALSPIRIT, "with an elemental spirit" },
		{ ST_ELEMENTALSPIRIT2, "with an elemental spirit" }, { ST_PECO, "riding" }, { ST_SUNSTANCE, "in the Sun stance" },
		{ ST_MOONSTANCE, "in the Lunar stance" }, { ST_STARSTANCE, "in the Star stance" },
		{ ST_UNIVERSESTANCE, "in the Universe stance" },
	};
	const auto it = states.find(skill->require.state);
	return it != states.end() ? why("it must be %s", it->second) : why("its state does not allow it");
}

struct CellScan {
	const block_list *self;
	const block_list *found;
};

static int32 cell_scan_cb(block_list *bl, va_list ap)
{
	CellScan *scan = va_arg(ap, CellScan *);
	if (bl->prev != nullptr && !status_isdead(*bl) && scan->found == nullptr)
		scan->found = bl;
	return 0;
}

/// Why a ground skill cannot be placed at (x, y): rAthena's skill_pos_maxcount_check, which it
/// runs only when the cast ENDS -- by then the cast is made and its catalyst taken, with nothing
/// placed and nothing said. A trap aimed at a monster's own cell failed that way every time.
/// nullptr when the cell is free.
static const char *why_cell(map_session_data *sd, uint16 id, uint16 lv, int16 x, int16 y)
{
	if (skill_pos_maxcount_check(sd, x, y, id, lv, BL_PC, false))
		return nullptr;
	const std::shared_ptr<s_skill_db> skill = skill_db.find(id);
	if (skill != nullptr && skill->unit_flag[UF_NOFOOTSET] && (battle_config.skill_nofootset & BL_PC)) {
		const int r = std::max(0, skill_get_unit_range(id, lv))
			+ std::max(0, static_cast<int>(skill->unit_layout_type[cap_value(static_cast<int>(lv), 1, MAX_SKILL_LEVEL) - 1]));
		CellScan scan{ sd, nullptr };
		map_foreachinallarea(cell_scan_cb, sd->m, x - r, y - r, x + r, y + r, BL_CHAR, &scan);
		if (scan.found != nullptr)
			return why("the cell is taken: %s stands %s", status_get_name(*scan.found), r > 0 ? "too near it" : "on it");
	}
	return why("the cell is taken (another trap or field is there, or it has as many as it may place)");
}

/// Why unit_skilluse_id / unit_skilluse_pos returned 0: their own checks, in their order, as far
/// as they can be asked again without casting.
static const char *why_unit_refused(map_session_data *sd, block_list *target, uint16 id, uint16 lv, bool ground,
	int16 x, int16 y)
{
	if (sd->ud.state.blockedskill)
		return why("its skills are blocked");
	if (target != sd && battle_config.ksprotection && mob_ksprotected(sd, target))
		return why("%s is another player's monster", status_get_name(*target));
	if (const char *cost = why_requirement(sd, id, lv); cost != nullptr)
		return cost;
	const int range = skill_get_range2(sd, id, lv, true);
	if (ground && (x != sd->x || y != sd->y)) {
		// The cell a ground skill is aimed at, which Aim can put away from the target.
		block_list cell;
		cell.type = BL_NUL;
		cell.m = sd->m;
		cell.x = x;
		cell.y = y;
		const int d = std::max(std::abs(sd->x - x), std::abs(sd->y - y));
		if (unit_is_walking(sd))
			return why("it was still walking (%d cells off, range %d)", d, range);
		if (!battle_check_range(sd, &cell, range))
			return d > range ? why("out of range: %d > %d", d, range) : why("no clear line to the cell");
	} else if (!ground && target != sd) {
		const int d = distance_bl(sd, target);
		if (!battle_check_range(sd, target, range))
			return d > range ? why("out of range: %d > %d", d, range) : why("no clear line to the target");
	}
	return why("rAthena refused it (the skill's own check when a cast begins)");
}

/// Where a walking unit will be `ms` from now: along the path it is on, at its speed (a
/// diagonal step costs 1.4). A unit standing still, or at the end of its path, is where it is.
/// Returns how many cells ahead that is.
static int cell_after(block_list *bl, int32 ms, int16 &x, int16 &y)
{
	x = bl->x;
	y = bl->y;
	const unit_data *ud = unit_bl2ud(bl);
	if (ud == nullptr || ud->walktimer == INVALID_TIMER || ms <= 0)
		return 0;
	const int speed = std::max(1, static_cast<int>(status_get_speed(bl)));
	int steps = 0;
	for (int i = ud->walkpath.path_pos; i < ud->walkpath.path_len; ++i) {
		const int dir = ud->walkpath.path[i];
		const int cost = (dir & 1) ? speed * 14 / 10 : speed;
		if (ms < cost)
			break;
		ms -= cost;
		x += dirx[dir];
		y += diry[dir];
		++steps;
	}
	return steps;
}

/// What the trace adds to an aimed cast: the cell, and how it was come by.
static std::string g_cast_note;

/// Aim: the cell a ground cast lands on. From the companion (or the target), aim_cells along
/// the line between the two; with Lead the target counts as where it will be when the cast
/// lands. A cell nobody can stand on is pulled back toward where the count began. A reason
/// when there is no such cell.
static const char *aim_cell(map_session_data *sd, const Rule &rule, block_list *target, uint16 id, uint16 lv,
	int16 &x, int16 &y)
{
	int16 tx = target->x, ty = target->y;
	const int led = rule.aim_lead ? cell_after(target, skill_castfix(sd, id, lv), tx, ty) : 0;
	x = tx;
	y = ty;
	char note[96] = "";
	if (rule.aim_cells > 0) {
		const int dx = tx - sd->x, dy = ty - sd->y;
		const int dist = std::max(std::abs(dx), std::abs(dy));
		if (dist == 0)
			return why("nowhere to aim: %s stands on its cell", status_get_name(*target));
		// k cells from the companion along the line; counted from the target, dist - cells.
		// Too close for the cell asked for: there is no such cell between the two.
		if (dist <= rule.aim_cells)
			return why("too close to aim %d cells %s: %s is %d away", static_cast<int>(rule.aim_cells),
				rule.aim_from_target ? "in front of it" : "toward it", status_get_name(*target), dist);
		int k = rule.aim_from_target ? dist - rule.aim_cells : rule.aim_cells;
		const int step = rule.aim_from_target ? 1 : -1; // back toward where the count began
		bool found = false;
		for (; k >= 1 && k <= dist; k += step) {
			x = static_cast<int16>(sd->x + (dx * k + (dx >= 0 ? dist / 2 : -(dist / 2))) / dist);
			y = static_cast<int16>(sd->y + (dy * k + (dy >= 0 ? dist / 2 : -(dist / 2))) / dist);
			if (map_getcell(sd->m, x, y, CELL_CHKPASS)) {
				found = true;
				break;
			}
		}
		if (!found)
			return why("no free cell to aim at %d cells %s", static_cast<int>(rule.aim_cells),
				rule.aim_from_target ? "in front of it" : "toward it");
		safesnprintf(note, sizeof(note), ", %d cells from itself, %d from %s", k, dist - k, led > 0 ? "where it will be" : "it");
	}
	char buf[160];
	if (led > 0)
		safesnprintf(buf, sizeof(buf), " at (%d,%d)%s, led %d cells", x, y, note, led);
	else
		safesnprintf(buf, sizeof(buf), " at (%d,%d)%s%s", x, y, note, rule.aim_lead ? ", not led (it stands still)" : "");
	g_cast_note = buf;
	return nullptr;
}

static const char *cast(Turn &t, const Rule &rule, block_list *target, uint16 id)
{
	g_cast_note.clear();
	map_session_data *sd = t.sd;
	const uint16 known = pc_checkskill(sd, id);
	const uint16 lv = rule.cast_lv > 0 ? std::min<uint16>(rule.cast_lv, known) : known;
	const int32 inf = skill_get_inf(id);
	if (inf & INF_SELF_SKILL)
		target = sd;
	if (target == nullptr)
		return "no target";
	// A combo step (Chain Combo, Combo Finish, ...) is meant for the previous step's after-cast
	// delay: rAthena opens SC_COMBO for exactly that long and checks the order itself
	// (skill_check_condition_castbegin). Waiting the delay out would always miss it.
	const bool combo_step = skill_is_combo(id) != 0 && sd->sc.getSCE(SC_COMBO) != nullptr;
	if (sd->ud.skilltimer != INVALID_TIMER)
		return nullptr; // busy casting: not a failure worth reporting
	if (!combo_step && (DIFF_TICK(t.tick, sd->ud.canact_tick) < 0 || DIFF_TICK(t.tick, sd->pop.skill_cd) < 0))
		return nullptr;
	if (skill_isNotOk(id, *sd)) {
		const auto cd = sd->scd.find(id);
		const TimerData *td = cd != sd->scd.end() ? get_timer(cd->second) : nullptr;
		if (td != nullptr)
			return why("on cooldown, %.1f s left", std::max<int64>(0, DIFF_TICK(td->tick, t.tick)) / 1000.0);
		return why("not allowed here or now (the map, a mount, or its global skill delay)");
	}
	if (!pop_skill_weapon_ok(sd, id))
		return why("the wrong weapon for it");
	if (!pop_skill_state_ok(sd, id, lv))
		return why_state(sd, id, lv);
	if (skill_get_sp(id, lv) > static_cast<int32>(sd->battle_status.sp))
		return why("not enough SP: needs %d, has %u", skill_get_sp(id, lv), sd->battle_status.sp);
	// Where a ground skill lands: the target's feet, or the cell Aim works out.
	int16 ax = target->x, ay = target->y;
	const bool aimed = rule.aim && (inf & INF_GROUND_SKILL) != 0 && target != sd;
	if (aimed) {
		if (const char *no_cell = aim_cell(sd, rule, target, id, lv, ax, ay); no_cell != nullptr)
			return no_cell;
	}
	if (const int range = skill_get_range2(sd, id, lv, true); aimed) {
		if (const int d = std::max(std::abs(sd->x - ax), std::abs(sd->y - ay)); d > range)
			return why("out of range: the cell is %d > %d", d, range);
	} else if (target != sd && !check_distance_bl(sd, target, range)) {
		return why("out of range: %d > %d", distance_bl(sd, target), range);
	}
	if (!status_check_skilluse(sd, target, id, 0)) {
		if (target->type != BL_PC && status_isdead(*target))
			return why("%s is dead", status_get_name(*target));
		const status_change *tsc = status_get_sc(target);
		if (tsc != nullptr && (tsc->option & (OPTION_HIDE | OPTION_CLOAK | OPTION_CHASEWALK | OPTION_INVISIBLE)) != 0)
			return why("%s is hidden", status_get_name(*target));
		return why("%s cannot be cast at now (its state: rAthena's status_check_skilluse)", status_get_name(*target));
	}
	if (inf & INF_GROUND_SKILL) {
		if (const char *taken = why_cell(sd, id, lv, ax, ay); taken != nullptr)
			return taken;
	}
	// Sanctuary heals the monsters standing in it unless they are undead or demons (the combat file).
	if ((inf & INF_GROUND_SKILL) && pop_ground_heal_helps_enemy(sd, id, ax, ay))
		return "it would heal a monster";
	const std::vector<std::pair<t_itemid, int32>> cost = rule.consume && kPayCatalysts
		? item_cost(id, lv) : std::vector<std::pair<t_itemid, int32>>();
	if (!can_pay(sd, cost))
		return why("a catalyst is missing");
	const bool ok = (inf & INF_GROUND_SKILL)
		? unit_skilluse_pos(sd, ax, ay, id, lv) != 0
		: unit_skilluse_id(sd, target->id, id, lv) != 0;
	if (!ok)
		return why_unit_refused(sd, target, id, lv, (inf & INF_GROUND_SKILL) != 0, ax, ay);
	// Paid when the cast starts, not when it lands: an interrupted cast still costs the stone.
	pay(sd, cost);
	// rAthena paces the next action itself: the cast timer (skilltimer) and the after-cast delay
	// (canact_tick), both after DEX, cards and Bragi, are checked above. Adding the skill's BASE
	// cast and delay on top made a Priest heal slower than a player could; only a short gap stays.
	const t_tick pace = static_cast<t_tick>(std::max(1, battle_config.population_engine_shell_attack_skill_delay_ms));
	sd->pop.skill_cd = t.tick + pace;
	sd->pop.last_cast_skill_id = id;
	return "";
}

/// Whether the walk the companion is on is one a rule started (hold_position marks it). A walk
/// the engine started -- following the owner -- is not the rule's, and must not count as the
/// rule having acted: that ended the turn without retreating.
static bool rule_walking(const Turn &t)
{
	return DIFF_TICK(t.tick, t.st->hold_until) < 0;
}

static const char *retreat(Turn &t, const Rule &rule, const RuleState &rs)
{
	map_session_data *sd = t.sd;
	// unit_walktoxy itself does not ask whether the unit may move: a petrified, frozen or
	// stunned shell was walked away. Players and monsters are checked before it; so are rules.
	if (!unit_can_move(sd))
		return nullptr;
	if (unit_is_walking(sd) && rule_walking(t))
		return ""; // already on its way; let it arrive
	if (rule.retreat == Retreat::Owner) {
		if (t.owner == nullptr)
			return "owner not here";
		if (check_distance_bl(sd, t.owner, 2))
			return "already beside the owner";
		if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:retreat_owner"))
			return nullptr;
		return unit_walktobl(sd, t.owner, 1, 0) ? "" : "no path";
	}
	block_list *from = same_map_bl(sd, rs.source);
	if (from == nullptr)
		from = t.enemy;
	if (from == nullptr)
		return "nothing to retreat from";
	const map_data *md = map_getmapdata(sd->m);
	if (md == nullptr)
		return "no map";
	const int sx = sd->x > from->x ? 1 : sd->x < from->x ? -1 : 0;
	const int sy = sd->y > from->y ? 1 : sd->y < from->y ? -1 : 0;
	for (int d = rule.distance; d >= 2; --d) {
		const int16 x = static_cast<int16>(cap_value(sd->x + sx * d, 0, md->xs - 1));
		const int16 y = static_cast<int16>(cap_value(sd->y + sy * d, 0, md->ys - 1));
		if (!map_getcell(sd->m, x, y, CELL_CHKPASS))
			continue;
		if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:retreat_away"))
			return nullptr;
		return unit_walktoxy(sd, x, y, 4) ? "" : "no path";
	}
	return "nowhere to go";
}

/// KeepDistance: nullptr when already far enough (the rule passes and the next one runs),
/// "" when it set off, or why it could not. Goes to the nearest open cell at least `keep`
/// cells from the monster, preferring the cells closest to where it stands.
static const char *keep_away(Turn &t, const Rule &rule, const RuleState &rs, block_list *about, block_list *target,
	bool &far_enough)
{
	map_session_data *sd = t.sd;
	far_enough = false;
	// unit_walktoxy itself does not ask whether the unit may move: a petrified, frozen or
	// stunned shell was walked away. Players and monsters are checked before it; so are rules.
	if (!unit_can_move(sd))
		return nullptr;
	// From an event's caster; else the rule's own pick (Target: { Enemy: boss } keeps a healer
	// away from the boss, Target: { Ally: attacked } keeps it within reach of whoever is hit);
	// else the current target.
	block_list *from = same_map_bl(sd, rs.source);
	if (from == nullptr)
		from = rule.sel.kind != Selector::Kind::None ? target : about;
	const int now_d = from != nullptr ? distance_bl(sd, from) : 0;
	const bool too_far = from != nullptr && rule.keep_max > 0 && now_d > rule.keep_max;
	if (from == nullptr || (now_d >= rule.keep_distance && !too_far)) {
		far_enough = true;
		return "";
	}
	if (unit_is_walking(sd) && rule_walking(t))
		return ""; // already on its way
	const map_data *md = map_getmapdata(sd->m);
	if (md == nullptr)
		return "no map";
	std::vector<std::tuple<int, int16, int16>> cells; // (distance from the shell, x, y)
	// Too close: the rings just past Min. Too far: the rings from Max down to Min.
	const int r_lo = rule.keep_distance;
	const int r_hi = rule.keep_max > 0 ? rule.keep_max : rule.keep_distance + 2;
	for (int r = r_lo; r <= r_hi; ++r) {
		for (int dx = -r; dx <= r; ++dx) {
			for (int dy = -r; dy <= r; ++dy) {
				if (std::max(std::abs(dx), std::abs(dy)) != r)
					continue;
				const int x = from->x + dx, y = from->y + dy;
				if (x < 0 || y < 0 || x >= md->xs || y >= md->ys || !map_getcell(sd->m, x, y, CELL_CHKPASS))
					continue;
				cells.emplace_back(std::max(std::abs(x - sd->x), std::abs(y - sd->y)), static_cast<int16>(x), static_cast<int16>(y));
			}
		}
	}
	std::sort(cells.begin(), cells.end());
	if (cells.empty())
		return "nowhere to go";
	if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:keep_distance"))
		return nullptr;
	// A cell behind a wall has no walkable path; try the next few rather than give up.
	for (size_t i = 0; i < cells.size() && i < 8; ++i)
		if (unit_walktoxy(sd, std::get<1>(cells[i]), std::get<2>(cells[i]), 4))
			return "";
	return "no path";
}

/// MoveTo: far_enough (the rule passes) when already there; "" when it set off; else why not.
/// MoveTo's Depth: of a field's cells, keep those at least `move_depth` cells inside its edge
/// (every cell that near is the field's too), so what lands beside the field does not reach.
/// A field too small for that keeps its deepest cells: the middle of a 3x3 is as far in as it goes.
static void keep_deep_cells(map_session_data *sd, const Rule &rule, std::vector<std::pair<int16, int16>> &cells)
{
	// The field can run on past Within: look that much further for what counts as inside.
	std::vector<std::pair<int16, int16>> all;
	field_units(sd, rule.move_skill, rule.move_owner,
		static_cast<int16>(std::min<int>(rule.move_within + 2 * rule.move_depth, 2 * AREA_SIZE)), &all);
	const std::set<std::pair<int16, int16>> field(all.begin(), all.end());
	auto depth = [&](const std::pair<int16, int16> &c) {
		int d = 0;
		for (; d < rule.move_depth; ++d) {
			const int r = d + 1;
			for (int dx = -r; dx <= r; ++dx)
				for (int dy = -r; dy <= r; ++dy)
					if (std::max(std::abs(dx), std::abs(dy)) == r
							&& field.count({ static_cast<int16>(c.first + dx), static_cast<int16>(c.second + dy) }) == 0)
						return d;
		}
		return d;
	};
	int best = 0;
	std::vector<std::pair<int, std::pair<int16, int16>>> ranked;
	for (const auto &c : cells) {
		ranked.emplace_back(depth(c), c);
		best = std::max(best, ranked.back().first);
	}
	cells.clear();
	for (const auto &r : ranked)
		if (r.first >= best)
			cells.push_back(r.second);
}

/// Whether a shot from (x, y) reaches `to` unhindered: rAthena's own test for a cast or an arrow
/// (battle_check_range's path_search_long over walls).
static bool clear_line(const map_session_data *sd, int16 x, int16 y, const block_list *to)
{
	return path_search_long(nullptr, sd->m, x, y, to->x, to->y, CELL_CHKWALL);
}

static const char *move_to(Turn &t, const Rule &rule, const RuleState &rs, block_list *about, block_list *target, bool &there)
{
	map_session_data *sd = t.sd;
	there = false;
	// unit_walktoxy itself does not ask whether the unit may move: a petrified, frozen or
	// stunned shell was walked away. Players and monsters are checked before it; so are rules.
	if (!unit_can_move(sd))
		return nullptr;
	if (rule.move == Move::Reachable) {
		// To the nearest cell the monster could fight back from, so hitting it there does not
		// make it teleport. A few dozen cells at most, nearest first.
		mob_data *md = about != nullptr && about->type == BL_MOB ? reinterpret_cast<mob_data *>(about) : nullptr;
		if (md == nullptr)
			return "no monster";
		if (mob_reaches(md, sd)) {
			there = true;
			return "";
		}
		if (unit_is_walking(sd))
			return "";
		const map_data *mapd = map_getmapdata(sd->m);
		if (mapd == nullptr)
			return "no map";
		std::vector<std::tuple<int, int16, int16>> cells;
		for (int dx = -8; dx <= 8; ++dx) {
			for (int dy = -8; dy <= 8; ++dy) {
				const int x = sd->x + dx, y = sd->y + dy;
				if ((dx == 0 && dy == 0) || x < 0 || y < 0 || x >= mapd->xs || y >= mapd->ys
						|| !map_getcell(sd->m, x, y, CELL_CHKPASS))
					continue;
				cells.emplace_back(std::max(std::abs(dx), std::abs(dy)), static_cast<int16>(x), static_cast<int16>(y));
			}
		}
		std::sort(cells.begin(), cells.end());
		if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:move_to"))
			return nullptr;
		size_t tried = 0;
		for (const auto &c : cells) {
			if (tried >= 24)
				break;
			++tried;
			if (mob_reaches_cell(md, std::get<1>(c), std::get<2>(c)) && unit_walktoxy(sd, std::get<1>(c), std::get<2>(c), 4))
				return "";
		}
		return "no reachable cell nearby";
	}
	if (rule.move == Move::Sight) {
		// To the nearest cell from which the rule's target is in the clear: a caster behind a
		// tree or a corner had every cast refused and stood there. Nearest first, so it steps
		// round the obstacle rather than across the field, and never further from the target
		// than Range, so the step does not take it out of its spell's reach.
		block_list *to = target != nullptr ? target : about;
		if (to == nullptr || to == sd)
			return nullptr;
		// In the clear and within Range: there. In the clear but further off (a first step that
		// only rounded the corner) is not yet where a cast can be made from.
		if (clear_line(sd, sd->x, sd->y, to) && distance_bl(sd, to) <= rule.move_range) {
			there = true;
			return "";
		}
		if (unit_is_walking(sd))
			return "";
		const map_data *mapd = map_getmapdata(sd->m);
		if (mapd == nullptr)
			return "no map";
		std::vector<std::tuple<int, int, int16, int16>> spots; // (steps from here, cells from the target, x, y)
		const int w = rule.move_within;
		for (int dx = -w; dx <= w; ++dx) {
			for (int dy = -w; dy <= w; ++dy) {
				const int x = sd->x + dx, y = sd->y + dy;
				if ((dx == 0 && dy == 0) || x < 0 || y < 0 || x >= mapd->xs || y >= mapd->ys
						|| !map_getcell(sd->m, x, y, CELL_CHKPASS))
					continue;
				const int far = std::max(std::abs(to->x - x), std::abs(to->y - y));
				if (far > rule.move_range || far < 1 || !clear_line(sd, static_cast<int16>(x), static_cast<int16>(y), to))
					continue;
				spots.emplace_back(std::max(std::abs(dx), std::abs(dy)), far, static_cast<int16>(x), static_cast<int16>(y));
			}
		}
		if (spots.empty())
			return "no cell nearby has a clear line to it";
		std::sort(spots.begin(), spots.end());
		if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:move_to"))
			return nullptr;
		for (size_t i = 0; i < spots.size() && i < 24; ++i)
			if (unit_walktoxy(sd, std::get<2>(spots[i]), std::get<3>(spots[i]), 4))
				return "";
		return "no path to a cell with a clear line";
	}
	std::vector<std::pair<int16, int16>> cells;
	if (rule.move == Move::EventUnit) {
		// To whoever the event is about (the companion that signalled, the member who spoke).
		block_list *who = same_map_bl(sd, rs.subject);
		if (who == nullptr)
			return "they are not here";
		if (check_distance_bl(sd, who, 1)) {
			there = true;
			return "";
		}
		if (unit_is_walking(sd) && sd->ud.target_to == who->id)
			return "";
		if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:move_to"))
			return nullptr;
		return unit_walktobl(sd, who, 1, 0) ? "" : "no path";
	}
	if (rule.move == Move::EventCell) {
		if (rs.cell_x < 0)
			return "no cell";
		cells.emplace_back(rs.cell_x, rs.cell_y);
	} else {
		field_units(sd, rule.move_skill, rule.move_owner, rule.move_within, &cells);
		if (cells.empty())
			return nullptr; // no such field right now: nothing to do, not a failure to report
		if (rule.move_depth > 0)
			keep_deep_cells(sd, rule, cells);
	}
	if (std::any_of(cells.begin(), cells.end(), [&](const auto &c) { return c.first == sd->x && c.second == sd->y; })) {
		there = true;
		return "";
	}
	if (unit_is_walking(sd))
		return ""; // already on its way
	std::sort(cells.begin(), cells.end(), [&](const auto &a, const auto &b) {
		const int da = std::max(std::abs(a.first - sd->x), std::abs(a.second - sd->y));
		const int db = std::max(std::abs(b.first - sd->x), std::abs(b.second - sd->y));
		return da != db ? da < db : a < b;
	});
	if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:move_to"))
		return nullptr;
	for (size_t i = 0; i < cells.size() && i < 8; ++i)
		if (map_getcell(sd->m, cells[i].first, cells[i].second, CELL_CHKPASS)
				&& unit_walktoxy(sd, cells[i].first, cells[i].second, 4))
			return "";
	return "no path";
}

/// Leave: clear (the rule passes) when not standing on such a unit; "" when it set off; else why not.
static const char *leave_ground(Turn &t, const Rule &rule, bool &clear)
{
	map_session_data *sd = t.sd;
	clear = false;
	// unit_walktoxy itself does not ask whether the unit may move: a petrified, frozen or
	// stunned shell was walked away. Players and monsters are checked before it; so are rules.
	if (!unit_can_move(sd))
		return nullptr;
	std::vector<std::pair<int16, int16>> units;
	// A little wider than the search, so a cell just past it is not taken for a free one.
	field_units(sd, rule.leave_skill, rule.leave_owner, static_cast<int16>(rule.leave_within + 2), &units);
	std::set<std::pair<int16, int16>> covered(units.begin(), units.end());
	if (covered.count(std::make_pair(sd->x, sd->y)) == 0) {
		clear = true;
		return "";
	}
	if (unit_is_walking(sd))
		return ""; // already on its way out
	const map_data *md = map_getmapdata(sd->m);
	if (md == nullptr)
		return "no map";
	std::vector<std::tuple<int, int16, int16>> cells; // (distance, x, y): nearest first
	for (int dx = -rule.leave_within; dx <= rule.leave_within; ++dx) {
		for (int dy = -rule.leave_within; dy <= rule.leave_within; ++dy) {
			const int x = sd->x + dx, y = sd->y + dy;
			if ((dx == 0 && dy == 0) || x < 0 || y < 0 || x >= md->xs || y >= md->ys)
				continue;
			if (covered.count(std::make_pair(static_cast<int16>(x), static_cast<int16>(y))) != 0
					|| !map_getcell(sd->m, x, y, CELL_CHKPASS))
				continue;
			cells.emplace_back(std::max(std::abs(dx), std::abs(dy)), static_cast<int16>(x), static_cast<int16>(y));
		}
	}
	if (cells.empty())
		return "nowhere free";
	std::sort(cells.begin(), cells.end());
	if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:leave"))
		return nullptr;
	for (size_t i = 0; i < cells.size() && i < 8; ++i)
		if (unit_walktoxy(sd, std::get<1>(cells[i]), std::get<2>(cells[i]), 4))
			return "";
	return "no path";
}

struct ChaserScan {
	int32 me;
	mob_data *nearest;
	int best_d;
	const block_list *center;
};

static int32 chaser_cb(block_list *bl, va_list ap)
{
	ChaserScan *scan = va_arg(ap, ChaserScan *);
	mob_data *md = reinterpret_cast<mob_data *>(bl);
	if (status_isdead(*md) || md->target_id != scan->me)
		return 0;
	const int d = distance_bl(scan->center, md);
	if (scan->nearest == nullptr || d < scan->best_d || (d == scan->best_d && md->id < scan->nearest->id)) {
		scan->nearest = md;
		scan->best_d = d;
	}
	return 0;
}

/// Kite: safe (the rule passes) when far enough from the monster and within the anchor's ring;
/// "" when it set off; else why not. Each step takes the reachable cell furthest from the monster
/// inside the ring around the anchor, so a monster that keeps chasing is led round the anchor --
/// the healer -- rather than onto it or away from it.
static const char *kite(Turn &t, const Rule &rule, block_list *anchor, block_list *about, bool &safe)
{
	map_session_data *sd = t.sd;
	safe = false;
	if (!unit_can_move(sd))
		return nullptr;
	if (anchor == nullptr)
		anchor = t.owner;
	if (anchor == nullptr || anchor == sd)
		return "nobody to stay near";
	ChaserScan scan{ sd->id, nullptr, 0, sd };
	map_foreachinrange(chaser_cb, sd, AREA_SIZE, BL_MOB, &scan);
	block_list *from = scan.nearest != nullptr ? static_cast<block_list *>(scan.nearest) : about;
	const int to_anchor = distance_bl(sd, anchor);
	const bool in_ring = to_anchor <= rule.kite_within && to_anchor >= rule.kite_gap;
	if (from == nullptr || (distance_bl(sd, from) >= rule.kite_away && in_ring)) {
		safe = true;
		return "";
	}
	if (unit_is_walking(sd) && in_ring)
		return ""; // on its way to a cell already chosen
	const map_data *md = map_getmapdata(sd->m);
	if (md == nullptr)
		return "no map";
	// (- distance from the monster, distance from here, x, y): the furthest from it first.
	std::vector<std::tuple<int, int, int16, int16>> cells;
	for (int dx = -6; dx <= 6; ++dx) {
		for (int dy = -6; dy <= 6; ++dy) {
			const int x = sd->x + dx, y = sd->y + dy;
			if ((dx == 0 && dy == 0) || x < 0 || y < 0 || x >= md->xs || y >= md->ys
					|| !map_getcell(sd->m, x, y, CELL_CHKPASS))
				continue;
			const int a = std::max(std::abs(x - anchor->x), std::abs(y - anchor->y));
			if (a > rule.kite_within || a < rule.kite_gap)
				continue;
			const int m = from != nullptr ? std::max(std::abs(x - from->x), std::abs(y - from->y)) : 0;
			cells.emplace_back(-m, std::max(std::abs(dx), std::abs(dy)), static_cast<int16>(x), static_cast<int16>(y));
		}
	}
	if (cells.empty())
		return "no room near them";
	std::sort(cells.begin(), cells.end());
	if (!population_shell_can_emit_movement(sd, MovementOwner::Combat, "strategy:kite"))
		return nullptr;
	for (size_t i = 0; i < cells.size() && i < 8; ++i)
		if (unit_walktoxy(sd, std::get<2>(cells[i]), std::get<3>(cells[i]), 4))
			return "";
	return "no path";
}

static bool requires_ok(const map_session_data *sd, const Requirements &req)
{
	if (req.base_level > 0 && static_cast<int32>(sd->status.base_level) < req.base_level)
		return false;
	if (req.roles != 0 && (req.roles & (1u << static_cast<uint8>(sd->pop.role))) == 0)
		return false;
	// A skill its owner unticked in the companion's skill selection counts as one it lacks:
	// every companion has its whole tree, so the selection is what tells two builds apart.
	for (const uint16 id : req.skills)
		if (pc_checkskill(sd, id) == 0 || !population_shell_skill_selected(sd, id))
			return false;
	for (const uint16 id : req.lacks)
		if (pc_checkskill(sd, id) > 0 && population_shell_skill_selected(sd, id))
			return false;
	for (const t_itemid id : req.items)
		if (pc_search_inventory(sd, id) < 0)
			return false;
	return true;
}

/// UseItem: the first item of the rule's list that is in the bag; 0 with none of them.
static t_itemid carried_item(const map_session_data *sd, const Rule &rule)
{
	for (const t_itemid id : rule.use_items)
		if (pc_search_inventory(const_cast<map_session_data *>(sd), id) >= 0)
			return id;
	return 0;
}

/// Whether a rule may cast this skill at all: the companion has it, and its owner has not
/// unticked it in the companion's skill selection (population_shell_skill_selected, the combat
/// file). That selection is a deliberate choice; a plan does not override it.
static bool may_cast(const map_session_data *sd, uint16 id)
{
	return pc_checkskill(const_cast<map_session_data *>(sd), id) > 0 && population_shell_skill_selected(sd, id);
}

static bool requires_ok(const map_session_data *sd, const Rule &rule)
{
	// Unlike the skill rotation, a rule never casts a skill the companion has not learned, nor
	// one its owner deselected.
	if (!rule.cast_options.empty()) {
		if (std::none_of(rule.cast_options.begin(), rule.cast_options.end(), [&](uint16 id) { return may_cast(sd, id); }))
			return false;
	} else if (rule.cast_skill != 0 && !may_cast(sd, rule.cast_skill)) {
		return false;
	}
	// UseItem: only what it carries. Without Companion inventory that is what the engine hands it.
	if (rule.use_item != 0 && carried_item(sd, rule) == 0)
		return false;
	return requires_ok(sd, rule.req);
}

/// A rule has placed the companion: following leaves it there for a moment (see
/// population_strategy_holds_position). Renewed every turn a positional rule acts.
static void hold_position(Turn &t)
{
	t.st->hold_until = t.tick + 600;
}

/// Whether a recruited companion's mode lets a rule pick `mob` itself, as the engine's own
/// targeting does (population_strategy_target): Passive picks no monster, Defensive only one
/// already in the party's fight -- the owner's target, or one hitting a party member.
static bool mode_allows_enemy(const Turn &t, const block_list *mob)
{
	map_session_data *sd = t.sd;
	if (mob == nullptr || mob->type != BL_MOB || !population_engine_is_recruited_companion(sd))
		return true;
	if (sd->pop.companion_mode == PopulationCompanionMode::Attack)
		return true;
	if (sd->pop.companion_mode == PopulationCompanionMode::Passive)
		return false;
	const mob_data *md = reinterpret_cast<const mob_data *>(mob);
	const unit_data *owner_ud = t.owner != nullptr ? unit_bl2ud(t.owner) : nullptr;
	return (owner_ud != nullptr && owner_ud->target == md->id) || (md->target_id != 0 && is_party(sd, md->target_id));
}

/// Sit: true. The checks a player's sit request passes (clif_parse_ActionRequest_sub), and the
/// calls the engine's own rest makes (pop_shell_rest). Never while its owner walks: a sitting
/// companion cannot follow. True when it sits now.
static bool sit_down(Turn &t)
{
	map_session_data *sd = t.sd;
	// Never while its owner walks, sitting or not: the follow code stands it up to follow.
	if (t.owner != nullptr && unit_is_walking(t.owner))
		return false;
	if (pc_issit(sd)) {
		// Already sitting, by this rule or by the engine's rest: either way, it stays down.
		return true;
	}
	if (pc_isdead(sd) || sd->ud.skilltimer != INVALID_TIMER
			|| (sd->sc.opt1 && sd->sc.opt1 != OPT1_STONEWAIT && sd->sc.opt1 != OPT1_BURNING)
			|| sd->sc.getSCE(SC_DANCING)
			|| (sd->sc.getSCE(SC_GRAVITATION) && sd->sc.getSCE(SC_GRAVITATION)->val3 == BCT_SELF)
			|| (sd->state.block_action & PCBLOCK_SITSTAND))
		return false;
	if (unit_is_walking(sd))
		unit_stop_walking(sd, USW_FIXPOS);
	unit_stop_attack(sd);
	sd->pop.companion_formation_active = false;
	pc_setsit(sd);
	skill_sit(sd, true);
	clif_sitting(*sd);
	t.st->sat = true;
	return true;
}

/// Stand up a companion a Sit rule sat down, the way a player's client does (pop_shell_stand).
/// One the engine's own rest sat down is left to the rest.
static void rise(Turn &t)
{
	map_session_data *sd = t.sd;
	if (!t.st->sat)
		return;
	t.st->sat = false;
	if (pc_issit(sd) && pc_setstand(sd, false)) {
		skill_sit(sd, false);
		clif_standing(*sd);
	}
}

/// UseItem: one of `nameid` from the bag, the player's own path (pc_useitem: the item's delay, its
/// job and level limits, its script, one taken). False when rAthena refuses it.
static bool use_item(Turn &t, t_itemid nameid, block_list *target)
{
	map_session_data *sd = t.sd;
	const int16 idx = pc_search_inventory(sd, nameid);
	// Not into a cast under way: an item's own cast would lose the item it is paid with.
	if (idx < 0 || pc_isdead(sd) || sd->ud.skilltimer != INVALID_TIMER)
		return false;
	const int32 had = sd->inventory.u.items_inventory[idx].amount;
	if (!pc_useitem(sd, idx))
		return false;
	// An item that casts a skill (a converter, a Fly Wing, a scroll) only arms it: the client
	// answers with the cast, and rAthena takes the item when that cast goes through. A shell has
	// no client, so the cast is made here: on itself, or for a skill that needs one, on the
	// rule's target (a helping skill never on a monster, a harming one never on the party).
	if (sd->skillitem != 0) {
		const uint16 id = sd->skillitem, lv = sd->skillitemlv;
		const int32 inf = skill_get_inf(id);
		block_list *at = sd;
		if (!(inf & INF_SELF_SKILL) && target != nullptr && (target->type == BL_MOB) != ((inf & INF_SUPPORT_SKILL) != 0))
			at = target;
		const bool harms = (inf & (INF_ATTACK_SKILL | INF_GROUND_SKILL)) != 0 && !(inf & INF_SELF_SKILL);
		const bool ok = !(harms && at == sd && (inf & INF_ATTACK_SKILL))
			&& ((inf & INF_GROUND_SKILL) ? unit_skilluse_pos(sd, at->x, at->y, id, lv) : unit_skilluse_id(sd, at->id, id, lv)) != 0;
		if (!ok) {
			sd->skillitem = sd->skillitemlv = 0; // disarmed: nothing was cast, nothing is taken
			return false;
		}
	}
	// The use animation for everyone around, which clif_useitemack sends only to a session.
	if (!session_isActive(sd->fd)) {
		PACKET_ZC_USE_ITEM_ACK p = {};
		p.packetType = useItemAckType;
		p.index = idx + 2;
#if PACKETVER >= 3
		const t_itemid view = itemdb_viewid(nameid);
		p.itemId = static_cast<decltype(p.itemId)>(view > 0 ? view : nameid);
		p.AID = sd->id;
#endif
		p.amount = had - 1;
		p.result = true;
		clif_send(&p, sizeof(p), sd, AREA_WOS);
	}
	return true;
}

static Outcome run_rule(Turn &t, const Rule &rule, const Plan &plan, PlanState &ps, bool do_skills, bool attack_only)
{
	map_session_data *sd = t.sd;
	RuleState &rs = t.st->rules[rule.uid];
	if (!requires_ok(sd, rule) || DIFF_TICK(t.tick, rs.cooldown_until) < 0)
		return Outcome::Skipped;
	if (rule.event != Event::None && DIFF_TICK(t.tick, rs.pending_until) >= 0)
		return Outcome::Skipped;
	if ((rule.instrategy_below >= 0 || rule.instrategy_atleast >= 0)
			&& !threshold_ok(static_cast<int32>(std::min<int64>(DIFF_TICK(t.tick, ps.entered), INT32_MAX)),
				rule.instrategy_below, rule.instrategy_atleast))
		return Outcome::Skipped;
	if (rule.infight_below >= 0 || rule.infight_atleast >= 0) {
		const ShellState &st = *t.st;
		const bool fighting = st.fight_since != 0 && DIFF_TICK(t.tick, st.last_engaged) <= 5000;
		const int32 in_fight = fighting ? static_cast<int32>(std::min<int64>(DIFF_TICK(t.tick, st.fight_since), INT32_MAX)) : 0;
		if (!threshold_ok(in_fight, rule.infight_below, rule.infight_atleast))
			return Outcome::Skipped;
	}
	if (rule.charge_sc >= 0 && !threshold_ok(status_charges(sd, rule.charge_sc, rule.charge_val), rule.charge_below, rule.charge_atleast))
		return Outcome::Skipped;
	if (rule.field_skill != 0 && !rule.field_at_target
			&& !threshold_ok(field_units(sd, rule.field_skill, rule.field_owner, rule.field_range),
			rule.field_below, rule.field_atleast))
		return Outcome::Skipped;

	// A rule that only picks a target has nothing left to do once a higher one has picked.
	if (rule.set_target && t.target_set && rule.cast_skill == 0 && rule.say.empty() && rule.signal.empty()
			&& rule.switch_to.empty())
		return Outcome::Skipped;
	int range = AREA_SIZE;
	if (rule.cast_skill != 0) {
		range = 1;
		for (const uint16 id : rule.cast_options.empty() ? std::vector<uint16>{ rule.cast_skill } : rule.cast_options) {
			const uint16 lv = pc_checkskill(sd, id);
			if (lv > 0)
				range = std::max(range, skill_get_range2(sd, id, lv, true));
		}
	}
	t.claim = rule.claim.empty() ? nullptr : &rule.claim;   // selectors pass over claimed targets
	t.claim_passed = t.claim_holder = 0;
	block_list *target = resolve_target(t, rule, rs, range);
	t.claim = nullptr;
	// A fixed target (the current one, an event's) that another companion has claimed: not this rule.
	if (!rule.claim.empty() && target != nullptr && target != sd
			&& claimed_by_other(sd, rule.claim, target->id, t.tick, &t.claim_holder)) {
		t.claim_passed = target->id;
		target = nullptr;
	}
	if (target == nullptr && t.claim_passed != 0) {
		// Without this line, a rule that found every target claimed looks like one that never fires.
		char cbuf[16];
		block_list *passed = map_id2bl(t.claim_passed);
		const map_session_data *holder = map_id2sd(t.claim_holder);
		trace(sd, *t.st, t.tick, "rule %s: %s is claimed (%s) by %s", label(rule, cbuf, sizeof(cbuf)),
			passed != nullptr ? status_get_name(*passed) : "its target", rule.claim.c_str(),
			holder != nullptr ? holder->status.name : "another companion");
		return Outcome::Skipped;
	}
	// A monster the rule picked itself: the companion's mode decides, as for the engine's own
	// choice. (The current target, t.enemy, already went through it.)
	if (rule.sel.kind == Selector::Kind::Enemy && target != nullptr && !mode_allows_enemy(t, target)) {
		trace(sd, *t.st, t.tick, "rule %s: %s left alone (companion mode)", rule.name.c_str(), status_get_name(*target));
		return Outcome::Skipped;
	}
	if (rule.cast_skill != 0 && target == nullptr && !(skill_get_inf(rule.cast_skill) & INF_SELF_SKILL))
		return Outcome::Skipped;
	if ((rule.sel.kind != Selector::Kind::None || rule.set_target) && target == nullptr)
		return Outcome::Skipped; // a selector that finds no one: the rule does not apply

	// The monster the rule is about: its selector's, or the current target.
	block_list *about = rule.sel.kind == Selector::Kind::Enemy ? target : t.enemy;
	if (rule.field_at_target) {
		if (about == nullptr && target == nullptr)
			return Outcome::Skipped;
		block_list *center = target != nullptr ? target : about;
		if (!threshold_ok(field_units(sd, rule.field_skill, rule.field_owner, rule.field_range, nullptr, center),
				rule.field_below, rule.field_atleast))
			return Outcome::Skipped;
	}
	for (const Selector *gate : { &rule.absent, &rule.present }) {
		if (gate->kind == Selector::Kind::None)
			continue;
		const int r = gate->range > 0 ? gate->range : AREA_SIZE;
		const block_list *found = gate->kind == Selector::Kind::Ally ? select_ally(t, *gate, r) : select_enemy(t, *gate, r);
		if ((found != nullptr) != (gate == &rule.present))
			return Outcome::Skipped;
	}
	if (rule.has_count) {
		block_list *center = rule.count_around_target ? (target != nullptr ? target : about) : sd;
		if (center == nullptr || !threshold_ok(count_enemies(t, rule.count_sel, center, rule.count_range),
				rule.count_below, rule.count_atleast))
			return Outcome::Skipped;
	}
	if (!rule.enemy_elements.empty() || !rule.enemy_races.empty() || !rule.enemy_sizes.empty() || rule.enemy_boss >= 0) {
		if (about == nullptr)
			return Outcome::Skipped;
		auto in = [](const std::vector<int32> &v, int32 x) { return v.empty() || std::find(v.begin(), v.end(), x) != v.end(); };
		if (!in(rule.enemy_elements, status_get_element(about)) || !in(rule.enemy_races, status_get_race(about))
				|| !in(rule.enemy_sizes, status_get_size(about)))
			return Outcome::Skipped;
		if (rule.enemy_boss >= 0 && (status_get_class_(about) == CLASS_BOSS) != (rule.enemy_boss == 1))
			return Outcome::Skipped;
	}
	if (rule.reach >= 0) {
		mob_data *md = about != nullptr && about->type == BL_MOB ? reinterpret_cast<mob_data *>(about) : nullptr;
		// Reach: false is "hitting it from here would be answered": out of its reach, and it has a
		// rudeattacked skill for the state it is in. Reach: true is only the first half.
		if (md == nullptr || (rule.reach == 1 ? !mob_reaches(md, sd) : (mob_reaches(md, sd) || !mob_answers_rude(md, sd))))
			return Outcome::Skipped;
	}

	if (rule.when) {
		expanded_ai::TargetBag bag;
		bag.shell = sd;
		// With Target: { Enemy: ... }, enemy_* tokens ask about the chosen monster.
		bag.enemy = rule.sel.kind == Selector::Kind::Enemy ? target : t.enemy;
		// ally_* and master_* tokens ask about the rule's own target and the owner.
		block_list *ally = target != nullptr && target->type == BL_PC && target != sd ? target : same_map_bl(sd, rs.subject);
		bag.bls[static_cast<size_t>(expanded_ai::ExpTarget::Ally)] = ally;
		bag.bls[static_cast<size_t>(expanded_ai::ExpTarget::Master)] = t.owner;
		if (!(*rule.when)(bag))
			return Outcome::Skipped;
	}

	const int32 claim_on = target != nullptr ? target->id : 0;
	const auto claim_key = std::make_tuple(sd->status.party_id, rule.uid, claim_on);
	if (rule.one_per_party) {
		const auto it = g_claims.find(claim_key);
		if (it != g_claims.end() && it->second.first != sd->id && DIFF_TICK(t.tick, it->second.second) < 0)
			return Outcome::Skipped;
	}

	char buf[16];
	const char *name = label(rule, buf, sizeof(buf));
	bool acted = false;
	// Every action but Sit needs the companion on its feet: a sitting character can neither
	// move (unit_can_move) nor act.
	if (!rule.sit && (rule.cast_skill != 0 || rule.retreat != Retreat::None || rule.hold || rule.keep_distance > 0
			|| rule.move != Move::None || rule.leave || rule.kite)
			&& !(rule.cast_skill != 0 && (!do_skills || attack_only)))
		rise(t);
	if (rule.cast_skill != 0) {
		if (!do_skills || attack_only)
			return Outcome::Skipped;
		const uint16 skill = rule.cast_options.empty() ? rule.cast_skill : best_against(sd, rule, target, t.plans);
		if (skill == 0) {
			trace(sd, *t.st, t.tick, "rule %s: nothing in its Cast list can be cast (SP, Allow, or the target resists them all)", name);
			return Outcome::Skipped;
		}
		if (t.plans != nullptr && !plans_allow(sd, *t.plans, skill, true)) {
			trace(sd, *t.st, t.tick, "rule %s: %s not cast (another plan's Ban)", name, skill_get_desc(skill));
			return Outcome::Skipped;
		}
		// An instant cast can kill the target, and a monster with no spawn entry (a slave, a
		// summon) is freed as it dies, before cast() returns: hold ids across it, never pointers.
		const int32 target_id = target != nullptr ? target->id : 0;
		const int32 enemy_id = t.enemy != nullptr ? t.enemy->id : 0;
		const char *why = cast(t, rule, target, skill);
		target = target_id != 0 ? map_id2bl(target_id) : nullptr;
		t.enemy = enemy_id != 0 ? map_id2bl(enemy_id) : nullptr;
		if (why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: %s not cast (%s)", name, skill_get_desc(skill), why);
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: %s on %s%s (SP %u/%u)", name, skill_get_desc(skill),
			target != nullptr ? status_get_name(*target) : target_id != 0 ? "a target now gone" : "self",
			g_cast_note.c_str(), sd->battle_status.sp, sd->battle_status.max_sp);
		acted = true;
	} else if (rule.use_item != 0) {
		const int32 enemy_id = t.enemy != nullptr ? t.enemy->id : 0;
		const int32 target_id = target != nullptr ? target->id : 0;
		const t_itemid nameid = carried_item(sd, rule);
		const bool used = nameid != 0 && use_item(t, nameid, target);
		// An item's script can do anything a skill can (a Fly Wing moves the companion).
		target = target_id != 0 ? map_id2bl(target_id) : nullptr;
		t.enemy = enemy_id != 0 ? same_map_bl(sd, enemy_id) : nullptr;
		if (!used) {
			trace(sd, *t.st, t.tick, "rule %s: %s not used (its delay, its job or level limit, the companion's state, or no target for what it casts)",
				name, nameid != 0 ? itemdb_name(nameid) : "the item");
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: used %s", name, itemdb_name(nameid));
		acted = true;
	} else if (rule.retreat != Retreat::None) {
		const char *why = retreat(t, rule, rs);
		if (why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: no retreat (%s)", name, why);
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: retreat %s", name, rule.retreat == Retreat::Owner ? "to owner" : "away");
		acted = true;
	} else if (rule.leave) {
		bool clear = false;
		const char *why = leave_ground(t, rule, clear);
		if (clear || why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: cannot leave (%s)", name, why);
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: leaving %s", name, rule.leave_skill ? skill_get_desc(rule.leave_skill) : "hostile ground");
		acted = true;
	} else if (rule.move != Move::None) {
		bool there = false;
		const char *why = move_to(t, rule, rs, about, target, there);
		if (there && rule.move != Move::Reachable && rule.move != Move::Sight)
			hold_position(t); // standing where the rule wants it: following must not walk it off
		if (there || why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: cannot move (%s)", name, why);
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: moving to %s", name, rule.move == Move::EventCell ? "the cast's cell"
			: rule.move == Move::EventUnit ? "them" : rule.move == Move::Reachable ? "where it can reach"
			: rule.move == Move::Sight ? "a clear line" : skill_get_desc(rule.move_skill));
		acted = true;
	} else if (rule.kite) {
		bool safe = false;
		const char *why = kite(t, rule, target != nullptr && target->type == BL_PC ? target : nullptr, about, safe);
		if (safe || why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: cannot kite (%s)", name, why);
			return Outcome::Skipped;
		}
		trace(sd, *t.st, t.tick, "rule %s: kiting", name);
		acted = true;
	} else if (rule.keep_distance > 0) {
		bool far_enough = false;
		const char *why = keep_away(t, rule, rs, about, target, far_enough);
		if (far_enough || why == nullptr)
			return Outcome::Skipped;
		if (*why != '\0') {
			trace(sd, *t.st, t.tick, "rule %s: cannot keep distance (%s)", name, why);
			return Outcome::Skipped;
		}
		if (rule.keep_max > 0)
			trace(sd, *t.st, t.tick, "rule %s: keeping %d to %d cells away", name, rule.keep_distance, rule.keep_max);
		else
			trace(sd, *t.st, t.tick, "rule %s: keeping %d cells away", name, rule.keep_distance);
		acted = true;
	} else if (rule.sit) {
		if (!sit_down(t)) {
			trace(sd, *t.st, t.tick, "rule %s: cannot sit now", name);
			return Outcome::Skipped;
		}
		t.sitting = true;
		trace(sd, *t.st, t.tick, "rule %s: sit (SP %u/%u, HP %u/%u)", name, sd->battle_status.sp,
			sd->battle_status.max_sp, sd->battle_status.hp, sd->battle_status.max_hp);
		acted = true;
	} else if (rule.hold) {
		// Stand still: no chase, no walk toward the target. A continuous attack command
		// would chase it too, so that goes as well.
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		if (sd->ud.attacktimer != INVALID_TIMER || sd->ud.state.attack_continue)
			unit_stop_attack(sd);
		trace(sd, *t.st, t.tick, "rule %s: hold", name);
		acted = true;
	}

	if (acted && rule.cast_skill == 0 && rule.use_item == 0)
		hold_position(t); // Retreat, KeepDistance, MoveTo, Leave, Hold, Sit
	if (rule.set_target && target != nullptr && target->type == BL_MOB && !t.target_set) {
		t.target_set = true;
		// Held for a few seconds and renewed while the rule applies; population_strategy_target
		// keeps it over the party controller's choice.
		t.st->forced_target = target->id;
		t.st->forced_until = t.tick + 3000;
		if (sd->pop.target_id != target->id) {
			population_shell_target_change(sd, target->id);
			trace(sd, *t.st, t.tick, "rule %s: target %s", name, status_get_name(*target));
		}
	}
	if (!rule.say.empty())
		say(t, rule, rs, target);
	if (!rule.signal.empty() && sd->status.party_id > 0) {
		std::deque<SignalLine> &sigs = g_signals[sd->status.party_id];
		sigs.push_back({ ++g_signal_seq, t.tick, sd->id, rule.signal });
		while (sigs.size() > 32)
			sigs.pop_front();
		trace(sd, *t.st, t.tick, "rule %s: signal %s", name, rule.signal.c_str());
	}
	bool switched = false;
	if (!rule.switch_to.empty() && rule.switch_to != ps.active
			&& plan.strategies.find(rule.switch_to) != plan.strategies.end()) {
		trace(sd, *t.st, t.tick, "rule %s: strategy %s -> %s", name, ps.active.empty() ? "(none)" : ps.active.c_str(),
			rule.switch_to.c_str());
		ps.active = rule.switch_to;
		ps.entered = t.tick;
		switched = true;
	}

	rs.pending_until = 0; // the event has been answered
	if (rule.cooldown_ms > 0)
		rs.cooldown_until = t.tick + static_cast<t_tick>(rule.cooldown_ms);
	if (rule.one_per_party)
		g_claims[claim_key] = std::make_pair(sd->id, t.tick + static_cast<t_tick>(std::max<uint32>(rule.cooldown_ms, 3000)));
	if (acted && !rule.claim.empty() && claim_on != 0 && claim_on != sd->id && sd->status.party_id > 0)
		g_named_claims[std::make_tuple(sd->status.party_id, rule.claim, claim_on)]
			= std::make_pair(sd->id, t.tick + static_cast<t_tick>(rule.claim_ms));
	if (acted)
		return Outcome::Acted;
	return switched ? Outcome::Switched : Outcome::Done;
}

struct Candidate {
	const Rule *rule;
	const Plan *plan;
	PlanState *state;
};

/// Whether a shell runs strategy rules: a recruited companion, or a regular combat shell when a
/// plan is For: shells or all (arena fighters have their own turn and never reach here).
static bool takes_part(const map_session_data *sd)
{
	if (sd == nullptr)
		return false;
	if (population_engine_is_recruited_companion(sd))
		return true;
	return g_db.for_shells && population_engine_is_population_pc(sd->id) && sd->pop.arena_team == 0;
}


static int32 boss_scan_cb(block_list *bl, va_list ap)
{
	auto *found = va_arg(ap, std::vector<mob_data *> *);
	mob_data *md = reinterpret_cast<mob_data *>(bl);
	if (!status_isdead(*md) && md->status.class_ == CLASS_BOSS)
		found->push_back(md);
	return 0;
}

static int32 encounter_scan_cb(block_list *bl, va_list ap)
{
	auto *found = va_arg(ap, std::vector<mob_data *> *);
	mob_data *md = reinterpret_cast<mob_data *>(bl);
	if (!status_isdead(*md) && g_db.encounter.count(md->mob_id) != 0)
		found->push_back(md);
	return 0;
}

/// The plans that apply, most specific first: the monster it targets, then the encounter
/// monsters near it (the nearest of each kind), then its race and element, then Boss (the
/// boss it targets, else the nearest), then All; within each, this job before its family before its 1st class before
/// All, and the builds the companion meets before the plan for every build ("" sorts first
/// in the table, so it is taken last).
static std::vector<PlanRef> plans_for(const map_session_data *sd, const block_list *enemy)
{
	std::vector<std::pair<uint32, int32>> mobs; // (mob id, instance)
	const mob_data *target = enemy != nullptr && enemy->type == BL_MOB ? reinterpret_cast<const mob_data *>(enemy) : nullptr;
	if (target != nullptr)
		mobs.emplace_back(target->mob_id, target->id);
	auto nearest_first = [&](std::vector<mob_data *> &found) {
		std::sort(found.begin(), found.end(), [&](const mob_data *a, const mob_data *b) {
			const int da = distance_bl(sd, a), db = distance_bl(sd, b);
			return da != db ? da < db : a->id < b->id;
		});
	};
	if (!g_db.encounter.empty()) {
		std::vector<mob_data *> found;
		map_foreachinrange(encounter_scan_cb, sd, AREA_SIZE, BL_MOB, &found);
		nearest_first(found);
		for (const mob_data *md : found)
			if (std::none_of(mobs.begin(), mobs.end(), [&](const auto &m) { return m.first == md->mob_id; }))
				mobs.emplace_back(md->mob_id, md->id);
	}
	// A race or an element: of the monster it fights, or with none, of the nearest one on the
	// party (a Priest seldom has a target of its own). Both fields first, then each alone.
	const uint8 me = population_engine_is_recruited_companion(sd) ? 1 : 2;
	if (g_db.category_plans & me) {
		const mob_data *about = target != nullptr && !status_isdead(*target) ? target : nullptr;
		if (about == nullptr) {
			MobScan scan;
			map_foreachinrange(mob_scan_cb, sd, AREA_SIZE, BL_MOB, &scan);
			std::vector<mob_data *> found;
			for (mob_data *md : scan.mobs)
				if (md->target_id != 0 && is_party(sd, md->target_id))
					found.push_back(md);
			nearest_first(found);
			if (!found.empty())
				about = found.front();
		}
		if (about != nullptr) {
			block_list *bl = const_cast<mob_data *>(about);
			const int32 race = status_get_race(bl), element = status_get_element(bl);
			for (const uint32 key : { category_key(race, element), category_key(race, -1), category_key(-1, element) })
				mobs.emplace_back(key, about->id);
		}
	}
	if (g_db.boss_plans & me) {
		if (target != nullptr && target->status.class_ == CLASS_BOSS && !status_isdead(*target)) {
			mobs.emplace_back(kBossMobs, target->id);
		} else {
			std::vector<mob_data *> found;
			map_foreachinrange(boss_scan_cb, sd, AREA_SIZE, BL_MOB, &found);
			nearest_first(found);
			if (!found.empty())
				mobs.emplace_back(kBossMobs, found.front()->id);
		}
	}
	mobs.emplace_back(kAllMobs, 0);

	std::vector<PlanRef> out;
	const bool companion = population_engine_is_recruited_companion(sd);
	auto for_me = [&](const Plan &plan) {
		return plan.audience == Audience::All || (plan.audience == Audience::Companions) == companion;
	};
	const int32 job = sd->status.class_;
	int32 family = job_family(job, sd->status.sex);
	if (family < 0) // none: -1 would read as kAllJobs
		family = job;
	const int32 base = population_engine_job_base_class(sd->status.class_);
	for (const auto &m : mobs) {
		for (const int32 j : { job, family, base, kAllJobs }) {
			const Plan *every_build = nullptr;
			PlanKey every_key;
			for (auto it = g_db.plans.lower_bound(PlanKey(m.first, j, std::string())); it != g_db.plans.end()
					&& std::get<0>(it->first) == m.first && std::get<1>(it->first) == j; ++it) {
				if (!for_me(it->second)
						|| std::any_of(out.begin(), out.end(), [&](const PlanRef &p) { return p.plan == &it->second; }))
					continue; // not for this kind of shell, or the same key twice (job == base)
				if (it->second.exact && j != job && j != family)
					continue; // Exact: not for a class built on this one
				if (std::get<2>(it->first).empty()) {
					every_build = &it->second;
					every_key = it->first;
				} else if (requires_ok(sd, it->second.req)) {
					out.push_back({ it->first, &it->second, m.second });
				}
			}
			if (every_build != nullptr)
				out.push_back({ every_key, every_build, m.second });
		}
	}
	return out;
}

/// Why a monster the companion was fighting is gone: dead (or removed), or alive somewhere it
/// cannot be fought from here (teleported, out of sight, another map).
static bool gone_died(const map_session_data *sd, int32 instance, bool &gone)
{
	const mob_data *md = map_id2md(instance);
	if (md == nullptr || status_isdead(*md)) {
		gone = true;
		return true;
	}
	gone = md->m != sd->m || !check_distance_bl(sd, md, AREA_SIZE);
	return false;
}

/// encounter_ended / target_lost: compare with what the last turn saw. After a gap (the
/// companion had no turns) it starts again from what it sees now rather than report stale changes.
static void track_fight(Turn &t, const std::vector<PlanRef> &plans)
{
	ShellState &st = *t.st;
	map_session_data *sd = t.sd;
	const bool baseline = st.last_seen == 0 || DIFF_TICK(t.tick, st.last_seen) > 2000;
	st.last_seen = t.tick;

	std::vector<std::pair<uint32, int32>> now;
	for (const PlanRef &p : plans) {
		const uint32 mob = std::get<0>(p.key);
		uint32 kind = mob;
		if (mob == kBossMobs) { // a Boss plan's boss is an encounter too, under its own id
			const mob_data *md = map_id2md(p.instance);
			kind = md != nullptr ? md->mob_id : 0;
		} else if (g_db.encounter.count(mob) == 0) {
			kind = 0;
		}
		if (kind != 0 && p.instance != 0
				&& std::find(now.begin(), now.end(), std::make_pair(kind, p.instance)) == now.end())
			now.emplace_back(kind, p.instance);
	}
	auto record = [&](Event kind, uint32 mob, int32 instance, bool died) {
		st.occurrences.push_back({ ++g_occurrence_seq, t.tick, kind, mob, instance, died, st.last_bosses.count(instance) != 0 });
		while (!st.occurrences.empty()
				&& (st.occurrences.size() > 16 || DIFF_TICK(t.tick, st.occurrences.front().tick) > 10000))
			st.occurrences.pop_front();
	};
	if (!baseline) {
		for (const auto &e : st.last_encounters) {
			if (std::find(now.begin(), now.end(), e) != now.end())
				continue;
			bool gone = false;
			const bool died = gone_died(sd, e.second, gone);
			if (died || gone) // still here: a Boss plan only turned to a nearer boss
				record(Event::EncounterEnded, e.first, e.second, died);
		}
		if (st.last_target != 0 && st.last_target != sd->pop.target_id) {
			bool gone = false;
			const bool died = gone_died(sd, st.last_target, gone);
			if (died || gone) // a target the companion simply switched away from is not lost
				record(Event::TargetLost, st.last_target_mob, st.last_target, died);
		}
	}
	st.last_encounters = std::move(now);
	st.last_target = sd->pop.target_id;
	const mob_data *md = st.last_target != 0 ? map_id2md(st.last_target) : nullptr;
	st.last_target_mob = md != nullptr ? md->mob_id : 0;
	// Boss or not is asked once the monster is gone, and a dead one cannot be asked: note it now.
	st.last_bosses.clear();
	if (md != nullptr && md->status.class_ == CLASS_BOSS)
		st.last_bosses.insert(md->id);
	for (const auto &e : st.last_encounters) {
		const mob_data *em = map_id2md(e.second);
		if (em != nullptr && em->status.class_ == CLASS_BOSS)
			st.last_bosses.insert(em->id);
	}
}

} // namespace pop_strategy

// ---------------------------------------------------------------------------
// The engine's entry points
// ---------------------------------------------------------------------------

using namespace pop_strategy;

bool population_strategy_load()
{
	reset_runtime();
	const bool ok = g_db.load();
	ShowStatus("Population engine: population_strategy.yml loaded (%zu rules).\n", g_db.rule_count);
	return ok;
}

bool population_strategy_reload()
{
	reset_runtime();
	return g_db.reload();
}

void population_strategy_final()
{
	reset_runtime();
	g_db.clear();
}

size_t population_strategy_rule_count()
{
	return g_db.rule_count;
}

bool population_strategy_turn(map_session_data *sd, t_tick tick, bool do_skills, bool attack_only)
{
	if (g_db.rule_count == 0 || !takes_part(sd))
		return false;
	prune(tick);

	block_list *enemy = same_map_bl(sd, sd->pop.target_id);
	const auto plans = plans_for(sd, enemy);
	if (plans.empty()) {
		const auto it = g_shells.find(sd->id);
		if (it != g_shells.end() && it->second.sat) { // no plan, no Sit rule: up again
			Turn up{ sd, nullptr, enemy, tick, &it->second };
			rise(up);
		}
		return false;
	}

	Turn t{ sd, population_engine_companion_loot_owner(sd), enemy, tick, &shell_state(sd, tick) };
	t.plans = &plans;
	track_fight(t, plans);
	// InFight: a fight begins when the companion has a target, or a plan about a monster applies,
	// after at least 5 s without either; it ends 5 s after the last.
	if (sd->pop.target_id != 0
			|| std::any_of(plans.begin(), plans.end(), [](const PlanRef &p) { return std::get<0>(p.key) != kAllMobs; })) {
		if (t.st->fight_since == 0 || DIFF_TICK(tick, t.st->last_engaged) > 5000)
			t.st->fight_since = tick;
		t.st->last_engaged = tick;
	}

	// Every plan keeps its own active strategy. A monster's plan starts over with each
	// new monster of that kind (an encounter plan: with each new boss, not each new target);
	// an All plan keeps its strategy until a rule switches it.
	std::vector<std::pair<const Plan *, PlanState *>> states;
	for (const PlanRef &p : plans) {
		PlanState &ps = t.st->plans[p.key];
		if (!ps.started || (std::get<0>(p.key) != kAllMobs && ps.fight != p.instance)) {
			ps.started = true;
			ps.active = p.plan->start;
			ps.fight = p.instance;
			ps.entered = tick;
		}
		states.emplace_back(p.plan, &ps);
	}

	// A Switch takes effect in the same turn; three in a row is a loop, not a plan.
	for (int pass = 0; pass < 3; ++pass) {
		// Disable: a plan (or its active strategy) puts other plans' rules of that name aside.
		std::vector<std::pair<const std::string *, const Plan *>> off;
		for (auto &s : states) {
			for (const std::string &n : s.first->disable)
				off.emplace_back(&n, s.first);
			const auto it = s.first->strategies.find(s.second->active);
			if (it != s.first->strategies.end())
				for (const std::string &n : it->second.disable)
					off.emplace_back(&n, s.first);
		}
		auto disabled = [&](const Rule &r, const Plan *plan) {
			return std::any_of(off.begin(), off.end(), [&](const auto &o) { return o.second != plan && *o.first == r.name; });
		};
		std::vector<Candidate> list;
		for (auto &s : states) {
			for (const RulePtr &r : s.first->rules)
				if (!disabled(*r, s.first))
					list.push_back({ r.get(), s.first, s.second });
			const auto it = s.first->strategies.find(s.second->active);
			if (it != s.first->strategies.end())
				for (const RulePtr &r : it->second.rules)
					if (!disabled(*r, s.first))
						list.push_back({ r.get(), s.first, s.second });
		}
		// Priority first; ties keep the more specific plan, then file order.
		std::stable_sort(list.begin(), list.end(),
			[](const Candidate &a, const Candidate &b) { return a.rule->priority > b.rule->priority; });

		// Events are looked at before anything acts, so a rule behind one that acts every
		// turn still sees its event happen.
		for (const Candidate &c : list)
			if (c.rule->event != Event::None)
				poll_event(t, *c.rule, t.st->rules[c.rule->uid]);

		bool switched = false;
		for (const Candidate &c : list) {
			const Outcome o = run_rule(t, *c.rule, *c.plan, *c.state, do_skills, attack_only);
			if (o == Outcome::Acted)
				return true;
			if (o == Outcome::Switched) {
				switched = true;
				break;
			}
		}
		if (!switched) {
			if (!t.sitting)
				rise(t); // no Sit rule applies any more
			return false;
		}
	}
	if (!t.sitting)
		rise(t);
	return false;
}

bool population_strategy_handles_resurrection(map_session_data *sd)
{
	if (!g_db.revives || !takes_part(sd))
		return false;
	// A plan that revives with its own rule (and the skill to cast it) does it its own way --
	// typically behind a Safety Wall -- and the engine's immediate attempt would cut across it.
	for (const PlanRef &p : plans_for(sd, same_map_bl(sd, sd->pop.target_id))) {
		auto revives = [&](const std::vector<RulePtr> &rules) {
			return std::any_of(rules.begin(), rules.end(), [&](const RulePtr &r) {
				// requires_ok(sd, *r): the skill known and not deselected by the owner, or the
				// engine's own Resurrection must not stand aside for a rule that cannot cast.
				return (r->cast_skill == ALL_RESURRECTION || r->cast_skill == WM_DEADHILLHERE) && requires_ok(sd, *r);
			});
		};
		if (revives(p.plan->rules))
			return true;
		// Only the strategy the companion is in now (or will start in): a revive rule kept
		// for a later phase must not stand the engine's own revive aside in this one.
		const std::string *active = &p.plan->start;
		const auto shell = g_shells.find(sd->id);
		if (shell != g_shells.end()) {
			const auto ps = shell->second.plans.find(p.key);
			if (ps != shell->second.plans.end() && ps->second.started
					&& (std::get<0>(p.key) == kAllMobs || ps->second.fight == p.instance))
				active = &ps->second.active;
		}
		const auto it = p.plan->strategies.find(*active);
		if (it != p.plan->strategies.end() && revives(it->second.rules))
			return true;
	}
	return false;
}

bool population_strategy_keeps_seated(const map_session_data *sd)
{
	if (g_db.rule_count == 0 || sd == nullptr || !pc_issit(sd))
		return false;
	const auto it = g_shells.find(sd->id);
	return it != g_shells.end() && it->second.char_id == sd->status.char_id && it->second.sat;
}

bool population_strategy_holds_position(const map_session_data *sd, t_tick tick)
{
	if (g_db.rule_count == 0 || sd == nullptr)
		return false;
	const auto it = g_shells.find(sd->id);
	return it != g_shells.end() && it->second.char_id == sd->status.char_id
		&& DIFF_TICK(tick, it->second.hold_until) < 0;
}

namespace pop_strategy {

/// The active strategy of one of a companion's plans, if it has one.
static const Strategy *active_strategy(const map_session_data *sd, const PlanRef &p)
{
	const auto st = g_shells.find(sd->id);
	if (st == g_shells.end() || st->second.char_id != sd->status.char_id)
		return nullptr;
	const auto ps = st->second.plans.find(p.key);
	if (ps == st->second.plans.end())
		return nullptr;
	const auto it = p.plan->strategies.find(ps->second.active);
	return it != p.plan->strategies.end() ? &it->second : nullptr;
}

/// Whether every plan that applies lets the companion use this skill: no Ban (the plan's, or its
/// active strategy's) may name it, and -- for what the engine casts on its own -- each Allow must
/// list it. A rule is an explicit decision, so Allow does not bind rules; another plan's Ban does.
/// A plan never stops a skill its own rules cast.
static bool plans_allow(const map_session_data *sd, const std::vector<PlanRef> &plans, uint16 skill, bool by_rule)
{
	if (!g_db.limits_skills)
		return true;
	for (const PlanRef &p : plans) {
		const Plan &plan = *p.plan;
		if (std::binary_search(plan.own.begin(), plan.own.end(), skill))
			continue;
		const Strategy *active = active_strategy(sd, p);
		if (!by_rule && plan.has_allow && !std::binary_search(plan.allow.begin(), plan.allow.end(), skill))
			return false;
		if (!by_rule && active != nullptr && active->has_allow
				&& !std::binary_search(active->allow.begin(), active->allow.end(), skill))
			return false;
		if (std::find(plan.ban.begin(), plan.ban.end(), skill) != plan.ban.end())
			return false;
		if (active != nullptr && std::find(active->ban.begin(), active->ban.end(), skill) != active->ban.end())
			return false;
	}
	return true;
}

/// The plans for a companion and target, kept for the rest of the tick: the engine asks once
/// per skill it considers, and the plans cannot change within one tick.
static const std::vector<PlanRef> &plans_this_tick(map_session_data *sd, block_list *target)
{
	static int32 cached_id = 0, cached_target = 0;
	static t_tick cached_tick = 0;
	static uint32 cached_generation = 0;
	static std::vector<PlanRef> cached;
	const t_tick now = gettick();
	const int32 target_id = target != nullptr ? target->id : 0;
	if (cached_id != sd->id || cached_tick != now || cached_target != target_id || cached_generation != g_generation) {
		cached = plans_for(sd, target);
		cached_id = sd->id;
		cached_tick = now;
		cached_target = target_id;
		cached_generation = g_generation;
	}
	return cached;
}

} // namespace pop_strategy

bool population_strategy_skill_allowed(map_session_data *sd, block_list *target, uint16 skill_id)
{
	if (!g_db.limits_skills || !takes_part(sd))
		return true;
	return plans_allow(sd, plans_this_tick(sd, target), skill_id, false);
}

bool population_strategy_attack_allowed(map_session_data *sd)
{
	if (!g_db.limits_attack || !takes_part(sd))
		return true;
	// The most specific plan that says anything decides: a boss's strategy that allows a plain
	// hit for a moment overrides "casters never melee" from Mob: All.
	for (const PlanRef &p : plans_this_tick(sd, map_id2bl(sd->pop.target_id))) {
		const Strategy *active = active_strategy(sd, p);
		const int8 attack = active != nullptr && active->attack >= 0 ? active->attack : p.plan->attack;
		if (attack >= 0)
			return attack != 0;
	}
	return true;
}

bool population_strategy_rotation_allows(map_session_data *sd, block_list *target, uint16 skill_id)
{
	if (!g_db.limits_rotation || !takes_part(sd))
		return true;
	const std::vector<PlanRef> &cached = plans_this_tick(sd, target);
	if (!plans_allow(sd, cached, skill_id, false))
		return false;
	// Rotation layers: a plan (or its active strategy) that says false wins; else one that says
	// true; else the default, which is off while a plan about a particular monster applies. So
	// a boss's plan that says nothing leaves the decision to a role plan that does.
	bool said_true = false, about_monster = false;
	for (const PlanRef &p : cached) {
		int8 rotation = p.plan->rotation;
		if (is_particular(std::get<0>(p.key)))
			about_monster = true;
		const Strategy *active = active_strategy(sd, p);
		if (active != nullptr && active->rotation >= 0)
			rotation = active->rotation;
		if (rotation == 0)
			return false;
		said_true = said_true || rotation > 0;
	}
	return said_true || !about_monster;
}

uint32 population_strategy_target(map_session_data *sd, map_session_data *owner, uint32 desired)
{
	// SetTarget: a rule chose this monster; it wins until it expires, dies or is out of reach.
	if (g_db.rule_count > 0 && sd != nullptr && owner != nullptr && population_engine_is_recruited_companion(sd)
			&& sd->pop.companion_mode != PopulationCompanionMode::Passive) {
		const auto it = g_shells.find(sd->id);
		if (it != g_shells.end() && it->second.char_id == sd->status.char_id && it->second.forced_target != 0) {
			ShellState &st = it->second;
			const mob_data *md = map_id2md(st.forced_target);
			if (DIFF_TICK(gettick(), st.forced_until) < 0 && md != nullptr && md->m == sd->m && !status_isdead(*md)
					&& !at_cap(sd, owner, md)
					&& (population_shell_check_target(sd, md->id) || population_shell_check_target_for_movement(sd, md->id)))
				return static_cast<uint32>(st.forced_target);
			st.forced_target = 0;
		}
	}
	if (g_db.targeting.empty() || sd == nullptr || owner == nullptr || !population_engine_is_recruited_companion(sd)
			|| sd->pop.companion_mode == PopulationCompanionMode::Passive)
		return desired;

	const unit_data *owner_ud = unit_bl2ud(owner);
	const uint32 owner_target = owner_ud != nullptr && owner_ud->target > 0 ? static_cast<uint32>(owner_ud->target) : 0;
	auto targeting = [](const mob_data *md) {
		const auto it = g_db.targeting.find(md->mob_id);
		return it != g_db.targeting.end() ? it->second : Targeting();
	};
	// Whatever the owner fights, or what is hitting the party, is never ignored.
	auto pressing = [&](const mob_data *md) {
		return md->id == static_cast<int32>(owner_target) || (md->target_id != 0 && is_party(sd, md->target_id));
	};

	const mob_data *cur = desired != 0 ? map_id2md(static_cast<int32>(desired)) : nullptr;
	bool dropped = false;
	if (cur != nullptr && ((targeting(cur).ignore && !pressing(cur)) || at_cap(sd, owner, cur))) {
		desired = 0;
		dropped = true;
	}
	if (desired == 0 && !dropped)
		return 0; // the controller found nothing to do; Priority never starts a fight

	const int32 floor = cur != nullptr && !dropped ? targeting(cur).priority : INT32_MIN;
	uint32 best = 0;
	int32 best_prio = floor;
	int best_d = INT32_MAX;
	for (const auto &entry : sd->pop.mob_tracker.tracked_mobs) {
		const mob_data *md = map_id2md(static_cast<int32>(entry.second.mob_id));
		if (md == nullptr || md->m != owner->m || status_isdead(*md) || !check_distance_bl(owner, md, 12))
			continue;
		const Targeting tg = targeting(md);
		if ((tg.ignore && !pressing(md)) || at_cap(sd, owner, md))
			continue;
		// Defensive companions only take monsters already in the party's fight.
		if (sd->pop.companion_mode != PopulationCompanionMode::Attack && !pressing(md))
			continue;
		if (!population_shell_check_target(sd, md->id) && !population_shell_check_target_for_movement(sd, md->id))
			continue;
		const int d = distance_bl(owner, md);
		if (tg.priority > best_prio || (tg.priority == best_prio && best != 0 && (d < best_d || (d == best_d && static_cast<uint32>(md->id) < best)))) {
			best = static_cast<uint32>(md->id);
			best_prio = tg.priority;
			best_d = d;
		}
	}
	if (best != 0 && (dropped || best_prio > floor))
		return best;
	return desired;
}

void population_strategy_on_party_chat(map_session_data *from_sd, const char *message)
{
	if (g_db.rule_count == 0 || from_sd == nullptr || message == nullptr || from_sd->status.party_id <= 0)
		return;
	std::string text = lower(message);
	while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back())))
		text.pop_back();

	// "<companion name> trace": its owner turns its trace on or off.
	static const std::string suffix = " trace";
	if (text.size() > suffix.size() && text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0) {
		const std::string who = text.substr(0, text.size() - suffix.size());
		const party_data *p = party_search(from_sd->status.party_id);
		for (int i = 0; p != nullptr && i < MAX_PARTY; ++i) {
			map_session_data *m = p->data[i].sd;
			if (m == nullptr || !population_engine_is_recruited_companion(m) || lower(m->status.name) != who
					|| m->pop.companion_owner_account != from_sd->status.account_id
					|| m->pop.companion_owner_char != from_sd->status.char_id)
				continue;
			ShellState &st = shell_state(m, gettick());
			st.trace = !st.trace;
			st.tracer_char = 0;
			st.last_trace.clear();
			char reply[CHAT_SIZE_MAX];
			safesnprintf(reply, sizeof(reply), "[%s] strategy trace %s.", m->status.name, st.trace ? "on" : "off");
			clif_displaymessage(from_sd->fd, reply);
			return;
		}
		// Not a companion of theirs: a regular shell in sight by that name, if shells have plans.
		if (g_db.for_shells) {
			struct NameScan { const std::string *who; map_session_data *found; } scan{ &who, nullptr };
			map_foreachinrange([](block_list *bl, va_list ap) -> int32 {
				NameScan *n = va_arg(ap, NameScan *);
				map_session_data *m = BL_CAST(BL_PC, bl);
				if (n->found == nullptr && m != nullptr && population_engine_is_population_pc(m->id)
						&& !population_engine_is_recruited_companion(m) && lower(m->status.name) == *n->who)
					n->found = m;
				return 0;
			}, from_sd, AREA_SIZE, BL_PC, &scan);
			if (scan.found != nullptr) {
				ShellState &st = shell_state(scan.found, gettick());
				st.trace = !st.trace;
				st.tracer_char = st.trace ? from_sd->status.char_id : 0;
				st.last_trace.clear();
				char reply[CHAT_SIZE_MAX];
				safesnprintf(reply, sizeof(reply), "[%s] strategy trace %s.", scan.found->status.name, st.trace ? "on" : "off");
				clif_displaymessage(from_sd->fd, reply);
				return;
			}
		}
	}

	if (!g_db.uses_chat)
		return;
	const t_tick tick = gettick();
	std::deque<ChatLine> &lines = g_chat[from_sd->status.party_id];
	lines.push_back({ ++g_chat_seq, tick, from_sd->id, from_sd->status.account_id, from_sd->status.char_id,
		party_isleader(from_sd), text });
	while (!lines.empty() && (lines.size() > 32 || DIFF_TICK(tick, lines.front().tick) > 10000))
		lines.pop_front();
}
