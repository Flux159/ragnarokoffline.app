// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Population shell: ranged ammo selection (standalone; not autocombat combat_helpers).
#pragma once

class map_session_data;
struct mob_data;

void population_shell_equip_best_arrow_for_target(map_session_data *sd, mob_data *md);
void population_shell_equip_best_bullet_for_target(map_session_data *sd, mob_data *md);
