// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine — Logic gates for ExpandedCondition trees.
//
// Each gate owns a vector of children and combines their boolean results.
// AND/OR/NAND/NOR short-circuit; XOR/NXOR don't (they need full parity).
#pragma once

#include "expanded_condition.hpp"

#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace expanded_ai {

/// A gate node: holds children + the function that combines them.
class ConditionContainer : public ExpandedCondition {
public:
	enum class Gate : uint8_t { And, Or, Nand, Nor, Xor, Nxor };

	ConditionContainer(Gate g) : gate_(g) {}

	void add(std::shared_ptr<ExpandedCondition> child) {
		if (child) children_.push_back(std::move(child));
	}

	bool operator()(const TargetBag& bag) const override {
		switch (gate_) {
		case Gate::And:
			for (const auto& c : children_) if (!(*c)(bag)) return false;
			return true;
		case Gate::Or:
			for (const auto& c : children_) if ((*c)(bag)) return true;
			return false;
		case Gate::Nand:
			for (const auto& c : children_) if (!(*c)(bag)) return true;
			return false;
		case Gate::Nor:
			for (const auto& c : children_) if ((*c)(bag)) return false;
			return true;
		case Gate::Xor: {
			int true_count = 0;
			for (const auto& c : children_) if ((*c)(bag)) ++true_count;
			return true_count == 1;
		}
		case Gate::Nxor: {
			int true_count = 0;
			for (const auto& c : children_) if ((*c)(bag)) ++true_count;
			const int n = static_cast<int>(children_.size());
			return true_count == 0 || true_count == n;
		}
		}
		return false;
	}

	bool empty() const { return children_.empty(); }

	/// Resolve a YAML gate-key string (case-insensitive) to the enum.
	/// Returns false if the name is not a recognised gate.
	static bool name2gate(std::string name, Gate& out) {
		for (auto& c : name) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
		if (name == "and")  { out = Gate::And;  return true; }
		if (name == "or")   { out = Gate::Or;   return true; }
		if (name == "nand") { out = Gate::Nand; return true; }
		if (name == "nor")  { out = Gate::Nor;  return true; }
		if (name == "xor")  { out = Gate::Xor;  return true; }
		if (name == "nxor") { out = Gate::Nxor; return true; }
		return false;
	}

private:
	Gate gate_;
	std::vector<std::shared_ptr<ExpandedCondition>> children_;
};

} // namespace expanded_ai
