// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population engine — public entry point for the expanded-condition parser.
#pragma once

#include <memory>

// Forward-declare ryml::NodeRef indirectly via the YAML database header.
#include <common/database.hpp>

#include "expanded_condition.hpp"

namespace expanded_ai {

/// Build an ExpandedCondition tree from a YAML node. Accepts scalar / sequence /
/// map shapes (see parser .cpp for grammar). Returns a non-null tree even on
/// errors (a constant-false sentinel) so callers can rely on the pointer
/// without null-checking each time.
std::shared_ptr<ExpandedCondition> parse_expanded_condition(const ryml::NodeRef& node);

} // namespace expanded_ai
