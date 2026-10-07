// Executable checks of the same reservation queue the map-server uses.
// c++ -std=c++17 -Wall -Wextra -Werror tests/population-shell-returns.cpp -o /tmp/shell-returns
#include "../third-party/population-engine/files/src/map/population_engine/core/population_shell_returns.hpp"
#include <cassert>
#include <iostream>

int main()
{
	assert(!population_shell_needs_unload(false, true, 900, 1000, 0)); // starting supplies alone
	assert(!population_shell_needs_unload(true, false, 899, 1000, 2));
	assert(population_shell_needs_unload(true, false, 900, 1000, 2));
	assert(population_shell_needs_unload(true, false, 100, 1000, 1)); // slot limit, not weight
	assert(population_shell_needs_unload(true, true, 100, 1000, 50)); // next drop will not fit
	PopulationShellReturns returns;
	PopulationShellReturn a;
	a.departed_id = 100;
	a.map = 1;
	a.job = 7;
	a.name = "Returning adventurer";
	a.ready_at = 120000;
	a.gear.push_back({1701, 2});
	a.gear.push_back({20214, 4096}); // costume slot remains distinct from ordinary headgear
	const std::vector<uint16_t> jobs{7, 8};
	returns.reserve(a);
	assert(returns.count(1, jobs) == 1);
	// A low global cap must not let another profile on this map steal the slot.
	assert(!returns.allow_fresh(1, 4, 5));
	assert(returns.allow_fresh(2, 4, 5)); // another map may use spare global capacity
	assert(returns.allow_fresh(1, 3, 5)); // unrelated vacancy still fills
	assert(!returns.allow_fresh(1, 4, 4)); // lowered cap cannot underflow
	assert(returns.count(2, jobs) == 0);
	assert(returns.count(1, {9}) == 0);
	assert(returns.fit(1, jobs, 20, 19) == 1); // departure cannot create a refill vacancy
	assert(returns.next(1, jobs, 119999) == nullptr);
	assert(returns.next(1, jobs, 120000)->name == a.name);
	assert(returns.next(1, jobs, 120000)->gear[0].item_id == 1701);
	assert(returns.next(1, jobs, 120000)->gear[1].position == 4096);
	assert(returns.next(1, jobs, 120001) != nullptr); // failed spawn keeps its reservation
	returns.complete(100);
	assert(returns.count(1, jobs) == 0);
	assert(returns.empty());

	returns.reserve(a);
	a.departed_id = 101;
	a.ready_at = 130000;
	returns.reserve(a);
	a.departed_id = 102;
	a.map = 2;
	returns.reserve(a);
	assert(returns.fit(1, jobs, 20, 19) == 1); // lowered target cancels the newest excess return
	assert(returns.next(1, jobs, 140000)->departed_id == 100);
	assert(returns.count(2, jobs) == 1);
	assert(returns.fit(1, jobs, 0, 19) == 0); // area disabled; no unsigned deficit underflow
	assert(returns.next(1, jobs, 140000) == nullptr);
	returns.discard_if([](const auto &entry) { return entry.map == 2; });
	assert(returns.empty()); // map abandonment frees snapshots and reservations together

	a.map = 1;
	returns.reserve(a);
	returns.clear(); // reload, shutdown, or looting disabled
	assert(returns.empty());
	std::cout << "shell return reservations passed\n";
}
