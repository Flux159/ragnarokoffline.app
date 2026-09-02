// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Ranged ammo equip logic for population combat shells.

#include "population_shell_ammo.hpp"

#include <common/timer.hpp>

#include "../../mob.hpp"
#include "../../pc.hpp"

void population_shell_safe_displaymessage_id(map_session_data *sd, int msg_id);

namespace {

constexpr int kAmmoElementBonus = 500;

static bool pe_shell_elemstrong(const mob_data *md, int ele)
{
	if (!md)
		return false;

	const int def_ele = md->status.def_ele;
	const int ele_lv = md->status.ele_lv;

	switch (ele) {
	case ELE_GHOST:
		return (def_ele == ELE_UNDEAD && ele_lv >= 2) || (def_ele == ELE_GHOST);
	case ELE_FIRE:
		return def_ele == ELE_UNDEAD || def_ele == ELE_EARTH;
	case ELE_WATER:
		return (def_ele == ELE_UNDEAD && ele_lv >= 3) || (def_ele == ELE_FIRE);
	case ELE_WIND:
		return def_ele == ELE_WATER;
	case ELE_EARTH:
		return def_ele == ELE_WIND;
	case ELE_HOLY:
		return (def_ele == ELE_POISON && ele_lv >= 3) || (def_ele == ELE_DARK) || (def_ele == ELE_UNDEAD);
	case ELE_DARK:
		return def_ele == ELE_HOLY;
	case ELE_POISON:
		return (def_ele == ELE_UNDEAD && ele_lv >= 2) || (def_ele == ELE_GHOST) || (def_ele == ELE_NEUTRAL);
	case ELE_UNDEAD:
		return (def_ele == ELE_HOLY && ele_lv >= 2);
	case ELE_NEUTRAL:
	default:
		return false;
	}
}

static bool pe_shell_elemallowed(mob_data *md, int ele)
{
	if (!md)
		return true;

	const int def_ele = md->status.def_ele;
	const int ele_lv = md->status.ele_lv;

	if (md->sc.getSCE(SC_WHITEIMPRISON)) {
		if (ele != ELE_GHOST)
			return false;
	}

	switch (ele) {
	case ELE_GHOST:
		return !((def_ele == ELE_NEUTRAL && ele_lv >= 2) || (def_ele == ELE_FIRE && ele_lv >= 3) ||
				(def_ele == ELE_WATER && ele_lv >= 3) || (def_ele == ELE_WIND && ele_lv >= 3) ||
				(def_ele == ELE_EARTH && ele_lv >= 3) || (def_ele == ELE_POISON && ele_lv >= 3) ||
				(def_ele == ELE_HOLY && ele_lv >= 2) || (def_ele == ELE_DARK && ele_lv >= 2));
	case ELE_FIRE:
	case ELE_WATER:
	case ELE_WIND:
	case ELE_EARTH:
		if (def_ele == ele || (def_ele == ELE_HOLY && ele_lv >= 2) || (def_ele == ELE_DARK && ele_lv >= 3))
			return false;
		if (ele == ELE_EARTH && def_ele == ELE_UNDEAD && ele_lv >= 4)
			return false;
		return true;
	case ELE_HOLY:
		return def_ele != ELE_HOLY;
	case ELE_DARK:
		return !(def_ele == ELE_POISON || def_ele == ELE_DARK || def_ele == ELE_UNDEAD);
	case ELE_POISON:
		return !((def_ele == ELE_WATER && ele_lv >= 3) || (def_ele == ELE_GHOST && ele_lv >= 3) ||
				(def_ele == ELE_POISON) || (def_ele == ELE_UNDEAD) || (def_ele == ELE_HOLY && ele_lv >= 2) ||
				(def_ele == ELE_DARK));
	case ELE_UNDEAD:
		return !((def_ele == ELE_WATER && ele_lv >= 3) || (def_ele == ELE_FIRE && ele_lv >= 3) ||
				(def_ele == ELE_WIND && ele_lv >= 3) || (def_ele == ELE_EARTH && ele_lv >= 3) ||
				(def_ele == ELE_POISON && ele_lv >= 1) || (def_ele == ELE_UNDEAD) || (def_ele == ELE_DARK));
	case ELE_NEUTRAL:
		return !(def_ele == ELE_GHOST && ele_lv >= 2);
	default:
		return true;
	}
}

static int pe_shell_ammochange(map_session_data *sd, mob_data *md, const unsigned short *ammoIds,
	const unsigned short *ammoElements, const unsigned short *ammoAtk, size_t ammoCount, int rqAmount,
	const unsigned short *ammoLevels)
{
	if (!sd)
		return 0;
	if (DIFF_TICK(sd->canequip_tick, gettick()) > 0)
		return 0;

	int bestIndex = -1;
	int bestPriority = -1;
	int bestElement = -1;
	bool isEquipped = false;

	for (size_t i = 0; i < ammoCount; ++i) {
		int16 index = pc_search_inventory(sd, ammoIds[i]);
		if (index < 0)
			continue;
		if (rqAmount > 0 && sd->inventory.u.items_inventory[index].amount < rqAmount)
			continue;
		if (ammoLevels && sd->status.base_level < ammoLevels[i])
			continue;

		int priority = static_cast<int>(ammoAtk[i]);
		if (pe_shell_elemstrong(md, ammoElements[i]))
			priority += kAmmoElementBonus;

		if (pe_shell_elemallowed(md, ammoElements[i]) && priority > bestPriority) {
			bestPriority = priority;
			bestIndex = index;
			isEquipped = pc_checkequip2(sd, ammoIds[i], EQI_AMMO, EQI_AMMO + 1);
			bestElement = ammoElements[i];
		}
	}

	if (bestIndex > -1) {
		if (!isEquipped)
			pc_equipitem(sd, bestIndex, EQP_AMMO);
		return bestElement;
	}

	population_shell_safe_displaymessage_id(sd, 2117);
	return -1;
}

} // namespace

void population_shell_equip_best_arrow_for_target(map_session_data *sd, mob_data *md)
{
	static constexpr unsigned short arrows[] = { 1750, 1751, 1752, 1753, 1754, 1755, 1756, 1757, 1762, 1765, 1766, 1767, 1770, 1772, 1773, 1774 };
	static constexpr unsigned short arrowElements[] = { ELE_NEUTRAL, ELE_HOLY, ELE_FIRE, ELE_NEUTRAL, ELE_WATER, ELE_WIND, ELE_EARTH, ELE_GHOST, ELE_NEUTRAL, ELE_POISON, ELE_HOLY, ELE_DARK, ELE_NEUTRAL, ELE_HOLY, ELE_NEUTRAL, ELE_NEUTRAL };
	static constexpr unsigned short arrowAtk[] = { 25, 30, 30, 40, 30, 30, 30, 30, 30, 50, 50, 30, 30, 50, 45, 35 };

	pe_shell_ammochange(sd, md, arrows, arrowElements, arrowAtk, sizeof(arrows) / sizeof(arrows[0]), 0, nullptr);
}

void population_shell_equip_best_bullet_for_target(map_session_data *sd, mob_data *md)
{
	static constexpr unsigned short bullets[] = { 13200, 13201, 13215, 13216, 13217, 13218, 13219, 13220, 13221, 13228, 13229, 13230, 13231, 13232 };
	static constexpr unsigned short bulletElements[] = { ELE_NEUTRAL, ELE_HOLY, ELE_NEUTRAL, ELE_FIRE, ELE_WATER, ELE_WIND, ELE_EARTH, ELE_HOLY, ELE_HOLY, ELE_FIRE, ELE_WIND, ELE_WATER, ELE_POISON, ELE_DARK };
	static constexpr unsigned short bulletAtk[] = { 25, 15, 50, 40, 40, 40, 40, 40, 15, 20, 20, 20, 20, 20 };
	static constexpr unsigned short bulletLevels[] = { 1, 1, 100, 100, 100, 100, 100, 100, 1, 1, 1, 1, 1, 1 };

	pe_shell_ammochange(sd, md, bullets, bulletElements, bulletAtk, sizeof(bullets) / sizeof(bullets[0]), 0, bulletLevels);
}
