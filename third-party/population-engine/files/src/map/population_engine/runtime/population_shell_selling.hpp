// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC: ambient shells leave to unload and later reclaim their population slot.
#pragma once
#include "../core/population_shell_returns.hpp"

class map_session_data;

bool population_shell_selling_depart(map_session_data *sd, int64_t now);
void population_shell_returns_clear();
void population_shell_returns_prune(bool under_pressure);
size_t population_shell_returns_fit(int16_t map, const std::vector<uint16_t> &jobs, size_t target, size_t live);
size_t population_shell_returns_fill(int16_t map, const std::vector<uint16_t> &jobs, size_t *budget);
size_t population_shell_returns_count(int16_t map, const std::vector<uint16_t> &jobs);
bool population_shell_returns_allow_fresh(int16_t map, size_t global_live, size_t global_cap);
