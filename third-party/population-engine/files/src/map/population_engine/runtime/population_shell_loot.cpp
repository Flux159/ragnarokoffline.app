// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (shell looting): ambient shells pick up what their kills dropped.
//
// Shells never picked anything up: with item_auto_get off (the default) their
// drops simply lay on the ground until they expired, which no real player
// does. This lets an ambient shell walk over and take what it earned, with the
// priorities a player has: fight first, grab the rare card first, walk past
// some of the jellopies, and now and then forget one after a fight.
//
// What a shell considers its loot: floor items that a monster dropped
// (mob_id != 0) and on which the shell holds first loot priority, i.e. its own
// kills. Pickups go through stock pc_takeitem, so the client sees the pickup
// animation and picklog records them under the shell's char_id (95000000+).
//
// Recruited companions are left out: their loot priority already belongs to
// their owner (0003-companion-loot-owner.patch).

#include "population_shell_loot.hpp"
#include "population_shell_selling.hpp"

#include <algorithm>
#include <cstdlib>
#include <limits>
#include <vector>

#include <common/random.hpp>
#include <common/timer.hpp>

#include "../../battle.hpp"
#include "../../itemdb.hpp"
#include "../../map.hpp"
#include "../../mob.hpp"
#include "../../pc.hpp"
#include "../../status.hpp"
#include "../../unit.hpp"
#include "../../population_engine.hpp"
#include "../core/population_engine_core.hpp"
#include "population_shell_runtime.hpp"

namespace {

/// How often a shell looks around for new drops.
constexpr t_tick kLootScanIntervalMs = 300;
/// A shell that was hit this recently counts as being attacked.
constexpr t_tick kLootRecentHitMs = 1500;
/// Walk attempts before an unreachable item is given up.
constexpr uint8_t kLootMaxWalkFails = 3;
/// Reaction delay before going for a fresh drop (a player notices the item, then clicks).
constexpr int32 kLootReactRareMinMs = 150, kLootReactRareMaxMs = 400;
constexpr int32 kLootReactMinMs = 300, kLootReactMaxMs = 900;
/// Pause after each pickup, as between two clicks.
constexpr int32 kLootPauseMinMs = 250, kLootPauseMaxMs = 600;

flooritem_data *loot_resolve(const PopulationShellLootEntry &e, int16 m)
{
	block_list *bl = map_id2bl(e.item_bl_id);
	if (bl == nullptr || bl->type != BL_ITEM || bl->m != m)
		return nullptr;
	flooritem_data *fitem = reinterpret_cast<flooritem_data *>(bl);
	if (fitem->item.nameid != e.nameid)
		return nullptr; // block id reused for another item
	return fitem;
}

/// Weight the shell can still carry before rAthena's first overweight step
/// (natural_heal_weight_rate: 50% pre-renewal, 70% renewal), where natural
/// regen stops. Without this cap they
/// would keep looting to 90%, where Weight90 stops them attacking and using
/// skills: a field full of shells standing still. The same cap and the same
/// unbonused carry limit as the ammo stock (population_shell_ammo.cpp), because
/// max_weight is raised to 2000000 while a shell spawns.
int64 loot_weight_room(const map_session_data *sd)
{
	const int64 max_weight = job_db.get_maxWeight(pc_mapid2jobid(sd->class_, sd->status.sex)) +
		static_cast<int64>(sd->status.str) * 300;
	return max_weight * battle_config.natural_heal_weight_rate / 100 - 1 - sd->weight;
}

/// Whether picking up this drop keeps the shell under the cap above.
bool loot_fits(const map_session_data *sd, const flooritem_data *fitem)
{
	std::shared_ptr<item_data> id = item_db.find(fitem->item.nameid);
	const int64 weight = id != nullptr ? static_cast<int64>(id->weight) * fitem->item.amount : 0;
	return weight <= loot_weight_room(sd);
}

/// Rare: any card, or a drop whose base rate in this monster's table is at or
/// below population_engine_loot_rare_rate (per 10000, so 100 = 1%).
bool loot_is_rare(const flooritem_data *fitem)
{
	const t_itemid nameid = fitem->item.nameid;
	std::shared_ptr<item_data> id = item_db.find(nameid);
	if (id != nullptr && id->type == IT_CARD)
		return true;

	const int32 threshold = battle_config.population_engine_loot_rare_rate;
	if (threshold <= 0 || fitem->mob_id == 0)
		return false;
	std::shared_ptr<s_mob_db> mob = mob_db.find(fitem->mob_id);
	if (mob == nullptr)
		return false;

	uint32 best = std::numeric_limits<uint32>::max();
	for (const auto &d : mob->dropitem)
		if (d != nullptr && d->nameid == nameid)
			best = std::min(best, d->rate);
	for (const auto &d : mob->mvpitem)
		if (d != nullptr && d->nameid == nameid)
			best = std::min(best, d->rate);
	return best != std::numeric_limits<uint32>::max() && best <= static_cast<uint32>(threshold);
}

int32 loot_scan_sub(block_list *bl, va_list ap)
{
	map_session_data *sd = va_arg(ap, map_session_data *);
	std::vector<flooritem_data *> *out = va_arg(ap, std::vector<flooritem_data *> *);
	flooritem_data *fitem = BL_CAST(BL_ITEM, bl);
	if (fitem == nullptr)
		return 0;
	// Its own kills only: a monster drop on which the shell holds first priority.
	if (fitem->mob_id == 0 || static_cast<uint32>(fitem->first_get_charid) != sd->status.char_id)
		return 0;
	out->push_back(fitem);
	return 1;
}

/// Find new drops and decide on each exactly once: queue it, or leave it.
void loot_scan(map_session_data *sd, t_tick now)
{
	s_population &pe = sd->pop;
	if (DIFF_TICK(now, pe.loot_next_scan) < 0)
		return;
	pe.loot_next_scan = now + kLootScanIntervalMs;

	// Records of decided items outlive the item itself (floor lifetime), then go.
	for (auto it = pe.loot_seen.begin(); it != pe.loot_seen.end();) {
		if (DIFF_TICK(now, it->second) >= 0)
			it = pe.loot_seen.erase(it);
		else
			++it;
	}

	std::vector<flooritem_data *> found;
	map_foreachinallrange(loot_scan_sub, sd,
		static_cast<int16>(std::max(1, battle_config.population_engine_loot_radius)), BL_ITEM, sd, &found);

	const t_tick remember_ms = std::max<t_tick>(battle_config.flooritem_lifetime, 1000) + 10000;
	const t_tick timeout = std::max(1000, battle_config.population_engine_loot_timeout_ms);
	const int32 common_pct = std::clamp(battle_config.population_engine_loot_common_pickup_pct, 0, 100);
	const int32 rare_pct = std::clamp(battle_config.population_engine_loot_rare_pickup_pct, 0, 100);

	for (flooritem_data *fitem : found) {
		if (!pe.loot_seen.emplace(fitem->id, now + remember_ms).second)
			continue; // already decided
		// A full bag: the shell leaves it, as a player with no room would.
		if (!loot_fits(sd, fitem)) {
			pe.loot_bag_blocked = true;
			continue;
		}

		// Whether it bothers at all: a player picks up most of what drops, nearly
		// every rare drop, and walks past some of the rest.
		const bool rare = loot_is_rare(fitem);
		if (!rnd_chance(rare ? rare_pct : common_pct, 100))
			continue;

		PopulationShellLootEntry e;
		e.item_bl_id = fitem->id;
		e.nameid     = fitem->item.nameid;
		e.rare       = rare;
		e.ready_at   = now + (rare ? rnd_value(kLootReactRareMinMs, kLootReactRareMaxMs)
		                           : rnd_value(kLootReactMinMs, kLootReactMaxMs));
		e.give_up_at = now + (rare ? timeout * 2 : timeout);
		pe.loot_queue.push_back(e);
	}
}

void loot_stop_walk(map_session_data *sd)
{
	if (sd->pop.loot_walking_to != 0 && unit_is_walking(sd))
		unit_stop_walking(sd, USW_FIXPOS);
	sd->pop.loot_walking_to = 0;
}

} // namespace

void population_shell_loot_clear(map_session_data *sd)
{
	if (sd == nullptr)
		return;
	s_population &pe = sd->pop;
	pe.loot_queue.clear();
	pe.loot_seen.clear();
	pe.loot_next_scan = 0;
	pe.loot_next_action = 0;
	pe.loot_walking_to = 0;
}

bool population_shell_loot_busy(const map_session_data *sd)
{
	return sd != nullptr && (sd->pop.loot_selling_pending || !sd->pop.loot_queue.empty());
}

// DIAGNOSTIC-BEGIN: population_shell_loot_try_unload
bool population_shell_loot_try_unload(map_session_data *sd, t_tick now)
{
	if (!sd || !battle_config.population_engine_loot_enable || !sd->pop.ambient_quota
		|| !sd->pop.loot_collected || !sd->state.active || !sd->prev)
		return false;
	if (pc_isdead(sd) || pc_issit(sd) || pc_ishiding(sd) || pc_cant_act(sd))
		return false;
	s_population &pe = sd->pop;
	const int64 loot_limit = loot_weight_room(sd) + sd->weight + 1;
	if (population_shell_needs_unload(pe.loot_collected, pe.loot_bag_blocked,
		sd->weight, loot_limit, pc_inventoryblank(sd))
		&& unit_counttargeted(sd) == 0 && sd->ud.skilltimer == INVALID_TIMER
		&& (pe.last_attacked_tick == 0 || DIFF_TICK(now, pe.last_attacked_tick) >= kLootRecentHitMs)
		&& population_shell_selling_depart(sd, now))
		return true;

	return false;
}
// DIAGNOSTIC-END: population_shell_loot_try_unload

bool population_shell_loot_tick(map_session_data *sd, t_tick now)
{
	if (sd == nullptr)
		return false;
	s_population &pe = sd->pop;

	if (!battle_config.population_engine_loot_enable || population_engine_is_recruited_companion(sd)) {
		if (!pe.loot_queue.empty() || !pe.loot_seen.empty())
			population_shell_loot_clear(sd);
		return false;
	}
	if (pe.hold.despawn_pending)
		return true;
	if (pc_isdead(sd) || pc_issit(sd) || pc_ishiding(sd) || pc_cant_act(sd))
		return false;

	loot_scan(sd, now);

	// Drop what is gone (taken, expired) or has been forgotten.
	for (auto it = pe.loot_queue.begin(); it != pe.loot_queue.end();) {
		if (loot_resolve(*it, sd->m) == nullptr || DIFF_TICK(now, it->give_up_at) >= 0) {
			if (pe.loot_walking_to == it->item_bl_id)
				loot_stop_walk(sd);
			it = pe.loot_queue.erase(it);
		} else
			++it;
	}
	if (pe.loot_queue.empty()) {
		pe.loot_walking_to = 0;
		return false;
	}

	const bool being_attacked = unit_counttargeted(sd) > 0
		|| (pe.last_attacked_tick != 0 && DIFF_TICK(now, pe.last_attacked_tick) < kLootRecentHitMs);
	const int32 abort_pct = std::clamp(battle_config.population_engine_loot_hp_abort_pct, 0, 100);
	const bool hp_low = static_cast<int64>(sd->battle_status.hp) * 100
		< static_cast<int64>(sd->battle_status.max_hp) * abort_pct;

	// Pick the item to go for: rare before ordinary, nearest first. A rare drop
	// is worth taking a few hits for; an ordinary one waits until the fight is over.
	PopulationShellLootEntry *pick = nullptr;
	flooritem_data *pick_item = nullptr;
	int pick_dist = std::numeric_limits<int>::max();
	bool waiting_on_reaction = false;
	const int32 forget_pct = std::clamp(battle_config.population_engine_loot_forget_pct, 0, 100);
	for (auto it = pe.loot_queue.begin(); it != pe.loot_queue.end();) {
		PopulationShellLootEntry &e = *it;
		const bool eligible = e.rare ? !hp_low : !being_attacked;
		if (!eligible) {
			e.interrupted = true; // a fight is holding it back
			++it;
			continue;
		}
		// The fight is over: did it still remember the drop it meant to take?
		if (e.interrupted) {
			e.interrupted = false;
			if (forget_pct > 0 && rnd_chance(forget_pct, 100)) {
				if (pe.loot_walking_to == e.item_bl_id)
					loot_stop_walk(sd);
				it = pe.loot_queue.erase(it);
				continue;
			}
		}
		++it;
	}
	if (pe.loot_queue.empty())
		return false;

	for (PopulationShellLootEntry &e : pe.loot_queue) {
		const bool eligible = e.rare ? !hp_low : !being_attacked;
		if (!eligible)
			continue;
		if (DIFF_TICK(now, e.ready_at) < 0) {
			waiting_on_reaction = true;
			continue;
		}
		flooritem_data *fitem = loot_resolve(e, sd->m);
		const int dist = distance_bl(sd, fitem);
		const bool better = pick == nullptr
			|| (e.rare && !pick->rare)
			|| (e.rare == pick->rare && dist < pick_dist);
		if (better) {
			pick = &e;
			pick_item = fitem;
			pick_dist = dist;
		}
	}

	if (pick == nullptr) {
		// A drop it is about to go for: stand and look at it for a moment rather
		// than run off after the next monster and come back.
		if (waiting_on_reaction)
			return true;
		// Only ordinary loot left and something is attacking: back to the fight.
		loot_stop_walk(sd);
		return false;
	}

	if (DIFF_TICK(now, pe.loot_next_action) < 0)
		return true;

	// Looting owns movement this tick.
	population_shell_reset_movement_tick_state(sd, now);
	pe.movement_owner = MovementOwner::Loot;
	pe.movement_owner_reason = MovementOwnerReason::LootActive;
	pe.movement_owner_since_tick = now;
	unit_stop_attack(sd);

	if (check_distance_bl(sd, pick_item, 1)) {
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		const int32 item_id = pick->item_bl_id;
		// pc_takeitem plays the pickup animation and logs to picklog. If it
		// fails (full inventory) the item is given up, as a player would. So is
		// one that no longer fits under the weight cap: the queue was decided
		// before the pickups ahead of it.
		if (loot_fits(sd, pick_item)) {
			pc_takeitem(sd, pick_item);
			// pc_takeitem also returns true on an add-item failure. Only removal
			// of the floor item proves the shell really acquired this drop.
			if (map_id2bl(item_id) == nullptr)
				pe.loot_collected = true;
		} else {
			pe.loot_bag_blocked = true;
		}
		pe.loot_queue.erase(std::remove_if(pe.loot_queue.begin(), pe.loot_queue.end(),
			[item_id](const PopulationShellLootEntry &e) { return e.item_bl_id == item_id; }),
			pe.loot_queue.end());
		pe.loot_walking_to = 0;
		pe.loot_next_action = now + rnd_value(kLootPauseMinMs, kLootPauseMaxMs);
		return true;
	}

	// Already on the way there.
	if (pe.loot_walking_to == pick->item_bl_id && unit_is_walking(sd)
		&& std::abs(sd->ud.to_x - pick_item->x) <= 1 && std::abs(sd->ud.to_y - pick_item->y) <= 1)
		return true;

	if (!population_shell_can_emit_movement(sd, MovementOwner::Loot, "population_shell:loot"))
		return true; // e.g. mid-cast: wait for it, keep the claim on the tick

	if (unit_walktoxy(sd, pick_item->x, pick_item->y, 4) || unit_walktoxy(sd, pick_item->x, pick_item->y, 1)) {
		pe.last_move = now;
		pe.loot_walking_to = pick->item_bl_id;
		return true;
	}

	pe.movement_emitted_this_tick = false;
	if (++pick->walk_fails >= kLootMaxWalkFails) {
		const int32 item_id = pick->item_bl_id;
		pe.loot_queue.erase(std::remove_if(pe.loot_queue.begin(), pe.loot_queue.end(),
			[item_id](const PopulationShellLootEntry &e) { return e.item_bl_id == item_id; }),
			pe.loot_queue.end());
	}
	pe.loot_walking_to = 0;
	return false;
}
