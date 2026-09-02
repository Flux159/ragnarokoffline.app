// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population wander AI and pathfinding.
#pragma once

#include <cstdint>

#include <common/timer.hpp>

class map_session_data;

void population_engine_path_erase_for_pc(int32 id);
void population_engine_path_clear_all();
void population_engine_path_register_wander_state(map_session_data *sd);

void population_engine_path_register_timer_funcs();
void population_engine_path_restart_wander_timer();
void population_engine_path_stop_wander_timer();

TIMER_FUNC(population_engine_wander_timer);

/// Rolling per-tick instrumentation for the wander timer.
/// All times are in microseconds; counts are per-tick averages over the last N ticks.
/// Goal: identify which sub-step (freecell / fallback / unit_walktoxy) dominates
/// a populated wander tick before committing to A2/A3/A4 architecture work.
struct WanderTimingSnapshot {
    uint64_t ticks_recorded;       ///< Total wander ticks observed since reset.
    uint64_t window_size;          ///< Sliding window length (in ticks).

    // Per-tick averages over the window:
    double   avg_total_us;         ///< Total wall time spent in the wander timer body.
    double   avg_freecell_us;      ///< Time inside map_search_freecell.
    double   avg_fallback_us;      ///< Time inside population_engine_pick_adjacent_passable (incl. path_search).
    double   avg_unit_walktoxy_us; ///< Time inside unit_walktoxy (the suspected hotspot).
    double   avg_processed;        ///< Shells walked per tick.
    double   avg_examined;         ///< Shells examined per tick (cursor sweep).

    // Most recent tick (un-averaged) for spotting outliers:
    uint64_t last_total_us;
    uint64_t last_freecell_us;
    uint64_t last_fallback_us;
    uint64_t last_unit_walktoxy_us;
    uint32_t last_processed;
    uint32_t last_examined;

    // Worst tick seen so far:
    uint64_t worst_total_us;
    uint32_t worst_processed;

    // Cumulative call counters (reset by reset_timing()):
    uint64_t freecell_calls;
    uint64_t fallback_calls;
    uint64_t unit_walktoxy_calls;
};

WanderTimingSnapshot population_engine_path_get_timing_snapshot();
void                 population_engine_path_reset_timing();
