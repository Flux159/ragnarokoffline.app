// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// RAGNAROKMAC (companion script events): which of rAthena's player script events run for a shell.
//
// Shells never run them (patch 0001): the crowd would fill the event queue, and a script
// written for a player talks to a client a shell does not have. A recruited companion is the
// exception for OnPCDieEvent only: it is a party member whose death a script may need to see
// (a fight that counts its fallen). The label runs attached to the companion, as it does for a
// player, so strcharinfo(0) is the companion's name.
#pragma once

#include "../../npc.hpp"
#include "../../population_engine.hpp"

inline bool population_shell_runs_script_event(const map_session_data &sd, enum npce_event type)
{
	return type == NPCE_DIE && population_engine_is_recruited_companion(&sd);
}
