// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell: unified virtual ammunition provisioning and selection.
#pragma once

#include <common/cbasetypes.hpp>

class map_session_data;
struct mob_data;

// Keep the shell's inaccessible inventory stocked and equip a valid default for
// its weapon/class. Safe to call repeatedly (spawn, warp recovery, combat).
void population_shell_prepare_ammo(map_session_data *sd);

// Select the strongest usable ammunition whose element is effective against the
// current target. Returns true when no ammo is needed or valid ammo is equipped.
bool population_shell_equip_best_ammo_for_target(map_session_data *sd, mob_data *md);

// Equip ammunition accepted by a skill's AmmoType requirement. This also covers
// Ninja shuriken/kunai skills, whose ammo requirement is skill-driven rather than
// derived from the equipped weapon.
bool population_shell_equip_ammo_for_skill(map_session_data *sd, mob_data *md, uint16 skill_id, uint16 skill_lv);
