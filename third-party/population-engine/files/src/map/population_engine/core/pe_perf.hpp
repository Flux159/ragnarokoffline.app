// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
//
// Population Engine — generic per-scope performance instrumentation.
//
// Design goals:
//   * Drop a single RAII line at the top of any function or block to time it.
//   * Cheap enough to leave compiled in production (~50 ns/scope).
//   * Single-threaded (main map thread only) — no atomics needed.
//   * Identifies sections by stable string literal pointer (no hashing).
//   * Bounded memory: max 64 distinct sections.
//
// Typical use:
//   void some_timer() {
//       PE_PERF_SCOPE("chat_timer");
//       // ... work ...
//   }
//
//   // Inside a hot loop where you want to attribute sub-cost:
//   {
//       PE_PERF_SCOPE("chat_timer.broadcast");
//       clif_GlobalMessage(...);
//   }
//
// Output is consumed by `@populate timing` (atcommand layer).

#ifndef POPULATION_ENGINE_CORE_PE_PERF_HPP
#define POPULATION_ENGINE_CORE_PE_PERF_HPP

#include <chrono>
#include <cstddef>
#include <cstdint>

namespace pe_perf {

constexpr size_t kMaxSections = 64;

struct SectionStat {
    const char *name;        ///< Stable string-literal pointer; null = empty slot.
    uint64_t    calls;       ///< Total invocations since reset.
    uint64_t    total_us;    ///< Cumulative wall time.
    uint64_t    last_us;     ///< Most recent invocation time.
    uint64_t    worst_us;    ///< Worst single invocation.
    uint64_t    min_us;      ///< Best single invocation (UINT64_MAX = unset).
};

/// Record a measurement.  Called by the RAII Scope dtor; usually you don't call this directly.
void record(const char *name, uint64_t elapsed_us);

/// Snapshot copy of all live sections (in registration order).  `out_count` receives the
/// number of populated entries (<= kMaxSections).  Caller passes a buffer of kMaxSections.
void snapshot(SectionStat *out, size_t &out_count);

/// Wipe all counters.  Section name registry is preserved.
void reset();

/// RAII scope guard.  Records elapsed microseconds when destroyed.
struct Scope {
    const char                                              *name;
    std::chrono::steady_clock::time_point                    t0;

    explicit Scope(const char *section_name) noexcept
        : name(section_name)
        , t0(std::chrono::steady_clock::now())
    {}

    ~Scope() noexcept {
        const auto t1 = std::chrono::steady_clock::now();
        const uint64_t elapsed_us = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());
        record(name, elapsed_us);
    }

    Scope(const Scope &)            = delete;
    Scope &operator=(const Scope &) = delete;
};

} // namespace pe_perf

#define PE_PERF_CONCAT_INNER(a, b) a##b
#define PE_PERF_CONCAT(a, b)       PE_PERF_CONCAT_INNER(a, b)
#define PE_PERF_SCOPE(name_literal) ::pe_perf::Scope PE_PERF_CONCAT(_pe_perf_scope_, __LINE__){(name_literal)}

#endif // POPULATION_ENGINE_CORE_PE_PERF_HPP
