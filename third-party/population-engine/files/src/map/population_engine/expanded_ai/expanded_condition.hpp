// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine — Expanded AI Conditions framework.
// Lets `Condition:` in population_skill_db.yml be a boolean tree of predicates
// joined by AND/OR/NAND/NOR/XOR/NXOR gates instead of a single flat token.
//
// Inspired by Singe-Horizontal's "Expanded AI Conditions" patch (2022) but
// scoped to the population engine and the map_session_data data model.
//
// Lifecycle: parsed once during population_skill_db YAML load, stored as
// std::shared_ptr<ExpandedCondition> on s_pop_skill_entry / runtime skill
// structs. Evaluated every skill-pick tick via operator()(sd, target).
#pragma once

#include <array>
#include <cstdint>

class map_session_data;
struct block_list;

namespace expanded_ai {

/// Which side of the engagement a predicate is asking about.
/// Not every predicate honours every target — distance/HP only make sense
/// against an enemy or ally; status checks work on all four.
enum class ExpTarget : uint8_t {
	Self    = 0, ///< The shell itself (always available).
	Enemy   = 1, ///< Current combat target (may be nullptr → predicate fails).
	Ally    = 2, ///< Resolved lazily by the predicate (foreachinrange).
	Master  = 3, ///< Reserved (homunc/merc owner). Not used by population shells.
	_Count  = 4,
};

/// Bag of pre-resolved block_list pointers handed to every predicate.
/// Self+Enemy are populated by the caller; Ally/Master stay nullptr and the
/// predicate that needs them does the lookup itself (so we don't pay the
/// foreachinrange cost when no predicate asks for an ally).
struct TargetBag {
	map_session_data*                                              shell  = nullptr;
	block_list*                                                    enemy  = nullptr;
	std::array<block_list*, static_cast<size_t>(ExpTarget::_Count)> bls   {};
};

/// Abstract base for one node in an expanded-condition tree.
/// Subclasses: SingleCondition (leaf predicate), ConditionContainer (gate).
class ExpandedCondition {
public:
	virtual ~ExpandedCondition() = default;
	/// Evaluate this node against the given context.
	virtual bool operator()(const TargetBag& bag) const = 0;
};

} // namespace expanded_ai
