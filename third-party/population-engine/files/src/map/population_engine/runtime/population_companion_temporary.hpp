// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC (temporary recruits): a character recruited from the world (whispered, then
// invited) helps for a while and goes back to the world, instead of joining the saved list.
// Companions hired or drafted from the Companions window are unchanged: they are the ones a
// player keeps, gears up and calls back.
//
// The whole feature lives in this file and population_companion_temporary.cpp. The engine
// reaches it from lines marked "RAGNAROKMAC (temporary recruits)" in population_engine.cpp:
// the recruit's persistence, the dismiss and expel paths, the owner's logout and the recall
// at login.
//
// A recruit is temporary only when the server says so (population_engine_companion_recruit_temporary,
// Settings -> Population -> Recruits are temporary, off by default) at the moment it is
// recruited, and only when its row is new: a companion already saved stays saved. Its row
// carries `temporary` = 1 (v16). Such a row is deleted when the companion leaves the party,
// when its owner logs out, and at the owner's next login for a shutdown that skipped the
// logout - unless it still holds gear its owner gave it, which is never thrown away: that
// companion stays on the saved list until the gear is taken back and it is dismissed again.
#pragma once

#include <common/cbasetypes.hpp>

class map_session_data;

/// Whether this character already keeps a row for the shell. Asked before the recruit's row is
/// written: a re-invited companion that was saved before stays what it was.
bool population_companion_row_kept(uint32 owner_account, uint32 owner_char, uint32 index_);

/// After a recruit's row was written: mark it temporary when the server says recruits are and
/// the row is new (`fresh`), and tell the owner.
void population_companion_temporary_mark(map_session_data *owner, uint32 index_, bool fresh);

/// A companion left the party, or its owner left: delete its row if it is temporary and holds
/// none of its owner's gear. Returns true when the row was deleted.
bool population_companion_temporary_drop(uint32 index_);

/// Expelled from the party window: rAthena took the live companion out of the party, but the
/// engine puts a companion back into its owner's party after the rebuild that follows. A recruit
/// that went its own way belongs to no one any more, so it stays out and lives on in the world.
void population_companion_temporary_let_go(uint32 index_);

/// At login, before the recall: drop the temporary rows of `owner` that a shutdown left behind.
/// A companion that is live in the world is left alone.
void population_companion_temporary_drop_all(const map_session_data *owner);
