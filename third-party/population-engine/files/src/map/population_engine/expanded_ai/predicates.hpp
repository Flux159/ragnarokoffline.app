// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine — Leaf predicates for ExpandedCondition trees.
//
// Each predicate evaluates one fact about a target slot in the TargetBag.
// All predicates respect an `inverted` flag so the parser can collapse the
// `not_` prefix into the leaf without an extra wrapper class.
//
// Phase 1 set:
//   - LegacyPredicate     — defers to population_shell_skill_condition_ok so every
//                           existing PopSkillCondition token (self_targeted,
//                           enemy_hidden, hp_below, …) is usable inside trees.
//   - StatusPredicate     — `<target>_<scname>` (boolean status check).
//   - NumericPredicate    — `<target>_(hp|sp|hp_pct|sp_pct|distance|range)_<cmp><n>`.
#pragma once

#include "expanded_condition.hpp"

#include <cstdint>
#include <string>

#include <common/cbasetypes.hpp>

#include "../../map.hpp"        // block_list, sc_type
#include "../../pc.hpp"         // map_session_data
#include "../../status.hpp"     // status_get_sc, sc_type, status_get_hp
#include "../../battle.hpp"     // battle_check_target

// Forward decl in GLOBAL namespace — defined in population_engine_combat.cpp.
// Must NOT be inside namespace expanded_ai or the mangled name won't match.
bool population_shell_skill_condition_ok(
	map_session_data* sd,
	uint8_t condition, uint8_t cond_value_num, int16_t cond_sc_resolved,
	block_list* target_bl);

namespace expanded_ai {

enum class Cmp : uint8_t { Lt, Le, Gt, Ge, Eq };

inline bool cmp_eval(Cmp c, int lhs, int rhs) {
	switch (c) {
	case Cmp::Lt: return lhs <  rhs;
	case Cmp::Le: return lhs <= rhs;
	case Cmp::Gt: return lhs >  rhs;
	case Cmp::Ge: return lhs >= rhs;
	case Cmp::Eq: return lhs == rhs;
	}
	return false;
}

inline bool cmp_from_str(const std::string& s, Cmp& out) {
	if (s == "lt") { out = Cmp::Lt; return true; }
	if (s == "le") { out = Cmp::Le; return true; }
	if (s == "gt") { out = Cmp::Gt; return true; }
	if (s == "ge") { out = Cmp::Ge; return true; }
	if (s == "eq") { out = Cmp::Eq; return true; }
	return false;
}

/// Resolve a TargetBag slot to a block_list. Returns nullptr if the slot is
/// empty (e.g. Enemy when the shell has no target).
inline block_list* resolve_bl(const TargetBag& bag, ExpTarget t) {
	switch (t) {
	case ExpTarget::Self:   return bag.shell ? static_cast<block_list*>(bag.shell) : nullptr;
	case ExpTarget::Enemy:  return bag.enemy;
	case ExpTarget::Ally:   return bag.bls[static_cast<size_t>(ExpTarget::Ally)];
	case ExpTarget::Master: return bag.bls[static_cast<size_t>(ExpTarget::Master)];
	default: return nullptr;
	}
}

// ----------------------------------------------------------------------------
// Adapter for legacy PopSkillCondition tokens (so the entire flat enum is
// available inside expanded trees with zero re-implementation).
// ----------------------------------------------------------------------------
// (Forward declaration of population_shell_skill_condition_ok lives at the
// top of this file, in the global namespace, so its mangled name resolves
// against the definition in population_engine_combat.cpp.)

class LegacyPredicate : public ExpandedCondition {
public:
	LegacyPredicate(uint8_t cond, uint8_t v, int16_t sc, bool inverted)
		: cond_(cond), v_(v), sc_(sc), inv_(inverted) {}

	bool operator()(const TargetBag& bag) const override {
		if (!bag.shell) return false;
		const bool r = ::population_shell_skill_condition_ok(bag.shell, cond_, v_, sc_, bag.enemy);
		return inv_ ? !r : r;
	}

private:
	uint8_t  cond_;
	uint8_t  v_;
	int16_t  sc_;
	bool     inv_;
};

// ----------------------------------------------------------------------------
// Boolean status check: `<target>_<scname>` (e.g. self_hiding, enemy_stun).
// ----------------------------------------------------------------------------
class StatusPredicate : public ExpandedCondition {
public:
	StatusPredicate(ExpTarget t, sc_type sc, bool inverted)
		: t_(t), sc_(sc), inv_(inverted) {}

	bool operator()(const TargetBag& bag) const override {
		block_list* bl = resolve_bl(bag, t_);
		if (!bl) return inv_;  // missing target counts as "no, doesn't have it"
		const status_change* sc = status_get_sc(bl);
		const bool has = (sc != nullptr && sc->getSCE(sc_) != nullptr);
		return inv_ ? !has : has;
	}

private:
	ExpTarget t_;
	sc_type   sc_;
	bool      inv_;
};

// ----------------------------------------------------------------------------
// Numeric predicate: HP%, SP%, raw HP/SP, or distance, with comparator+value.
// ----------------------------------------------------------------------------
enum class NumKind : uint8_t { HpPct, SpPct, Hp, Sp, Distance };

class NumericPredicate : public ExpandedCondition {
public:
	NumericPredicate(ExpTarget t, NumKind k, Cmp cmp, int value, bool inverted)
		: t_(t), kind_(k), cmp_(cmp), val_(value), inv_(inverted) {}

	bool operator()(const TargetBag& bag) const override {
		block_list* bl = resolve_bl(bag, t_);
		if (!bl) return inv_;
		int lhs = 0;
		switch (kind_) {
		case NumKind::HpPct: {
			const int max = status_get_max_hp(bl);
			if (max <= 0) return inv_;
			lhs = static_cast<int>(static_cast<int64>(status_get_hp(bl)) * 100 / max);
			break;
		}
		case NumKind::SpPct: {
			const int max = status_get_max_sp(bl);
			if (max <= 0) return inv_;
			lhs = static_cast<int>(static_cast<int64>(status_get_sp(bl)) * 100 / max);
			break;
		}
		case NumKind::Hp:       lhs = status_get_hp(bl); break;
		case NumKind::Sp:       lhs = status_get_sp(bl); break;
		case NumKind::Distance: {
			block_list* sbl = bag.shell ? static_cast<block_list*>(bag.shell) : nullptr;
			if (!sbl || bl->m != sbl->m) return inv_;
			lhs = distance_bl(sbl, bl);
			break;
		}
		}
		const bool r = cmp_eval(cmp_, lhs, val_);
		return inv_ ? !r : r;
	}

	static bool kind_from_str(const std::string& s, NumKind& out) {
		if (s == "hp_pct")   { out = NumKind::HpPct;    return true; }
		if (s == "sp_pct")   { out = NumKind::SpPct;    return true; }
		if (s == "hp")       { out = NumKind::Hp;       return true; }
		if (s == "sp")       { out = NumKind::Sp;       return true; }
		if (s == "distance") { out = NumKind::Distance; return true; }
		return false;
	}

private:
	ExpTarget t_;
	NumKind   kind_;
	Cmp       cmp_;
	int       val_;
	bool      inv_;
};

} // namespace expanded_ai
