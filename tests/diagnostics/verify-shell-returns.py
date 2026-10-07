#!/usr/bin/env python3
"""Execute the shell-return queue and deferred callback without a game server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from source_region import source_region
from test_source_region import SourceRegionTests

# Keep the source-boundary contract covered in the same CI entry point.
result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(SourceRegionTests))
if not result.wasSuccessful():
    raise SystemExit(1)

source = Path(__file__).resolve().parents[1] / 'population-shell-returns.cpp'
repo = source.parent.parent
with tempfile.TemporaryDirectory(prefix='shell-returns-') as directory:
    binary = Path(directory) / 'shell-returns'
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

    # Execute the actual deferred callback with only its server-boundary calls
    # replaced. A whisper can claim the shell between scheduling and this call.
    runtime = repo / 'third-party/population-engine/files/src/map/population_engine/runtime/population_shell_selling.cpp'
    text = runtime.read_text()
    callback = source_region(text, 'pop_shell_selling_timer', runtime)
    clear = source_region(text, 'population_shell_returns_clear', runtime)
    check = Path(directory) / 'departure.cpp'
    check.write_text('''
#include <cassert>
#include <cstdint>
#include "third-party/population-engine/files/src/map/population_engine/core/population_shell_returns.hpp"
#define TIMER_FUNC(name) int name(int, int64_t tick, int id, intptr_t data)
constexpr int CLR_TELEPORT = 1;
struct map_session_data {
    int id = 7;
    bool prev = true, recruited = false, released = false;
    struct { bool loot_selling_pending = true; struct { bool despawn_pending = true; } hold; } pop;
} shell;
int effects = 0;
PopulationShellReturns g_pop_shell_returns;
uint32_t g_pop_shell_return_generation = 0;
map_session_data *map_id2sd(int id) { return id == shell.id ? &shell : nullptr; }
bool population_engine_is_population_pc(int) { return true; }
bool pop_shell_selling_eligible(const map_session_data *sd) { return !sd->recruited; }
PopulationShellReturn pop_shell_selling_snapshot(const map_session_data *sd, int64_t now) {
    PopulationShellReturn entry; entry.departed_id = sd->id; entry.ready_at = now + 120000; return entry;
}
void clif_clearunit_area(map_session_data &, int) { ++effects; }
void population_engine_shell_release(map_session_data *sd) { sd->released = true; }
''' + callback + clear + '''
int main() {
    shell.recruited = true;
    pop_shell_selling_timer(0, 1, 7, 0);
    assert(!shell.released && effects == 0 && g_pop_shell_returns.empty());
    assert(!shell.pop.loot_selling_pending && !shell.pop.hold.despawn_pending);
    shell = map_session_data{};
    population_shell_returns_clear(); // reload/stop invalidates a scheduled departure
    pop_shell_selling_timer(0, 1, 7, 0);
    assert(!shell.released && effects == 0 && g_pop_shell_returns.empty());
    assert(!shell.pop.loot_selling_pending && !shell.pop.hold.despawn_pending);
    g_pop_shell_return_generation = 0;
    shell = map_session_data{};
    pop_shell_selling_timer(0, 1, 8, 0); // actor gone / id no longer resolves
    assert(!shell.released && g_pop_shell_returns.empty());
    pop_shell_selling_timer(0, 1, 7, 0);
    assert(shell.released && effects == 1 && !g_pop_shell_returns.empty());
    pop_shell_selling_timer(0, 1, 7, 0); // duplicate/stale callback cannot reserve twice
    assert(effects == 1);
}
''')
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', '-I', str(repo), str(check), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    print('deferred departure preserves pending recruits and ignores stale callbacks')

    loot = runtime.parent / 'population_shell_loot.cpp'
    decision = source_region(loot.read_text(), 'population_shell_loot_try_unload', loot)
    check.write_text('''
#include <cassert>
#include <cstdint>
#include "third-party/population-engine/files/src/map/population_engine/core/population_shell_returns.hpp"
using int64 = int64_t;
using t_tick = int64_t;
constexpr int INVALID_TIMER = -1;
constexpr int kLootRecentHitMs = 1500;
#define DIFF_TICK(a,b) ((a)-(b))
struct { bool population_engine_loot_enable = true; } battle_config;
struct s_population { bool ambient_quota = true, loot_collected = true, loot_bag_blocked = false; t_tick last_attacked_tick = 0; };
struct map_session_data {
    s_population pop;
    struct { bool active = true; } state;
    bool prev = true, dead = false, sitting = false, hiding = false, busy = false;
    int targeted = 0, weight = 900;
    struct { int skilltimer = INVALID_TIMER; } ud;
} shell;
bool pc_isdead(map_session_data *s) { return s->dead; }
bool pc_issit(map_session_data *s) { return s->sitting; }
bool pc_ishiding(map_session_data *s) { return s->hiding; }
bool pc_cant_act(map_session_data *s) { return s->busy; }
int64 loot_weight_room(map_session_data *s) { return 1000 - s->weight - 1; }
int pc_inventoryblank(map_session_data *) { return 10; }
int unit_counttargeted(map_session_data *s) { return s->targeted; }
int departed = 0;
bool population_shell_selling_depart(map_session_data *, t_tick) { ++departed; return true; }
''' + decision + '''
int main() {
    // No floor-item search or player-distance input: the lifecycle timer can
    // unload a previously collected bag even when combat AI is asleep.
    assert(population_shell_loot_try_unload(&shell, 5000));
    shell.pop.loot_collected = false;
    assert(!population_shell_loot_try_unload(&shell, 5000));
    shell.pop.loot_collected = true;
    shell.targeted = 1;
    assert(!population_shell_loot_try_unload(&shell, 5000));
    shell.targeted = 0; shell.ud.skilltimer = 1;
    assert(!population_shell_loot_try_unload(&shell, 5000));
    shell.ud.skilltimer = INVALID_TIMER; shell.pop.last_attacked_tick = 4500;
    assert(!population_shell_loot_try_unload(&shell, 5000));
    assert(population_shell_loot_try_unload(&shell, 6000));
    shell.pop.ambient_quota = false;
    assert(!population_shell_loot_try_unload(&shell, 6000));
    assert(departed == 2);
}
''')
    subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', '-Wall', '-Wextra',
                    '-Werror', '-I', str(repo), str(check), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    print('lifecycle unloading preserves collected-loot and combat safety gates')
