// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine — YAML parser for ExpandedCondition trees.
//
// Public entry point:
//   std::shared_ptr<ExpandedCondition> parse_expanded_condition(const ryml::NodeRef& node);
//
// Grammar reminder:
//   scalar          → leaf token  (e.g. "self_hiding", "not_enemy_stun", "self_hp_pct_lt50")
//   sequence        → AND of child nodes
//   map             → AND of (gate(child_seq) for each gate-key in map)
//                     where gate-key ∈ {AND,OR,NAND,NOR,XOR,NXOR} (case-insensitive)
//
// Token grammar:
//   [not_]<target>_<rest>
//     target ∈ {self,enemy,ally,master}
//     rest is parsed as either:
//       - exact legacy PopSkillCondition name → LegacyPredicate
//       - <numkind>_<cmp><digits>             → NumericPredicate
//       - <scname>                            → StatusPredicate
//
// On any parse failure we ShowError and return a "constant false" sentinel so
// the rotation skip the skill instead of crashing.

#include "expanded_parser.hpp"

#include "expanded_condition.hpp"
#include "logic_gates.hpp"
#include "predicates.hpp"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <common/showmsg.hpp>

#include "../../script.hpp"   // script_get_constant

namespace expanded_ai {

namespace {

// ----------------------------------------------------------------------------
// Sentinel: a leaf that always returns the same boolean. Used when a token
// fails to parse so the broken skill is permanently skipped instead of
// silently activating every tick.
// ----------------------------------------------------------------------------
class ConstantPredicate : public ExpandedCondition {
public:
	explicit ConstantPredicate(bool v) : v_(v) {}
	bool operator()(const TargetBag&) const override { return v_; }
private:
	bool v_;
};

// ----------------------------------------------------------------------------
// Legacy condition table (mirror of population_skill_db.cpp's s_cond_name_map).
// Kept inline here so the parser is self-contained — the legacy parser only
// uses its table at YAML load, and we need ours at YAML load too, so the
// duplication is one-time and harmless.
// ----------------------------------------------------------------------------
static const std::unordered_map<std::string, uint8_t> s_legacy_cond = {
	{ "always",               0  }, { "hp_below",             1  },
	{ "sp_below",             2  }, { "hp_above",             3  },
	{ "enemy_hp_below",       4  }, { "enemy_hp_above",       5  },
	{ "enemy_status",         6  }, { "not_enemy_status",     7  },
	{ "self_status",          8  }, { "not_self_status",      9  },
	{ "distance_below",       10 }, { "distance_above",       11 },
	{ "enemy_count_nearby",   12 }, { "map_zone",             13 },
	{ "melee_attacked",       14 }, { "range_attacked",       15 },
	{ "ally_hp_below",        16 }, { "ally_status",          17 },
	{ "not_ally_status",      18 }, { "has_sphere",           19 },
	{ "enemy_hidden",         20 }, { "enemy_casting",        21 },
	{ "enemy_casting_ground", 22 }, { "cell_has_skill_unit",  23 },
	{ "self_targeted",        24 }, { "enemy_element",        25 },
	{ "enemy_race",           26 }, { "ally_count_nearby",    27 },
	{ "enemy_is_boss",        28 }, { "sp_above",             29 },
	{ "self_being_cast_on",   31 },
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

inline std::string node_scalar(const ryml::NodeRef& n) {
	if (!n.has_val()) return {};
	return std::string(n.val().str, n.val().len);
}

inline std::string node_keystr(const ryml::NodeRef& n) {
	if (!n.has_key()) return {};
	return std::string(n.key().str, n.key().len);
}

inline void str_tolower(std::string& s) {
	for (char& c : s)
		c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
}

inline bool target_from_str(const std::string& s, ExpTarget& out) {
	if (s == "self")   { out = ExpTarget::Self;   return true; }
	if (s == "enemy")  { out = ExpTarget::Enemy;  return true; }
	if (s == "ally")   { out = ExpTarget::Ally;   return true; }
	if (s == "master") { out = ExpTarget::Master; return true; }
	return false;
}

/// Try to parse a comparator-and-value tail like "lt50", "ge100pct", "gt0".
/// On match: sets cmp/value/pct_flag and returns true.
inline bool try_parse_cmp_tail(const std::string& tail, Cmp& cmp, int& value) {
	if (tail.size() < 3) return false;
	const std::string head = tail.substr(0, 2);
	if (!cmp_from_str(head, cmp)) return false;
	std::string rest = tail.substr(2);
	// Allow optional trailing "pct" suffix (semantic hint; numeric value unchanged).
	if (rest.size() > 3 && rest.substr(rest.size() - 3) == "pct")
		rest = rest.substr(0, rest.size() - 3);
	if (rest.empty()) return false;
	for (char c : rest)
		if (!std::isdigit(static_cast<unsigned char>(c))) return false;
	value = std::atoi(rest.c_str());
	return true;
}

/// Resolve an SC name (e.g. "hiding", "stun") to sc_type via script_get_constant.
/// Tries lowercase as-is then uppercased with "SC_" prefix.
inline int16_t resolve_sc(const std::string& name) {
	if (name.empty()) return -1;
	int64_t cst = 0;
	if (script_get_constant(name.c_str(), &cst))
		return static_cast<int16_t>(cst);
	std::string up = "SC_";
	for (char c : name)
		up += static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
	if (script_get_constant(up.c_str(), &cst))
		return static_cast<int16_t>(cst);
	return -1;
}

// ----------------------------------------------------------------------------
// Parse a single scalar token into a leaf ExpandedCondition.
// Returns nullptr on failure (caller logs).
// ----------------------------------------------------------------------------
std::shared_ptr<ExpandedCondition> parse_token(std::string token) {
	str_tolower(token);
	if (token.empty()) return nullptr;

	// Step 1 — strip the optional `not_` prefix into an inverter flag.
	bool inv = false;
	if (token.size() > 4 && token.substr(0, 4) == "not_") {
		// Special-case: legacy tokens that already include "not_" in their
		// canonical name (e.g. "not_enemy_status"). Try the full string first.
		auto leg_full = s_legacy_cond.find(token);
		if (leg_full != s_legacy_cond.end())
			return std::make_shared<LegacyPredicate>(leg_full->second, 0, -1, /*inv*/false);
		inv = true;
		token = token.substr(4);
	}

	// Step 2 — exact legacy match (after `not_` stripping).
	{
		auto it = s_legacy_cond.find(token);
		if (it != s_legacy_cond.end())
			return std::make_shared<LegacyPredicate>(it->second, 0, -1, inv);
	}

	// Step 3 — split on `_`. First segment is target.
	std::vector<std::string> parts;
	{
		size_t prev = 0;
		for (size_t i = 0; i <= token.size(); ++i) {
			if (i == token.size() || token[i] == '_') {
				parts.emplace_back(token.substr(prev, i - prev));
				prev = i + 1;
			}
		}
	}
	if (parts.size() < 2) return nullptr;

	ExpTarget tgt;
	if (!target_from_str(parts[0], tgt)) return nullptr;

	// Step 4 — try to peel a comparator tail from the last segment.
	Cmp cmp{};
	int val = 0;
	bool has_cmp = false;
	if (parts.size() >= 3 && try_parse_cmp_tail(parts.back(), cmp, val)) {
		has_cmp = true;
		parts.pop_back();
	}

	// Step 5 — middle segments form the predicate name.
	std::string pred;
	for (size_t i = 1; i < parts.size(); ++i) {
		if (i > 1) pred += '_';
		pred += parts[i];
	}
	if (pred.empty()) return nullptr;

	// Special-case: <enemy|ally>_count_nearby_<cmp><N>
	// Legacy EnemyCountNearby/AllyCountNearby use `count >= CondValue` semantics,
	// so route through LegacyPredicate. We can express ge/gt/lt/le by adjusting
	// the threshold; eq is not expressible and is rejected.
	if (pred == "count_nearby" && (tgt == ExpTarget::Enemy || tgt == ExpTarget::Ally)) {
		if (!has_cmp) {
			ShowError("expanded_condition: '%s_count_nearby' requires a comparator (e.g. _ge2)\n",
				tgt == ExpTarget::Enemy ? "enemy" : "ally");
			return nullptr;
		}
		const uint8_t leg = (tgt == ExpTarget::Enemy)
			? /*EnemyCountNearby*/ 12
			: /*AllyCountNearby */ 27;
		// Translate `count <cmp> N` into legacy `count >= adj_v`, possibly inverted.
		int adj_v = val;
		bool extra_inv = false;
		switch (cmp) {
		case Cmp::Ge: adj_v = val;     extra_inv = false; break; // count >= N
		case Cmp::Gt: adj_v = val + 1; extra_inv = false; break; // count >= N+1
		case Cmp::Lt: adj_v = val;     extra_inv = true;  break; // !(count >= N)
		case Cmp::Le: adj_v = val + 1; extra_inv = true;  break; // !(count >= N+1)
		case Cmp::Eq:
			ShowError("expanded_condition: '%s_count_nearby_eqN' is not supported (use _ge with bracketing)\n",
				tgt == ExpTarget::Enemy ? "enemy" : "ally");
			return nullptr;
		}
		if (adj_v < 0) adj_v = 0;
		return std::make_shared<LegacyPredicate>(leg,
			static_cast<uint8_t>(adj_v), -1, inv != extra_inv);
	}

	// Numeric predicate?
	NumKind nk;
	if (NumericPredicate::kind_from_str(pred, nk)) {
		if (!has_cmp) {
			// Default: "exists with non-zero value" — treat as gt 0.
			cmp = Cmp::Gt;
			val = 0;
		}
		return std::make_shared<NumericPredicate>(tgt, nk, cmp, val, inv);
	}

	// Otherwise interpret as a status-name check.
	if (has_cmp) return nullptr;  // status check rejects comparators
	const int16_t sc = resolve_sc(pred);
	if (sc < 0) return nullptr;
	return std::make_shared<StatusPredicate>(tgt, static_cast<sc_type>(sc), inv);
}

// Forward
std::shared_ptr<ExpandedCondition> parse_node(const ryml::NodeRef& node);

/// Build a gate from a YAML sequence (the value of a gate-key map entry).
std::shared_ptr<ConditionContainer> build_gate(ConditionContainer::Gate g, const ryml::NodeRef& seq) {
	auto c = std::make_shared<ConditionContainer>(g);
	if (seq.is_seq()) {
		for (const auto& child : seq.children()) {
			auto sub = parse_node(child);
			if (sub) c->add(sub);
		}
	} else {
		// Tolerate single-child gates written as scalar/map without a wrapping seq.
		auto sub = parse_node(seq);
		if (sub) c->add(sub);
	}
	return c;
}

std::shared_ptr<ExpandedCondition> parse_node(const ryml::NodeRef& node) {
	// Scalar leaf
	if (node.has_val() && !node.is_seq() && !node.is_map()) {
		std::string tok = node_scalar(node);
		auto leaf = parse_token(tok);
		if (!leaf) {
			ShowError("population_skill_db: invalid expanded-condition token '%s'\n", tok.c_str());
			return std::make_shared<ConstantPredicate>(false);
		}
		return leaf;
	}

	// Sequence → implicit AND
	if (node.is_seq()) {
		auto c = std::make_shared<ConditionContainer>(ConditionContainer::Gate::And);
		for (const auto& child : node.children()) {
			auto sub = parse_node(child);
			if (sub) c->add(sub);
		}
		return c;
	}

	// Map → AND across each gate-key entry
	if (node.is_map()) {
		auto root = std::make_shared<ConditionContainer>(ConditionContainer::Gate::And);
		for (const auto& kv : node.children()) {
			std::string key = node_keystr(kv);
			ConditionContainer::Gate g;
			if (!ConditionContainer::name2gate(key, g)) {
				ShowError("population_skill_db: unknown gate '%s' in expanded condition\n", key.c_str());
				continue;
			}
			auto gate = build_gate(g, kv);
			if (gate && !gate->empty())
				root->add(gate);
		}
		return root;
	}

	return nullptr;
}

} // namespace

std::shared_ptr<ExpandedCondition> parse_expanded_condition(const ryml::NodeRef& node) {
	return parse_node(node);
}

} // namespace expanded_ai
