// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// RAGNAROKMAC: shell control API, for mods' NPC scripts.
//
// What a mod's NPC script cannot do with stock commands: find shells, take one
// away from the engine's AI for a while, make one and remove one. Everything
// else (walking, talking, emotes, skills, sitting) is stock -- a shell is a real
// map_session_data, so unitwalk/unittalk/emotion/unitskilluseid/sit work on it
// by unit id or name. The engine does the part of unitwarp, pcfollow and
// unitattack a player's client would (population_shell_control_sweep).
//
// Not a translation unit of its own: population_engine.cpp includes it, as it
// does population_customers.cpp, so it reaches the engine's own helpers. The
// script commands are in src/custom/script.inc (patch 0027); the declarations
// in population_engine/population_shell_control.hpp; the per-shell state is
// sd->pop.hold (core/population_shell_hold.hpp).

static void pop_shell_follow_reset(map_session_data *sd);

/// Bounds of a hold, so a script cannot freeze a shell for good by mistake.
static constexpr int64_t POP_HOLD_DEFAULT_MS = 60000;
static constexpr int64_t POP_HOLD_MIN_MS     = 1000;
static constexpr int64_t POP_HOLD_MAX_MS     = 30 * 60 * 1000;

static bool pop_shell_is_vendor(const map_session_data *sd)
{
	return sd->state.vending || sd->state.buyingstore || !sd->pop.vendor_key.empty()
		|| sd->pop.behavior == static_cast<uint8_t>(PopulationBehavior::Vendor);
}

int population_engine_shell_kind(int32_t gid)
{
	if (!population_engine_is_population_pc(gid))
		return POP_SHELL_NONE;
	const map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr)
		return POP_SHELL_NONE;
	// companion_owner_account is also set while a player's party invitation is
	// pending, which is exactly when a script must not take the shell either.
	if (pop_is_companion(sd) || sd->pop.companion_owner_account != 0)
		return POP_SHELL_COMPANION;
	if (pop_shell_is_vendor(sd))
		return POP_SHELL_VENDOR;
	return POP_SHELL_AMBIENT;
}

bool population_engine_shell_is_held(const map_session_data *sd)
{
	return sd != nullptr && sd->pop.hold.npc != 0 && DIFF_TICK(sd->pop.hold.until, gettick()) > 0;
}

size_t population_engine_find_shells(int16_t m, int16_t x, int16_t y, int range, int flags,
	std::vector<int32_t> &out)
{
	std::vector<std::pair<int, int32_t>> found;
	for (map_session_data *sd : g_population_engine_pcs) {
		if (sd == nullptr || !sd->state.active || sd->prev == nullptr || sd->m != m)
			continue;
		if (map_id2bl(sd->id) != sd || sd->pop.hold.despawn_pending)
			continue;
		const int d = std::max(std::abs(sd->x - x), std::abs(sd->y - y));
		if (range >= 0 && d > range)
			continue;
		const int kind = population_engine_shell_kind(sd->id);
		if (kind == POP_SHELL_COMPANION)
			continue;
		if (kind == POP_SHELL_VENDOR && !(flags & POP_FIND_VENDORS))
			continue;
		// hold.npc rather than shell_is_held: a lapsed hold the sweep has not ended
		// yet still belongs to its script for that moment.
		if (sd->pop.hold.npc != 0 && !(flags & POP_FIND_HELD))
			continue;
		if (pc_isdead(sd) && !(flags & POP_FIND_DEAD))
			continue;
		found.emplace_back(d, sd->id);
	}
	std::sort(found.begin(), found.end());
	out.clear();
	out.reserve(found.size());
	for (const auto &f : found)
		out.push_back(f.second);
	return out.size();
}

/// Stop whatever the AI had the shell doing, so the script starts from rest.
static void pop_shell_stop_ai_action(map_session_data *sd)
{
	population_shell_target_change(sd, 0);
	sd->pop.sticky_target_id = 0;
	sd->pop.sticky_until = 0;
	unit_skillcastcancel(sd, 0);
	unit_stop_attack(sd);
	pc_stop_following(sd);
	unit_stop_walking(sd, USW_FIXPOS);
}

bool population_engine_shell_hold(int32_t gid, int32_t npc_id, int64_t ms)
{
	if (npc_id == 0 || population_engine_shell_kind(gid) != POP_SHELL_AMBIENT)
		return false;
	map_session_data *sd = map_id2sd(gid);
	if (sd->pop.hold.despawn_pending)
		return false;
	if (population_engine_shell_is_held(sd) && sd->pop.hold.npc != npc_id)
		return false;
	const bool fresh = sd->pop.hold.npc != npc_id;
	if (fresh && sd->pop.hold.npc != 0) {
		// Another script's hold lapsed and the sweep has not ended it yet: its
		// whisper event is not this script's.
		sd->pop.hold.whisper_event.clear();
	}
	sd->pop.hold.npc = npc_id;
	sd->pop.hold.until = gettick() + cap_value(ms > 0 ? ms : POP_HOLD_DEFAULT_MS, POP_HOLD_MIN_MS, POP_HOLD_MAX_MS);
	if (fresh)
		pop_shell_stop_ai_action(sd);
	return true;
}

/// End a hold and hand the shell back to the engine. An actor population_spawn
/// made logs out unless it was spawned to stay, and so does a shell a script
/// took to another map: the drift check would otherwise drag it home in plain view.
static void pop_shell_end_hold(map_session_data *sd)
{
	sd->pop.hold.npc = 0;
	sd->pop.hold.until = 0;
	sd->pop.hold.whisper_event.clear();
	sd->pop.hold.lost_event.clear();
	unit_stop_attack(sd);
	// pcfollow runs its own timer, which would keep walking the shell after
	// whoever the script had it follow.
	pc_stop_following(sd);
	pop_shell_follow_reset(sd);
	unit_stop_walking(sd, USW_FIXPOS);
	if ((sd->pop.hold.spawned && !sd->pop.hold.keep)
		|| (sd->pop.spawn_map_id >= 0 && sd->m != sd->pop.spawn_map_id)) {
		population_engine_shell_despawn(sd->id, POP_DESPAWN_LOGOUT);
		return;
	}
	// A script may have sat it down, and the ambient AI cannot walk a sitting shell.
	if (pc_issit(sd) && sd->pop.behavior != static_cast<uint8_t>(PopulationBehavior::Sit)
		&& pc_setstand(sd, false)) {
		skill_sit(sd, 0);
		clif_standing(*sd);
	}
}

bool population_engine_shell_unhold(int32_t gid, int32_t npc_id)
{
	if (!population_engine_is_population_pc(gid))
		return false;
	map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr || npc_id == 0 || sd->pop.hold.npc != npc_id || sd->pop.hold.despawn_pending)
		return false;
	pop_shell_end_hold(sd);
	return true;
}

/// pc_setpos takes a character off the map and waits for its client to say the
/// new map has loaded; a shell has no client, so it would stay off the map and
/// the stale sweep would free it. The engine finishes its own warps itself, and
/// this does the same for a held shell a script warped (unitwarp), or that
/// rAthena's follow timer carried after its target through a warp (pcfollow).
static void pop_shell_finish_script_warp(map_session_data *sd)
{
	if (sd->prev != nullptr || !sd->state.active || map_id2bl(sd->id) != sd || pc_isdead(sd))
		return;
	if (pop_shell_finish_map_placement(sd))
		pop_shell_broadcast_map_placement(sd);
}

/// unitattack on a character only swings at a target in reach; otherwise rAthena
/// asks the character's client to walk over (clif_movetoattack), and a shell has
/// none. Walk a held shell into range the way a monster chases; rAthena's own walk
/// code then attacks on arrival, and chases again if the target moved on.
static void pop_shell_chase_attack(map_session_data *sd)
{
	unit_data &ud = sd->ud;
	if (ud.target == 0 || !ud.state.attack_continue || ud.attacktimer != INVALID_TIMER
		|| unit_is_walking(sd) || sd->prev == nullptr || pc_isdead(sd))
		return;
	block_list *tbl = map_id2bl(ud.target);
	if (tbl == nullptr || tbl->m != sd->m || status_isdead(*tbl)) {
		unit_stop_attack(sd);
		return;
	}
	const int range = status_get_status_data(*sd)->rhw.range;
	if (check_distance_bl(sd, tbl, range))
		return;
	if (!unit_walktobl(sd, tbl, range, 2))
		unit_stop_attack(sd); // unreachable: give the order up rather than retry forever
}

TIMER_FUNC(pc_follow_timer); // pc.cpp; no header declares it

/// Why a held shell lost whoever it followed: @shell_lost in its lost event.
enum PopulationShellLostReason : int {
	POP_LOST_TELEPORTED    = 1, ///< vanished from this map without a portal (fly wing, a skill)
	POP_LOST_LEFT_MAP      = 2, ///< left the map without a portal (butterfly wing, Kafra, Warp Portal)
	POP_LOST_PORTAL_FAILED = 3, ///< left by a portal the shell could not reach in time
	POP_LOST_OUT_OF_REACH  = 4, ///< walked somewhere the shell cannot path to
};

static void pop_shell_follow_reset(map_session_data *sd)
{
	sd->pop.hold.follow_seen_m = -1;
	sd->pop.hold.follow_portal = 0;
	sd->pop.hold.follow_portal_until = 0;
}

/// The warp near (x, y) on map m that leads to dest_mapindex, if any. The cell
/// a target was last seen on is a step or two short of the warp it took.
static npc_data *pop_find_warp_near(int16_t m, int16_t x, int16_t y, uint16_t dest_mapindex)
{
	map_data *mapdata = map_getmapdata(m);
	if (mapdata == nullptr)
		return nullptr;
	for (int32 i = 0; i < mapdata->npc_num; ++i) {
		npc_data *nd = mapdata->npc[i];
		if (nd == nullptr || nd->subtype != NPCTYPE_WARP || nd->is_invisible || nd->u.warp.mapindex != dest_mapindex)
			continue;
		if (std::abs(nd->x - x) <= nd->u.warp.xs + 2 && std::abs(nd->y - y) <= nd->u.warp.ys + 2)
			return nd;
	}
	return nullptr;
}

/// One tick of a held shell's follow. Same map and in reach: walk after the
/// target as rAthena's follow does. Gone through a portal: walk into that
/// portal, which warps the shell as it warps a player. Gone any other way:
/// the follow ends, and the reason is returned for the lost event (0 = still
/// following).
static int pop_shell_follow_step(map_session_data *sd, t_tick now)
{
	s_pop_hold &p = sd->pop.hold;
	block_list *tbl = map_id2bl(sd->followtarget);
	if (tbl == nullptr) {
		// Logged out or gone: nobody to tell.
		pc_stop_following(sd);
		pop_shell_follow_reset(sd);
		return 0;
	}
	if (sd->prev == nullptr || tbl->prev == nullptr || pc_isdead(sd))
		return 0; // one of them is between maps; look again next tick
	const bool can_walk = !unit_is_walking(sd) && DIFF_TICK(now, p.follow_next_walk) >= 0
		&& sd->ud.skilltimer == INVALID_TIMER && sd->ud.attacktimer == INVALID_TIMER;
	const bool reachable = tbl->m == sd->m && unit_can_reach_bl(sd, tbl, AREA_SIZE, 0, nullptr, nullptr);

	if (p.follow_portal != 0) {
		if (reachable) {
			pop_shell_follow_reset(sd); // through, or the target came back
		} else {
			npc_data *nd = map_id2nd(p.follow_portal);
			if (nd == nullptr || nd->m != sd->m || DIFF_TICK(now, p.follow_portal_until) > 0)
				return POP_LOST_PORTAL_FAILED;
			if (can_walk) {
				p.follow_next_walk = now + 500;
				if (!unit_walktoxy(sd, nd->x, nd->y, 0))
					return POP_LOST_PORTAL_FAILED;
			}
			return 0;
		}
	}

	const bool seen_here = p.follow_seen_m == sd->m;
	if (tbl->m == sd->m) {
		// Walking moves a few cells between ticks; a fly wing or a portal moves many.
		const bool jumped = seen_here && distance_xy(p.follow_seen_x, p.follow_seen_y, tbl->x, tbl->y) > 6;
		if (reachable || !jumped) {
			p.follow_seen_m = sd->m;
			p.follow_seen_x = tbl->x;
			p.follow_seen_y = tbl->y;
			if (can_walk && !check_distance_bl(sd, tbl, 5)) {
				p.follow_next_walk = now + 500;
				const bool walking = reachable ? unit_walktobl(sd, tbl, 5, 0) : unit_walktoxy(sd, tbl->x, tbl->y, 0);
				if (!walking && !reachable)
					return POP_LOST_OUT_OF_REACH;
			}
			return 0;
		}
	}
	// Gone out of reach at a jump, on this map or to another: a portal near
	// where it was last seen, leading where it went, is one the shell can take.
	if (seen_here) {
		npc_data *nd = pop_find_warp_near(sd->m, p.follow_seen_x, p.follow_seen_y, map_id2index(tbl->m));
		if (nd != nullptr) {
			p.follow_portal = nd->id;
			p.follow_portal_until = now + 15000;
			// A follower notices a moment later, then walks the few cells it
			// trailed by: through the portal a second or two after the target.
			p.follow_next_walk = now + 400 + rnd() % 800;
			return 0;
		}
	}
	return tbl->m == sd->m ? POP_LOST_TELEPORTED : POP_LOST_LEFT_MAP;
}

/// End a held shell's follow and run its lost event, with the followed player
/// attached. Called after the sweep's loop: the event's script may spawn shells,
/// which would invalidate the loop over g_population_engine_pcs.
static void pop_shell_follow_lost(int32_t shell_id, int32_t target_id, int reason)
{
	map_session_data *sd = map_id2sd(shell_id);
	if (sd == nullptr || !population_engine_is_population_pc(shell_id))
		return;
	pc_stop_following(sd);
	pop_shell_follow_reset(sd);
	map_session_data *tsd = map_id2sd(target_id);
	if (sd->pop.hold.lost_event.empty() || tsd == nullptr || population_engine_is_population_pc(tsd->id))
		return;
	pc_setreg(tsd, add_str("@shell_gid"), sd->id);
	pc_setreg(tsd, add_str("@shell_lost"), reason);
	npc_event(tsd, sd->pop.hold.lost_event.c_str(), 0);
}

/// The stale collection's part: see population_shell_control.hpp.
void population_shell_control_place_held(map_session_data *sd)
{
	if (population_engine_shell_is_held(sd))
		pop_shell_finish_script_warp(sd);
}

/// The engine's part in a hold, from the combat timer before its stale sweep:
/// finishes warps, chases attack orders, and ends the holds that lapsed or whose
/// NPC no longer exists (a script reload), so a script that stops caring never
/// leaves a frozen shell behind.
void population_shell_control_sweep()
{
	struct Lost { int32_t shell, target; int reason; };
	std::vector<Lost> lost;
	const t_tick now = gettick();
	for (map_session_data *sd : g_population_engine_pcs) {
		if (sd == nullptr || sd->pop.hold.npc == 0 || sd->pop.hold.despawn_pending)
			continue;
		pop_shell_finish_script_warp(sd);
		if (!population_engine_shell_is_held(sd) || map_id2nd(sd->pop.hold.npc) == nullptr) {
			pop_shell_end_hold(sd);
			continue;
		}
		// pcfollow: take the follow over from rAthena's timer, which would
		// teleport the shell after a target it cannot reach.
		if (sd->followtimer != INVALID_TIMER) {
			delete_timer(sd->followtimer, pc_follow_timer);
			sd->followtimer = INVALID_TIMER;
		}
		if (sd->followtarget > 0) {
			const int reason = pop_shell_follow_step(sd, now);
			if (reason != 0)
				lost.push_back({ sd->id, sd->followtarget, reason });
		} else if (sd->pop.hold.follow_seen_m >= 0 || sd->pop.hold.follow_portal != 0) {
			pop_shell_follow_reset(sd); // pcstopfollow
		}
		pop_shell_chase_attack(sd);
	}
	for (const Lost &l : lost)
		pop_shell_follow_lost(l.shell, l.target, l.reason);
}

int32_t population_engine_shell_spawn(int32_t npc_id, int16_t m, int16_t x, int16_t y,
	uint16_t job, int base_level, const char *name, int sex, int flags)
{
	if (!battle_config.population_engine_enable || npc_id == 0 || m < 0)
		return 0;
	if (g_population_engine_count.load() >= static_cast<size_t>(battle_config.population_engine_max_count))
		return 0;
	if (!job_db.exists(job))
		return 0;
	// The job's profile supplies gear, stats and skills, as for an ambient spawn.
	std::shared_ptr<PopulationEngine> prof = population_engine_db().find(job);
	if (prof == nullptr) {
		ShowWarning("population_spawn: job %u has no population profile to inherit.\n", job);
		return 0;
	}
	// A name is how players and later commands address the shell, so it must be free.
	if (name != nullptr && name[0] != '\0') {
		if (strlen(name) >= NAME_LENGTH || map_nick2sd(name, false) != nullptr)
			return 0;
	}
	if (x == 0 && y == 0) {
		if (!map_search_freecell(nullptr, m, &x, &y, -1, -1, 1))
			return 0;
	} else if (!map_getcell(m, x, y, CELL_CHKPASS)) {
		if (!map_search_freecell(nullptr, m, &x, &y, 3, 3, 1))
			return 0;
	}
	const uint32_t index = population_engine_allocate_index();
	if (index == 0)
		return 0;

	char sx = get_job_required_sex(job);
	if (sx == '\0' && (sex == SEX_MALE || sex == SEX_FEMALE))
		sx = (sex == SEX_MALE) ? 'M' : 'F';
	if (sx == '\0')
		sx = prof->sex_override >= 0 ? (prof->sex_override ? 'M' : 'F') : ((rnd() % 2) ? 'M' : 'F');
	auto pick = [](const std::vector<uint16_t> &pool) -> uint16_t {
		return pool.empty() ? 0 : pool[rnd() % pool.size()];
	};
	const uint8_t map_category = map_getmapflag(m, MF_TOWN) ? 1 : 2;

	// g_pop_draft_level is how spawn_shell takes a level it did not roll itself;
	// it still clamps it to the profile's band.
	g_pop_draft_level = static_cast<int16_t>(base_level > 0 ? cap_value(base_level, 1, MAX_LEVEL) : 0);
	map_session_data *sd = population_engine_spawn_shell(
		m, x, y, index, job, sx,
		static_cast<uint8_t>(population_roll_closed_range(MIN_HAIR_STYLE, MAX_HAIR_STYLE)),
		static_cast<uint16_t>(population_roll_closed_range(MIN_HAIR_COLOR, MAX_HAIR_COLOR)),
		pick(prof->weapon_pool), pick(prof->shield_pool),
		pick(prof->head_top_pool), pick(prof->head_mid_pool), pick(prof->head_bottom_pool),
		0, static_cast<uint16_t>(population_roll_closed_range(MIN_CLOTH_COLOR, MAX_CLOTH_COLOR)),
		pick(prof->garment_pool), prof->script, false, prof.get(), map_category, PopulationDbSource::Main);
	g_pop_draft_level = 0;
	if (sd == nullptr) {
		g_population_engine_stats.errors++;
		return 0;
	}
	g_population_engine_pcs.push_back(sd);
	g_population_engine_count++;
	g_population_engine_stats.total_created++;
	g_population_engine_stats.active_units++;

	// A town merchant's profile opens a stall at spawn. An actor is not a shop.
	if (pop_shell_is_vendor(sd)) {
		population_engine_shell_close_stall(sd);
		sd->pop.behavior = sd->pop.behavior_base = static_cast<uint8_t>(PopulationBehavior::Wander);
	}
	// Sit and Vendor profiles sit their shell down at spawn, and a sitting
	// character cannot walk, follow or attack. An actor arrives standing; the
	// script sits it down if the scene wants that.
	if (pc_issit(sd) && pc_setstand(sd, false)) {
		skill_sit(sd, 0);
		clif_standing(*sd);
	}
	if (name != nullptr && name[0] != '\0') {
		safestrncpy(sd->status.name, name, NAME_LENGTH);
		clif_name_area(sd);
	}
	sd->pop.hold.spawned = true;
	sd->pop.hold.keep = (flags & POP_SPAWN_KEEP) != 0;
	sd->pop.hold.npc = npc_id;
	sd->pop.hold.until = gettick() + POP_HOLD_DEFAULT_MS;
	pop_shell_stop_ai_action(sd);
	return sd->id;
}

static TIMER_FUNC(pop_shell_despawn_timer)
{
	map_session_data *sd = map_id2sd(static_cast<int32>(id));
	// despawn_pending: the shell may have gone another way in the meantime, and
	// whatever holds its id now was not what the script meant.
	if (sd == nullptr || !population_engine_is_population_pc(sd->id) || pop_is_companion(sd)
		|| !sd->pop.hold.despawn_pending)
		return 0;
	if (data == POP_DESPAWN_FLYWING && sd->prev != nullptr)
		clif_clearunit_area(*sd, CLR_TELEPORT);
	population_engine_shell_release(sd);
	return 0;
}

bool population_engine_shell_despawn(int32_t gid, int style)
{
	if (!population_engine_is_population_pc(gid))
		return false;
	map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr || pop_is_companion(sd))
		return false;
	if (sd->pop.hold.despawn_pending)
		return true;
	// Deferred one tick: the script that asked may still be using the shell in
	// the same run, and releasing frees it.
	sd->pop.hold.despawn_pending = true;
	pop_shell_stop_ai_action(sd);
	static bool named = false; // the timer's name for rAthena's timer diagnostics
	if (!named) {
		add_timer_func_list(pop_shell_despawn_timer, "pop_shell_despawn_timer");
		named = true;
	}
	add_timer(gettick() + 1, pop_shell_despawn_timer, gid,
		style == POP_DESPAWN_FLYWING ? POP_DESPAWN_FLYWING : POP_DESPAWN_LOGOUT);
	return true;
}

bool population_engine_shell_despawn_for(int32_t gid, int32_t npc_id, int style)
{
	if (npc_id == 0 || !population_engine_is_population_pc(gid))
		return false;
	const map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr)
		return false;
	// Its own actor, held or lapsed but not yet swept: this NPC's to remove.
	const bool own = sd->pop.hold.npc == npc_id;
	// Anything else only when nobody holds it and it is an ordinary ambient
	// shell: not a vendor mid-trade, not a companion, not another scene's actor.
	const bool free_ambient = sd->pop.hold.npc == 0 && population_engine_shell_kind(gid) == POP_SHELL_AMBIENT;
	if (!own && !free_ambient)
		return false;
	return population_engine_shell_despawn(gid, style);
}

bool population_engine_shell_set_whisper_event(int32_t gid, int32_t npc_id, const char *event)
{
	if (!population_engine_is_population_pc(gid))
		return false;
	map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr || npc_id == 0 || sd->pop.hold.npc != npc_id || !population_engine_shell_is_held(sd))
		return false;
	sd->pop.hold.whisper_event = (event != nullptr) ? event : "";
	return true;
}

bool population_engine_shell_set_lost_event(int32_t gid, int32_t npc_id, const char *event)
{
	if (!population_engine_is_population_pc(gid))
		return false;
	map_session_data *sd = map_id2sd(gid);
	if (sd == nullptr || npc_id == 0 || sd->pop.hold.npc != npc_id || !population_engine_shell_is_held(sd))
		return false;
	sd->pop.hold.lost_event = (event != nullptr) ? event : "";
	return true;
}

/// A whisper to a held shell: the holding script's event if it set one, else
/// silence -- a script's actor does not answer with an ambient canned line,
/// nor recruits into a party. Returns false when the shell is not held, and
/// the engine answers as usual.
bool population_shell_control_whisper(map_session_data *from_sd, map_session_data *bot_sd, const char *message)
{
	if (!population_engine_shell_is_held(bot_sd))
		return false;
	if (!bot_sd->pop.hold.whisper_event.empty()) {
		pc_setreg(from_sd, add_str("@shell_gid"), bot_sd->id);
		pc_setregstr(from_sd, add_str("@shell_msg$"), message);
		npc_event(from_sd, bot_sd->pop.hold.whisper_event.c_str(), 0);
	}
	return true;
}
