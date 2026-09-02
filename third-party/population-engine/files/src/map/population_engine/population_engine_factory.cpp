// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Population engine factory: unity-builds all submodule translation units into
// the parent population_engine.cpp translation unit.

#include "population_engine_factory.hpp"

#include "core/pe_perf.cpp"
#include "config/population_config.cpp"
#include "config/population_skill_db.cpp"
#include "config/population_spawn_db.cpp"
#include "runtime/population_engine_combat.cpp"
#include "runtime/population_engine_path.cpp"
#include "runtime/population_shell_ammo.cpp"
#include "runtime/population_shell_runtime.cpp"
// Expanded conditions parser MUST come after combat.cpp so the LegacyPredicate
// forward declaration in predicates.hpp can resolve population_shell_skill_condition_ok.
#include "expanded_ai/expanded_parser.cpp"
