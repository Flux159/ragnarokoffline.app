// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
//
// pe_perf — implementation.

#include "pe_perf.hpp"

#include <array>
#include <cstring>
#include <limits>

namespace pe_perf {

namespace {

std::array<SectionStat, kMaxSections> g_sections{};
size_t                                g_section_count = 0;

// Linear lookup by pointer identity (string literals have stable addresses
// within a translation unit; PE_PERF_SCOPE always passes the same literal
// from the same call site, so this is safe and fast).
inline SectionStat *find_or_create(const char *name) noexcept {
    for (size_t i = 0; i < g_section_count; ++i) {
        if (g_sections[i].name == name)
            return &g_sections[i];
    }
    if (g_section_count >= kMaxSections)
        return nullptr; // silently drop further sections
    SectionStat &s = g_sections[g_section_count++];
    s.name     = name;
    s.calls    = 0;
    s.total_us = 0;
    s.last_us  = 0;
    s.worst_us = 0;
    s.min_us   = std::numeric_limits<uint64_t>::max();
    return &s;
}

} // namespace

void record(const char *name, uint64_t elapsed_us) {
    SectionStat *s = find_or_create(name);
    if (s == nullptr)
        return;
    s->calls    += 1;
    s->total_us += elapsed_us;
    s->last_us   = elapsed_us;
    if (elapsed_us > s->worst_us) s->worst_us = elapsed_us;
    if (elapsed_us < s->min_us)   s->min_us   = elapsed_us;
}

void snapshot(SectionStat *out, size_t &out_count) {
    out_count = g_section_count;
    for (size_t i = 0; i < g_section_count; ++i)
        out[i] = g_sections[i];
}

void reset() {
    for (size_t i = 0; i < g_section_count; ++i) {
        g_sections[i].calls    = 0;
        g_sections[i].total_us = 0;
        g_sections[i].last_us  = 0;
        g_sections[i].worst_us = 0;
        g_sections[i].min_us   = std::numeric_limits<uint64_t>::max();
    }
}

} // namespace pe_perf
