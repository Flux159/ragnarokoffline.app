// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// Copyright (c) Louis T Steinhil - https://github.com/YlenXWalker
// For more information, see LICENCE in the main folder
//
// Population engine: spawns fake PC shells to fill maps with lifelike activity.
// Includes wander AI, combat AI, ambient chat, and YAML-driven equipment/skill profiles.

#include "population_engine.hpp"
#include "population_engine/population_shell_control.hpp" // RAGNAROKMAC

#include "population_engine/runtime/population_engine_combat.hpp"
#include "population_engine/runtime/population_shell_ammo.hpp"
#include "population_engine/runtime/population_shell_loot.hpp"
#include "population_engine/runtime/population_shell_selling.hpp"
#include "population_engine/runtime/population_shell_runtime.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <common/malloc.hpp>
#include <common/mapindex.hpp>
#include <common/mmo.hpp>
#include <common/random.hpp>
#include <common/showmsg.hpp>
#include <common/socket.hpp>
#include <common/strlib.hpp>
#include <common/timer.hpp>
#include <common/utils.hpp>
#include "battle.hpp"
#include "chrif.hpp"
#include "clif.hpp"
#include "intif.hpp"
#include "itemdb.hpp"
#include "log.hpp"
#include "map.hpp"
#include "mapreg.hpp"
#include "mob.hpp"
#include "npc.hpp"
#include "party.hpp"
#include "path.hpp"
#include "pc.hpp"
#include "pc_groups.hpp"
#include "script.hpp"
#include "skill.hpp"
#include "status.hpp"
#include "unit.hpp"
#include "vending.hpp"
#include "buyingstore.hpp"

#include "population_engine/config/population_config.hpp"
#include "population_engine/config/population_yaml_types.hpp"
#include "population_engine/core/population_engine_core.hpp"
#include "population_engine/runtime/population_engine_path.hpp"

// Unity-build: all submodule translation units compiled via the factory.
#include "population_engine/population_engine_factory.cpp"
#include "population_engine/core/pe_perf.hpp"
#include "homunculus.hpp"

// RAGNAROKMAC (homunculus): defined in homunculus.cpp, but this pin exports no declaration
// of it through a header our TU includes. Declared at FILE scope on purpose - a declaration
// inside an anonymous namespace would give it internal linkage and fail to link.
void hom_alloc(map_session_data *sd, struct s_homunculus *hom);

// Goal 2: per-shell equipment fingerprint (id -> last-snapshotted hash). A cheap
// sum of equipped item ids; recomputed each combat tick, re-snapshot only on change.
static std::unordered_map<int32_t, uint64_t> g_pop_companion_gear_hash;

static uint64_t pop_companion_gear_hash(const map_session_data *sd)
{
	uint64_t hash = 0;
	for (int16_t i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = sd->inventory.u.items_inventory[i];
		if (!slot.nameid || !slot.equip) continue;
		hash = hash * 1000003ULL + (uint64_t)slot.nameid * 31ULL + (uint64_t)slot.equip;
	}
	hash = hash * 1000003ULL + (uint64_t)sd->status.base_level;
	hash = hash * 1000003ULL + (uint64_t)sd->status.job_level;
	return hash;
}


std::vector<map_session_data *> g_population_engine_pcs;

// ----------------------------------------------------------------------
// Dynamic vendor stock cache.
//
// Building a vendor's source-map list and walking every map's mob drop
// table on EVERY shell spawn was a measurable lag source (autosummon
// can spawn dozens of vendor shells per tick). The drop tables are
// effectively static at runtime, so we cache:
//   - the resolved source-map id list per vendor key
//   - a pre-sorted DropEntry pool per (vendor key, source map id)
// Cache is invalidated on vendor/spawn YAML reload.
// ----------------------------------------------------------------------
struct PopVendorDropEntry { t_itemid nameid; uint32_t rate; };
struct PopVendorCacheBucket {
	std::vector<int16> source_mids;
	std::unordered_map<int16, std::vector<PopVendorDropEntry>> drops_by_mid;
	bool source_mids_built = false;
};
static std::unordered_map<std::string, PopVendorCacheBucket> g_pop_vendor_dyn_cache;

/// RAGNAROKMAC: the base level the next spawn should take, set only around a
/// hired companion's draft (population_engine_companion_hire). 0 = roll as usual.
static int16_t g_pop_draft_level = 0;

void population_engine_vendor_dyn_cache_clear() {
	g_pop_vendor_dyn_cache.clear();
}

// Cache of jobs whose effective behavior is Vendor (any category override).
// Populated lazily by the autosummon timer; cleared on YAML reload.
static std::vector<uint16_t> g_pop_vendor_job_pool;
static bool                  g_pop_vendor_job_pool_built = false;
void population_engine_vendor_job_pool_clear() {
	g_pop_vendor_job_pool.clear();
	g_pop_vendor_job_pool_built = false;
}
static std::unordered_map<int32, t_tick> g_pop_chat_next_tick; ///< Per-shell next chat eligibility tick.
/// RAGNAROKMAC: last vendor callout per map, for a mod vendor's Callouts MapGapSeconds.
static std::unordered_map<int16, t_tick> g_pop_vendor_last_callout;
static bool pop_mod_vendor_callout_pace(const map_session_data* sd, const PopulationVendorEntry* ve, int& lo, int& hi);
static int32 g_pop_chat_timer = INVALID_TIMER;
static int32 g_population_combat_global_timer = INVALID_TIMER;
static size_t g_chat_cursor = 0;    ///< Round-robin index for batched chat replies.
// Last count written to cp_population_stats; UINT32_MAX = never written.
static uint32_t g_last_db_written_count = UINT32_MAX;

static const std::string kPopulationChatProfileDefault("default");

/// If equipment omits ChatProfile:, use "default" from db/population_chat.yml (must exist).
static const std::string& population_engine_chat_profile_key(const PopulationEngine* eq)
{
	if (eq != nullptr && !eq->chat_profile.empty())
		return eq->chat_profile;
	return kPopulationChatProfileDefault;
}

static void population_engine_chat_replace_all(std::string& s, const char* needle, const std::string& repl) {
	const size_t nlen = strlen(needle);
	if (nlen == 0)
		return;
	for (size_t pos = 0; (pos = s.find(needle, pos)) != std::string::npos; pos += repl.size()) {
		s.replace(pos, nlen, repl);
	}
}

/// RAGNAROKMAC: compact zeny for a chat callout - 1500000 -> "1.5M", 12000 -> "12K",
/// 500 -> "500z". Deliberately approximate (one decimal place); the exact price is in
/// the vend window. The {price} placeholder in population_chat.yml resolves through here.
static void population_engine_format_zeny_compact(uint32 z, char* out, size_t out_sz) {
	if (z >= 1000000) {
		const uint32 whole = z / 1000000;
		const uint32 frac = (z % 1000000) / 100000; // first decimal digit
		if (frac > 0)
			safesnprintf(out, out_sz, "%u.%uM", whole, frac);
		else
			safesnprintf(out, out_sz, "%uM", whole);
	} else if (z >= 10000) {
		safesnprintf(out, out_sz, "%uK", z / 1000);
	} else if (z >= 1000) {
		const uint32 whole = z / 1000;
		const uint32 frac = (z % 1000) / 100;
		if (frac > 0)
			safesnprintf(out, out_sz, "%u.%uK", whole, frac);
		else
			safesnprintf(out, out_sz, "%uK", whole);
	} else {
		safesnprintf(out, out_sz, "%uz", z);
	}
}

/// RAGNAROKMAC: pick one random live vend slot for a vendor shell so a callout names
/// something the shell actually sells, at its real price. Reads the standard rAthena
/// vending data (sd->vending[]/vend_num) populated by vending_openvending() at spawn.
/// Returns false when the shell is not vending or the slot is unusable, which the
/// {item}/{price} formatting path treats as "skip this line".
static bool population_engine_pick_vend_stock(map_session_data* sd, const char** ename_out, uint32* price_out) {
	// RAGNAROKMAC: a buying store's callout names something it is buying, at
	// what it pays.
	if (sd != nullptr && sd->state.buyingstore && sd->buyingstore.slots > 0) {
		const int pick = static_cast<int>(rnd() % sd->buyingstore.slots);
		const auto& bi = sd->buyingstore.items[pick];
		if (bi.nameid == 0 || bi.amount <= 0)
			return false;
		std::shared_ptr<item_data> id = item_db.find(bi.nameid);
		if (!id || id->ename.empty())
			return false;
		if (ename_out != nullptr)
			*ename_out = id->ename.c_str();
		if (price_out != nullptr)
			*price_out = static_cast<uint32>(bi.price);
		return true;
	}
	if (sd == nullptr || sd->vend_num <= 0)
		return false;
	const int pick = static_cast<int>(rnd() % static_cast<uint32>(sd->vend_num));
	const int16 cart_idx = sd->vending[pick].index;
	if (cart_idx < 0 || cart_idx >= MAX_CART)
		return false;
	const t_itemid nameid = sd->cart.u.items_cart[cart_idx].nameid;
	if (nameid == 0)
		return false;
	std::shared_ptr<item_data> id = item_db.find(nameid);
	if (!id || id->ename.empty())
		return false;
	if (ename_out != nullptr)
		*ename_out = id->ename.c_str();
	if (price_out != nullptr)
		*price_out = sd->vending[pick].value;
	return true;
}

static void population_engine_format_chat_line(map_session_data* sd, const char* templ, char* out, size_t out_sz) {
	if (!out || out_sz == 0)
		return;
	out[0] = '\0';
	if (!templ || !*templ)
		return;
	std::string s(templ);
	if (sd) {
		population_engine_chat_replace_all(s, "{name}", std::string(sd->status.name));
		const char* mapn = map_mapid2mapname(sd->m);
		population_engine_chat_replace_all(s, "{map}", std::string(mapn && mapn[0] ? mapn : "?"));
		const char* jn = job_name(sd->status.class_);
		population_engine_chat_replace_all(s, "{job}", std::string(jn && jn[0] ? jn : "?"));

		// RAGNAROKMAC: {item}/{price} name a real item from the shell's own vend so a
		// vendor callout tells the truth ("Poring Card, only 1M!"). Only resolved when
		// the line asks for it; a non-vendor (or a vendor with no sellable slot) leaves
		// `out` empty so the caller's blocked-line check skips it this tick.
		if (s.find("{item}") != std::string::npos || s.find("{price}") != std::string::npos) {
			const char* ename = nullptr;
			uint32 price = 0;
			if (!population_engine_pick_vend_stock(sd, &ename, &price))
				return; // out already "\0"
			char pricebuf[32];
			population_engine_format_zeny_compact(price, pricebuf, sizeof(pricebuf));
			population_engine_chat_replace_all(s, "{item}", std::string(ename));
			population_engine_chat_replace_all(s, "{price}", std::string(pricebuf));
		}
	}
	if (s.size() >= out_sz)
		s.resize(out_sz - 1);
	memcpy(out, s.c_str(), s.size() + 1);
}

/// Same format as player map chat (clif_process_message): "Name : message" so the client chat log shows the bot as speaker.
static void population_engine_send_public_chat_as_pc(map_session_data* bot_sd, const char* message_body)
{
	PE_PERF_SCOPE("chat.broadcast");
	if (!bot_sd || !message_body || !message_body[0] || !bot_sd->status.name[0])
		return;
	char line[CHAT_SIZE_MAX + NAME_LENGTH * 2];
	safesnprintf(line, sizeof(line), "%s : %s", bot_sd->status.name, message_body);
	clif_GlobalMessage(*bot_sd, line, AREA_CHAT_WOC);
}

static bool population_engine_chat_line_blocked(const char* msg) {
	if (!msg || !msg[0])
		return true;
	std::string lower(msg);
	std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });
	return population_yaml_name_hits_blocklist(lower);
}

static void population_engine_register_shell_chat_state(map_session_data* sd, const PopulationEngine* pop_cfg) {
	extern struct Battle_Config battle_config;
	if (!sd || !battle_config.population_engine_chat_enable)
		return;
	if (pop_cfg == nullptr)
		return;
	const std::vector<std::string>* pool = population_chat_db().pool_for_profile(population_engine_chat_profile_key(pop_cfg));
	if (pool == nullptr || pool->empty())
		return;
	const int32 j = battle_config.population_engine_chat_cooldown_jitter_ms;
	const t_tick when = gettick() + (j > 0 ? static_cast<t_tick>(rnd() % (static_cast<uint32_t>(j) + 1u)) : 0);
	g_pop_chat_next_tick[sd->id] = when;
}

static void population_engine_register_shell_wander_state(map_session_data *sd)
{
	population_engine_path_register_wander_state(sd);
}

static std::string generate_bot_name(uint32_t index); // defined later; used by population_roll_base_name_from_profile

static int16_t population_roll_closed_range(int16_t a, int16_t b)
{
	if (b < a)
		std::swap(a, b);
	const uint32_t span = static_cast<uint32_t>(b - a) + 1u;
	return static_cast<int16_t>(a + static_cast<int32_t>(rnd() % span));
}

static PopulationNameProfile::Strategy population_effective_name_strategy(const PopulationNameProfile* prof)
{
	if (!prof)
		return PopulationNameProfile::Strategy::BotIndex;
	if (prof->strategy != PopulationNameProfile::Strategy::None)
		return prof->strategy;

	const auto& g_syl0 = population_yaml_name_syl_start();
	const auto& g_sylm = population_yaml_name_syl_mid();
	const auto& g_syle = population_yaml_name_syl_end();
	const bool has_syl = (!prof->syllables_start.empty() || !prof->syllables_mid.empty() || !prof->syllables_end.empty()
		|| !g_syl0.empty() || !g_sylm.empty() || !g_syle.empty());
	if (has_syl)
		return PopulationNameProfile::Strategy::Syllables;
	if (!prof->pool.empty())
		return PopulationNameProfile::Strategy::PickOne;
	const auto& g_adj = population_yaml_name_adjectives();
	const auto& g_nou = population_yaml_name_nouns();
	if (!g_adj.empty() && !g_nou.empty())
		return PopulationNameProfile::Strategy::AdjectiveNoun;
	return PopulationNameProfile::Strategy::BotIndex;
}

static std::string population_roll_base_name_from_profile(PopulationNameProfile::Strategy strat, const PopulationNameProfile* prof, uint32_t index, uint32_t salt)
{
	const uint32_t variant = index + salt;

	auto pick_from = [](const std::vector<std::string>& profv, const std::vector<std::string>& glob) -> std::string {
		if (!profv.empty())
			return profv[rnd() % profv.size()];
		if (!glob.empty())
			return glob[rnd() % glob.size()];
		return std::string();
	};

	switch (strat) {
	case PopulationNameProfile::Strategy::BotIndex:
		return generate_bot_name(variant);
	case PopulationNameProfile::Strategy::PickOne: {
		if (!prof || prof->pool.empty())
			break;
		return prof->pool[rnd() % prof->pool.size()];
	}
	case PopulationNameProfile::Strategy::AdjectiveNoun: {
		const auto& g_adj = population_yaml_name_adjectives();
		const auto& g_nou = population_yaml_name_nouns();
		std::string adj = pick_from(prof != nullptr ? prof->adjectives : g_adj, g_adj);
		std::string noun = pick_from(prof != nullptr ? prof->nouns : g_nou, g_nou);
		if (adj.empty() || noun.empty())
			break;
		return adj + "_" + noun;
	}
	case PopulationNameProfile::Strategy::PrefixNumber: {
		const auto& prefs = population_yaml_name_global_prefixes();
		std::string pfx = !prefs.empty() ? prefs[rnd() % prefs.size()] : std::string("Bot");
		char buf[NAME_LENGTH];
		snprintf(buf, sizeof(buf), "%s%u", pfx.c_str(), static_cast<unsigned>(variant % 100000u));
		return std::string(buf);
	}
	case PopulationNameProfile::Strategy::Syllables: {
		const auto& g_syl0 = population_yaml_name_syl_start();
		const auto& g_sylm = population_yaml_name_syl_mid();
		const auto& g_syle = population_yaml_name_syl_end();
		std::string a, m, e;
		if (prof != nullptr) {
			a = pick_from(prof->syllables_start, g_syl0);
			m = pick_from(prof->syllables_mid, g_sylm);
			e = pick_from(prof->syllables_end, g_syle);
		} else {
			if (!g_syl0.empty())
				a = g_syl0[rnd() % g_syl0.size()];
			if (!g_sylm.empty())
				m = g_sylm[rnd() % g_sylm.size()];
			if (!g_syle.empty())
				e = g_syle[rnd() % g_syle.size()];
		}
		const std::string s = a + m + e;
		if (!s.empty())
			return s;
		break;
	}
	case PopulationNameProfile::Strategy::None:
	default:
		break;
	}
	return generate_bot_name(variant);
}

// Global state
static std::atomic<bool> g_population_engine_running(false);
static std::atomic<size_t> g_population_engine_count(0); // Atomic counter for fast access without mutex
static PopulationEngineStats g_population_engine_stats;

TIMER_FUNC(population_engine_chat_timer) {
	PE_PERF_SCOPE("timer.chat");
	extern struct Battle_Config battle_config;
	if (!battle_config.population_engine_chat_enable)
		return 0;

	const t_tick now = gettick();
	const int max_lines = battle_config.population_engine_chat_max_per_tick;
	int spoken = 0;
	size_t iterated = 0;

	const size_t n = g_population_engine_pcs.size();
	if (n == 0)
		return 0;
	if (g_chat_cursor >= n)
		g_chat_cursor = 0;

	// Periodic eviction of stale g_pop_chat_next_tick entries (shells that were released).
	// Runs a full sweep every 8 chat ticks (~4s at 500ms interval) instead of a
	// cursor-based partial scan whose position is meaningless after unordered_map rehash.
	{
		static int s_evict_countdown = 0;
		if (++s_evict_countdown >= 8) {
			s_evict_countdown = 0;
			auto it = g_pop_chat_next_tick.begin();
			while (it != g_pop_chat_next_tick.end()) {
				if (!population_engine_is_population_pc(it->first))
					it = g_pop_chat_next_tick.erase(it);
				else
					++it;
			}
		}
	}

	for (size_t i = 0; i < n && spoken < max_lines; ++i) {
		const size_t idx = (g_chat_cursor + i) % n;
		++iterated;
		map_session_data* raw_sd = g_population_engine_pcs[idx];
		if (raw_sd == nullptr || !raw_sd->state.active)
			continue;
		if (raw_sd->prev == nullptr)
			continue;
		if (map_id2bl(raw_sd->id) != raw_sd)
			continue;
		// RAGNAROKMAC (shell control API): a held shell says what its script says.
		if (population_engine_shell_is_held(raw_sd))
			continue;

		std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(raw_sd).find(raw_sd->status.class_);

		// Context-aware pool selection: vendor shells call out, arena shells taunt, hunters talk hunt, else idle/profile.
		const std::vector<std::string>* pool = nullptr;
		const auto beh = static_cast<PopulationBehavior>(raw_sd->pop.behavior);
		if (beh == PopulationBehavior::Vendor && raw_sd->pop.vendor_buying) {
			// RAGNAROKMAC: buyers call out what they buy; without buyer_call
			// lines they stay quiet rather than shout "Selling ...".
			pool = population_chat_db().lines_for_category("buyer_call");
			if (pool == nullptr || pool->empty())
				continue;
		} else if (beh == PopulationBehavior::Vendor)
			pool = population_chat_db().lines_for_category("vendor_call");
		else if (raw_sd->pop.arena_team > 0)
			pool = population_chat_db().lines_for_category("pvp_taunt");
		else if (raw_sd->pop.target_id != 0)
			pool = population_chat_db().lines_for_category("hunt");
		// Fallback to profile pool.
		if ((!pool || pool->empty()) && equipment)
			pool = population_chat_db().pool_for_profile(population_engine_chat_profile_key(equipment.get()));
		if (pool == nullptr || pool->empty())
			continue;

		t_tick next = 0;
		{
			auto it = g_pop_chat_next_tick.find(raw_sd->id);
			if (it != g_pop_chat_next_tick.end())
				next = it->second;
		}
		if (now < next)
			continue;

		// RAGNAROKMAC: a mod vendor with Callouts waits its turn on the map, so a
		// street of stalls takes turns instead of talking over one another.
		const PopulationVendorEntry* mod_ve = nullptr;
		int pace_lo = 0, pace_hi = 0;
		if (beh == PopulationBehavior::Vendor && !raw_sd->pop.vendor_spawn_id.empty()) {
			mod_ve = population_vendor_db().find(raw_sd->pop.vendor_key);
			if (!pop_mod_vendor_callout_pace(raw_sd, mod_ve, pace_lo, pace_hi)) {
				// Its mod switched callouts off; look again in a minute.
				g_pop_chat_next_tick[raw_sd->id] = now + 60000;
				continue;
			}
			if (mod_ve != nullptr && mod_ve->callout_map_gap_sec > 0) {
				auto lit = g_pop_vendor_last_callout.find(raw_sd->m);
				if (lit != g_pop_vendor_last_callout.end() &&
				    DIFF_TICK(now, lit->second) < static_cast<t_tick>(mod_ve->callout_map_gap_sec) * 1000) {
					g_pop_chat_next_tick[raw_sd->id] = now + 1000 + static_cast<t_tick>(rnd() % 3000);
					continue;
				}
			}
		}

		const std::string& pick = (*pool)[rnd() % pool->size()];
		char buf[CHAT_SIZE_MAX];
		population_engine_format_chat_line(raw_sd, pick.c_str(), buf, sizeof(buf));
		if (population_engine_chat_line_blocked(buf))
			continue;

		population_engine_send_public_chat_as_pc(raw_sd, buf);
		g_population_engine_stats.chat_lines_emitted++;

		const int32 base_cd = battle_config.population_engine_chat_cooldown_ms;
		const int32 jit = battle_config.population_engine_chat_cooldown_jitter_ms;
		t_tick add = static_cast<t_tick>(base_cd + (jit > 0 ? static_cast<int32>(rnd() % (static_cast<uint32_t>(jit) + 1u)) : 0));
		// RAGNAROKMAC: a mod vendor's own pace replaces the global cooldown.
		if (pace_hi > 0)
			add = static_cast<t_tick>(pace_lo + static_cast<int32>(rnd() % static_cast<uint32_t>(pace_hi - pace_lo + 1))) * 1000;
		if (beh == PopulationBehavior::Vendor)
			g_pop_vendor_last_callout[raw_sd->m] = now;
		g_pop_chat_next_tick[raw_sd->id] = now + add;
		spoken++;
	}
	g_chat_cursor = (g_chat_cursor + iterated) % std::max(n, size_t(1));
	return 0;
}

/// `whisper_to_sd` null = public map chat line ("Name : msg"); else whisper back.
static bool population_engine_deliver_chat_reply_locked(map_session_data* bot_sd, map_session_data* whisper_to_sd)
{
	extern struct Battle_Config battle_config;
	if (!bot_sd || !battle_config.population_engine_chat_enable || !battle_config.population_engine_chat_reply_enable)
		return false;
	if (bot_sd->prev == nullptr || map_id2bl(bot_sd->id) != bot_sd)
		return false;
	if (!bot_sd->status.name[0])
		return false;

	// Context-aware category selection: pick a situational category first, then fall back to profile pool.
	const std::vector<std::string>* pool = nullptr;
	const auto beh = static_cast<PopulationBehavior>(bot_sd->pop.behavior);

	// Determine context category from shell state.
	const char* ctx_category = nullptr;
	if (bot_sd->pop.arena_team > 0)
		ctx_category = "pvp_taunt";
	else if (beh == PopulationBehavior::Vendor)
		ctx_category = "shop";
	else if (bot_sd->pop.target_id != 0 || (bot_sd->pop.mob_tracker.tracked_mobs.size() > 0))
		ctx_category = "hunt";
	else if (beh == PopulationBehavior::Social || beh == PopulationBehavior::Wander)
		ctx_category = "idle";

	if (ctx_category)
		pool = population_chat_db().lines_for_category(ctx_category);

	// Fallback: profile pool (merged categories configured in population_chat.yml per profile).
	if (!pool || pool->empty()) {
		std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(bot_sd).find(bot_sd->status.class_);
		if (equipment == nullptr)
			return false;
		pool = population_chat_db().pool_for_profile(population_engine_chat_profile_key(equipment.get()));
	}
	if (!pool || pool->empty())
		return false;

	const t_tick now = gettick();
	t_tick next = 0;
	{
		auto it = g_pop_chat_next_tick.find(bot_sd->id);
		if (it != g_pop_chat_next_tick.end())
			next = it->second;
	}
	if (now < next)
		return false;

	const std::string& pick = (*pool)[rnd() % pool->size()];
	char buf[CHAT_SIZE_MAX];
	population_engine_format_chat_line(bot_sd, pick.c_str(), buf, sizeof(buf));
	if (population_engine_chat_line_blocked(buf))
		return false;

	if (whisper_to_sd != nullptr) {
		if (!session_isActive(whisper_to_sd->fd))
			return false;
		clif_wis_message(whisper_to_sd, bot_sd->status.name, buf, strlen(buf) + 1, pc_get_group_level(bot_sd));
	} else {
		population_engine_send_public_chat_as_pc(bot_sd, buf);
	}

	g_population_engine_stats.chat_lines_emitted++;
	const int32 base_cd = battle_config.population_engine_chat_cooldown_ms;
	const int32 jit = battle_config.population_engine_chat_cooldown_jitter_ms;
	const t_tick add = static_cast<t_tick>(base_cd + (jit > 0 ? static_cast<int32>(rnd() % (static_cast<uint32_t>(jit) + 1u)) : 0));
	g_pop_chat_next_tick[bot_sd->id] = now + add;
	return true;
}

static PopulationEngineConfig g_current_config;
static int32 g_autosummon_timer = INVALID_TIMER;
// RAGNAROKMAC: Pool-vendor rotation. Fires every POP_VENDOR_ROTATION_TICK_MS and
// releases vendor shells whose per-shell vendor_rotation_at has passed; the
// autosummon pass refills with a fresh pool pick + title. See the Pool branch in
// population_engine_spawn_shell.
static int32 g_vendor_rotation_timer = INVALID_TIMER;
static constexpr int32 POP_VENDOR_ROTATION_TICK_MS = 60000; // 60s is plenty for an hours-scale rotation.
/// 5M-slot ID pool; index in [1, POPULATION_ENGINE_INDEX_MAX) keeps account_id below POPULATION_ENGINE_ACCOUNT_ID_END.
static constexpr uint32_t POPULATION_ENGINE_INDEX_MAX = POPULATION_ENGINE_ACCOUNT_ID_END - POPULATION_ENGINE_ACCOUNT_ID_BASE;
static std::atomic<uint32_t> g_next_population_engine_index(1);
/// RAGNAROKMAC: indices owned by a PERSISTED companion, loaded from
/// `cp_companion_persistence`. The ambient allocator must never issue one of these: the
/// counter above resets to 1 on every engine start while a recruited companion keeps its
/// permanent index, so without this reservation an ambient shell can be handed an index a
/// companion already owns. Both then share `char_id == CHAR_ID_BASE + index`, and because
/// the skill selector resolves "the live shell" BY INDEX, the player's selection lands on
/// the ambient shell while the UI (name-based) shows the companion - so clearly-disabled
/// skills keep being cast. Loaded lazily on first use because the table is provisioned by
/// the supervisor at boot, which can run after the engine starts.
static std::unordered_set<uint32_t> g_reserved_companion_indices;
static bool g_reserved_companion_indices_loaded = false;

// Forward declarations.
/// RAGNAROKMAC (vehicles): declared here because the job-advance path calls it long
/// before its definition, which sits with spawn_shell further down.
static void population_engine_sync_shell_vehicle(map_session_data *sd);
static void population_engine_sync_shell_homunculus(map_session_data *sd);
/// RAGNAROKMAC (homunculus, phase 3c): can this JOB have a pet at all?
///
/// The attach gate asks the live shell (`pc_checkskill(sd, AM_CALLHOMUN)`), which cannot answer
/// for a benched companion - the panel has to decide whether to draw a control at all. So ask the
/// source both of them share: this job's granted skill tree. `SkillTreeDatabase::loadingFinished`
/// flattens `Inherit` into `tree->skills`, so Alchemist -> Creator -> Biolo all answer true here
/// while every other job answers false, with no job whitelist to maintain.
bool population_engine_class_can_have_homunculus(uint16_t class_)
{
	std::shared_ptr<s_skill_tree> tree = skill_tree_db.find(class_);
	if (tree == nullptr)
		return false;
	for (const auto &entry : tree->skills) {
		if (entry.first == AM_CALLHOMUN && entry.second && entry.second->max_lv > 0)
			return true;
	}
	return false;
}

/// RAGNAROKMAC (homunculus, phase 3): this companion's stored pet state.
///
/// The pet's own level and exp have to live here rather than in the char server: `hom_id` stays 0
/// (see the attach), so nothing stock can ever load or save this pet.
///
/// Absent columns or an absent row leave the defaults - enabled = -1 ("never chosen", which means
/// on for this class), class 0 (derive it), level 0 (a new pet starts at 1), exp 0. That is
/// deliberate: an install whose table predates the v8 columns must behave exactly as it did
/// before, not lose its pet.
static void population_engine_load_shell_homunculus(map_session_data *sd, int *enabled,
	uint32_t *class_, uint32_t *level, long long *exp_)
{
	*enabled = -1;
	*class_ = 0;
	*level = 0;
	*exp_ = 0;

	if (sd == nullptr || mmysql_handle == nullptr)
		return;
	const uint32_t owner = sd->pop.companion_owner_account;
	if (owner == 0)
		return; // not a recruited companion: nothing can be stored against it
	const uint32_t index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;

	char q[320];
	snprintf(q, sizeof(q),
		"SELECT hom_enabled, hom_class, hom_level, hom_exp FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		owner, sd->pop.companion_owner_char, index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		if (data != nullptr && data[0] != '\0')
			*enabled = atoi(data); // NULL arrives as an empty string, which must stay "never chosen"
		Sql_GetData(mmysql_handle, 1, &data, nullptr);
		if (data != nullptr)
			*class_ = static_cast<uint32_t>(atoi(data));
		Sql_GetData(mmysql_handle, 2, &data, nullptr);
		if (data != nullptr)
			*level = static_cast<uint32_t>(atoi(data));
		Sql_GetData(mmysql_handle, 3, &data, nullptr);
		if (data != nullptr)
			*exp_ = atoll(data);
	}
	Sql_FreeResult(mmysql_handle);
}

/// RAGNAROKMAC (homunculus): give an alchemist-line shell the homunculus its class entitles it
/// to, driven by the engine rather than by a client.
///
/// The stock path cannot serve a shell. `hom_create_request()` creates nothing in the map
/// server - it fills a struct and asks the CHAR server (`intif_homunculus_create`), and a shell
/// carries a synthetic identity (`char_id == POPULATION_ENGINE_CHAR_ID_BASE + index`) with no
/// `char` row for a `homunculus` row to belong to. So build `s_homunculus` in memory exactly as
/// `hom_create_request` does and hand it to `hom_alloc()`, which is the map-side alloc/attach
/// and touches nothing off-server.
///
/// `sd->status.hom_id` is deliberately left at 0, which keeps the load at login in `pc.cpp` from
/// firing and makes the row delete in `unit_free`'s BL_HOM case match nothing. It does NOT make
/// a save harmless: the char server reads hom_id 0 as a new homunculus and INSERTs a row, so
/// patch 0012 drops that save request for population accounts. Nothing stock can
/// load or save this pet, so its own state is persisted separately - the companion's level and
/// exp are the engine's to keep.
///
/// Idempotent: a shell that already has one is left alone, so this is safe on every recall.
static void population_engine_sync_shell_homunculus(map_session_data *sd)
{
	if (sd == nullptr)
		return;
	// Never touch a real player's homunculus.
	if (!population_engine_is_population_pc(sd->id))
		return;
	if (sd->hd != nullptr)
		return; // already attached
	// Alchemist line only, through the class's own skill: a skill gate needs no job whitelist,
	// so advancing Alchemist -> Creator keeps the pet without a list to maintain.
	if (pc_checkskill(sd, AM_CALLHOMUN) <= 0)
		return;

	// Deterministic class per companion. Stock picks at random (`HM_CLASS_BASE + rnd_value(0,7)`),
	// which is fine for a one-off creation but wrong here: this runs again after every recall, so
	// a random pick would change the pet out from under the player.
	if (sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE)
		return; // not a population shell
	const uint32_t index = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;

	// What this companion had last session, and whether it wants a pet at all.
	int wanted = -1;
	uint32_t stored_class = 0, stored_level = 0;
	long long stored_exp = 0;
	population_engine_load_shell_homunculus(sd, &wanted, &stored_class, &stored_level, &stored_exp);

	// Only an explicit 0 means no: NULL is "never chosen", and for this class that is on.
	if (wanted == 0)
		return;

	// Deterministic class per companion, unless the row already remembers a better answer.
	int32_t hom_class = (stored_class > 0)
		? static_cast<int32_t>(stored_class)
		: HM_CLASS_BASE + static_cast<int32_t>(index % 8);

	std::shared_ptr<s_homunculus_db> homun_db = homunculus_db.homun_search(hom_class);

	if (homun_db == nullptr) {
		// A stored class the current data set no longer has must not cost the companion its pet:
		// fall back to the derived class and let the next snapshot correct the row.
		hom_class = HM_CLASS_BASE + static_cast<int32_t>(index % 8);
		homun_db = homunculus_db.homun_search(hom_class);
		if (homun_db == nullptr)
			return; // unknown class: do not hand hom_alloc something it would request a delete for
	}

	struct s_homunculus homun;
	memset(&homun, 0, sizeof(homun));
	safestrncpy(homun.name, homun_db->name, NAME_LENGTH - 1);
	homun.class_ = hom_class;
	// A new pet starts at level 1; a returning one resumes where it was. Level is what hom_alloc
	// turns into exp_next, so restoring it also restores the threshold the next kill is measured
	// against - a pet restored at level 1 with a level-40 threshold would look permanently stalled.
	homun.level = (stored_level > 0) ? static_cast<int32_t>(stored_level) : 1;
	homun.exp = static_cast<t_exp>(stored_exp);
	homun.hunger = 32; // stock newborn values, as hom_create_request sets them
	homun.intimacy = 2100;
	homun.char_id = sd->status.char_id;
	// homun.hom_id stays 0 - that is what keeps the char server out of this.

	const s_hom_stats base = homun_db->base;
	homun.max_hp = base.HP;
	homun.max_sp = base.SP;
	homun.str = base.str * 10;
	homun.agi = base.agi * 10;
	homun.vit = base.vit * 10;
	homun.int_ = base.int_ * 10;
	homun.dex = base.dex * 10;
	homun.luk = base.luk * 10;
	// A summon arrives healthy. Stock's `hp = 10` is a newborn's first breath and would leave a
	// companion's pet dead on arrival beside a levelled companion.
	homun.hp = homun.max_hp;
	homun.sp = homun.max_sp;

	hom_alloc(sd, &homun);
}

static map_session_data* population_engine_spawn_shell(int16_t map_id, int x, int y, uint32_t index,
	uint16_t job_id, char sex, uint8_t hair_style, uint16_t hair_color,
	uint16_t weapon, uint16_t shield, uint16_t head_top, uint16_t head_mid,
	uint16_t head_bottom, uint32_t option, uint16_t cloth_color, uint16_t garment,
	struct script_code* init_script, bool skip_arrow, const PopulationEngine* pop_cfg,
	uint8_t map_category = 0,
	PopulationDbSource db_source = PopulationDbSource::Main,
	const PopulationVendorEntry* mod_entry = nullptr,
	const PopulationModSpawn* mod_spawn = nullptr,
	int16_t mod_seat = -1,
	const PopulationShellReturn* returning = nullptr);
static std::string generate_bot_name(uint32_t index);
static std::string generate_population_pc_name(uint32_t index, const PopulationEngine* cfg);
static int16_t get_random_job_id();
static char    get_job_required_sex(uint16_t job_id);
static uint16_t get_base_job(uint16_t job_id);
static uint16_t get_job_weapon(uint16_t job_id);
static uint16_t get_random_headgear(uint8_t slot);
static uint16_t get_random_costume_robe();
static uint16_t find_valid_equip_item(uint32 equip_type);

/// Equip one item on a shell. `force_pos` overrides the item's equip bitmask — use for
/// accessories where the item supports both L and R but we need a specific slot.
static void population_engine_shell_equip_item(map_session_data* sd, t_itemid nameid, uint32_t index, const char* slot_label, uint32 force_pos = 0)
{
	if (!sd || nameid == 0)
		return;
	// Guard against max_weight reset by prior pc_equipitem → status_calc_pc calls.
	sd->max_weight = 2000000;
	struct item tmp_item = {};
	tmp_item.nameid = nameid;
	tmp_item.amount = 1;
	tmp_item.identify = 1;
	tmp_item.equip = 0;
	enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
	if (result != ADDITEM_SUCCESS) {
		ShowWarning("Population engine: Failed to add %s item %u to population shell %u (result: %d)\n",
			slot_label ? slot_label : "?", (unsigned)nameid, index, result);
		return;
	}
	for (int16 i = 0; i < MAX_INVENTORY; i++) {
		const auto& slot = sd->inventory.u.items_inventory[i];
		if (slot.nameid == nameid && slot.amount > 0 && slot.equip == 0) {
			struct item_data* id = itemdb_search(nameid);
			if (id && id->equip) {
				const uint32 pos = (force_pos != 0) ? force_pos : id->equip;
				(void)pc_equipitem(sd, i, pos, false);
			} else {
				if (!id)
					ShowWarning("Population engine: %s %u not found in itemdb for population shell %u\n",
						slot_label ? slot_label : "?", (unsigned)nameid, index);
				else if (!id->equip)
					ShowWarning("Population engine: %s %u has no equip flags for population shell %u\n",
						slot_label ? slot_label : "?", (unsigned)nameid, index);
			}
			break;
		}
	}
}
static void population_engine_sync_vd_weapon_shield(map_session_data* sd);
static void population_engine_destroy_failed_spawn(map_session_data* sd);

/// Count population shells on a specific map.
/// job_id = UINT16_MAX counts all jobs; otherwise counts only shells matching that job.
static size_t population_engine_count_shells_on_map(int16_t map_id, uint16_t job_id = UINT16_MAX) {
    size_t count = 0;
    for (map_session_data* sd : g_population_engine_pcs) {
        // RAGNAROKMAC: a script's population_spawn actor is outside every quota.
        if (sd && sd->m == map_id && !sd->pop.hold.spawned) {
            if (job_id == UINT16_MAX || sd->status.class_ == job_id)
                count++;
        }
    }
    return count;
}

/// Count shells whose job belongs to a given profile job list.
/// Used by fill_category to compute the per-map deficit so the autosummon
/// timer does not keep stacking shells onto maps that are already at quota.
static size_t population_engine_count_shells_on_map_for_profile(
        int16_t map_id, const std::vector<uint16_t>& jobs)
{
    size_t count = 0;
    for (map_session_data* sd : g_population_engine_pcs) {
        if (!sd || sd->m != map_id || sd->pop.hold.spawned) continue; // RAGNAROKMAC
        const uint16_t c = static_cast<uint16_t>(sd->status.class_);
        for (uint16_t j : jobs) {
            if (c == j) { ++count; break; }
        }
    }
    return count;
}

/// Count vendor-behavior shells (state.vending == 1) currently on a map.
/// Used by the VendorPlacement-driven autosummon pass to enforce MaxVendors.
static size_t population_engine_count_vendors_on_map(int16_t map_id) {
    size_t count = 0;
    for (map_session_data* sd : g_population_engine_pcs) {
        // RAGNAROKMAC: mod vendor shells have their own counts; never let them
        // use up the engine's own MaxVendors. (No mods -> no change.)
        if (sd && sd->m == map_id && sd->state.vending && sd->pop.vendor_spawn_id.empty())
            ++count;
    }
    return count;
}

/// RAGNAROKMAC: shells of one mod vendor spawn block on a map, whatever their
/// state (a shell whose stall failed to open still holds its place, so the pass
/// does not spawn replacements forever). `seat` >= 0 counts only that seat.
static size_t population_engine_count_mod_shells(int16_t map_id, const std::string& spawn_id, int16_t seat = -1) {
    size_t count = 0;
    for (map_session_data* sd : g_population_engine_pcs) {
        if (sd && sd->m == map_id && sd->pop.vendor_spawn_id == spawn_id &&
            (seat < 0 || sd->pop.vendor_seat == seat))
            ++count;
    }
    return count;
}



// Forward declaration — defined after population_engine_shell_release.
int32 population_engine_respawn_shell_timer(int32 tid, t_tick tick, int32 id, intptr_t data);
static bool pop_shell_finish_map_placement(map_session_data *sd);
static void pop_shell_broadcast_map_placement(map_session_data *sd);

// Tear down a partially constructed fake PC when spawn fails before map_quit runs.
static void population_engine_destroy_failed_spawn(map_session_data* sd)
{
    if (!sd)
        return;
	g_pop_chat_next_tick.erase(sd->id);
	population_engine_path_erase_for_pc(sd->id);
    if (sd->regs.vars) {
        sd->regs.vars->destroy(sd->regs.vars, script_reg_destroy);
        sd->regs.vars = nullptr;
    }
    if (sd->regs.arrays) {
        sd->regs.arrays->destroy(sd->regs.arrays, script_free_array_db);
        sd->regs.arrays = nullptr;
    }
    sd->~map_session_data();
    aFree(sd);
}

/// RAGNAROKMAC: drop a shell from the live registry, by pointer identity.
///
/// Deliberately never dereferences `sd`: it is called from the release path,
/// where the object may already have been torn down by another route, and
/// comparing pointer values is safe where reading through them is not.
///
/// Returns whether an entry was actually removed, so the counters are only
/// adjusted by whoever really took the shell out. Callers that already
/// removed it -- the arena partition, and the drains that std::move the whole
/// vector -- find nothing here and leave the counts alone.
static bool population_engine_forget_shell(map_session_data* sd)
{
	auto it = std::find(g_population_engine_pcs.begin(), g_population_engine_pcs.end(), sd);
	if (it == g_population_engine_pcs.end())
		return false;
	g_population_engine_pcs.erase(it);
	if (g_population_engine_count.load() > 0)
		g_population_engine_count--;
	if (g_population_engine_stats.active_units > 0)
		g_population_engine_stats.active_units--;
	return true;
}

void population_engine_shell_release(map_session_data* sd)
{
	if (!sd)
		return;
	// RAGNAROKMAC: leave the registry before anything else, and before the
	// guard below, which reads sd->id.
	//
	// Releasing used to be the caller's job to pair with removal, and one
	// caller did not: the abandoned-map sweep collects shells on maps that
	// have gone quiet and releases them while they are still listed. The
	// combat timer's stale sweep then read sd->id out of freed memory --
	// which is the SIGSEGV in population_engine_collect_stale_shells that
	// this fixes.
	//
	// Doing it here rather than at each call site makes the invariant one
	// that cannot be broken by adding another caller later: nothing is freed
	// while the registry still points at it.
	population_engine_forget_shell(sd);
	// Defensive guard: a kill cascade (e.g. Asura Strike against a mortal shell)
	// can free `sd` out-of-band before the next stale-shell sweep runs. Touching
	// `sd->sc` (an unordered_map) on freed memory crashes deep inside _Find_last.
	// If the BL is no longer registered under this id, the shell has already been
	// torn down by another path; bail before any further access.
	if (map_id2bl(sd->id) != sd)
		return;
	// Detach real memberships before freeing the shell: party data holds sd pointers.
	if (sd->status.party_id > 0 && sd->status.party_id < 0x70000000) {
		const int32 party_id = sd->status.party_id;
		// RAGNAROKMAC: release a shell with PARTY_MEMBER_WITHDRAW_LEAVE, not the
		// hardcoded EXPEL inside party_removemember2 — an EXPEL triggers the
		// Goal-3 deactivation hook and permanently benches the companion when it
		// was really just a death/wipe cleanup, which should re-summon on next
		// login like any non-expelled companion. Shells never hold party-bound
		// items, so the trade_bound_cancel inside removemember2 is a no-op here.
		intif_party_leave(party_id, sd->status.account_id, sd->status.char_id,
			sd->status.name, PARTY_MEMBER_WITHDRAW_LEAVE);
		party_member_withdraw(party_id, sd->status.account_id, sd->status.char_id,
			sd->status.name, PARTY_MEMBER_WITHDRAW_LEAVE);
		// party_member_withdraw() clears the member row but NOT data[].sd, which is
		// where this shell was registered. Leaving it there means the periodic
		// party_send_xy_timer dereferences freed memory - and its only guard is a
		// null check, which a dangling pointer passes. Clear every slot that still
		// points at this shell before it is freed.
		struct party_data *pd = party_search(party_id);
		if (pd != nullptr) {
			for (int32_t slot = 0; slot < MAX_PARTY; ++slot) {
				if (pd->data[slot].sd == sd) {
					pd->data[slot].sd = nullptr;
					pd->data[slot].x = 0;
					pd->data[slot].y = 0;
					pd->data[slot].hp = 0;
				}
			}
		}
	}
	sd->status.party_id = 0; // clear synthetic membership before teardown
	g_pop_chat_next_tick.erase(sd->id);
	g_pop_companion_gear_hash.erase(sd->id);
	population_engine_path_erase_for_pc(sd->id);
	// Cancel a pending respawn timer so it doesn't fire on a freed/reused shell.
	if (sd->pop.respawn_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(sd->pop.respawn_timer);
		if (td && td->func == population_engine_respawn_shell_timer)
			delete_timer(sd->pop.respawn_timer, population_engine_respawn_shell_timer);
		sd->pop.respawn_timer = INVALID_TIMER;
	}
	population_engine_combat_shell_teardown(sd);
	// Re-check after teardown: combat_changestate / hat-effect callbacks may have
	// triggered map_quit on shells with non-zero action_on_end, freeing `sd`.
	if (map_id2bl(sd->id) != sd)
		return;
	sd->pop.flags &= ~PSF::CombatActive;
#ifdef SECURE_NPCTIMEOUT
	if (sd->npc_idle_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(sd->npc_idle_timer);
		if (td && td->func == npc_secure_timeout_timer)
			delete_timer(sd->npc_idle_timer, npc_secure_timeout_timer);
		sd->npc_idle_timer = INVALID_TIMER;
	}
#endif
	sd->state.changemap = 0;
	sd->state.warping = 0;
	sd->state.connect_new = 0;

	// Only call map_quit if the shell is still registered.  Any external path that
	// calls map_quit on a shell (handle_shutdown, @kickall, etc.) will have already
	// removed it from id_db via map_deliddb; skip here to avoid double unit_free.
	if (map_id2bl(sd->id) != nullptr)
		map_quit(sd);
	else {
		// RAGNAROKMAC (Goal 1): already deregistered — map_quit would early-out
		// or double-free. Do the minimal teardown map_quit/unit_free would have
		// done so we never leave a dangling grid node or pending skill timers
		// behind (both caused crashes: stale bl in map blocks → UAF; pending
		// skill_timerskill entries → SIGSEGV in skill_timerskill after a new
		// shell reused the same account id).
		if (sd->prev != nullptr) {
			map_delblock(sd);
			clif_clearunit_area(*sd, CLR_OUTSIGHT);
			if (map_getmapdata(sd->m)) {
				struct map_data *md_ = map_getmapdata(sd->m);
				if (md_ && md_->users > 0)
					md_->users--;
			}
			sd->prev = nullptr;
		}
		skill_unit_move(sd, gettick(), 4);
		skill_cleartimerskill(sd);
		map_deliddb(sd);
	}

	// map_quit → unit_free_pc → unit_free handles sc_display, quest_log, bonus_script, etc.
	// Fake PCs never reach chrif_auth_delete, so the raw C hash tables in regs must be
	// freed here manually; unit_free does not touch them.
	// ~map_session_data destroys C++ containers; aFree releases the CREATE'd block.
	if (sd->regs.vars) {
		sd->regs.vars->destroy(sd->regs.vars, script_reg_destroy);
		sd->regs.vars = nullptr;
	}
	if (sd->regs.arrays) {
		sd->regs.arrays->destroy(sd->regs.arrays, script_free_array_db);
		sd->regs.arrays = nullptr;
	}
	sd->~map_session_data();
	aFree(sd);
}

static bool pop_is_companion(const map_session_data *sd);
static map_session_data *pop_companion_owner(map_session_data *sd);
static uint32_t pop_online_char(uint32_t account_id);
static map_session_data *pop_companion_owner_session(const map_session_data *shell);
static bool pop_companion_owned_by(const map_session_data *shell, const map_session_data *player);
static void pop_companion_set_owner(map_session_data *shell, const map_session_data *owner);
static void pop_companion_register_local_party(map_session_data *sd, map_session_data *owner);
/// Item 9: close a vending stall so a companion can follow and fight (helper is defined
/// next to pop_companion_register_local_party, which is after the recruit hook that needs it).
static void population_engine_shell_close_stall(map_session_data *sd);
bool population_engine_persist_companion_row(map_session_data *sd, const map_session_data *owner);

/// Removes stale shells from g_population_engine_pcs and returns them.
/// Caller must call population_engine_shell_release on each returned pointer.
std::vector<map_session_data*> population_engine_collect_stale_shells()
{
	std::vector<map_session_data*> stale;
	auto it = g_population_engine_pcs.begin();
	while (it != g_population_engine_pcs.end()) {
		map_session_data* sd = *it;
		// A dead recruited shell remains a real party member and a targetable
		// corpse while its owner stays on this map.  Keeping the same BL_PC in the
		// map grid lets normal Resurrection/Yggdrasil Leaf revive it in place and
		// avoids the duplicate actors caused by remove/re-add respawns.  Once the
		// owner leaves the map (or is no longer available), normal stale cleanup
		// below releases the corpse and withdraws it from the party.
		if (sd && pop_is_companion(sd) && pc_isdead(sd)) {
			map_session_data *owner = pop_companion_owner(sd);
			if (owner && sd->state.active && sd->prev != nullptr &&
				map_id2bl(sd->id) == sd && sd->m == owner->m) {
				++it;
				continue;
			}
			// RAGNAROKMAC: a companion whose owner is still online (party wipe: the
			// owner died and respawned at the save point, or the owner changed maps)
			// must RESPAWN beside its owner and KEEP its party membership, not be
			// released — releasing freed the shell and (via the EXPEL-typed leave)
			// permanently benched it. If the owner is genuinely gone (logout), fall
			// through to the normal release; the login recall re-summons it.
			//
			// pop_companion_owner() above demands that the shell's party_id match the
			// owner's party_id, which is exactly the link the char server destroys:
			// party_recv_info() replays the party without this shell's row (a shell
			// has no `char` table row), so the owner reads as absent, the branch falls
			// through to the release, and the player sees a companion silently
			// expelled from the party that @companion summon cannot bring back — the
			// recall takes the "already live" path for a shell still in the registry
			// and returns without re-registering it. Ownership (the account link) is
			// the durable identity, so heal the local party row and retry.
			if (owner == nullptr && sd->pop.companion_owner_account != 0) {
				// The owning CHARACTER only: another character of the same account is not it.
				map_session_data *cand = pop_companion_owner_session(sd);
				if (cand != nullptr && !population_engine_is_population_pc(cand->id)
					&& cand->state.active && cand->prev != nullptr) {
					pop_companion_register_local_party(sd, cand);
					owner = pop_companion_owner(sd);
					if (owner != nullptr)
						ShowInfo("Population engine: re-registered companion %s into %s's party after a party rebuild.\n",
							sd->status.name, owner->status.name);
				}
			}
			if (owner && owner->state.active) {
				ShowInfo("Population engine: companion %s left behind; respawning beside owner %s (kept in party).\n",
					sd->status.name, owner->status.name);
				if (sd->pop.respawn_timer != INVALID_TIMER) {
					const TimerData* td = get_timer(sd->pop.respawn_timer);
					if (td && td->func == population_engine_respawn_shell_timer)
						delete_timer(sd->pop.respawn_timer, population_engine_respawn_shell_timer);
					sd->pop.respawn_timer = INVALID_TIMER;
				}
				sd->pop.respawn_timer = add_timer(gettick() + 2000,
					population_engine_respawn_shell_timer, sd->id, 0);
				++it;
				continue;
			}
			ShowInfo("Population engine: dead companion %s left behind by its owner; releasing it.\n",
				sd->status.name);
			stale.push_back(sd);
			it = g_population_engine_pcs.erase(it);
			if (g_population_engine_count.load() > 0)
				g_population_engine_count--;
			if (g_population_engine_stats.active_units > 0)
				g_population_engine_stats.active_units--;
			continue;
		}
		// pc_setpos briefly removes a fake PC from the map block grid. Under rapid
		// owner map changes that state can survive until this timer, even though the
		// shell is still active, registered, and has a valid companion owner. Do not
		// destroy it as stale: the companion pass below repairs its placement.
		if (sd && pop_is_companion(sd) && sd->state.active && sd->prev == nullptr
			&& map_id2bl(sd->id) == sd && pop_companion_owner(sd) != nullptr) {
			++it;
			continue;
		}
		// RAGNAROKMAC (Goal 1): a companion whose owner is online on the same map
		// is never stale, no matter what transient grid/id-db state it is in —
		// re-register and re-place it instead of releasing it. Releasing here
		// kicked companions out of the party seconds after every relogin, and a
		// deregistered-but-on-grid release path leaks both the grid node and the
		// shell's pending skill_timerskill entries (SIGSEGV in skill_timerskill).
		if (sd && pop_is_companion(sd) && sd->state.active) {
			map_session_data *owner = pop_companion_owner(sd);
			if (owner != nullptr && sd->m == owner->m) {
				if (map_id2bl(sd->id) != sd) {
					map_addiddb(sd); // restore lost id_db registration
					ShowInfo("Population engine: re-registered companion %s in id_db.\n",
						sd->status.name);
				}
				if (sd->prev == nullptr && map_addblock(sd) == 0) {
					struct map_data *md_ = map_getmapdata(sd->m);
					if (md_) {
						if (md_->users++ == 0 && battle_config.dynamic_mobs)
							map_spawnmobs(sd->m);
						if (!pc_isinvisible(sd))
							md_->users_pvp++;
					}
					sd->state.debug_remove_map = 0;
				}
				++it;
				continue;
			}
		}
		// RAGNAROKMAC: a live companion left behind on a map the owner has left
		// (party wipe: owner respawned at the save point; or the owner teleported
		// mid-fight) must TELEPORT to its owner and keep party membership — the
		// release path here kicked it from the party even though nobody expelled it.
		if (sd && pop_is_companion(sd) && sd->state.active) {
			map_session_data *owner = pop_companion_owner(sd);
			if (owner != nullptr && owner->state.active && sd->m != owner->m
				&& !pc_isdead(sd) && map_id2bl(sd->id) == sd) {
				int16_t tx = owner->x, ty = owner->y;
				map_search_freecell(owner, owner->m, &tx, &ty, 2, 2, 0);
				if (pc_setpos(sd, map_id2index(owner->m), tx, ty, CLR_TELEPORT) == SETPOS_OK) {
					pop_shell_finish_map_placement(sd);
					pop_shell_broadcast_map_placement(sd);
					ShowInfo("Population engine: companion %s followed its owner to another map.\n",
						sd->status.name);
					++it;
					continue;
				}
			}
		}
		if (!sd || !population_engine_is_population_pc(sd->id) || !population_engine_combat_shell_ac_ok(sd)) {
			if (sd && sd->status.party_id > 0 && sd->status.party_id < 0x70000000) {
				ShowWarning("Population engine: companion %s became stale (active=%d, on_map=%d, registered=%d, flags=0x%x).\n",
					sd->status.name, static_cast<int>(sd->state.active), sd->prev != nullptr,
					map_id2bl(sd->id) == sd, sd->pop.flags);
			}
			stale.push_back(sd);
			it = g_population_engine_pcs.erase(it);
			if (g_population_engine_count.load() > 0)
				g_population_engine_count--;
			if (g_population_engine_stats.active_units > 0)
				g_population_engine_stats.active_units--;
		} else {
			++it;
		}
	}
	return stale;
}

void population_engine_stats_record_walk_failure()
{
	// Called from the wander timer without the mutex; the stats struct uses plain uint32
	// but increments from the single map-main thread so no atomic needed.
	g_population_engine_stats.walk_failures++;
}

/// Allocate the next free population index from the 5 M ID pool.
/// Normal path: atomic increment, O(1).
/// Exhaustion path (rare): scans g_population_engine_pcs for used indices and returns
/// the first free slot, avoiding collision with any shell still alive.
/// Returns 0 on total pool exhaustion (impossible under normal conditions).
/// RAGNAROKMAC: load the persisted-companion index set once, on first use.
/// Called from the allocator, so it runs whatever brings a shell into the world and cannot
/// race the supervisor's table creation (an eager load at engine start could).
static void population_engine_load_reserved_indices()
{
	if (g_reserved_companion_indices_loaded)
		return;
	g_reserved_companion_indices_loaded = true; // set even on failure: one attempt per start
	if (mmysql_handle == nullptr)
		return;
	if (Sql_Query(mmysql_handle, "SELECT shell_index FROM `cp_companion_persistence`") != SQL_SUCCESS) {
		// A missing table is legitimate on an install that never recruited anyone, so this is
		// a warning rather than an error - but it must be VISIBLE, because silently getting an
		// empty set is exactly how the index collision would come back unnoticed.
		ShowWarning("Population engine: could not read reserved companion indices; ambient shells "
			"may collide with persisted companions this session.\n");
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	char* data = nullptr;
	while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		const uint32_t idx = data != nullptr ? static_cast<uint32_t>(atoi(data)) : 0u;
		if (idx != 0)
			g_reserved_companion_indices.insert(idx);
	}
	Sql_FreeResult(mmysql_handle);
	if (!g_reserved_companion_indices.empty())
		ShowInfo("Population engine: reserved %zu persisted companion index(es) from ambient reuse.\n",
			g_reserved_companion_indices.size());
}

/// Is `index` already owned by a persisted companion?
/// Also reports a collision, which is the diagnostic this project lacked: it fires when a
/// shell is about to be issued an index the persistence table already claims.
static bool population_engine_index_is_reserved(uint32_t index, const char* source)
{
	if (index == 0)
		return false;
	if (g_reserved_companion_indices.find(index) == g_reserved_companion_indices.end())
		return false;
	ShowWarning("Population engine: index %u is owned by a persisted companion; refusing it for "
		"%s (ambient spawn). This is the collision that makes a companion's skill selection "
		"attach to the wrong shell.\n", index, source != nullptr ? source : "spawn");
	return true;
}

static uint32_t population_engine_allocate_index()
{
	population_engine_load_reserved_indices();

	// Fast path: walk forward from the counter until an unreserved index is found. The loop is
	// bounded because the reserved set is tiny (one entry per recruited companion) while the
	// pool is 5M slots, so it exits almost immediately in practice.
	for (int guard = 0; guard < 100000; ++guard) {
		uint32_t index = g_next_population_engine_index.fetch_add(1, std::memory_order_relaxed);
		if (index >= POPULATION_ENGINE_INDEX_MAX)
			break; // fall through to the wrap scan below
		if (!population_engine_index_is_reserved(index, "ambient spawn"))
			return index;
	}

	// Pool counter wrapped (or the bounded walk above gave up). Build a set of in-use indices
	// and find the first free one that is not reserved for a persisted companion.
	ShowWarning("Population engine: ID counter exhausted; scanning for a free index (live shells: %zu, reserved: %zu).\n",
		g_population_engine_pcs.size(), g_reserved_companion_indices.size());
	std::unordered_set<uint32_t> used;
	used.reserve(g_population_engine_pcs.size());
	for (const map_session_data* sd : g_population_engine_pcs) {
		if (!sd) continue;
		const uint32_t aid = sd->status.account_id;
		if (aid >= POPULATION_ENGINE_ACCOUNT_ID_BASE)
			used.insert(aid - POPULATION_ENGINE_ACCOUNT_ID_BASE);
	}
	for (uint32_t i = 1; i < POPULATION_ENGINE_INDEX_MAX; ++i) {
		if (used.find(i) != used.end())
			continue;
		if (population_engine_index_is_reserved(i, "ambient spawn (wrap scan)"))
			continue;
		g_next_population_engine_index.store(i + 1, std::memory_order_relaxed);
		return i;
	}
	ShowError("Population engine: ID pool fully exhausted (%u slots all occupied); spawn skipped.\n",
		static_cast<unsigned>(POPULATION_ENGINE_INDEX_MAX));
	return 0;
}

/// Spawn up to `want` population shells on `map_id`, respecting global and per-map limits.
/// `job_hint`     — preferred job; UINT16_MAX = random.
/// `tick_budget`  — pointer to remaining spawn budget for this timer tick; nullptr = unlimited.
///                  Decremented by the number of shells actually spawned.
/// `bypass_existing_check` — when true, the per-job existing-on-map gate is skipped.
///                  Used by the VendorPlacement-driven pass which controls its own
///                  population target via PopulationVendorPlacement::max_vendors.
/// Returns the number of shells actually spawned.
static size_t autosummon_fill_map(int16_t map_id, size_t want, uint16_t job_hint = UINT16_MAX,
                                  size_t* tick_budget = nullptr, uint8_t map_category = 0,
                                  bool bypass_existing_check = false, const PopulationShellReturn* returning = nullptr)
{
	if (want == 0)
		return 0;
	if (tick_budget != nullptr) {
		if (*tick_budget == 0)
			return 0;
		if (want > *tick_budget)
			want = *tick_budget;
	}
	struct map_data* mapdata = map_getmapdata(map_id);
	if (!mapdata || !mapdata->cell)
		return 0;

	extern struct Battle_Config battle_config;
	const size_t max_global = static_cast<size_t>(battle_config.population_engine_max_count);

	// Only spawn shells that are missing to reach the target.
	// Count only shells of this specific job so multiple profiles can coexist on the same map.
	if (!bypass_existing_check) {
		const size_t existing = population_engine_count_shells_on_map(map_id, job_hint);
		if (existing >= want)
			return 0;
		want -= existing;
	}

	// Pre-compute vendor placement and build the vendor position snapshot once for the
	// entire batch to avoid O(N_slots × N_shells) re-walks of g_population_engine_pcs.
	const PopulationVendorPlacement *map_vp =
		population_vendor_db().vendor_placement_for_map(std::string(mapdata->name));
	std::vector<std::pair<int16, int16>> vendor_positions_here;
	// RAGNAROKMAC: mod vendor shells stay in the spacing snapshot (base vendors
	// must not stand on a mod stall) but not in the MaxVendors count, which is
	// the engine's own budget. With no mod vendors both equal upstream.
	size_t base_vendors_here = 0;
	if (map_vp && (map_vp->min_spacing > 0 || map_vp->max_vendors > 0)) {
		vendor_positions_here.reserve(g_population_engine_pcs.size());
		for (auto* psd : g_population_engine_pcs) {
			if (!psd || psd->m != map_id) continue;
			if (!psd->state.vending) continue;
			vendor_positions_here.emplace_back(psd->x, psd->y);
			if (psd->pop.vendor_spawn_id.empty())
				++base_vendors_here;
		}
	}

	size_t spawned = 0;
	for (size_t j = 0; j < want; ++j) {
		// Re-check global limit each iteration (other calls may have consumed slots).
		if (g_population_engine_count.load() >= max_global)
			break;
		// Even below this profile's quota, another profile on the same map must
		// not consume a selling shell's slot when the global cap is the limit.
		if (!returning && !population_shell_returns_allow_fresh(map_id, g_population_engine_count.load(), max_global))
			break;

		// Pre-resolve the equipment/behavior for this slot so vendor placement constraints
		// can be applied to the cell pick (vendors are restricted to specific maps/areas
		// and must respect a minimum spacing from other vendor shells).
		const uint16_t pre_job_id = (job_hint != UINT16_MAX && pcdb_checkid(job_hint))
			? job_hint : get_random_job_id();
		PopulationDbSource pre_src = PopulationDbSource::Main;
		auto pre_equipment = population_engine_find_any(pre_job_id, &pre_src);
		if (!pre_equipment) {
			const uint16_t base_job = get_base_job(pre_job_id);
			if (base_job != pre_job_id)
				pre_equipment = population_engine_find_any(base_job, &pre_src);
		}
		// For town spawns (map_category==1), if the resolved entry doesn't have Vendor as its
		// town_behavior, check vendor_pop_db directly — it may have a VendorKey and the right
		// town_behavior even if the engine.yml entry shadows it in the general lookup.
		if (map_category == 1 && pre_equipment &&
		    pre_equipment->town_behavior != PopulationBehavior::Vendor) {
			if (auto vp = population_vendor_pop_db().find(pre_job_id)) {
				pre_src      = PopulationDbSource::Vendor;
				pre_equipment = vp;
			} else {
				const uint16_t base_job = get_base_job(pre_job_id);
				if (base_job != pre_job_id) {
					if (auto vp2 = population_vendor_pop_db().find(base_job)) {
						pre_src       = PopulationDbSource::Vendor;
						pre_equipment = vp2;
					}
				}
			}
		}
		PopulationBehavior eff_beh = pre_equipment ? pre_equipment->behavior : PopulationBehavior::Combat;
		if (pre_equipment) {
			PopulationBehavior cat_beh = PopulationBehavior::None;
			if      (map_category == 1) cat_beh = pre_equipment->town_behavior;
			else if (map_category == 2) cat_beh = pre_equipment->field_behavior;
			else if (map_category == 3) cat_beh = pre_equipment->dungeon_behavior;
			if (cat_beh != PopulationBehavior::None)
				eff_beh = cat_beh;
		}
		const bool is_vendor_spawn = (eff_beh == PopulationBehavior::Vendor);

		// Vendor placement — use the map-level entry pre-computed before the slot loop.
		const PopulationVendorPlacement *vp = is_vendor_spawn ? map_vp : nullptr;

		// When ANY VendorPlacement entries exist, vendor-behavior shells are
		// restricted to the listed maps only. A vendor spawn on a map with no
		// placement entry is dropped here so towns/etc. cannot accumulate vendors.
		if (is_vendor_spawn && !vp && population_vendor_db().any_vendor_placements())
			continue;

		// Enforce MaxVendors cap. vendor_positions_here was built before this loop
		// and is updated after each successful vendor spawn below.
		if (vp && vp->max_vendors > 0 &&
		    static_cast<int>(base_vendors_here) >= vp->max_vendors)
			continue; // map full of vendors already

		// Find a walkable spawn position.
		int x = 0, y = 0;
		if (mapdata->xs > 0 && mapdata->ys > 0) {
			int16_t sx = 0, sy = 0;

			// Determine search area. Default keeps a 50-cell border on large maps,
			// but shrinks the border on small maps (e.g. prt_mk is ~100x100; a
			// fixed 50-cell border would collapse the search to a single column).
			const int16_t margin_x = static_cast<int16_t>(std::min<int>(50, std::max<int>(2, mapdata->xs / 5)));
			const int16_t margin_y = static_cast<int16_t>(std::min<int>(50, std::max<int>(2, mapdata->ys / 5)));
			int16_t lo_x = margin_x, lo_y = margin_y;
			int16_t hi_x = static_cast<int16_t>(std::max<int>(margin_x + 1, mapdata->xs - margin_x));
			int16_t hi_y = static_cast<int16_t>(std::max<int>(margin_y + 1, mapdata->ys - margin_y));
			if (vp && vp->area_x1 >= 0 && vp->area_y1 >= 0 && vp->area_x2 >= vp->area_x1 && vp->area_y2 >= vp->area_y1) {
				// Clamp the placement area to the map bounds so a slightly oversized
				// box still produces a valid search range.
				lo_x = std::max<int16_t>(0, vp->area_x1);
				lo_y = std::max<int16_t>(0, vp->area_y1);
				hi_x = std::min<int16_t>(static_cast<int16_t>(mapdata->xs - 1), vp->area_x2);
				hi_y = std::min<int16_t>(static_cast<int16_t>(mapdata->ys - 1), vp->area_y2);
				if (hi_x <= lo_x) hi_x = static_cast<int16_t>(lo_x + 1);
				if (hi_y <= lo_y) hi_y = static_cast<int16_t>(lo_y + 1);
			}

			// Distance check vs the snapshot taken above (no mutex in inner loop).
			const int spacing = (vp ? vp->min_spacing : 0);
			auto cell_far_enough = [&](int16_t tx, int16_t ty) -> bool {
				if (spacing <= 0) return true;
				for (const auto &p : vendor_positions_here) {
					if (std::abs(static_cast<int>(p.first)  - tx) <= spacing &&
					    std::abs(static_cast<int>(p.second) - ty) <= spacing)
						return false;
				}
				return true;
			};

			const int max_attempts = vp ? 60 : 20;
			for (int attempt = 0; attempt < max_attempts; ++attempt) {
				const int16_t span_x = static_cast<int16_t>(std::max<int16_t>(1, hi_x - lo_x));
				const int16_t span_y = static_cast<int16_t>(std::max<int16_t>(1, hi_y - lo_y));
				sx = static_cast<int16_t>(lo_x + (rnd() % span_x));
				sy = static_cast<int16_t>(lo_y + (rnd() % span_y));
				if (sx >= mapdata->xs) sx = static_cast<int16_t>(mapdata->xs - 1);
				if (sy >= mapdata->ys) sy = static_cast<int16_t>(mapdata->ys - 1);
				if (!map_getcell(map_id, sx, sy, CELL_CHKPASS)) continue;
				if (!cell_far_enough(sx, sy)) continue;
				x = sx; y = sy;
				break;
			}
			if (x == 0 && y == 0 && !vp) {
				// Fallback: map_search_freecell (only when no placement constraints).
				if (map_search_freecell(nullptr, map_id, &sx, &sy,
					std::min(20, static_cast<int>(mapdata->xs / 2)),
					std::min(20, static_cast<int>(mapdata->ys / 2)), 1)) {
					x = sx; y = sy;
				}
			}
			if (x == 0 && y == 0 && vp) {
				// Placement-constrained fallback: scan from a random center inside
				// the placement area. Honors the area but ignores spacing as a
				// last resort so vendors actually appear on small/dense maps.
				const int16_t span_x = static_cast<int16_t>(std::max<int16_t>(1, hi_x - lo_x));
				const int16_t span_y = static_cast<int16_t>(std::max<int16_t>(1, hi_y - lo_y));
				sx = static_cast<int16_t>(lo_x + (rnd() % span_x));
				sy = static_cast<int16_t>(lo_y + (rnd() % span_y));
				if (map_search_freecell(nullptr, map_id, &sx, &sy,
					std::min<int16_t>(static_cast<int16_t>(span_x / 2 + 4), 20),
					std::min<int16_t>(static_cast<int16_t>(span_y / 2 + 4), 20), 1)) {
					x = sx; y = sy;
				}
			}
		}
		if (x == 0 && y == 0)
			continue; // No walkable cell found for this slot; skip.

		// Use the pre-resolved job/equipment (may have been used to enforce vendor placement).
		uint16_t job_id = pre_job_id;
		auto equipment = pre_equipment;

		// Gender (job-locked wins; then YAML Sex; else random).
		char sex;
		const char required_sex = get_job_required_sex(job_id);
		if (required_sex != '\0') {
			sex = required_sex;
		} else if (equipment && equipment->sex_override >= 0) {
			sex = equipment->sex_override ? 'M' : 'F';
		} else {
			sex = (rnd() % 2) ? 'M' : 'F';
		}

		const uint8_t  hair_style  = MAX_HAIR_STYLE;
		const uint16_t hair_color  = static_cast<uint16_t>(population_roll_closed_range(MIN_HAIR_COLOR, MAX_HAIR_COLOR));
		const uint16_t cloth_color = static_cast<uint16_t>(population_roll_closed_range(MIN_CLOTH_COLOR, MAX_CLOTH_COLOR));

		// Pick one item randomly from each equipment pool (empty pool = no item in that slot).
		auto pick_pool = [](const std::vector<uint16_t>& p) -> uint16_t {
			if (p.empty()) return 0;
			return p.size() == 1 ? p[0] : p[rnd() % p.size()];
		};

		uint16_t weapon = 0, shield = 0, head_top = 0, head_mid = 0, head_bottom = 0, garment = 0;
		struct script_code* init_script = nullptr;
		bool skip_arrow = false;
		if (equipment) {
			weapon      = pick_pool(equipment->weapon_pool);
			shield      = pick_pool(equipment->shield_pool);
			head_top    = pick_pool(equipment->head_top_pool);
			head_mid    = pick_pool(equipment->head_mid_pool);
			head_bottom = pick_pool(equipment->head_bottom_pool);
			garment     = pick_pool(equipment->garment_pool);
			init_script = equipment->script;
			skip_arrow  = equipment->skip_arrow;
		} else {
			weapon = get_job_weapon(job_id);
			if (rnd() % 2 == 0) {
				struct item_data* sid = itemdb_search(2101);
				if (sid && (sid->equip & EQP_SHIELD))
					shield = 2101;
			}
			head_top    = (rnd() % 3 == 0) ? get_random_headgear(0) : 0;
			head_mid    = (rnd() % 3 == 0) ? get_random_headgear(1) : 0;
			head_bottom = (rnd() % 3 == 0) ? get_random_headgear(2) : 0;
			garment     = (rnd() % 2 == 0) ? get_random_costume_robe() : 0;
		}

		// Unique ID — collision-safe allocation from the 5 M pool.
		uint32_t index = population_engine_allocate_index();
		if (index == 0)
			continue; // pool fully exhausted, skip this shell

		const PopulationEngine* pop_cfg = equipment ? equipment.get() : nullptr;
		map_session_data* sd = population_engine_spawn_shell(
			map_id, x, y, index, job_id, sex, hair_style,
			hair_color, weapon, shield, head_top, head_mid, head_bottom,
			0 /*option*/, cloth_color, garment, init_script, skip_arrow, pop_cfg, map_category, pre_src,
			nullptr, nullptr, -1, returning);

		if (sd) {
			sd->pop.ambient_quota = !is_vendor_spawn && pre_src == PopulationDbSource::Main;
			g_population_engine_pcs.push_back(sd);
			g_population_engine_count++;
			g_population_engine_stats.total_created++;
			g_population_engine_stats.active_units++;
			++spawned;
			// Keep the pre-built snapshot current so subsequent slots in this batch
			// see the just-spawned vendor when enforcing spacing and MaxVendors.
			if (is_vendor_spawn && vp) {
				vendor_positions_here.emplace_back(static_cast<int16>(x), static_cast<int16>(y));
				++base_vendors_here;
			}
		} else {
			g_population_engine_stats.errors++;
		}
	}
	if (tick_budget != nullptr)
		*tick_budget -= spawned;
	return spawned;
}

/// Autosummon timer: fills maps to their YAML-configured population targets.
///
/// Each spawn profile declares per-category map lists and population targets.
/// Per-map target = floor(pop / map_count); first (pop % map_count) maps get +1.
/// Fires every 10s and tops up maps that are below target.
/// population_engine_autosummon_batch_size caps total spawns per tick (0 = unlimited).
/// Write current population shell count to cp_population_stats for FluxCP.
/// Guarded by g_last_db_written_count so SQL only fires on actual changes.
static void population_engine_write_count_sql(uint32_t count)
{
	if (mmysql_handle == nullptr)
		return;
	if (Sql_Query(mmysql_handle,
		"INSERT INTO `cp_population_stats` (`id`, `active_count`) VALUES (1, %u) "
		"ON DUPLICATE KEY UPDATE `active_count` = VALUES(`active_count`)",
		count) != SQL_SUCCESS)
		Sql_ShowDebug(mmysql_handle);
	g_last_db_written_count = count;
}

// ---- RAGNAROKMAC: shop titles ---------------------------------------------
//
// Upstream falls back to the literal string "Shop" for any vendor whose YAML
// does not name one, and most of them do not -- so a market is forty identical
// signs. A real RO town is the opposite: the signs are the character of the
// place. These are picked per stall, once, when it opens.
//
// Kept under MESSAGE_SIZE (80) by a wide margin; the client truncates rather
// than complains, which would be a quiet way to look broken.
static const char *POP_SHOP_TITLES[] = {
	"Cheap Potions!",
	"Everything Must Go",
	"Buy 2 Get 1 Free",
	"Newbie Friendly Prices",
	"Best Deals in Prontera",
	"Fresh Loot, Just Farmed",
	"Selling Cheap, No Haggling",
	"Overstocked! Help Me Out",
	"Quitting - Selling All",
	"Rare Finds Inside",
	"Cards & Curios",
	"Potions, Wings, Fly Wings",
	"Adventurer Supplies",
	"Field Drops, Fair Prices",
	"Dungeon Haul",
	"Zeny Needed, Prices Slashed",
	"One Stop Shop",
	"Discount Corner",
	"Bulk Deals Here",
	"Arrows & Ammo",
	"Blacksmith Surplus",
	"Alchemy Leftovers",
	"Cheaper Than Kafra",
	"Honest Prices, Honest Merchant",
	"No Refunds, Sorry",
	"Weekly Special",
	"Clearance!",
	"Just Browsing? Come In",
	"Support Your Local Merchant",
	"Emergency Supplies",
	"Healing Items Stocked",
	"Restock Day",
	"Everything Half Off",
	"Trader's Rest",
	"Merchant Guild Approved",
	"Priced to Move",
	"Last Stock of the Day",
	"Fresh From Payon",
	"Straight From Geffen",
	"Morocc Imports",
	"Traveller's Kit",
	"Buy Now, Level Later",
	"Small Shop, Good Prices",
	"Thanks For Stopping By",
	"Come Back Anytime",
};

// ---- RAGNAROKMAC: level shells to the map they stand on -------------------
//
// A profile's BaseLevel is global, so the same range applies on a newbie field
// and in a late dungeon. Banding the spawn tables fixes the maps we ship, but a
// mod that adds its own map cannot be curated in advance -- and mods are meant
// to need no rebuild. So where the map has monsters, let them say what level
// its inhabitants should be.
//
// The profile's minimum is a floor, which is not a nicety: gear sets are chosen
// per profile and pc_equipitem enforces each item's equip level, so a shell
// pushed below its profile's band would silently equip nothing and stand there
// unarmed. The band's top is not a ceiling. The tier table puts a band on a map
// once for both eras, and the eras disagree: Renewal's Payon Cave 4 is level 66
// and its Glast Heim churches are 115, where the bands stop at 26 and 99. Held to
// the band, those shells were the weakest thing on the map. So the monsters may
// lift a shell past its band, up to its class's max base level. No shipped gear
// set has a maximum equip level, so the gear still fits.
static std::unordered_map<int16_t, int> g_pop_map_mob_level;

using PopMobLevels = std::vector<std::pair<int, int>>; // level, count

static int pop_collect_mob_level(struct block_list *bl, va_list ap) {
	auto *out = va_arg(ap, PopMobLevels*); // an alias: va_arg is a macro, and the pair's comma splits it
	if (bl == nullptr)
		return 0;
	const int lv = status_get_lv(bl);
	if (lv > 0)
		out->emplace_back(lv, 1);
	return 1;
}

/// Median monster level on a map, or 0 where it has none (towns). Computed once
/// per map, since this is called on every spawn.
///
/// Read from the map's spawn lines (mapdata->moblist, every line while
/// dynamic_mobs is on, as it is by default), each weighted by its count. Live
/// monsters were the source before, and they misled: dynamic_mobs removes them
/// from a map nobody is on, and the sample stopped at the first 64 in block
/// order, one corner of the map. Renewal's Payon Cave 2 (median 34 by its spawn
/// lines) put level 13 shells there. Live monsters remain the fallback, and a
/// map without any is not cached, so it is looked at again once they are back.
static int pop_map_mob_level(int16_t m) {
	const auto it = g_pop_map_mob_level.find(m);
	if (it != g_pop_map_mob_level.end())
		return it->second;

	PopMobLevels levels;
	bool from_spawns = false;
	if (const struct map_data *mapdata = map_getmapdata(m)) {
		for (const struct spawn_data *spawn : mapdata->moblist) {
			if (spawn == nullptr || spawn->num == 0)
				continue;
			int lv = static_cast<int>(spawn->level);
			if (lv <= 0) {
				const std::shared_ptr<s_mob_db> db = mob_db.find(static_cast<uint32>(spawn->id));
				lv = db != nullptr ? db->lv : 0;
			}
			if (lv > 0) {
				levels.emplace_back(lv, spawn->num);
				from_spawns = true;
			}
		}
	}
	if (levels.empty())
		map_foreachinmap(pop_collect_mob_level, m, BL_MOB, &levels);
	int out = 0;
	if (!levels.empty()) {
		std::sort(levels.begin(), levels.end());
		int64_t total = 0;
		for (const auto &l : levels)
			total += l.second;
		int64_t seen = 0;
		for (const auto &l : levels) {
			seen += l.second;
			if (seen * 2 > total) {
				out = l.first;
				break;
			}
		}
	}
	if (from_spawns || out > 0)
		g_pop_map_mob_level[m] = out;
	return out;
}

// ---- RAGNAROKMAC: demand-driven population -------------------------------
//
// Upstream fills every map named in population_spawn.yml whether or not anyone
// is there: the shipped YAML asks for 4,060 shells across 124 maps, for what is
// usually one player and a couple of friends. Worse, with a global cap the fill
// runs in database order, so a low cap produces a crowded Prontera and empty
// dungeons rather than a thin scatter.
//
// We keep the YAML's per-map densities exactly as they are and change only
// which maps they are applied to: the ones somebody is actually on, plus a
// grace window so walking out and back does not rebuild the crowd from
// scratch. Shells elsewhere are released.
static std::unordered_set<int16_t> g_pop_occupied_maps;
static std::unordered_map<int16_t, t_tick> g_pop_map_vacant_since;
static t_tick g_pop_occupancy_checked = 0;

static int pop_occupancy_collect(map_session_data *sd, va_list ap) {
	auto *out = va_arg(ap, std::unordered_set<int16_t>*);
	if (sd == nullptr || sd->prev == nullptr)
		return 0;
	// Shells increment mapdata->users like any other PC, so map occupancy has
	// to be counted here rather than read off the map.
	if (population_engine_is_population_pc(sd->id))
		return 0;
	out->insert(sd->m);
	return 1;
}

/// Refresh the occupied-map set, at most once a second. One pass over the pc
/// list, shells included, which is cheap beside the per-tick work it saves.
static void pop_occupancy_refresh() {
	const t_tick now = gettick();
	if (g_pop_occupancy_checked != 0 && DIFF_TICK(now, g_pop_occupancy_checked) < 1000)
		return;
	g_pop_occupancy_checked = now;

	std::unordered_set<int16_t> live;
	map_foreachpc(pop_occupancy_collect, &live);

	for (const int16_t m : live)
		g_pop_map_vacant_since.erase(m);
	for (const int16_t m : g_pop_occupied_maps) {
		if (live.count(m) == 0 && g_pop_map_vacant_since.count(m) == 0)
			g_pop_map_vacant_since[m] = now;
	}
	g_pop_occupied_maps.swap(live);
}

bool population_engine_map_has_real_players(int16_t m) {
	if (!battle_config.population_engine_demand_spawn)
		return true;
	pop_occupancy_refresh();
	return g_pop_occupied_maps.count(m) != 0;
}

/// A map worth holding shells on: someone is on it, or left recently enough
/// that they may well come straight back.
static bool pop_map_is_live(int16_t m) {
	if (!battle_config.population_engine_demand_spawn)
		return true;
	if (g_pop_occupied_maps.count(m) != 0)
		return true;
	const auto it = g_pop_map_vacant_since.find(m);
	if (it == g_pop_map_vacant_since.end())
		return false;
	return DIFF_TICK(gettick(), it->second) < battle_config.population_engine_demand_grace_ms;
}

/// Finish the map placement normally completed by a real client's LoadEndAck.
/// Population shells have no socket, so every pc_setpos path must call this.
static bool pop_shell_finish_map_placement(map_session_data *sd)
{
	if (!sd)
		return false;
	sd->state.changemap = 0;
	sd->state.connect_new = 0;
	sd->state.warping = 0;
	sd->state.rewarp = 0;
	if (sd->prev == nullptr) {
		if (map_addblock(sd) != 0)
			return false;
		struct map_data *mapdata = map_getmapdata(sd->m);
		if (mapdata) {
			if (mapdata->users++ == 0 && battle_config.dynamic_mobs)
				map_spawnmobs(sd->m);
			if (!pc_isinvisible(sd))
				mapdata->users_pvp++;
		}
	}
	sd->state.debug_remove_map = 0;
	population_shell_status_checkmapchange(sd);
	return true;
}

static void pop_shell_broadcast_map_placement(map_session_data *sd)
{
	if (!sd || sd->prev == nullptr)
		return;
	clif_spawn(sd);
	if (sd->status.party_id > 0 && sd->status.party_id < 0x70000000) {
		party_send_movemap(sd);
		clif_party_hp(*sd);
		clif_party_xy(*sd);
	}
}

static bool pop_is_companion(const map_session_data *sd)
{
	return sd && sd->status.party_id > 0 && sd->status.party_id < 0x70000000
		&& sd->pop.companion_owner_account != 0;
}

// RAGNAROKMAC (companions per character) ------------------------------------------
// Companions belong to a CHARACTER. map_id2sd(account_id) returns whichever character of
// that account is logged in, so keying ownership on the account alone made a second
// character of the same account the owner of the first one's companions: they stayed in the
// world after character 1 logged out, showed up in character 2's list, and did not follow.
// Every "who owns this" question goes through these four.

/// The character of this account that is logged in right now, or 0. rAthena allows one
/// character per account online at a time, so for a command the player just typed this is
/// exactly the character asking.
static uint32_t pop_online_char(uint32_t account_id)
{
	if (account_id == 0)
		return 0;
	const map_session_data *sd = map_id2sd(account_id);
	if (sd == nullptr || population_engine_is_population_pc(sd->id))
		return 0;
	return sd->status.char_id;
}

/// The owner's session, only if the owning CHARACTER is the one logged in.
static map_session_data *pop_companion_owner_session(const map_session_data *shell)
{
	if (shell == nullptr || shell->pop.companion_owner_account == 0)
		return nullptr;
	map_session_data *sd = map_id2sd(shell->pop.companion_owner_account);
	if (sd == nullptr || population_engine_is_population_pc(sd->id)
		|| sd->status.char_id != shell->pop.companion_owner_char)
		return nullptr;
	return sd;
}

static bool pop_companion_owned_by(const map_session_data *shell, const map_session_data *player)
{
	return shell != nullptr && player != nullptr && shell->pop.companion_owner_account != 0
		&& shell->pop.companion_owner_account == player->status.account_id
		&& shell->pop.companion_owner_char == player->status.char_id;
}

static void pop_companion_set_owner(map_session_data *shell, const map_session_data *owner)
{
	shell->pop.companion_owner_account = owner != nullptr ? owner->status.account_id : 0;
	shell->pop.companion_owner_char = owner != nullptr ? owner->status.char_id : 0;
}

bool population_engine_companion_owned_by(const map_session_data *shell, const map_session_data *player)
{
	return pop_companion_owned_by(shell, player);
}

// RAGNAROKMAC -- companion cap, configurable per install. Read from battle_conf:
// population_engine_companion_limit (default 4, clamped there to [4, 11]).
// rAthena's MAX_PARTY is 12 including the leader, so 11 is the most that can
// join one player: at that setting the party is full and no second real player
// fits, which is the operator's choice to make.
static size_t pop_companion_limit()
{
	// Mirror electron/population-conf.js exactly: floor 4, ceiling 11. The
	// ceiling is MAX_PARTY (12) minus the leader, so the recruiter always has a
	// slot even when every companion accepts. A hand-edited conf that ignores
	// the UI clamp still cannot overflow the party slots here.
	int v = battle_config.population_engine_companion_limit;
	if (v < 4) return 4;
	if (v > 11) return 11;
	return static_cast<size_t>(v);
}

bool population_engine_can_recruit_companion(const map_session_data *owner)
{
	if (!owner || population_engine_is_population_pc(owner->id))
		return false;
	size_t count = 0;
	for (const map_session_data *candidate : g_population_engine_pcs) {
		if (pop_is_companion(candidate) &&
			((owner->status.party_id > 0 && owner->status.party_id < 0x70000000 &&
			  candidate->status.party_id == owner->status.party_id) ||
			 (owner->status.party_id == 0 &&
			  pop_companion_owned_by(candidate, owner))) &&
			++count >= pop_companion_limit())
			return false;
	}
	return true;
}

static map_session_data *pop_companion_owner(map_session_data *sd)
{
	if (!pop_is_companion(sd))
		return nullptr;
	map_session_data *owner = pop_companion_owner_session(sd);
	if (!owner || population_engine_is_population_pc(owner->id)
		|| !owner->state.active || owner->prev == nullptr
		|| owner->status.party_id != sd->status.party_id)
		return nullptr;
	return owner;
}

map_session_data *population_engine_companion_loot_owner(map_session_data *shell)
{
	map_session_data *owner = pop_companion_owner(shell);
	if (!owner || owner->m != shell->m)
		return nullptr;
	return owner;
}

bool population_engine_is_recruited_companion(const map_session_data *sd)
{
	return sd && population_engine_is_population_pc(sd->id) && pop_is_companion(sd);
}

/// Assign each recruited shell a deterministic, unobstructed idle cell around
/// its owner. Recomputing from stable shell IDs keeps the layout consistent
/// without persisting party-slot bookkeeping across map changes.
static bool pop_companion_formation_cell(map_session_data *sd, map_session_data *owner,
	int16 &out_x, int16 &out_y)
{
	if (!sd || !owner || sd->m != owner->m)
		return false;

	std::vector<map_session_data *> companions;
	for (map_session_data *candidate : g_population_engine_pcs) {
		if (pop_is_companion(candidate) && candidate->state.active &&
			pop_companion_owned_by(candidate, owner))
			companions.push_back(candidate);
	}
	std::sort(companions.begin(), companions.end(), [](const map_session_data *lhs, const map_session_data *rhs) {
		return lhs->id < rhs->id;
	});

	// The first four cells form a symmetric square around the player, and the
	// rest widen the ring. There is one cell per companion the cap allows
	// (11), plus one, so a full party still has an obstacle fallback to try:
	// with fewer cells than companions the last ones found nothing and stood
	// wherever they happened to stop. Every cell stays within the distance
	// pop_companion_update_formation keeps formation active over.
	static constexpr int8 offsets[][2] = {
		{-2,  1}, { 2,  1}, {-2, -1}, { 2, -1},
		{ 0,  2}, { 0, -2}, {-2,  0}, { 2,  0},
		{-1,  2}, { 1,  2}, {-1, -2}, { 1, -2}
	};
	static constexpr size_t offset_count = sizeof(offsets) / sizeof(offsets[0]);
	std::vector<std::pair<int16, int16>> reserved;
	for (size_t rank = 0; rank < companions.size(); ++rank) {
		bool assigned = false;
		int16 assigned_x = 0;
		int16 assigned_y = 0;
		for (size_t attempt = 0; attempt < offset_count; ++attempt) {
			const size_t offset_index = (rank + attempt) % offset_count;
			const int16 x = static_cast<int16>(owner->x + offsets[offset_index][0]);
			const int16 y = static_cast<int16>(owner->y + offsets[offset_index][1]);
			if (map_getcell(owner->m, x, y, CELL_CHKNOPASS))
				continue;
			if (std::find(reserved.begin(), reserved.end(), std::make_pair(x, y)) != reserved.end())
				continue;
			assigned_x = x;
			assigned_y = y;
			assigned = true;
			reserved.emplace_back(x, y);
			break;
		}
		if (companions[rank] == sd) {
			if (!assigned)
				return false;
			out_x = assigned_x;
			out_y = assigned_y;
			return true;
		}
	}
	return false;
}

static void pop_companion_update_formation(map_session_data *sd, map_session_data *owner)
{
	if (!sd || !owner || sd->m != owner->m || pc_isdead(sd))
		return;
	if (sd->pop.target_id != 0 || unit_is_walking(owner) || distance_bl(sd, owner) > 4 ||
		sd->ud.skilltimer != INVALID_TIMER) {
		sd->pop.companion_formation_active = false;
		return;
	}

	int16 target_x = 0;
	int16 target_y = 0;
	if (!pop_companion_formation_cell(sd, owner, target_x, target_y)) {
		sd->pop.companion_formation_active = false;
		return;
	}
	if (sd->x == target_x && sd->y == target_y) {
		sd->pop.companion_formation_active = false;
		return;
	}
	if (sd->pop.companion_formation_active) {
		if (sd->pop.companion_formation_x == target_x &&
			sd->pop.companion_formation_y == target_y && unit_is_walking(sd))
			return;
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		sd->pop.companion_formation_active = false;
	}
	// A non-formation walk belongs to combat/support and has priority.
	if (unit_is_walking(sd))
		return;
	if (unit_walktoxy(sd, target_x, target_y, 0) || unit_walktoxy(sd, target_x, target_y, 1)) {
		sd->pop.companion_formation_active = true;
		sd->pop.companion_formation_x = target_x;
		sd->pop.companion_formation_y = target_y;
	}
}

static uint32 pop_companion_party_threat(map_session_data *sd)
{
	if (!sd)
		return 0;
	for (const auto &entry : sd->pop.mob_tracker.tracked_mobs) {
		const s_pe_tracked_mob &mob = entry.second;
		if (mob.target_id == 0)
			continue;
		map_session_data *victim = map_id2sd(mob.target_id);
		if (!victim || victim->status.party_id != sd->status.party_id)
			continue;
		if (population_shell_check_target(sd, mob.mob_id) ||
			population_shell_check_target_for_movement(sd, mob.mob_id))
			return mob.mob_id;
	}
	return 0;
}

/// RAGNAROKMAC: how far from its owner a companion takes on a monster by itself (Attack mode).
static constexpr int kCompanionCombatRadius = 12;

/// A companion only joins combat chosen by its owner or forced on the party.
/// This intentionally replaces the shell's town/field origin behavior.
static uint32 pop_companion_combat_target(map_session_data *sd, map_session_data *owner, t_tick now)
{
	if (!sd || !owner)
		return 0;
	if (sd->pop.companion_mode == PopulationCompanionMode::Passive)
		return 0;

	// Tanks protect the party before copying the owner's target.
	if (static_cast<PopulationRoleType>(sd->pop.role) == PopulationRoleType::Tank) {
		const uint32 threat = pop_companion_party_threat(sd);
		if (threat != 0)
			return threat;
	}
	unit_data *owner_ud = unit_bl2ud(owner);
	if (owner_ud) {
		uint32 owner_target = 0;
		// unit_data::target remains authoritative across the short gaps between
		// basic-attack timer callbacks; gating on attacktimer alone misses most
		// ordinary player attacks (especially visible with town-origin shells).
		if (owner_ud->target > 0)
			owner_target = static_cast<uint32>(owner_ud->target);
		else if (owner_ud->skilltimer != INVALID_TIMER && owner_ud->skilltarget > 0)
			owner_target = static_cast<uint32>(owner_ud->skilltarget);
		if (owner_target != 0 &&
			(population_shell_check_target(sd, owner_target) ||
			 population_shell_check_target_for_movement(sd, owner_target)))
			return owner_target;
	}

	// Retaliate against a recent direct attacker so a passive owner cannot leave
	// the companion helpless. Repeated hits keep this short grace window alive.
	if (sd->pop.last_attacker_id != 0 && sd->pop.last_attacked_tick != 0 &&
		DIFF_TICK(now, sd->pop.last_attacked_tick) <= 5000 &&
		(population_shell_check_target(sd, sd->pop.last_attacker_id) ||
		 population_shell_check_target_for_movement(sd, sd->pop.last_attacker_id)))
		return sd->pop.last_attacker_id;

	// Defensive and Attack modes both protect party members already under attack.
	const uint32 party_threat = pop_companion_party_threat(sd);
	if (party_threat != 0)
		return party_threat;

	// Attack mode may independently acquire a monster, but only inside the
	// owner's 12-cell command radius. Pick the closest valid target so shells
	// do not spread out or chase ambient targets across the map.
	if (sd->pop.companion_mode == PopulationCompanionMode::Attack) {
		uint32 best_id = 0;
		int best_distance = kCompanionCombatRadius + 1;
		for (const auto &entry : sd->pop.mob_tracker.tracked_mobs) {
			const s_pe_tracked_mob &mob = entry.second;
			block_list *mob_bl = map_id2bl(static_cast<int>(mob.mob_id));
			if (!mob_bl || mob_bl->m != owner->m)
				continue;
			const int owner_distance = distance_bl(owner, mob_bl);
			if (owner_distance > kCompanionCombatRadius || owner_distance >= best_distance)
				continue;
			if (!population_shell_check_target(sd, mob.mob_id) &&
				!population_shell_check_target_for_movement(sd, mob.mob_id))
				continue;
			best_id = mob.mob_id;
			best_distance = owner_distance;
		}
		if (best_id != 0)
			return best_id;
	}
	return 0;
}

/// Keep a real-party shell close to the player who recruited it.
/// Returns true when normal combat/support processing may run this tick.
/// RAGNAROKMAC (rest): stand a shell up, the way a player's client does.
static void pop_shell_stand(map_session_data *sd)
{
	sd->pop.resting = false;
	if (pc_issit(sd) && pc_setstand(sd, false)) {
		skill_sit(sd, false);
		clif_standing(*sd);
	}
}

static bool pop_companion_follow_owner(map_session_data *sd, map_session_data *owner, t_tick now)
{
	if (!sd || !owner || pc_isdead(sd))
		return false;
	// A resting companion stays down while its owner stands still; pop_companion_rest decides
	// when it gets up, and anything below that moves it stands it first.
	if (pc_issit(sd) && !(sd->pop.resting && !unit_is_walking(owner)))
		pop_shell_stand(sd);
	if (sd->pop.companion_formation_active &&
		(unit_is_walking(owner) || sd->pop.target_id != 0)) {
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		sd->pop.companion_formation_active = false;
	}

	auto warp_near_owner = [&]() -> bool {
		pop_shell_stand(sd);
		sd->pop.companion_formation_active = false;
		int16 x = owner->x;
		int16 y = owner->y;
		map_search_freecell(owner, owner->m, &x, &y, 2, 2, 0);
		population_shell_target_change(sd, 0);
		unit_stop_attack(sd);
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		if (pc_setpos(sd, owner->mapindex, x, y, CLR_TELEPORT) != SETPOS_OK)
			return false;
		if (!pop_shell_finish_map_placement(sd)) {
			ShowError("Population engine: failed to place companion %s near %s.\n",
				sd->status.name, owner->status.name);
			return false;
		}
		population_shell_prepare_ammo(sd);
		sd->pop.last_teleport = now;
		pop_shell_broadcast_map_placement(sd);
		return true;
	};

	// Repair the precise state observed during rapid map changes: the fake PC
	// remains active and registered but has lost its map-block membership.
	//
	// Only reset the throttle when the placement actually took. The old form set
	// companion_follow_next BEFORE knowing whether warp_near_owner() succeeded, so a
	// persistent failure re-warped on every tick - the live log showed one companion
	// "recovered" thirteen times in a row, and a shell teleported that often cannot
	// walk at all. On failure, back off instead of retrying immediately.
	if (sd->prev == nullptr) {
		if (warp_near_owner()) {
			sd->pop.companion_follow_next = now + 400;
			sd->pop.placement_fail_streak = 0;
			ShowInfo("Population engine: recovered off-map companion %s near %s on map %s.\n",
				sd->status.name, owner->status.name, mapindex_id2name(owner->mapindex));
		} else {
			// Exponential backoff, capped so a recoverable case is retried promptly
			// but a permanently unplaceable shell stops consuming the tick.
			const int16_t streak = static_cast<int16_t>(sd->pop.placement_fail_streak + 1);
			sd->pop.placement_fail_streak = streak;
			uint32_t backoff = 400u << (streak > 5 ? 5 : streak);
			if (backoff > 30000u) backoff = 30000u;
			sd->pop.companion_follow_next = now + backoff;
			if (streak == 1 || streak % 10 == 0)
				ShowWarning("Population engine: companion %s could not be placed near %s (%d attempts); backing off %ums.\n",
					sd->status.name, owner->status.name, streak, backoff);
		}
		return false;
	}

	// RAGNAROKMAC: how far the companion may stray from its owner. Combat takes monsters some way
	// from the owner (Attack mode up to 12 cells; the owner's target, a party threat or the last
	// attacker with no limit), but the follow walked the companion back as soon as it was 5 cells
	// away: it set off for a monster 8 cells out, turned back at the fifth cell, took the monster
	// again on arrival, and paced back and forth until the owner came closer. While it fights a
	// monster within the owner's sight it may go as far as the fight takes it, up to where it
	// would be warped back anyway; once the owner moves on and leaves the monster out of sight,
	// the leash is 4.
	int leash = 4;
	if (sd->pop.target_id != 0) {
		block_list *target = map_id2bl(static_cast<int>(sd->pop.target_id));
		if (target && target->m == owner->m && !status_isdead(*target)
		    && check_distance_bl(owner, target, AREA_SIZE))
			leash = AREA_SIZE + 2;
	}

	if (now < sd->pop.companion_follow_next)
		return sd->m == owner->m && check_distance_bl(sd, owner, leash);
	sd->pop.companion_follow_next = now + 400;

	if (sd->m != owner->m) {
		if (warp_near_owner())
			ShowInfo("Population engine: companion %s followed %s to map %s.\n",
				sd->status.name, owner->status.name, mapindex_id2name(owner->mapindex));
		return false;
	}

	const int owner_distance = distance_bl(sd, owner);
	if (owner_distance > AREA_SIZE + 2) {
		warp_near_owner();
		return false;
	}
	if (owner_distance > leash) {
		pop_shell_stand(sd);
		population_shell_target_change(sd, 0);
		unit_stop_attack(sd);
		// RAGNAROKMAC: Intensive Aim (Night Watch) is a toggle that roots its user until it is cast
		// again, so a companion that had it on stood still and was only warped back once the owner
		// was out of sight. Drop it to follow, as a player toggles it off to move; the combat row
		// turns it back on at the next fight.
		if (sd->sc.getSCE(SC_INTENSIVE_AIM)) {
			status_change_end(sd, SC_INTENSIVE_AIM_COUNT);
			status_change_end(sd, SC_INTENSIVE_AIM);
		}
		// RAGNAROKMAC: full path search (flag 0). The easy path (flag 1) never walks round an
		// obstacle, so with a wall or a tree in between the walk did not start at all and the
		// companion stood still until the owner was far enough away to warp it.
		unit_walktobl(sd, owner, 3, 0);
		return false;
	}
	return true;
}

/// RAGNAROKMAC (rest): a shell low on SP or HP sits down between fights, as a player rests.
/// Sitting halves the natural regen interval and lets sitting-regen skills work
/// (status_natural_heal), and once shells pay for their skills (0029) one that ran dry
/// otherwise stood about for minutes. It sits below the lower mark of either and gets up at
/// the upper mark of both, or as soon as it is needed: a target, or a hit on itself; for a
/// companion also a threat to the party, its owner moving off, or, for a healer, its owner
/// hurt; for an ambient shell also a drop it means to pick up. An ambient shell's marks are
/// fixed (POP_REST_*); a companion's are its owner's choice, from the Companions window.
/// Returns true while it rests; the combat tick is skipped then.
static constexpr int16_t POP_REST_BELOW_PCT = 30;
static constexpr int16_t POP_REST_UNTIL_PCT = 95;

/// RAGNAROKMAC (potions): a shell carries a few of the potions a player of its level buys from a
/// Tool Dealer, and drinks one while it is needed (the same test as for standing up from a rest)
/// and below POP_POTION_*_PCT. Out of a fight it rests instead. The stock is given on its first
/// combat tick, so a recalled companion gets its own level's potions rather than those of the
/// level 99 it is spawned at, and a vendor, which never fights, gets none. It is topped up when
/// a rest ends at the upper mark, and a shell back from a selling trip is a new shell with a
/// new stock.
static constexpr int16_t POP_POTION_HP_PCT = 40;
static constexpr int16_t POP_POTION_SP_PCT = 20;
static constexpr int POP_POTION_HP_STOCK = 10;
static constexpr int POP_POTION_SP_STOCK = 5;
static constexpr t_itemid POP_POTIONS[] = { 501, 502, 503, 504, 533, 505 };

static t_itemid pop_shell_hp_potion(const map_session_data *sd)
{
	const int lv = sd->status.base_level;
	return lv >= 80 ? 504 : lv >= 55 ? 503 : lv >= 30 ? 502 : 501; // White, Yellow, Orange, Red
}

static t_itemid pop_shell_sp_potion(const map_session_data *sd)
{
	return sd->status.base_level >= 55 ? 505 : 533; // Blue Potion, Grape Juice
}

/// Tops the stock up to POP_POTION_*_STOCK of its level's potions, and drops any other tier's: a
/// companion that has levelled since moves on to the next potion.
static void pop_shell_stock_potions(map_session_data *sd)
{
	sd->pop.potions_stocked = true;
	const t_itemid hp = pop_shell_hp_potion(sd), sp = pop_shell_sp_potion(sd);
	for (const t_itemid nameid : POP_POTIONS) {
		if (nameid == hp || nameid == sp)
			continue;
		const int16 idx = pc_search_inventory(sd, nameid);
		if (idx >= 0)
			pc_delitem(sd, idx, sd->inventory.u.items_inventory[idx].amount, 0, 0, LOG_TYPE_NONE);
	}
	for (const auto &want : { std::make_pair(hp, POP_POTION_HP_STOCK), std::make_pair(sp, POP_POTION_SP_STOCK) }) {
		const int16 idx = pc_search_inventory(sd, want.first);
		const int have = idx >= 0 ? sd->inventory.u.items_inventory[idx].amount : 0;
		if (have >= want.second || !itemdb_exists(want.first))
			continue;
		struct item it = {};
		it.nameid = want.first;
		it.identify = 1;
		pc_additem(sd, &it, want.second - have, LOG_TYPE_NONE, false);
	}
}

/// Drinks one potion if HP or SP is below its mark: HP first, as a player would.
static void pop_shell_drink(map_session_data *sd, int hp_pct, int sp_pct, t_tick now)
{
	if (DIFF_TICK(now, sd->pop.next_potion_tick) < 0 || pc_isdead(sd) || pc_issit(sd))
		return;
	int16 idx = -1;
	if (hp_pct < POP_POTION_HP_PCT)
		idx = pc_search_inventory(sd, pop_shell_hp_potion(sd));
	if (idx < 0 && sp_pct < POP_POTION_SP_PCT)
		idx = pc_search_inventory(sd, pop_shell_sp_potion(sd));
	if (idx < 0)
		return;
	// The player's own path: item delay, the heal script.
	const t_itemid nameid = sd->inventory.u.items_inventory[idx].nameid;
	const int32 had = sd->inventory.u.items_inventory[idx].amount;
	if (!pc_useitem(sd, idx))
		return;
	sd->pop.next_potion_tick = now + 1000;
	// And the use animation for everyone around, which clif_useitemack sends only for a
	// character with a session: a shell's potion healed it with nothing to show for it.
	if (!session_isActive(sd->fd)) {
		PACKET_ZC_USE_ITEM_ACK p = {};
		p.packetType = useItemAckType;
		p.index = idx + 2;
#if PACKETVER >= 3
		const t_itemid view = itemdb_viewid(nameid); // clif.cpp's client_nameid, which is static there
		p.itemId = static_cast<decltype(p.itemId)>(view > 0 ? view : nameid);
		p.AID = sd->id;
#endif
		p.amount = had - 1;
		p.result = true;
		clif_send(&p, sizeof(p), sd, AREA_WOS);
	}
}

static bool pop_shell_rest(map_session_data *sd, map_session_data *owner, uint32 target, t_tick now)
{
	// Never a dead shell: pc_setsit writes state.dead_sit = 2 over the 1 that pc_isdead reads,
	// so sitting one down stood it back up, alive at 0 HP.
	if (pc_isdead(sd) || status_isdead(*sd)) {
		sd->pop.resting = false;
		return false;
	}
	const int below = owner != nullptr ? sd->pop.companion_rest_below : POP_REST_BELOW_PCT;
	// Never stand up below the mark it sat down at, or it would sit straight back down.
	const int until = std::max(below + 1, static_cast<int>(owner != nullptr ? sd->pop.companion_rest_until : POP_REST_UNTIL_PCT));
	auto pct = [](uint32 cur, uint32 max) {
		return max > 0 ? static_cast<int>(static_cast<uint64>(cur) * 100 / max) : 100;
	};
	const int sp = pct(sd->battle_status.sp, sd->battle_status.max_sp);
	const int hp = pct(sd->battle_status.hp, sd->battle_status.max_hp);
	bool needed = target != 0
		|| (sd->pop.last_attacked_tick != 0 && DIFF_TICK(now, sd->pop.last_attacked_tick) <= 5000);
	if (owner != nullptr)
		needed = needed
			|| pc_isdead(owner)
			|| unit_is_walking(owner)
			|| (pc_checkskill(sd, AL_HEAL) > 0
				&& pct(owner->battle_status.hp, owner->battle_status.max_hp) < sd->pop.companion_heal_at)
			|| pop_companion_party_threat(sd) != 0;
	else
		needed = needed || population_shell_loot_busy(sd);

	if (!sd->pop.potions_stocked)
		pop_shell_stock_potions(sd);
	if (sd->pop.resting) {
		if (needed || !pc_issit(sd) || below <= 0 || (sp >= until && hp >= until)) {
			// A rest that ran its course restocks the potions; one cut short does not.
			if (!needed && sp >= until && hp >= until)
				pop_shell_stock_potions(sd);
			pop_shell_stand(sd);
			if (needed)
				pop_shell_drink(sd, hp, sp, now);
			return false;
		}
		return true;
	}
	if (needed)
		pop_shell_drink(sd, hp, sp, now);
	if (below <= 0 || needed || pc_issit(sd) || unit_is_walking(sd) || (sp >= below && hp >= below))
		return false;
	// The checks a player's sit request passes (clif_parse_ActionRequest_sub, DMG_SIT_DOWN).
	if (sd->ud.skilltimer != INVALID_TIMER || (sd->sc.opt1 && sd->sc.opt1 != OPT1_STONEWAIT && sd->sc.opt1 != OPT1_BURNING)
		|| sd->sc.getSCE(SC_DANCING)
		|| (sd->sc.getSCE(SC_GRAVITATION) && sd->sc.getSCE(SC_GRAVITATION)->val3 == BCT_SELF)
		|| (sd->state.block_action & PCBLOCK_SITSTAND))
		return false;
	unit_stop_attack(sd);
	sd->pop.companion_formation_active = false;
	pc_setsit(sd);
	skill_sit(sd, true);
	clif_sitting(*sd);
	sd->pop.resting = true;
	return true;
}

// ---- RAGNAROKMAC: mod vendors ------------------------------------------------
//
// A vendor entry with `Spawns:` belongs to a mod. Its shells are spawned here,
// next to (never through) the engine's own VendorPlacement pass, so a mod can
// put vendors on exact cells or in its own areas without changing where or how
// many of the engine's vendors appear, and without touching another mod's. The
// shell's look comes from the PlacementBound profile whose VendorKey equals the
// entry's key; its stock comes from the entry itself.

/// RAGNAROKMAC: a price the way players write it on a sign: 450z, 4.5k, 13k, 1.2m.
static std::string pop_price_short(uint32_t p) {
	char b[32];
	if (p >= 1000000)
		safesnprintf(b, sizeof(b), "%.1fm", p / 1000000.0);
	else if (p >= 1000)
		safesnprintf(b, sizeof(b), "%.1fk", p / 1000.0);
	else
		safesnprintf(b, sizeof(b), "%uz", p);
	std::string s = b;
	if (s.size() > 3 && s.compare(s.size() - 3, 2, ".0") == 0)
		s.erase(s.size() - 3, 2);
	return s;
}

/// RAGNAROKMAC: a sign for a mod stall, chosen once its stock is known (item
/// id and price of each line it opened with): its entry's TitleFromPool, plus
/// every StockTitles sign that stock bears out, with {item} and {price} filled
/// from one of its lines; {name} is the owner's name. Never one another stall
/// on the map already shows (another if one is free, else numbered): a vending
/// stall looks at other vending stalls, a buying store at both, as before.
/// fallback is the sign when there is no pool. Without StockTitles this picks
/// exactly as the code before it did.
static std::string pop_mod_pick_title(map_session_data* sd, const PopulationVendorEntry& e,
	const std::vector<std::pair<t_itemid, uint32_t>>& stock, const std::string& fallback, bool buying)
{
	const std::pair<t_itemid, uint32_t>* line = stock.empty() ? nullptr : &stock[rnd() % stock.size()];
	auto has = [&](t_itemid id) {
		for (const auto& s : stock)
			if (s.first == id)
				return true;
		return false;
	};
	// {item} and {price} only in StockTitles: TitleFromPool signs read as before.
	auto resolve = [&](const std::string& t, bool from_stock) {
		std::string r = t;
		population_engine_chat_replace_all(r, "{name}", std::string(sd->status.name));
		if (from_stock && line != nullptr) {
			std::shared_ptr<item_data> id = item_db.find(line->first);
			population_engine_chat_replace_all(r, "{item}", id ? id->ename : std::string("stuff"));
			population_engine_chat_replace_all(r, "{price}", pop_price_short(line->second));
		}
		if (r.size() >= MESSAGE_SIZE)
			r.resize(MESSAGE_SIZE - 1);
		return r;
	};
	auto in_use = [&](const std::string& t) {
		for (map_session_data* o : g_population_engine_pcs)
			if (o && o != sd && o->m == sd->m && (o->state.vending || (buying && o->state.buyingstore)) && t == o->message)
				return true;
		return false;
	};
	std::vector<std::string> cands;
	for (const std::string& t : e.title_pool)
		cands.push_back(resolve(t, false));
	for (const PopulationStockTitle& st : e.stock_titles) {
		if (line == nullptr && (st.text.find("{item}") != std::string::npos || st.text.find("{price}") != std::string::npos))
			continue;
		bool ok = true;
		for (t_itemid id : st.needs)
			if (!has(id)) { ok = false; break; }
		if (ok && !st.any.empty()) {
			ok = false;
			for (t_itemid id : st.any)
				if (has(id)) { ok = true; break; }
		}
		if (ok)
			cands.push_back(resolve(st.text, true));
	}
	if (cands.empty())
		cands.push_back(resolve(fallback, false));
	for (size_t i = cands.size(); i > 1; --i)
		std::swap(cands[i - 1], cands[rnd() % i]);
	for (const std::string& c : cands)
		if (!in_use(c))
			return c;
	const std::string base = cands.front();
	for (int n = 2; n < 100; ++n) {
		const std::string suffix = " " + std::to_string(n);
		std::string t = base.substr(0, std::min(base.size(), static_cast<size_t>(MESSAGE_SIZE - 1) - suffix.size())) + suffix;
		if (!in_use(t))
			return t;
	}
	return base;
}

/// A cell a mod vendor may take: walkable, vending allowed, nobody standing on
/// it (players and shells are both BL_PC). An occupied seat stays empty until
/// it is free again; it is never moved.
static bool pop_mod_vendor_cell_free(int16_t m, int16_t x, int16_t y) {
	struct map_data* md = map_getmapdata(m);
	if (!md || x < 0 || y < 0 || x >= md->xs || y >= md->ys)
		return false;
	if (!map_getcell(m, x, y, CELL_CHKPASS) || map_getcell(m, x, y, CELL_CHKNOVENDING))
		return false;
	return map_count_oncell(m, x, y, BL_PC, 0) == 0;
}

/// RAGNAROKMAC: true when an NPC stands within min_npc_vendchat_distance of
/// (x, y) -- the rule that keeps a player's own shop away from NPCs, which a
/// shell never goes through. Hidden NPCs (disablenpc) do not count, as for a
/// player. Used for Count + Areas only: a fixed seat is where its mod put it.
static bool pop_mod_vendor_near_npc(int16_t m, int16_t x, int16_t y) {
	const int16_t d = static_cast<int16_t>(battle_config.min_npc_vendchat_distance);
	if (d <= 0)
		return false;
	return map_foreachinallarea(npc_isnear_sub, m,
		static_cast<int16_t>(x - d), static_cast<int16_t>(y - d),
		static_cast<int16_t>(x + d), static_cast<int16_t>(y + d), BL_NPC, 0) > 0;
}

/// RAGNAROKMAC: a cell for the next shell of a "Fill: Lanes" block, the way
/// players open shops: in the first area (lane) that has not reached its share
/// of shells, in the order the block lists them, on a free cell near a shell
/// already there (within two cells past MinSpacing, so a stall now and then
/// leaves a gap), or anywhere in it when the lane is empty or its run is boxed
/// in (an NPC, a wall). A lane's share is LaneFillPct of its usable cells
/// (walkable, vending allowed, clear of NPCs), rolled once per lane in its
/// [min, max]; 100 fills it. Once every lane has its share the rest fill in
/// the same order, so a high Count still finds room. False if no cell is free.
static bool pop_mod_vendor_lane_cell(int16_t m, const PopulationModSpawn& sp,
	const std::vector<std::pair<int16_t, int16_t>>& mine, int16_t& out_x, int16_t& out_y)
{
	static std::unordered_map<std::string, int> lane_pct; // per lane, rolled once per run
	const int reach = sp.min_spacing + 2;
	struct Lane {
		std::vector<std::pair<int16_t, int16_t>> beside, free_cells;
		bool has_shells = false, at_share = false;
	};
	std::vector<Lane> lanes(sp.areas.size());
	for (size_t li = 0; li < sp.areas.size(); ++li) {
		const PopulationModSpawnArea& a = sp.areas[li];
		Lane& lane = lanes[li];
		int shells = 0, usable = 0;
		for (const auto& p : mine)
			if (p.first >= a.x1 && p.first <= a.x2 && p.second >= a.y1 && p.second <= a.y2)
				++shells;
		lane.has_shells = shells > 0;
		for (int16_t y = a.y1; y <= a.y2; ++y) {
			for (int16_t x = a.x1; x <= a.x2; ++x) {
				if (!map_getcell(m, x, y, CELL_CHKPASS) || map_getcell(m, x, y, CELL_CHKNOVENDING) ||
				    pop_mod_vendor_near_npc(m, x, y))
					continue;
				++usable;
				bool too_close = false, near_one = false;
				for (const auto& p : mine) {
					const int dx = std::abs(p.first - x), dy = std::abs(p.second - y);
					if (dx <= sp.min_spacing && dy <= sp.min_spacing) {
						too_close = true;
						break;
					}
					if (dx <= reach && dy <= reach)
						near_one = true;
				}
				if (too_close || !pop_mod_vendor_cell_free(m, x, y))
					continue;
				lane.free_cells.emplace_back(x, y);
				if (near_one)
					lane.beside.emplace_back(x, y);
			}
		}
		int pct = 100;
		if (sp.lane_fill_min < 100) {
			const std::string key = sp.spawn_id + "#" + std::to_string(li);
			auto it = lane_pct.find(key);
			if (it == lane_pct.end())
				it = lane_pct.emplace(key, sp.lane_fill_min +
					static_cast<int>(rnd() % static_cast<uint32_t>(sp.lane_fill_max - sp.lane_fill_min + 1))).first;
			pct = it->second;
		}
		lane.at_share = shells * 100 >= usable * pct;
	}
	auto take = [&](const Lane& lane) {
		const auto& from = (lane.has_shells && !lane.beside.empty()) ? lane.beside : lane.free_cells;
		if (from.empty())
			return false;
		const auto& c = from[rnd() % from.size()];
		out_x = c.first;
		out_y = c.second;
		return true;
	};
	for (const Lane& lane : lanes)
		if (!lane.at_share && take(lane))
			return true;
	for (const Lane& lane : lanes) // every lane has its share: the rest, in order
		if (take(lane))
			return true;
	return false;
}

/// Spawn one shell for a mod vendor block at (x, y). Mirrors the look-building in
/// autosummon_fill_map, but with the vendor's own profile handed in directly.
static bool pop_mod_vendor_spawn_one(int16_t m, const PopulationVendorEntry& entry,
	const PopulationModSpawn& sp, const PopulationEngine& prof, int16_t x, int16_t y, int16_t seat)
{
	const uint16_t job_id = prof.sprite_job;
	if (!pcdb_checkid(job_id))
		return false;

	char sex;
	const char required_sex = get_job_required_sex(job_id);
	if (required_sex != '\0')
		sex = required_sex;
	else if (prof.sex_override >= 0)
		sex = prof.sex_override ? 'M' : 'F';
	else
		sex = (rnd() % 2) ? 'M' : 'F';

	const uint8_t  hair_style  = MAX_HAIR_STYLE;
	const uint16_t hair_color  = static_cast<uint16_t>(population_roll_closed_range(MIN_HAIR_COLOR, MAX_HAIR_COLOR));
	const uint16_t cloth_color = static_cast<uint16_t>(population_roll_closed_range(MIN_CLOTH_COLOR, MAX_CLOTH_COLOR));
	auto pick_pool = [](const std::vector<uint16_t>& p) -> uint16_t {
		if (p.empty()) return 0;
		return p.size() == 1 ? p[0] : p[rnd() % p.size()];
	};

	const uint32_t index = population_engine_allocate_index();
	if (index == 0)
		return false;

	map_session_data* sd = population_engine_spawn_shell(
		m, x, y, index, job_id, sex, hair_style, hair_color,
		pick_pool(prof.weapon_pool), pick_pool(prof.shield_pool),
		pick_pool(prof.head_top_pool), pick_pool(prof.head_mid_pool), pick_pool(prof.head_bottom_pool),
		0 /*option*/, cloth_color, pick_pool(prof.garment_pool), prof.script, prof.skip_arrow,
		&prof, 1 /*town: selects TownBehavior vendor*/, PopulationDbSource::Vendor,
		&entry, &sp, seat);
	if (!sd) {
		g_population_engine_stats.errors++;
		return false;
	}
	g_population_engine_pcs.push_back(sd);
	g_population_engine_count++;
	g_population_engine_stats.total_created++;
	g_population_engine_stats.active_units++;
	// A stall's first callout lands anywhere in its interval, so a street that
	// spawns at once does not open with every stall shouting together. Always
	// set, even if its profile has no chat pool: no entry means "speak now".
	int pace_lo = 0, pace_hi = 0;
	pop_mod_vendor_callout_pace(sd, &entry, pace_lo, pace_hi);
	const int32 spread = pace_hi > 0 ? pace_hi
		: (battle_config.population_engine_chat_cooldown_ms + battle_config.population_engine_chat_cooldown_jitter_ms) / 1000;
	g_pop_chat_next_tick[sd->id] = gettick() + static_cast<t_tick>(rnd() % (static_cast<uint32_t>(std::max(spread, 1)) + 1u)) * 1000;
	return true;
}

/// RAGNAROKMAC: what a mod's scripts set for its vendors (from its settings),
/// per VendorKey prefix. -1 = not set, keep the YAML.
struct PopModVendorSettings {
	std::string prefix;
	int total = -1;            ///< population_vendor_count
	int rotation_min = -1;     ///< population_vendor_rotation (0 = never)
	int callouts = -1;         ///< population_vendor_callouts: 0 off, 1 on
	int callout_min_sec = -1;
	int callout_max_sec = -1;
	int respect_limit = -1;    ///< population_vendor_limit: 0 = spawn even when the population is full
	int price_pct = -1;        ///< population_vendor_price: every listed price × this / 100
};
static std::vector<PopModVendorSettings> g_pop_mod_vendor_settings;
/// Breaks ties when a total is smaller than the number of blocks, so which
/// themes sit out changes with each server start rather than always the same.
static uint32_t g_pop_mod_vendor_seed = 0;

static PopModVendorSettings& pop_mod_vendor_settings_for_prefix(const char* prefix) {
	const std::string p = prefix ? prefix : "";
	for (auto& e : g_pop_mod_vendor_settings)
		if (e.prefix == p)
			return e;
	g_pop_mod_vendor_settings.push_back(PopModVendorSettings{});
	g_pop_mod_vendor_settings.back().prefix = p;
	return g_pop_mod_vendor_settings.back();
}

/// The settings that apply to a VendorKey: the longest matching prefix.
static const PopModVendorSettings* pop_mod_vendor_settings_for_key(const std::string& key) {
	const PopModVendorSettings* best = nullptr;
	for (const auto& e : g_pop_mod_vendor_settings)
		if (key.compare(0, e.prefix.size(), e.prefix) == 0 && (!best || e.prefix.size() > best->prefix.size()))
			best = &e;
	return best;
}

void population_engine_set_mod_vendor_total(const char* prefix, int total) {
	if (g_pop_mod_vendor_seed == 0)
		g_pop_mod_vendor_seed = static_cast<uint32_t>(rnd()) | 1u;
	PopModVendorSettings& e = pop_mod_vendor_settings_for_prefix(prefix);
	e.total = total < 0 ? -1 : total;
	ShowInfo("Population engine: mod vendors '%s*': %d in total.\n", e.prefix.c_str(), e.total);
}

void population_engine_set_mod_vendor_rotation(const char* prefix, int minutes) {
	PopModVendorSettings& e = pop_mod_vendor_settings_for_prefix(prefix);
	e.rotation_min = minutes < 0 ? -1 : std::min(minutes, 168 * 60);
	ShowInfo("Population engine: mod vendors '%s*': rotate every %d min.\n", e.prefix.c_str(), e.rotation_min);
}

void population_engine_set_mod_vendor_callouts(const char* prefix, int on, int min_sec, int max_sec) {
	PopModVendorSettings& e = pop_mod_vendor_settings_for_prefix(prefix);
	e.callouts = on ? 1 : 0;
	if (max_sec < min_sec) std::swap(min_sec, max_sec);
	e.callout_min_sec = min_sec > 0 ? min_sec : -1;
	e.callout_max_sec = max_sec > 0 ? max_sec : -1;
	ShowInfo("Population engine: mod vendors '%s*': callouts %s, every %d-%d s.\n",
		e.prefix.c_str(), on ? "on" : "off", e.callout_min_sec, e.callout_max_sec);
}

void population_engine_set_mod_vendor_limit(const char* prefix, int respect) {
	PopModVendorSettings& e = pop_mod_vendor_settings_for_prefix(prefix);
	e.respect_limit = respect ? 1 : 0;
	ShowInfo("Population engine: mod vendors '%s*': %s the population limit.\n",
		e.prefix.c_str(), respect ? "respect" : "ignore");
}

void population_engine_set_mod_vendor_price(const char* prefix, int pct) {
	PopModVendorSettings& e = pop_mod_vendor_settings_for_prefix(prefix);
	e.price_pct = pct > 0 ? std::min(pct, 100000) : -1;
	ShowInfo("Population engine: mod vendors '%s*': prices at %d%%.\n", e.prefix.c_str(), pct > 0 ? e.price_pct : 100);
}

/// RAGNAROKMAC: a price percentage for one item that a mod sets in
/// $@pop_item_pct[<item id>] (unset or 0 = 100), on top of its mod's price
/// level. Applied wherever the engine prices a mod's stalls and buyers and in
/// the customers' market price, so a mod can move single prices at runtime: a
/// sale, a seasonal surge, a market that follows trades.
static int pop_item_price_pct(t_itemid id) {
	static int32 key = 0;
	if (key == 0)
		key = add_str("$@pop_item_pct");
	if (id == 0)
		return 100;
	const int64 v = mapreg_readreg(reference_uid(key, id));
	return v > 0 ? static_cast<int>(std::min<int64>(v, 1000)) : 100;
}

/// The price level a mod vendor's mod set, in percent (100 = as listed).
static int pop_mod_vendor_price_pct(const PopulationVendorEntry* mod_entry) {
	if (mod_entry == nullptr)
		return 100;
	const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(mod_entry->key);
	return st && st->price_pct > 0 ? st->price_pct : 100;
}

/// A mod vendor shell's callout pace: its settings, else its entry, else 0
/// (the engine's global cooldown). Returns false when its callouts are off.
static bool pop_mod_vendor_callout_pace(const map_session_data* sd, const PopulationVendorEntry* ve, int& lo, int& hi) {
	lo = ve ? ve->callout_min_sec : 0;
	hi = ve ? ve->callout_max_sec : 0;
	if (const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(sd->pop.vendor_key)) {
		if (st->callouts == 0)
			return false;
		if (st->callout_max_sec > 0) {
			lo = st->callout_min_sec > 0 ? st->callout_min_sec : st->callout_max_sec;
			hi = st->callout_max_sec;
		}
	}
	return true;
}

/// Per spawn block, the count a population_vendor_count total gives it: the
/// total split by the blocks' YAML counts (largest remainder, so it adds up
/// exactly), a seat block never above its seats.
static std::unordered_map<std::string, size_t> pop_mod_vendor_overrides() {
	std::unordered_map<std::string, size_t> out;
	for (const auto& tot : g_pop_mod_vendor_settings) {
		if (tot.total < 0)
			continue;
		std::vector<const PopulationModSpawn*> blocks;
		for (const auto& kv : population_vendor_db().vendor_entries())
			if (kv.first.compare(0, tot.prefix.size(), tot.prefix) == 0)
				for (const PopulationModSpawn& sp : kv.second.spawns)
					blocks.push_back(&sp);
		std::sort(blocks.begin(), blocks.end(),
			[](const PopulationModSpawn* a, const PopulationModSpawn* b) { return a->spawn_id < b->spawn_id; });
		auto weight = [](const PopulationModSpawn* sp) -> size_t {
			return sp->positions.empty() ? static_cast<size_t>(sp->count) : sp->positions.size();
		};
		size_t wsum = 0;
		for (const auto* sp : blocks) wsum += weight(sp);
		if (wsum == 0) continue;
		const size_t total = static_cast<size_t>(tot.total);
		std::vector<std::pair<size_t, size_t>> rem; // (remainder, index)
		size_t given = 0;
		for (size_t i = 0; i < blocks.size(); ++i) {
			const size_t share = total * weight(blocks[i]);
			out[blocks[i]->spawn_id] = share / wsum;
			given += share / wsum;
			rem.emplace_back(share % wsum, i);
		}
		std::vector<size_t> tie(blocks.size());
		for (size_t i = 0; i < blocks.size(); ++i)
			tie[i] = std::hash<std::string>()(blocks[i]->spawn_id) ^ (static_cast<size_t>(g_pop_mod_vendor_seed) * 2654435761u);
		std::sort(rem.begin(), rem.end(),
			[&](const std::pair<size_t, size_t>& a, const std::pair<size_t, size_t>& b) {
				return a.first != b.first ? a.first > b.first : tie[a.second] < tie[b.second];
			});
		for (size_t r = 0; given < total && r < rem.size(); ++r, ++given)
			++out[blocks[rem[r].second]->spawn_id];
		for (const auto* sp : blocks)
			if (!sp->positions.empty() && out[sp->spawn_id] > sp->positions.size())
				out[sp->spawn_id] = sp->positions.size();
	}
	return out;
}

/// RAGNAROKMAC: the theme a market spot gets. Themes below their Min come
/// first; otherwise a weighted pick, each theme's weight divided by (1 + the
/// stalls of it already in this block) so the street stays varied, skipping
/// themes at their Max. nullptr if no theme can be used.
static const PopulationVendorEntry* pop_market_pick(const PopulationVendorEntry& market, int16 m,
	const PopulationModSpawn& sp, std::unordered_set<std::string>& warned)
{
	std::unordered_map<std::string, int> have;
	for (map_session_data* psd : g_population_engine_pcs)
		if (psd && psd->m == m && psd->pop.vendor_spawn_id == sp.spawn_id)
			++have[psd->pop.vendor_key];

	struct Cand { const PopulationMarketTheme* t; const PopulationVendorEntry* e; };
	std::vector<Cand> usable;
	for (const PopulationMarketTheme& t : market.themes) {
		const PopulationVendorEntry* e = population_vendor_db().find(t.key);
		if (e == nullptr || e->is_market || population_vendor_pop_db().find_by_vendor_key(t.key) == nullptr) {
			if (warned.insert(market.key + ">" + t.key).second)
				ShowWarning("Population engine: market '%s' names theme '%s', which has no vendor entry "
				            "or no PlacementBound profile; skipped.\n", market.key.c_str(), t.key.c_str());
			continue;
		}
		if (t.max > 0 && have[t.key] >= t.max)
			continue;
		usable.push_back({ &t, e });
	}
	std::vector<Cand> need;
	for (const Cand& c : usable)
		if (have[c.t->key] < c.t->min)
			need.push_back(c);
	const std::vector<Cand>& from = need.empty() ? usable : need;
	auto weight = [&](const Cand& c) {
		return static_cast<double>(std::max(c.t->weight, need.empty() ? 0 : 1)) / (1 + have[c.t->key]);
	};
	double total = 0;
	for (const Cand& c : from)
		total += weight(c);
	if (total <= 0)
		return nullptr;
	double r = (static_cast<double>(rnd() % 1000000) / 1000000.0) * total;
	for (const Cand& c : from) {
		r -= weight(c);
		if (r <= 0)
			return c.e;
	}
	return from.back().e;
}

/// RAGNAROKMAC: open a buying store for a mod buyer shell: up to
/// MAX_BUYINGSTORE_SLOTS items drawn from its pool (only items rAthena lets a
/// buying store take), each with its wanted amount and a price rolled in its
/// range at the mod's price level, never below what an NPC pays (or a player
/// would sell there instead). The shell gets one of each item (rAthena wants
/// a buyer to own one), exactly the zeny it offers, and room to carry it all.
static bool pop_shell_open_buyingstore(map_session_data* sd, const PopulationVendorEntry& e) {
	if (sd == nullptr || e.pool.empty())
		return false;
	std::vector<const PopulationVendorStock*> cands;
	for (const PopulationVendorStock& vs : e.pool) {
		std::shared_ptr<item_data> id = item_db.find(vs.nameid);
		if (id && id->flag.buyingstore && vs.price > 0)
			cands.push_back(&vs);
	}
	if (cands.empty())
		return false;
	for (size_t i = cands.size(); i > 1; --i)
		std::swap(cands[i - 1], cands[rnd() % i]);
	int lo = e.pick_count_min > 0 ? e.pick_count_min : MAX_BUYINGSTORE_SLOTS;
	int hi = e.pick_count_max > 0 ? e.pick_count_max : lo;
	if (hi < lo) hi = lo;
	int want = hi > lo ? lo + static_cast<int>(rnd() % (hi - lo + 1)) : lo;
	want = std::max(1, std::min({ want, static_cast<int>(MAX_BUYINGSTORE_SLOTS), static_cast<int>(cands.size()) }));

	const int pct = pop_mod_vendor_price_pct(&e);
	std::vector<PACKET_CZ_REQ_OPEN_BUYING_STORE_sub> list;
	int64_t budget = 0;
	for (int i = 0; i < want; ++i) {
		const PopulationVendorStock& vs = *cands[i];
		std::shared_ptr<item_data> id = item_db.find(vs.nameid);
		int64_t p = vs.price_max > vs.price ? vs.price + static_cast<int64_t>(rnd() % (vs.price_max - vs.price + 1)) : vs.price;
		p = p * pct / 100 * pop_item_price_pct(vs.nameid) / 100;
		if (p >= 10000)     p = p / 500 * 500;
		else if (p >= 1000) p = p / 50 * 50;
		else if (p >= 100)  p = p / 5 * 5;
		if (p <= static_cast<int64_t>(id->value_sell)) p = id->value_sell + 1;
		p = std::min<int64_t>(std::max<int64_t>(p, 1), 99990000);
		// Wants between half and all of its listed amount.
		const int amount = std::max(1, std::min<int>(9998, vs.amount / 2 + static_cast<int>(rnd() % (vs.amount / 2 + 1))));
		PACKET_CZ_REQ_OPEN_BUYING_STORE_sub sub{};
		sub.itemId = vs.nameid;
		sub.amount = static_cast<uint16>(amount);
		sub.price = static_cast<uint32>(p);
		list.push_back(sub);
		budget += p * amount;
	}
	budget = std::min<int64_t>(budget, MAX_ZENY);

	// What rAthena asks of a buyer: one of each item, the zeny, and room.
	for (const auto& sub : list) {
		if (pc_search_inventory(sd, sub.itemId) >= 0)
			continue;
		struct item it = {};
		it.nameid = sub.itemId;
		it.identify = 1;
		pc_additem(sd, &it, 1, LOG_TYPE_NONE);
	}
	sd->status.zeny = static_cast<int32>(budget);
	sd->max_weight = INT32_MAX / 2;

	if (buyingstore_setup(sd, static_cast<unsigned char>(list.size())) != 0)
		return false;
	std::vector<std::pair<t_itemid, uint32_t>> bought;
	for (const auto& sub : list)
		bought.emplace_back(sub.itemId, sub.price);
	const std::string title = pop_mod_pick_title(sd, e, bought, e.title.empty() ? std::string("Buying") : e.title, true);
	if (buyingstore_create(sd, static_cast<int32>(budget), 1, title.c_str(), list.data(), static_cast<uint32>(list.size()), nullptr) != 0) {
		ShowWarning("Population engine: buyer '%s' (%s) could not open its buying store.\n", sd->status.name, e.key.c_str());
		return false;
	}
	// Rotation, like a stall.
	const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(e.key);
	const int rotation_sec = st && st->rotation_min >= 0 ? st->rotation_min * 60 : e.rotation_sec;
	if (rotation_sec > 0) {
		int jitter = std::min(e.rotation_jitter_sec, rotation_sec / 2);
		const int offset = jitter > 0 ? static_cast<int>(rnd() % (jitter * 2 + 1)) - jitter : 0;
		sd->pop.vendor_rotation_at = gettick() + static_cast<t_tick>(std::max(60, rotation_sec + offset)) * 1000;
	}
	return true;
}

// RAGNAROKMAC: customers for real players' stalls (opt-in; see the file).
#include "population_engine/runtime/population_customers.cpp"

/// RAGNAROKMAC: @vendorinfo. No argument: every mod stall on the GM's map.
/// With one: a vendor theme's settings and stock, or a market's themes.
/// A key may be given whole or by its last part ("byalan").
void population_engine_vendorinfo(map_session_data* sd, const char* arg) {
	if (sd == nullptr)
		return;
	const int fd = sd->fd;
	char buf[CHAT_SIZE_MAX];
	std::string q = arg ? arg : "";
	while (!q.empty() && std::isspace(static_cast<unsigned char>(q.back()))) q.pop_back();
	while (!q.empty() && std::isspace(static_cast<unsigned char>(q.front()))) q.erase(q.begin());

	// RAGNAROKMAC: @vendorinfo customers [ff <minutes>]: players' stalls.
	if (q.compare(0, 9, "customers") == 0) {
		std::string rest = q.substr(9);
		while (!rest.empty() && std::isspace(static_cast<unsigned char>(rest.front()))) rest.erase(rest.begin());
		population_customers_info(sd, rest);
		return;
	}

	if (q.empty()) {
		size_t n = 0;
		const t_tick now = gettick();
		for (map_session_data* psd : g_population_engine_pcs) {
			if (!psd || psd->m != sd->m || psd->pop.vendor_spawn_id.empty())
				continue;
			char rot[48] = "";
			if (psd->pop.vendor_rotation_at != 0)
				safesnprintf(rot, sizeof(rot), ", rotates in %lldm",
					static_cast<long long>(std::max<t_tick>(0, DIFF_TICK(psd->pop.vendor_rotation_at, now)) / 60000));
			const bool open = psd->state.vending || psd->state.buyingstore;
			safesnprintf(buf, sizeof(buf), "%s (%d,%d) %s: %s\"%s\", %d item(s)%s", psd->status.name, psd->x, psd->y,
				psd->pop.vendor_key.c_str(), psd->state.buyingstore ? "buying " : "", open ? psd->message : "(closed)",
				psd->state.buyingstore ? psd->buyingstore.slots : psd->vend_num, rot);
			clif_displaymessage(fd, buf);
			++n;
		}
		safesnprintf(buf, sizeof(buf), "%zu mod vendor stall(s) on this map. @vendorinfo <theme or market> for details.", n);
		clif_displaymessage(fd, buf);
		return;
	}

	const PopulationVendorEntry* e = population_vendor_db().find(q);
	if (e == nullptr) {
		const std::string tail = "/" + q;
		for (const auto& kv : population_vendor_db().vendor_entries())
			if (kv.first.size() >= tail.size() && kv.first.compare(kv.first.size() - tail.size(), tail.size(), tail) == 0) {
				e = &kv.second;
				break;
			}
	}
	if (e == nullptr) {
		safesnprintf(buf, sizeof(buf), "No vendor theme or market called '%s'.", q.c_str());
		clif_displaymessage(fd, buf);
		return;
	}

	if (e->is_market) {
		safesnprintf(buf, sizeof(buf), "Market %s: %zu spawn block(s), %zu theme(s).", e->key.c_str(), e->spawns.size(), e->themes.size());
		clif_displaymessage(fd, buf);
		std::unordered_map<std::string, int> live;
		for (map_session_data* psd : g_population_engine_pcs)
			for (const PopulationModSpawn& sp : e->spawns)
				if (psd && psd->pop.vendor_spawn_id == sp.spawn_id)
					++live[psd->pop.vendor_key];
		for (const PopulationMarketTheme& t : e->themes) {
			safesnprintf(buf, sizeof(buf), "  %s: weight %d, min %d, max %d, %d up now", t.key.c_str(), t.weight, t.min, t.max, live[t.key]);
			clif_displaymessage(fd, buf);
		}
		return;
	}

	const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(e->key);
	const int rotation_min = st && st->rotation_min >= 0 ? st->rotation_min : e->rotation_sec / 60;
	safesnprintf(buf, sizeof(buf), "%s: %zu pool item(s), %d-%d per stall, rotates every %d min, prices at %d%%%s.",
		e->key.c_str(), e->pool.size(), e->pick_count_min, e->pick_count_max, rotation_min,
		st && st->price_pct > 0 ? st->price_pct : 100, e->undercut_chance > 0 ? ", undercuts" : "");
	clif_displaymessage(fd, buf);
	size_t shown = 0;
	for (const PopulationVendorStock& vs : e->pool.empty() ? e->stock : e->pool) {
		if (++shown > 60) {
			clif_displaymessage(fd, "  ... (first 60 shown)");
			break;
		}
		std::shared_ptr<item_data> id = item_db.find(vs.nameid);
		std::string extra;
		if (vs.refine_max > 0)
			extra += vs.refine_max > vs.refine_min ? " +" + std::to_string(vs.refine_min) + "-" + std::to_string(vs.refine_max)
			                                        : " +" + std::to_string(vs.refine_max);
		if (vs.element != 0)
			extra += std::string(" (element ") + std::to_string(vs.element) + (vs.stars ? ", " + std::to_string(vs.stars) + " star(s))" : ")");
		if (!vs.cards.empty())
			extra += " (" + std::to_string(vs.cards.size()) + " card(s))";
		if (vs.price_max > 0)
			safesnprintf(buf, sizeof(buf), "  %s%s x%d: %u-%uz", id ? id->ename.c_str() : "?", extra.c_str(), vs.amount, vs.price, vs.price_max);
		else
			safesnprintf(buf, sizeof(buf), "  %s%s x%d: %uz", id ? id->ename.c_str() : "?", extra.c_str(), vs.amount, vs.price);
		clif_displaymessage(fd, buf);
	}
}

/// Keep every mod vendor block on a live map at its count. Exact counts unless
/// the block opts into the density slider; respects the global Limit and the
/// per-tick budget like every other spawn.
static void population_engine_mod_vendor_pass(size_t* pbudget, size_t max_global) {
	if (!battle_config.population_engine_vending_enable)
		return;
	static std::unordered_set<std::string> warned_no_profile;
	// Out of this tick's budget ends the pass; the population limit only stops
	// the vendors whose mod respects it (the default), so check per entry.
	bool respect = true;
	auto budget_out = [&]() { return pbudget != nullptr && *pbudget == 0; };
	auto limit_hit = [&]() { return respect && g_population_engine_count.load() >= max_global; };
	auto spent = [&]() { if (pbudget != nullptr && *pbudget > 0) --*pbudget; };
	const int density = battle_config.population_engine_density_pct;
	auto scaled = [&](size_t n, bool opt_in) -> size_t {
		if (!opt_in || density == 100 || n == 0) return n;
		const size_t s = static_cast<size_t>((static_cast<int64_t>(n) * density) / 100);
		return s < 1 ? 1 : s;
	};

	const auto overrides = pop_mod_vendor_overrides();
	for (const auto& kv : population_vendor_db().vendor_entries()) {
		const PopulationVendorEntry& entry = kv.second;
		if (entry.spawns.empty())
			continue;
		{
			const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(entry.key);
			respect = !(st && st->respect_limit == 0);
		}
		const PopulationEngine* prof = population_vendor_pop_db().find_by_vendor_key(entry.key);
		if (prof == nullptr && !entry.is_market) {
			if (warned_no_profile.insert(entry.key).second)
				ShowWarning("Population engine: mod vendor '%s' has Spawns but no PlacementBound profile "
				            "with that VendorKey in population_vendor_pop.yml; not spawned.\n", entry.key.c_str());
			continue;
		}
		for (const PopulationModSpawn& sp : entry.spawns) {
			const int16 m = map_mapname2mapid(sp.map.c_str());
			if (m < 0)
				continue;
			// A vendor spawns as itself; a market spot rolls a theme and spawns
			// as that, still counted as one of the market's spots.
			auto spawn_here = [&](int16_t x, int16_t y, int16_t seat) -> bool {
				if (respect && !population_shell_returns_allow_fresh(m, g_population_engine_count.load(), max_global))
					return false;
				if (!entry.is_market)
					return pop_mod_vendor_spawn_one(m, entry, sp, *prof, x, y, seat);
				const PopulationVendorEntry* theme = pop_market_pick(entry, m, sp, warned_no_profile);
				if (theme == nullptr)
					return false;
				const PopulationEngine* tp = population_vendor_pop_db().find_by_vendor_key(theme->key);
				return tp != nullptr && pop_mod_vendor_spawn_one(m, *theme, sp, *tp, x, y, seat);
			};
			auto ov = overrides.find(sp.spawn_id);
			const size_t base = ov != overrides.end() ? ov->second
				: (sp.positions.empty() ? static_cast<size_t>(sp.count) : sp.positions.size());
			const size_t target = std::min(sp.positions.empty() ? SIZE_MAX : sp.positions.size(),
				scaled(base, sp.scale_with_density));

			// Lowered (a smaller total, or the density slider): release the extra
			// shells. Seats past the target go first, then any surplus.
			{
				std::vector<map_session_data*> extra;
				size_t kept = 0;
				for (map_session_data* psd : g_population_engine_pcs) {
					if (!psd || psd->m != m || psd->pop.vendor_spawn_id != sp.spawn_id) continue;
					if ((psd->pop.vendor_seat >= 0 && static_cast<size_t>(psd->pop.vendor_seat) >= target) || kept >= target)
						extra.push_back(psd);
					else
						++kept;
				}
				for (map_session_data* psd : extra)
					population_engine_shell_release(psd);
			}

			if (budget_out()) return;
			if (limit_hit()) goto next_entry;
			if (!pop_map_is_live(m))
				continue;

			if (!sp.positions.empty()) {
				// Fixed seats: one shell per seat. Scaling down fills the first N.
				const size_t seats = target;
				for (size_t i = 0; i < seats; ++i) {
					if (budget_out()) return;
					if (limit_hit()) goto next_entry;
					const int16_t seat = static_cast<int16_t>(i);
					if (population_engine_count_mod_shells(m, sp.spawn_id, seat) > 0)
						continue;
					const auto& pos = sp.positions[i];
					if (!pop_mod_vendor_cell_free(m, pos.first, pos.second))
						continue; // taken: leave empty until it is free
					if (spawn_here(pos.first, pos.second, seat))
						spent();
				}
				continue;
			}

			// Count + Areas: that many shells anywhere in the areas.
			size_t cur = population_engine_count_mod_shells(m, sp.spawn_id);
			if (cur >= target)
				continue;
			// MinSpacing is kept only between this block's own shells, and
			// Fill: Lanes places beside them.
			std::vector<std::pair<int16_t, int16_t>> mine;
			if (sp.min_spacing > 0 || sp.fill_lanes) {
				for (map_session_data* psd : g_population_engine_pcs)
					if (psd && psd->m == m && psd->pop.vendor_spawn_id == sp.spawn_id)
						mine.emplace_back(psd->x, psd->y);
			}
			// Pick an area weighted by its cell count, so a long strip and a
			// small plaza fill fairly.
			uint64_t total_cells = 0;
			for (const auto& a : sp.areas)
				total_cells += static_cast<uint64_t>(a.x2 - a.x1 + 1) * static_cast<uint64_t>(a.y2 - a.y1 + 1);
			if (total_cells == 0)
				continue;
			for (; cur < target; ++cur) {
				if (budget_out()) return;
				if (limit_hit()) goto next_entry;
				bool placed = false;
				if (sp.fill_lanes) {
					int16_t x = 0, y = 0;
					if (pop_mod_vendor_lane_cell(m, sp, mine, x, y) && spawn_here(x, y, -1)) {
						spent();
						mine.emplace_back(x, y);
						placed = true;
					}
				}
				for (int attempt = 0; attempt < 40 && !placed && !sp.fill_lanes; ++attempt) {
					uint64_t r = static_cast<uint64_t>(rnd()) % total_cells;
					const PopulationModSpawnArea* a = &sp.areas.back();
					for (const auto& cand : sp.areas) {
						const uint64_t cells = static_cast<uint64_t>(cand.x2 - cand.x1 + 1) * static_cast<uint64_t>(cand.y2 - cand.y1 + 1);
						if (r < cells) { a = &cand; break; }
						r -= cells;
					}
					const int16_t x = static_cast<int16_t>(a->x1 + rnd() % (a->x2 - a->x1 + 1));
					const int16_t y = static_cast<int16_t>(a->y1 + rnd() % (a->y2 - a->y1 + 1));
					if (!pop_mod_vendor_cell_free(m, x, y) || pop_mod_vendor_near_npc(m, x, y))
						continue;
					bool too_close = false;
					for (const auto& p : mine)
						if (std::abs(p.first - x) <= sp.min_spacing && std::abs(p.second - y) <= sp.min_spacing) { too_close = true; break; }
					if (too_close)
						continue;
					if (spawn_here(x, y, -1)) {
						spent();
						mine.emplace_back(x, y);
						placed = true;
					}
				}
				if (!placed)
					break; // no free cell this tick; try again next pass
			}
		}
	next_entry:;
	}
}

TIMER_FUNC(population_engine_autosummon_timer)
{
	PE_PERF_SCOPE("timer.autosummon");
	extern struct Battle_Config battle_config;
	const size_t max_global = static_cast<size_t>(battle_config.population_engine_max_count);

	// Collect drift candidates under lock, then call pc_setpos outside the lock.
	// to avoid deadlock via clif_* broadcast callbacks that may re-acquire the mutex.
	struct DriftEntry { map_session_data *sd; unsigned short mapindex; short x, y; };
	std::vector<DriftEntry> drift_candidates;
	for (map_session_data *sd : g_population_engine_pcs) {
		if (!sd || !sd->state.active || sd->prev == nullptr)
			continue;
		if (pop_is_companion(sd))
			continue;
		// RAGNAROKMAC (shell control API): a script may walk or warp its shell
		// anywhere; ending the hold settles where it lives.
		if (sd->pop.hold.npc != 0)
			continue;
		if (sd->pop.spawn_map_id < 0 || sd->m == sd->pop.spawn_map_id)
			continue;
		struct map_data *mapdata = map_getmapdata(sd->pop.spawn_map_id);
		if (!mapdata)
			continue;
		drift_candidates.push_back({sd, mapdata->index,
		    sd->pop.spawn_x, sd->pop.spawn_y});
	}
	// Map-drift check: shells that left their designated spawn map get warped back.
	for (auto &e : drift_candidates) {
		block_list *bl = map_id2bl(e.sd->id);
		if (bl && BL_CAST(BL_PC, bl) == e.sd)
			pc_setpos(e.sd, e.mapindex, e.x, e.y, CLR_TELEPORT);
	}

	// Sync active count to DB so FluxCP can display it on the website.
	{
		const uint32_t cur = static_cast<uint32_t>(g_population_engine_count.load(std::memory_order_relaxed));
		if (cur != g_last_db_written_count)
			population_engine_write_count_sql(cur);
	}

	if (!g_population_engine_running.load(std::memory_order_relaxed))
		return 0;

	// RAGNAROKMAC: hand back shells standing on maps nobody has been to for a
	// while. Runs before the cap check below, so a full population on dead maps
	// cannot starve the map the player is actually standing on.
	if (battle_config.population_engine_demand_spawn) {
		pop_occupancy_refresh();

		// The grace window keeps a map's shells for a while after its last
		// player leaves, so walking out and back does not rebuild the crowd.
		// But shells held for maps nobody is on still count against the global
		// cap, and fill_category gives up the moment that cap is reached -- so
		// a player hopping between maps could spend the entire budget on places
		// they had left, and arrive somewhere genuinely empty. Under pressure,
		// the map someone is standing on wins and grace is abandoned.
		const size_t cap = static_cast<size_t>(max_global);
		const bool under_pressure = g_population_engine_count.load() >= (cap - cap / 5);
		population_shell_returns_prune(under_pressure);

		std::vector<map_session_data*> abandoned;
		for (map_session_data *sd : g_population_engine_pcs) {
			if (sd == nullptr || !sd->state.active || sd->prev == nullptr)
				continue;
			if (pop_is_companion(sd))
				continue;
			const bool keep = under_pressure
				? g_pop_occupied_maps.count(sd->m) != 0
				: pop_map_is_live(sd->m);
			if (!keep)
				abandoned.push_back(sd);
		}
		for (map_session_data *sd : abandoned)
			population_engine_shell_release(sd);
	}

	if (!battle_config.population_engine_demand_spawn)
		population_shell_returns_prune(false);

	// Selling is lifecycle work, not combat AI: a full shell may have wandered
	// outside the player's viewport. Check only maps with a real player on them.
	if (battle_config.population_engine_loot_enable) {
		pop_occupancy_refresh();
		for (map_session_data *sd : g_population_engine_pcs)
			if (sd && g_pop_occupied_maps.count(sd->m) != 0)
				population_shell_loot_try_unload(sd, tick);
	}

	const int32 batch_cfg = battle_config.population_engine_autosummon_batch_size;
	size_t tick_budget = (batch_cfg > 0) ? static_cast<size_t>(batch_cfg) : 0;
	size_t* pbudget = (batch_cfg > 0) ? &tick_budget : nullptr;

	for (auto it = population_spawn_db().begin();
	     it != population_spawn_db().end(); ++it)
	{
		if (!it->second)
			continue;
		const PopulationSpawnEntry& se = *it->second;

		// Resolve Profile -> list of jobs that inherit from it. The pool is the
		// jobs declared in db/population_engine.yml whose Profile: matches; if
		// none match, the entry is silently skipped (no jobs to spawn).
		std::vector<uint16_t> profile_jobs = population_engine_db().jobs_with_profile(se.profile_name);
		if (profile_jobs.empty())
			continue;

		// Distribute `population` shells across `maps`: base = floor(pop/N),
		// first (pop%N) maps get base+1 to guarantee sum == population exactly.
		// max_per_map > 0 applies an additional per-map hard cap after distribution.
		// Jobs are picked at random per shell from `profile_jobs` so the spawn
		// is spread across every job that inherits the profile. bypass_existing_check
		// is passed to autosummon_fill_map so the per-job dedupe gate (which would
		// allow only one shell of a given job per map) does not throttle the
		// per-shell loop here.
		auto fill_category = [&](const std::vector<std::string>& maps, int32_t population, int32_t max_per_map, uint8_t category) -> bool {
			if (maps.empty())
				return false;
			const size_t pop   = static_cast<size_t>(std::max(0, population));
			const size_t count = maps.size();
			const size_t base  = pop / count;
			const size_t extra = pop % count;
			for (size_t i = 0; i < count; ++i) {
				size_t target = base + (i < extra ? 1u : 0u);
				if (max_per_map > 0 && target > static_cast<size_t>(max_per_map))
					target = static_cast<size_t>(max_per_map);
				const int16 mid = map_mapname2mapid(maps[i].c_str());
				if (mid < 0) continue;
				// RAGNAROKMAC: only populate maps somebody is on.
				if (!pop_map_is_live(mid)) continue;
				// Only spawn the deficit so the timer never stacks more shells
				// than the YAML quota onto a map that is already at capacity.
				size_t existing_on_map = population_engine_count_shells_on_map_for_profile(mid, profile_jobs);
				population_shell_returns_fit(mid, profile_jobs, target, existing_on_map);
				existing_on_map += population_shell_returns_fill(mid, profile_jobs, pbudget);
				const size_t occupied = existing_on_map + population_shell_returns_count(mid, profile_jobs);
				if (occupied >= target) continue;
				const size_t deficit = target - occupied;
				for (size_t s = 0; s < deficit; ++s) {
					if (pbudget != nullptr && *pbudget == 0) break;
					if (g_population_engine_count.load() >= max_global) break;
					const uint16_t pick = profile_jobs[rnd() % profile_jobs.size()];
					autosummon_fill_map(mid, 1, pick, pbudget, category, /*bypass_existing_check=*/true);
				}
			}
			return false;
		};

		// RAGNAROKMAC: density multiplier.
		//
		// The YAML declares a total per category and the engine distributes it
		// across the map list, so "how busy does one map feel" is a build-time
		// property of a file inside the container image -- not something a
		// player can reach. Scaling the totals here, before distribution, makes
		// it a setting: the shape of the world stays exactly as authored and
		// only its crowding changes.
		//
		// Applied to max_per_map too, or raising the density would quietly do
		// nothing on any category that declares a cap.
		//
		// RAGNAROKMAC: and each area's own share of that (Settings -> Population,
		// one slider each for towns, fields and dungeons): 0 leaves the area
		// empty, 100 is all of what the density gives it.
		const int32 dens = battle_config.population_engine_density_pct;
		auto scaled = [dens](int32_t v, int32_t share) -> int32_t {
			if (v <= 0)
				return v;
			if (share <= 0)
				return 0;
			const int64_t pct = (static_cast<int64_t>(dens) * share) / 100;
			if (pct == 100)
				return v;
			const int64_t out = (static_cast<int64_t>(v) * pct) / 100;
			// A category the YAML populated should never round away to nothing.
			return static_cast<int32_t>(out < 1 ? 1 : out);
		};
		const int32 town = battle_config.population_engine_town_pct;
		const int32 field = battle_config.population_engine_field_pct;
		const int32 dungeon = battle_config.population_engine_dungeon_pct;

		if (fill_category(se.towns,    scaled(se.towns_population, town),       scaled(se.towns_max_per_map, town),       1)) return 0;
		if (fill_category(se.fields,   scaled(se.fields_population, field),     scaled(se.fields_max_per_map, field),     2)) return 0;
		if (fill_category(se.dungeons, scaled(se.dungeons_population, dungeon), scaled(se.dungeons_max_per_map, dungeon), 3)) return 0;
	}

	// VendorPlacement-driven pass: directly fill maps listed under VendorPlacement
	// up to MaxVendors using vendor-behavior jobs from population_engine.yml.
	// Without this, a map referenced ONLY by VendorPlacement (e.g. prt_mk) would
	// never receive vendors because population_spawn_db has no entry for it.
	{
		// Build (cached) list of jobs whose effective behavior is Vendor in any
		// category (base, town, field, or dungeon). Cleared on YAML reload via
		// population_engine_vendor_job_pool_clear().
		if (!g_pop_vendor_job_pool_built) {
			// Vendor jobs live in db/population_vendor_pop.yml. Falls back to the
			// main DB only if the vendor DB is empty (e.g. file missing on disk).
			PopulationEngineDatabase& vsrc = population_vendor_pop_db().size() > 0
				? population_vendor_pop_db()
				: population_engine_db();
			for (auto it = vsrc.begin(); it != vsrc.end(); ++it) {
				if (!it->second) continue;
				const PopulationEngine &pe = *it->second;
				const bool is_vendor =
					pe.behavior         == PopulationBehavior::Vendor ||
					pe.town_behavior    == PopulationBehavior::Vendor ||
					pe.field_behavior   == PopulationBehavior::Vendor ||
					pe.dungeon_behavior == PopulationBehavior::Vendor;
				if (is_vendor)
					g_pop_vendor_job_pool.push_back(it->first);
			}
			g_pop_vendor_job_pool_built = true;
		}

		if (!g_pop_vendor_job_pool.empty() && population_vendor_db().any_vendor_placements()) {
			for (const auto &kv : population_vendor_db().vendor_placements()) {
				if (pbudget != nullptr && *pbudget == 0) break;
				if (g_population_engine_count.load() >= max_global) break;

				const PopulationVendorPlacement &vp = kv.second;
				int target = vp.max_vendors > 0 ? vp.max_vendors : 12; // sensible default
				// RAGNAROKMAC: vendors are most of what makes a town feel busy,
				// so they scale with the density dial like everyone else, and
				// with the towns' own share: towns at 0 have no stalls either.
				if (battle_config.population_engine_town_pct <= 0)
					continue;
				const int64_t vendor_pct = (static_cast<int64_t>(battle_config.population_engine_density_pct)
					* battle_config.population_engine_town_pct) / 100;
				if (vendor_pct != 100) {
					const int64_t t = (static_cast<int64_t>(target) * vendor_pct) / 100;
					target = static_cast<int>(t < 1 ? 1 : t);
				}
				const int16 mid  = map_mapname2mapid(vp.map.c_str());
				if (mid < 0) continue;
				// RAGNAROKMAC: vendors follow the same rule as everyone else.
				if (!pop_map_is_live(mid)) continue;

				const size_t cur = population_engine_count_vendors_on_map(mid);
				const size_t deficit = static_cast<size_t>(target) > cur ? static_cast<size_t>(target) - cur : 0;
				if (deficit == 0) continue;

				for (size_t d = 0; d < deficit; ++d) {
					if (pbudget != nullptr && *pbudget == 0) break;
					if (g_population_engine_count.load() >= max_global) break;
					const uint16_t vjob = g_pop_vendor_job_pool[rnd() % g_pop_vendor_job_pool.size()];
					// map_category=1: selects town_behavior override (Vendor on merchant jobs).
					// bypass_existing_check=true: placement pass owns the count via
					// population_engine_count_vendors_on_map above; the per-job gate in
					// autosummon_fill_map would otherwise stop at one shell per unique job.
					autosummon_fill_map(mid, 1, vjob, pbudget, 1, /*bypass_existing_check=*/true);
				}
			}
		}
	}

	// RAGNAROKMAC: mod vendors, after the engine's own vendors are served.
	population_engine_mod_vendor_pass(pbudget, max_global);

	return 0;
}

/// Tick a single bot if it qualifies. Called for each block_list within range
/// of a real PC. Dedupes via a per-pass set so two real PCs sharing view of the
/// same bot don't double-tick it.
struct s_pop_combat_tick_ctx {
	std::unordered_set<int32> ticked;
};

// Mirror of mob.cpp's ACTIVE_AI_RANGE (private there). Distance added on top of
// AREA_SIZE at which AI enters active mode.
static constexpr int POP_ACTIVE_AI_RANGE = 4;

static int32 pop_combat_tick_bot_in_range(block_list *bl, va_list ap)
{
	auto *ctx = va_arg(ap, s_pop_combat_tick_ctx *);
	map_session_data *sd = BL_CAST(BL_PC, bl);
	if (sd == nullptr)
		return 0;
	// Only bot PCs; skip real players.
	if (!population_engine_is_population_pc(sd->id))
		return 0;
	if (!sd->state.active || sd->prev == nullptr)
		return 0;
	if (!sd->state.population_combat)
		return 0;
	// Give the player a stationary target for the full invitation window.
	// The whisper handler already cancels any current walk/attack; suppressing
	// AI ticks here prevents it from immediately acquiring a new target.
	if (sd->pop.accept_party_request) {
		if (gettick() <= sd->pop.party_request_until)
			return 0;
		sd->pop.accept_party_request = false;
		sd->pop.party_request_account = 0;
		if (!pop_is_companion(sd))
			pop_companion_set_owner(sd, nullptr);
	}
	// RAGNAROKMAC (shell control API): a held shell does what its script says.
	if (population_engine_shell_is_held(sd))
		return 0;
	// Dedupe across multiple real-PC viewers.
	if (!ctx->ticked.insert(sd->id).second)
		return 0;
	// RAGNAROKMAC (rest): an ambient shell low on SP or HP sits between fights. Companions
	// come through here too, but rest in the companion loop, at their owner's marks.
	if (!pop_is_companion(sd) && pop_shell_rest(sd, nullptr, static_cast<uint32>(sd->pop.target_id), gettick()))
		return 1;
	population_engine_combat_per_tick(sd, true);
	return 1;
}

/// Outer callback: called for each PC in the world by map_foreachpc.
/// Skips bots; for real players, scans their viewport for bot PCs and ticks them.
static int32 pop_combat_tick_per_real_pc(map_session_data *sd, va_list ap)
{
	if (sd == nullptr)
		return 0;
	// Skip bots — only real players drive AI (mob_ai_hard pattern).
	if (population_engine_is_population_pc(sd->id))
		return 0;
	if (!sd->state.active || sd->prev == nullptr)
		return 0;
	auto *ctx = va_arg(ap, s_pop_combat_tick_ctx *);
	map_foreachinallrange(pop_combat_tick_bot_in_range, sd,
		AREA_SIZE + POP_ACTIVE_AI_RANGE, BL_PC, ctx);
	return 0;
}

// ==========================================================================
// RAGNAROKMAC: companion growth — stat auto-allocation + job advancement.
// Companions level via stock party exp share (pc_gainexp) and accumulate
// status_point/trait_point (pc_checkbaselevelup) but never spend them; this
// poll spends points toward the profile's researched target spread and walks
// the job line at the official gates, with a 50:50 coin flip at forks.
// ==========================================================================

struct PopJobAdvance {
	uint16_t from;
	uint16_t to_a;
	uint16_t to_b;   // 0 = no branch (always to_a)
	int32_t base_lv; // base level gate
	int32_t job_lv;  // job level gate (0 = none)
};

/// Is this transition a REBIRTH? Entering a transcendent class from a 2nd job is: the new class
/// usually cannot wear what the companion has on, so it is the player's decision, never automatic.
static bool pop_job_change_is_rebirth(uint16_t from, uint16_t to)
{
	return from >= 7 && from <= 20 && to >= 4008 && to <= 4022;
}

// 1st -> 2nd at base 40 (job_lv 0: fresh companions usually hit 40 before job 50;
// the official quests also require job level but companions fight constantly so
// base level is the friendlier gate), then trans/3rd/4th on the official gates.
static const PopJobAdvance kPopJobAdvanceTable[] = {
	// 1st -> 2nd (base 40, official job-quest level)
	{ 1,   7,  14,  40, 0 }, // Swordsman -> Knight | Crusader
	{ 2,   9,  16,  40, 0 }, // Mage -> Wizard | Sage
	{ 3,  11,  19,  40, 0 }, // Archer -> Hunter | Bard/Dancer (sex-adjusted by pc_jobchange)
	{ 4,   8,  15,  40, 0 }, // Acolyte -> Priest | Monk
	{ 5,  10,  18,  40, 0 }, // Merchant -> Blacksmith | Alchemist
	{ 6,  12,  17,  40, 0 }, // Thief -> Assassin | Rogue
	// 2nd -> trans (official rebirth gate: base 99 / job 70; we advance directly,
	// no level reset — a companion suddenly going back to 1/1 High Novice would
	// be a terrible feel in the middle of a hunt)
	{ 7, 4008, 0, 99, 50 }, { 14, 4015, 0, 99, 50 },
	{ 9, 4010, 0, 99, 50 }, { 16, 4017, 0, 99, 50 },
	{ 11, 4012, 0, 99, 50 }, { 19, 4020, 0, 99, 50 }, // Bard->Clown (Dancer->Gypsy via 4021 below)
	{ 8, 4009, 0, 99, 50 }, { 15, 4016, 0, 99, 50 },
	{ 10, 4011, 0, 99, 50 }, { 18, 4019, 0, 99, 50 },
	{ 12, 4013, 0, 99, 50 }, { 17, 4018, 0, 99, 50 },
	{ 20, 4021, 0, 99, 50 }, // Dancer -> Gypsy
	// Rebirth ladder (player-triggered from the Rebirth tab): High Novice -> a high 1st job at
	// base 40 (a uniform roll, handled as a special case above like Novice), then a high 1st job ->
	// its transcendent class on the SAME base-40 / job-0 gate as any other 1st -> 2nd step: these
	// rows are not rebirths (pop_job_change_is_rebirth is false for them), so a reborn companion
	// must not sit as a high 1st job from base 40 all the way to 99.
	{ 4002, 4008, 4015, 40, 0 }, // High Swordman -> Lord Knight | Paladin
	{ 4003, 4010, 4017, 40, 0 }, // High Mage     -> High Wizard | Scholar
	{ 4004, 4012, 4020, 40, 0 }, // High Archer   -> Sniper | Minstrel (sex-adjusted)
	{ 4005, 4009, 4016, 40, 0 }, // High Acolyte  -> High Priest | Champion
	{ 4006, 4011, 4019, 40, 0 }, // High Merchant -> Mastersmith | Biochemist
	{ 4007, 4013, 4018, 40, 0 }, // High Thief    -> Assassin Cross | Stalker
	// trans -> 3rd (official: base 99 / job 70)
	{ 4008, 4054, 0, 99, 70 }, { 4015, 4066, 0, 99, 70 },
	{ 4010, 4055, 0, 99, 70 }, { 4017, 4067, 0, 99, 70 },
	{ 4012, 4056, 0, 99, 70 }, { 4020, 4068, 0, 99, 70 },
	{ 4009, 4057, 0, 99, 70 }, { 4016, 4070, 0, 99, 70 },
	{ 4011, 4058, 0, 99, 70 }, { 4019, 4071, 0, 99, 70 },
	{ 4013, 4059, 0, 99, 70 }, { 4018, 4072, 0, 99, 70 },
	{ 4021, 4069, 0, 99, 70 },
	// trans/3rd -> 4th (official: base 200 / job 70)
	{ 4054, 4252, 0, 200, 70 }, // RuneKnight -> DragonKnight
	{ 4055, 4255, 0, 200, 70 }, // Warlock -> ArchMage
	{ 4056, 4257, 0, 200, 70 }, // Ranger -> Windhawk
	{ 4057, 4256, 0, 200, 70 }, // ArchBishop -> Cardinal
	{ 4058, 4253, 0, 200, 70 }, // Mechanic -> Meister
	{ 4059, 4254, 0, 200, 70 }, // GuillotineCross -> ShadowCross
	{ 4066, 4258, 0, 200, 70 }, // RoyalGuard -> ImperialGuard
	{ 4067, 4261, 0, 200, 70 }, // Sorcerer -> ElementalMaster
	{ 4068, 4263, 0, 200, 70 }, // Minstrel -> Troubadour
	{ 4069, 4264, 0, 200, 70 }, // Wanderer -> Trouvere
	{ 4070, 4262, 0, 200, 70 }, // Sura -> Inquisitor
	{ 4071, 4259, 0, 200, 70 }, // Genetic -> Biolo
	{ 4072, 4260, 0, 200, 70 }, // ShadowChaser -> AbyssChaser
	{ 4047, 4302, 0, 200, 70 }, // StarGladiator -> SkyEmperor
	{ 4049, 4303, 0, 200, 70 }, // SoulLinker -> SoulAscetic
	{ 4211, 4304, 0, 200, 70 }, // Kagerou -> Shinkiro
	{ 4212, 4305, 0, 200, 70 }, // Oboro -> Shiranui
	{ 4215, 4306, 0, 200, 70 }, // Rebellion -> NightWatch
	{ 23,   4307, 0, 200, 70 }, // SuperNovice -> HyperNovice
	{ 4218, 4308, 0, 200, 70 }, // Summoner -> SpiritHandler
};

// Stat spend order: profile-declared stats sorted by target size, biggest first.
// Points go +1 at a time through pc_statusup so cost scaling is honored.
static void pop_companion_spend_stat_points(map_session_data *sd, std::shared_ptr<PopulationEngine> prof)
{
	if (prof == nullptr) return;
	struct { int32_t sp; int16_t cur; int16_t target; } base_stats[6];
	base_stats[0] = { SP_STR, (int16_t)sd->status.str, prof->str_max };
	base_stats[1] = { SP_AGI, (int16_t)sd->status.agi, prof->agi_max };
	base_stats[2] = { SP_VIT, (int16_t)sd->status.vit, prof->vit_max };
	base_stats[3] = { SP_INT, (int16_t)sd->status.int_, prof->intl_max };
	base_stats[4] = { SP_DEX, (int16_t)sd->status.dex, prof->dex_max };
	base_stats[5] = { SP_LUK, (int16_t)sd->status.luk, prof->luk_max };
	// sort descending by target so the build's primary stat fills first
	for (int i = 0; i < 5; ++i)
		for (int j = i + 1; j < 6; ++j)
			if (base_stats[j].target > base_stats[i].target) {
				auto tmp = base_stats[i]; base_stats[i] = base_stats[j]; base_stats[j] = tmp;
			}
	int guard = 4000; // hard loop cap: a stat costs at most ~500 points to max
	while (sd->status.status_point > 0 && guard-- > 0) {
		bool spent_any = false;
		for (auto &bs : base_stats) {
			if (bs.target < 0) continue;             // stat not declared in profile
			if (bs.cur >= bs.target) continue;       // already at target
			if (bs.cur >= 500) continue;             // server maxparameter cap (user: 500)
			if (!pc_statusup(sd, bs.sp, 1)) continue;
			bs.cur++;
			spent_any = true;
			if (sd->status.status_point <= 0) break;
		}
		if (!spent_any) break;
	}

	// Trait points (4th-job era): same pattern, targets from profile trait fields.
	struct { int32_t sp; int16_t cur; int16_t target; } trait_stats[6];
	trait_stats[0] = { SP_POW, (int16_t)sd->status.pow, prof->pow_max };
	trait_stats[1] = { SP_STA, (int16_t)sd->status.sta, prof->sta_max };
	trait_stats[2] = { SP_WIS, (int16_t)sd->status.wis, prof->wis_max };
	trait_stats[3] = { SP_SPL, (int16_t)sd->status.spl, prof->spl_max };
	trait_stats[4] = { SP_CON, (int16_t)sd->status.con, prof->con_max };
	trait_stats[5] = { SP_CRT, (int16_t)sd->status.crt, prof->crt_max };
	for (int i = 0; i < 5; ++i)
		for (int j = i + 1; j < 6; ++j)
			if (trait_stats[j].target > trait_stats[i].target) {
				auto tmp = trait_stats[i]; trait_stats[i] = trait_stats[j]; trait_stats[j] = tmp;
			}
	guard = 2000;
	while (sd->status.trait_point > 0 && guard-- > 0) {
		bool spent_any = false;
		for (auto &ts : trait_stats) {
			if (ts.target < 0) continue;
			if (ts.cur >= ts.target) continue;
			if (!pc_traitstatusup(sd, ts.sp, 1)) continue;
			ts.cur++;
			spent_any = true;
			if (sd->status.trait_point <= 0) break;
		}
		if (!spent_any) break;
	}
}

/// The next class this companion would change into, or 0 if none applies.
///
/// @param allow_rebirth  false on the automatic path: a rebirth is never taken on its own, because
///                       the new class usually cannot wear the companion's gear. The Rebirth tab
///                       issues it explicitly.
static uint16_t pop_companion_next_job(uint16_t job_id, int32_t base_lv, int32_t job_lv,
	bool allow_rebirth)
{
	// Novice: six-way uniform roll at base 10
	if (job_id == 0 && base_lv >= 10)
		return static_cast<uint16_t>(1 + rnd() % 6);
	// High Novice: the same roll over the high first jobs, at base 40
	if (job_id == JOB_NOVICE_HIGH && base_lv >= 40)
		return static_cast<uint16_t>(JOB_SWORDMAN_HIGH + rnd() % 6);
	for (const PopJobAdvance &a : kPopJobAdvanceTable) {
		if (a.from != job_id) continue;
		if (base_lv < a.base_lv || job_lv < a.job_lv) continue;
		const uint16_t target = (a.to_b != 0 && (rnd() % 2)) ? a.to_b : a.to_a;
		if (!allow_rebirth && pop_job_change_is_rebirth(job_id, target))
			continue; // a rebirth waits for the player
		return target;
	}
	return 0;
}

static uint32_t pop_companion_given_worn(const map_session_data *shell);
static bool pop_companion_hand_back(map_session_data *owner, map_session_data *shell, int16 i,
	e_log_pick_type log_type, int32 amount = 0);

/// Change this companion's class. Shared by the automatic path and the player-triggered rebirth.
///
/// @param forced_target  0 on the automatic path (the ladder decides); otherwise the class to change
///                       into. A rebirth passes its target here so it runs the identical jobchange,
///                       skill reseed and gear dance rather than a second implementation of them.
/// @return true when the class actually changed.
static bool pop_companion_apply_job_change(map_session_data *sd, uint16_t forced_target)
{
	const uint16_t next = forced_target != 0 ? forced_target
		: pop_companion_next_job(sd->status.class_, sd->status.base_level, sd->status.job_level,
			/*allow_rebirth=*/false);
	if (next == 0) return false;
	// Player-given gear the new class cannot wear goes back to the player, so the player has to
	// be here to take it. Otherwise wait: the next level-up check tries again.
	map_session_data *owner = pop_companion_owner_session(sd);
	if (pop_companion_given_worn(sd) != 0 && (owner == nullptr || !owner->state.active))
		return false;
	std::vector<int16> given_before;
	for (int16_t i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &w = sd->inventory.u.items_inventory[i];
		if (w.nameid && w.equip && (w.equip & sd->pop.companion_given_mask))
			given_before.push_back(i);
	}
	// upper flag: trans jobs (4001+) need JOBL_UPPER
	const char upper = (next >= 4001 && next <= 4022) ? 1 : 0;
	const char *old_name = job_name(sd->status.class_);
	if (!pc_jobchange(sd, next, upper)) {
		ShowWarning("Population engine: companion %s job change %hu -> %hu failed.\n",
			sd->status.name, sd->status.class_, next);
		return false;
	}
	// A rebirth proper resets the LEVEL as well: High Novice starts over at 1/1, and rAthena's own
	// rebirth resets the build with it - npc/jobs/valkyrie.txt runs
	// `jobchange Job_Novice_High; resetlvl(1);`, and pc_resetlvl(sd, 1) is that call: stats back
	// to 1, the 100 status points, the platinum skills. Assigning the level by hand shipped a
	// level-1 High Novice carrying its level-99 stats and skills. Granted skill flags survive
	// pc_resetskill (it skips SKILL_FLAG_PERM_GRANTED), so the engine's own grants are untouched.
	// Advancing straight to the transcendent class keeps the level and stats - that is the whole
	// point of that option - and only the new job level starts over.
	if (next == JOB_NOVICE_HIGH) {
		pc_resetlvl(sd, 1);
	} else {
		sd->status.job_level = 1;
		sd->status.job_exp = 0;
	}
	ShowInfo("Population engine: companion %s advanced from %s to %s (base %d/job %d).\n",
		sd->status.name, old_name, job_name(next), sd->status.base_level, sd->status.job_level);
	// Re-arm the skill preset for the new job. Clearing the cooldowns alone was NOT
	// enough and the old comment was simply wrong: the rotation and buff lists are
	// keyed on status.class_ and the seeders only rebuild while those vectors are
	// EMPTY, so the previous class's skills survived the change and the companion
	// kept casting them forever (live: 11 companions advanced from Acolyte but all
	// still used Acolyte skills). Request an explicit reseed instead.
	sd->pop.skill_next_use_tick.clear();
	sd->pop.skills_need_reseed = true;
	// Player-given gear: kept if the new class can wear it, otherwise handed back. pc_jobchange
	// has already unequipped what the new class cannot use, and the companion's inventory is not
	// persisted, so anything left there would be gone at the next restart.
	for (int16 i : given_before) {
		if (sd->inventory.u.items_inventory[i].equip == 0 && owner != nullptr)
			(void)pop_companion_hand_back(owner, sd, i, LOG_TYPE_NPC);
	}
	sd->pop.companion_given_mask = pop_companion_given_worn(sd);
	const uint32_t keep = sd->pop.companion_given_mask;
	// Re-equip the companion's own gear from the new job's Eden set: unequip its old own
	// gear into the shell's inventory first, then run the same equip pass spawn uses - for the
	// positions player gear is not occupying.
	for (int16_t i = 0; i < MAX_INVENTORY; ++i) {
		struct item &slot = sd->inventory.u.items_inventory[i];
		if (slot.nameid && slot.equip && !(slot.equip & keep))
			pc_unequipitem(sd, i, 2);
	}
	std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(sd).find(sd->status.class_);
	if (equipment) {
		// Re-equip from the new job's gear set (same pool picks spawn uses).
		auto pick_pool = [](const std::vector<uint16_t> &pool) -> uint16_t {
			return pool.empty() ? 0 : pool[rnd() % pool.size()];
		};
		// An own piece never displaces player gear: skip it when it would take a kept position
		// (a two-handed weapon covers the shield too). Accessories are placed by slot.
		auto own = [sd, keep](uint16_t nameid, const char *label, uint32 force_pos) {
			if (nameid == 0)
				return;
			const std::shared_ptr<item_data> id = itemdb_exists(nameid);
			const uint32 pos = force_pos != 0 ? force_pos : (id != nullptr ? id->equip : 0);
			if (pos & keep)
				return;
			population_engine_shell_equip_item(sd, nameid, sd->status.char_id, label, force_pos);
		};
		own(pick_pool(equipment->weapon_pool),      "weapon",   0);
		own(pick_pool(equipment->shield_pool),      "shield",   0);
		own(pick_pool(equipment->armor_pool),       "armor",    0);
		own(pick_pool(equipment->shoes_pool),       "shoes",    0);
		own(pick_pool(equipment->garment_pool),     "garment",  0);
		own(pick_pool(equipment->head_top_pool),    "head_top", 0);
		own(pick_pool(equipment->head_mid_pool),    "head_mid", 0);
		own(pick_pool(equipment->head_bottom_pool), "head_low", 0);
		own(pick_pool(equipment->acc_l_pool),       "acc_l",    EQP_ACC_L);
		own(pick_pool(equipment->acc_r_pool),       "acc_r",    EQP_ACC_R);
	}
	if (owner != nullptr && !given_before.empty())
		chrif_save(owner, CSAVE_INVENTORY);
	status_calc_pc(sd, SCO_FORCE);
	// RAGNAROKMAC (vehicles): the new class may entitle the shell to a mount, falcon, warg or
	// mado that the old one did not have (Swordsman -> Knight, Blacksmith -> Mechanic, ...).
	population_engine_sync_shell_vehicle(sd);
	population_engine_sync_shell_homunculus(sd);
	// Persist the new job + reset job level right away so a crash can't roll it back.
	population_engine_persist_companion_gear(sd);
	return true;
}

/// RAGNAROKMAC (rebirth) ---------------------------------------------------------
/// Rebirth a companion the PLAYER'S way, from the Rebirth tab.
///
/// Automation deliberately never does this: entering a transcendent class usually means the
/// companion cannot wear much of what it has on, and gear the player handed over goes back to the
/// player. That is a decision, not a level-up.
///
/// @param mode  0 = the proper rebirth (High Novice, level reset to 1/1); 1 = straight to the
///              transcendent class, keeping the level.
/// @return 1 on success, 0 when it is not ready yet, -1 when rejected (message in out_msg).
int population_engine_companion_rebirth(uint32_t owner_account, const char *name_, int mode,
	char *out_msg, size_t out_msg_len)
{
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0])
		return -1;
	uint32_t index_ = 0;
	bool active = false;
	if (!population_engine_companion_find(owner_account, name_, &index_, &active)) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len, "No saved companion named %s.", name_);
		return -1;
	}
	map_session_data *shell = nullptr;
	for (map_session_data *cand : g_population_engine_pcs) {
		if (cand == nullptr || !pop_is_companion(cand))
			continue;
		if (cand->pop.companion_owner_account != owner_account)
			continue;
		if (cand->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		shell = cand;
		break;
	}
	if (shell == nullptr) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len,
				"%s is not summoned. Summon it first, then rebirth.", name_);
		return -1;
	}
	// Eligibility is the SAME predicate the automatic path uses with rebirth allowed, so the two can
	// never disagree about who is ready.
	const uint16_t target = pop_companion_next_job(shell->status.class_, shell->status.base_level,
		shell->status.job_level, /*allow_rebirth=*/true);
	if (target == 0 || !pop_job_change_is_rebirth(shell->status.class_, target)) {
		const char *cls = job_name(shell->status.class_);
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len,
				"%s (%s) cannot be reborn. Only a 2nd class that reached base 99 / job 50 can.",
				name_, cls != nullptr ? cls : "?");
		return 0;
	}
	const uint16_t chosen = (mode == 0) ? JOB_NOVICE_HIGH : target;
	if (!pop_companion_apply_job_change(shell, chosen)) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len, "The rebirth failed (see map-server console).");
		return -1;
	}
	if (out_msg != nullptr) {
		if (mode == 0)
			safesnprintf(out_msg, out_msg_len,
				"%s is reborn as High Novice at level 1. Gear it can no longer wear came back to you.",
				name_);
		else
			safesnprintf(out_msg, out_msg_len, "%s advanced straight to %s.", name_,
				job_name(chosen) != nullptr ? job_name(chosen) : "its transcendent class");
	}
	ShowInfo("Population engine: companion %s reborn as %s (owner %u)\n", name_,
		mode == 0 ? "High Novice" : job_name(chosen), owner_account);
	return 1;
}

// RAGNAROKMAC (Phase 2): set the support healer thresholds for every summoned
/// companion belonging to `owner_account`, persisting each row. Returns how many
/// live companions were updated (0 is still a success to the caller: the values
/// are saved for the next summon).
int population_engine_companion_set_heal_thresholds(uint32_t owner_account, int16_t heal_at, int16_t emergency_at)
{
	if (heal_at < 1 || heal_at > 99 || emergency_at < 1 || emergency_at > 99)
		return -1;
	int applied = 0;
	const uint32_t owner_char = pop_online_char(owner_account);
	for (map_session_data *sd : g_population_engine_pcs) {
		if (!sd || !pop_is_companion(sd))
			continue;
		if (sd->pop.companion_owner_account != owner_account || sd->pop.companion_owner_char != owner_char)
			continue;
		sd->pop.companion_heal_at = heal_at;
		sd->pop.companion_emergency_at = emergency_at;
		population_engine_persist_companion_gear(sd);
		++applied;
	}
	// Re-send the roster, which carries the thresholds, so an open Companions window shows them.
	if (map_session_data *owner_sd = map_charid2sd(owner_char); owner_sd != nullptr)
		population_engine_push_companion_list(owner_sd);
	return applied;
}

/// RAGNAROKMAC (rest): when every summoned companion of `owner_account` rests: below
/// `below` % of its SP or HP (0 = never) until both are back to `until` %. Persisted per
/// row like the healer thresholds; returns how many live companions were updated, or -1
/// for values out of range.
int population_engine_companion_set_rest_thresholds(uint32_t owner_account, int16_t below, int16_t until)
{
	if (below < 0 || below > 90 || until < below + 5 || until > 100)
		return -1;
	int applied = 0;
	const uint32_t owner_char = pop_online_char(owner_account);
	for (map_session_data *sd : g_population_engine_pcs) {
		if (!sd || !pop_is_companion(sd))
			continue;
		if (sd->pop.companion_owner_account != owner_account || sd->pop.companion_owner_char != owner_char)
			continue;
		sd->pop.companion_rest_below = below;
		sd->pop.companion_rest_until = until;
		population_engine_persist_companion_gear(sd);
		++applied;
	}
	// Re-send the roster, which carries the thresholds, so an open Companions window shows them.
	if (map_session_data *owner_sd = map_charid2sd(owner_char); owner_sd != nullptr)
		population_engine_push_companion_list(owner_sd);
	return applied;
}

// RAGNAROKMAC (skill selector) ---------------------------------------------------
// Per-companion skill selection. A companion's usable skills are the class's
// skill-tree closure (what spawn_shell grants) INTERSECTED with the entries that
// population_skill_db.yml curates for that class, because a curated row is what
// carries the rate / condition / target / cooldown a cast actually needs. The
// selection therefore narrows the preset list; it cannot invent behaviour for a
// skill that has no row, and set_skill_override() names those in its reply rather
// than accepting them silently.
//
// "auto" (skill_preset IS NULL) means the class preset list, which is what every
// companion used before this existed. An empty selection is a deliberate choice
// and is stored as an empty string, so the two states stay distinguishable -
// the seeders rebuild a list while it is empty, so conflating them would silently
// undo a player's choice.

/// Split a stored/typed spec into skill ids.
///
/// Accepts numeric ids and server skill names, separated by commas and/or
/// whitespace, so both `@companion skills Talivis 28,12` and a stored
/// `28,12` round-trip through the same code. Unknown tokens are reported via
/// `out_bad` rather than dropped quietly - a typo that silently does nothing is
/// indistinguishable from a feature that does not work.
size_t population_engine_companion_parse_skill_override(const char* stored,
	std::vector<uint16_t>& out)
{
	out.clear();
	if (stored == nullptr || stored[0] == '\0')
		return 0;

	char buf[512];
	safestrncpy(buf, stored, sizeof(buf));
	for (char* tok = strtok(buf, ", \t\r\n"); tok != nullptr; tok = strtok(nullptr, ", \t\r\n")) {
		if (tok[0] == '\0')
			continue;
		uint16_t sid = 0;
		// Numeric first: a name never starts with a digit, and skill ids are
		// within the skill_db range, so this cannot swallow a name.
		if (tok[0] >= '0' && tok[0] <= '9') {
			const long v = strtol(tok, nullptr, 10);
			// RAGNAROKMAC: bound by the SKILL DATABASE, not by MAX_SKILL. MAX_SKILL is the
			// size of status.skill[] (1641) while real ids reach 10019, so `v < MAX_SKILL`
			// rejected every 4th-job skill - and because this parser also reads the STORED
			// preset, those ids were dropped again on each recall, which is why a selection
			// appeared to forget its high-id entries. skill_get_index() is the same validity
			// predicate the seeders use.
			if (v > 0 && v <= 0xFFFF)
				sid = static_cast<uint16_t>(v);
		} else {
			sid = skill_name2id(tok);
		}
		if (sid == 0 || skill_get_index(sid) == 0)
			continue;
		if (std::find(out.begin(), out.end(), sid) == out.end())
			out.push_back(sid);
	}
	return out.size();
}

/// Skills this companion's class may actually use, in the order the preset list
/// defines them (so the menu reads like the rotation, not like a hash dump).
///
/// @param class_   the class to resolve (the LIVE class when summoned)
/// @param has_row  receives whether a curated behaviour row exists per emitted entry
/// @return ids legal for the class, regardless of selection
static std::vector<uint16_t> pop_companion_legal_skill_ids(uint16_t class_, const char* class_name)
{
	std::vector<uint16_t> legal;
	std::shared_ptr<s_skill_tree> tree = skill_tree_db.find(class_);
	if (tree == nullptr || tree->skills.empty()) {
		ShowWarning("population_engine: skill selector: no skill tree for %s (%u)\n",
			class_name != nullptr ? class_name : "?", class_);
		return legal;
	}
	// Iterate the CURATED list, not the tree: the tree closure is 38-81 entries
	// (most of them passives or utilities this AI never casts), while the curated
	// rows are the skills that have a rate/condition/target to cast with.
	const std::vector<s_pop_skill_entry>* rows = population_skill_db().find(class_);
	if (rows == nullptr || rows->empty())
		rows = population_skill_db().find(population_engine_job_base_class(class_));
	if (rows == nullptr)
		return legal;
	for (const s_pop_skill_entry& e : *rows) {
		if (e.skill_id == 0)
			continue;
		// Legal = the class's tree grants it. This is the "cannot activate
		// Cardinal skills from a Priest" half: a row that some OTHER class's
		// preset shares (the cross-class entries, e.g. TF_HIDING on Monk) is
		// offered only where the tree actually grants the skill.
		if (tree->skills.find(e.skill_id) == tree->skills.end())
			continue;
		if (std::find(legal.begin(), legal.end(), e.skill_id) == legal.end())
			legal.push_back(e.skill_id);
	}
	return legal;
}

/// The comma-separated id list stored in skill_preset. Returns false when it does not fit
/// `cap`, rather than storing a cut-down list the player never chose: a silently dropped
/// tail is a selection that changes by itself on the next login. The recall reads the
/// column back into a buffer of the same size.
static bool pop_companion_format_skill_preset(const std::vector<uint16_t> &picked, char *out, size_t cap)
{
	size_t used = 0;
	out[0] = '\0';
	for (size_t i = 0; i < picked.size(); ++i) {
		const int n = snprintf(out + used, cap - used, "%s%u", i > 0 ? "," : "",
			static_cast<unsigned>(picked[i]));
		if (n <= 0 || static_cast<size_t>(n) >= cap - used) {
			out[0] = '\0';
			return false;
		}
		used += static_cast<size_t>(n);
	}
	return true;
}

int population_engine_companion_set_skill_override(uint32_t owner_account, const char* name_,
	const char* spec, char* out_msg, size_t out_msg_len)
{
	if (out_msg != nullptr && out_msg_len > 0)
		out_msg[0] = '\0';
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0] || spec == nullptr)
		return -1;

	uint32_t index_ = 0; bool active = false;
	if (!population_engine_companion_find(owner_account, name_, &index_, &active))
		return -1;

	// The class to validate against: the live shell's when it is summoned (so a
	// companion that just advanced is judged on its NEW class), else the row's.
	//
	// RAGNAROKMAC: match on IDENTITY, not index alone. A bare char_id test also matches any
	// shell that happens to wear the same index, and attaching the selection to a coincidental
	// shell is how a companion with every skill disabled kept casting: the player's choice went
	// to the ambient shell while the party slot showed a shell with no override at all.
	map_session_data* live = nullptr;
	for (map_session_data* cand : g_population_engine_pcs) {
		if (cand == nullptr || !cand->state.active)
			continue;
		if (cand->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		if (cand->pop.companion_owner_account != owner_account
			|| cand->pop.companion_owner_char != pop_online_char(owner_account))
			continue; // another owner's shell, or an ambient one: not ours
		if (!pop_is_companion(cand))
			continue;
		live = cand;
		break;
	}
	if (live == nullptr) {
		// Distinguish "not summoned" from "summoned but wearing a colliding index" - the
		// second is a bug and must not be invisible.
		for (map_session_data* cand : g_population_engine_pcs) {
			if (cand != nullptr && cand->status.char_id == POPULATION_ENGINE_CHAR_ID_BASE + index_)
				// Phrased without embedded quotes: a bare char_id match can land on any shell
				// wearing that index, and this is the log that names the collision.
				ShowWarning("population_engine: companion index %u is worn by a shell that is not "
					"the companion of owner %u (name=%s, override=%d). The selection was saved "
					"but not applied - this is the index collision.\n",
					index_, owner_account, cand->status.name,
					cand->pop.skill_override_active ? 1 : 0);
		}
	}
	uint16_t class_ = 0;
	if (live != nullptr && live->status.class_ != 0) {
		class_ = live->status.class_;
	} else {
		char q[256];
		snprintf(q, sizeof(q),
			"SELECT job_id FROM `cp_companion_persistence` WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			return -1;
		}
		char* data = nullptr;
		if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
			Sql_GetData(mmysql_handle, 0, &data, nullptr);
			class_ = static_cast<uint16_t>(data != nullptr ? atoi(data) : 0);
		}
		Sql_FreeResult(mmysql_handle);
	}
	if (class_ == 0)
		return -1;

	// "auto" hands the companion back to its class preset list.
	const bool want_auto = (strcmpi(spec, "auto") == 0 || strcmpi(spec, "default") == 0
		|| strcmpi(spec, "reset") == 0);

	std::vector<uint16_t> picked;
	std::string rejected_unusable;
	size_t asked = 0;
	if (!want_auto) {
		std::vector<uint16_t> requested;
		population_engine_companion_parse_skill_override(spec, requested);
		asked = requested.size();
		if (requested.empty()) {
			// An empty spec is a legitimate "use no skills at all", but only when
			// the caller said so explicitly - not from a typo'd skill name, which
			// would otherwise read as a successful empty selection.
			const bool explicit_none = (strcmpi(spec, "none") == 0 || strcmpi(spec, "clear") == 0);
			if (!explicit_none) {
				if (out_msg != nullptr)
					safesnprintf(out_msg, out_msg_len,
						"None of those names or ids are real skills.");
				return -1;
			}
		}
		const std::vector<uint16_t> legal = pop_companion_legal_skill_ids(class_,
			job_name(class_));
		for (uint16_t sid : requested) {
			if (std::find(legal.begin(), legal.end(), sid) == legal.end()) {
				if (!rejected_unusable.empty())
					rejected_unusable += ", ";
				rejected_unusable += skill_get_name(sid);
				continue;
			}
			picked.push_back(sid);
		}
	}

	// Persist first: the row is the durable half, and a failure here must not
	// leave the live shell running a selection that will not survive a relog.
	{
		char preset[512];
		if (!want_auto && !pop_companion_format_skill_preset(picked, preset, sizeof(preset))) {
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len,
					"That is too many skills to save (%zu); choose fewer.", picked.size());
			return -1;
		}
		if (want_auto)
			preset[0] = '\0';
		char q[768];
		if (want_auto)
			snprintf(q, sizeof(q),
				"UPDATE `cp_companion_persistence` SET skill_preset=NULL"
				" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
				owner_account, pop_online_char(owner_account), index_);
		else
			snprintf(q, sizeof(q),
				"UPDATE `cp_companion_persistence` SET skill_preset='%s'"
				" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
				preset, owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len, "Could not save the selection (see map-server console).");
			return -1;
		}
	}

	// Apply to the live shell and ask for a rebuild. skills_need_reseed is the
	// existing job-change flag: the seeders rebuild both lists when they see it
	// and clear it once both are done, so the change lands on the next tick.
	if (live != nullptr) {
		live->pop.skill_override = want_auto ? std::vector<uint16_t>() : picked;
		live->pop.skill_override_active = !want_auto;
		live->pop.skills_need_reseed = true;
	}

	if (out_msg != nullptr) {
		if (want_auto) {
			safesnprintf(out_msg, out_msg_len,
				"%s is back on its class skill list.", name_);
		} else if (picked.empty()) {
			safesnprintf(out_msg, out_msg_len,
				"%s will use no skills (auto-attack only)%s.", name_,
				rejected_unusable.empty() ? "" : " - the skills you named have no usable entry for its class");
		} else {
			safesnprintf(out_msg, out_msg_len, "%s: %u skill%s selected%s%s.",
				name_, static_cast<unsigned>(picked.size()), picked.size() == 1 ? "" : "s",
				live == nullptr ? " (applies when summoned)" : "",
				rejected_unusable.empty() ? "" : " - some were not usable for its class");
		}
	}
	ShowInfo("population_engine: skill selection for companion %u (owner %u): %s (%u of %u usable)\n",
		index_, owner_account, want_auto ? "auto" : "explicit",
		static_cast<unsigned>(picked.size()), static_cast<unsigned>(asked));
	return want_auto ? 0 : static_cast<int>(picked.size());
}

/// RAGNAROKMAC (skill selector): flip exactly one skill in a companion's selection.
///
/// The tick-box UI cannot send a whole list (the atcommand's `param` is 23 bytes
/// and truncates), so each click is one small command and the stored selection is
/// the state. Resolution order matters: `none`/`auto`/`toggle`/`only`/`all` are
/// verbs, anything else is treated as a single skill id or name.
///
/// @param verb  "toggle" (flip), "only" (select just this), "all" (select every
///              legal skill). Any other value is not handled here.
/// @return count of selected skills after the change, or -1 when rejected.
int population_engine_companion_toggle_skill(uint32_t owner_account, const char* name_,
	const char* verb, const char* skill_token, char* out_msg, size_t out_msg_len)
{
	if (out_msg != nullptr && out_msg_len > 0)
		out_msg[0] = '\0';
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0] || verb == nullptr)
		return -1;

	uint32_t index_ = 0; bool active = false;
	if (!population_engine_companion_find(owner_account, name_, &index_, &active))
		return -1;

	// Live class when summoned (a companion that just advanced must offer its NEW
	// class's skills), else the persisted job_id.
	// RAGNAROKMAC: identity, not index alone - see the note in set_skill_override.
	map_session_data* live = nullptr;
	for (map_session_data* cand : g_population_engine_pcs) {
		if (cand == nullptr || !cand->state.active)
			continue;
		if (cand->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		if (cand->pop.companion_owner_account != owner_account
			|| cand->pop.companion_owner_char != pop_online_char(owner_account))
			continue;
		if (!pop_is_companion(cand))
			continue;
		live = cand;
		break;
	}
	uint16_t class_ = 0;
	char stored[512];
	stored[0] = '\0';
	bool storage_never_set = true; // stays true only when the column comes back NULL
	{
		char q[320];
		snprintf(q, sizeof(q),
			"SELECT job_id, skill_preset FROM `cp_companion_persistence`"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			return -1;
		}
		char* data = nullptr;
		if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
			Sql_GetData(mmysql_handle, 0, &data, nullptr);
			class_ = static_cast<uint16_t>(data != nullptr ? atoi(data) : 0);
			Sql_GetData(mmysql_handle, 1, &data, nullptr);
			// NULL = never chosen ("auto"). Copy only a real value so an empty string
			// stays empty and therefore means "chose nothing".
			if (data != nullptr) {
				safestrncpy(stored, data, sizeof(stored));
				storage_never_set = false;
			}
		}
		Sql_FreeResult(mmysql_handle);
	}
	if (live != nullptr && live->status.class_ != 0)
		class_ = live->status.class_;
	if (class_ == 0)
		return -1;

	const std::vector<uint16_t> legal = pop_companion_legal_skill_ids(class_, job_name(class_));
	if (legal.empty())
		return -1;

	// Current selection. `storage_never_set` is the NULL-vs-empty distinction the row
	// depends on: NULL = the companion was never configured and is using the whole
	// class list (which is what the UI displays as everything ticked, because that is
	// what the shell actually casts), so a flip must start from that full list - an
	// untick removes exactly one skill instead of discarding the class list and
	// selecting the single skill under the cursor. An explicit empty string stays
	// "chose nothing" and is left alone.
	std::vector<uint16_t> picked;
	if (storage_never_set)
		picked = legal;
	else
		population_engine_companion_parse_skill_override(stored, picked);

	if (strcmpi(verb, "all") == 0) {
		picked = legal;
	} else {
		if (skill_token == nullptr || !skill_token[0])
			return -1;
		uint16_t sid = 0;
		if (skill_token[0] >= '0' && skill_token[0] <= '9') {
			const long v = strtol(skill_token, nullptr, 10);
			// RAGNAROKMAC: see the note in population_engine_companion_parse_skill_override.
			// MAX_SKILL is the skill-array size, not the id ceiling: a 4th-job id such as
			// MT_TRIPLE_LASER (6003) is above it and was rejected as "cannot use".
			if (v > 0 && v <= 0xFFFF)
				sid = static_cast<uint16_t>(v);
		} else {
			sid = skill_name2id(skill_token);
		}
		if (sid == 0 || std::find(legal.begin(), legal.end(), sid) == legal.end()) {
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len,
					"%s cannot use %s.", name_,
					skill_token[0] ? skill_token : "(no skill given)");
			return -1;
		}
		std::vector<uint16_t>::iterator it = std::find(picked.begin(), picked.end(), sid);
		if (strcmpi(verb, "only") == 0) {
			picked.clear();
			picked.push_back(sid);
		} else if (it != picked.end()) {
			picked.erase(it);      // toggle off
		} else {
			picked.push_back(sid); // toggle on
		}
	}

	// Persist, then apply to the live shell through the existing rebuild flag.
	char preset[512];
	if (!pop_companion_format_skill_preset(picked, preset, sizeof(preset))) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len,
				"That is too many skills to save (%zu); turn some off first.", picked.size());
		return -1;
	}
	{
		char q[768];
		snprintf(q, sizeof(q),
			"UPDATE `cp_companion_persistence` SET skill_preset='%s'"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			preset, owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len, "Could not save the selection.");
			return -1;
		}
	}
	if (live != nullptr) {
		live->pop.skill_override = picked;
		live->pop.skill_override_active = true;
		live->pop.skills_need_reseed = true;
	}
	if (out_msg != nullptr)
		safesnprintf(out_msg, out_msg_len, "%s: %u skill%s selected%s.",
			name_, static_cast<unsigned>(picked.size()), picked.size() == 1 ? "" : "s",
			live == nullptr ? " (applies when summoned)" : "");
	ShowInfo("population_engine: skill selection for companion %u now %u skill(s) (%s)\n",
		index_, static_cast<unsigned>(picked.size()), verb);
	return static_cast<int>(picked.size());
}

/// True if `a`'s status ends `b`'s (status EndOnStart), unless `a` needs `b` up to be cast: that
/// is a chain (the Inquisitor's Judge needs First Faith Power and ends it), not a choice.
static bool pop_skill_ends_skill(uint16_t a, uint16_t b)
{
#ifndef RENEWAL
	// Pre-renewal songs and ensembles are performances on the ground: the performer holds
	// SC_DANCING, and a new one stops the one playing, with no status naming the other.
	const std::vector<e_skill_inf2> perf = { INF2_ISSONG, INF2_ISENSEMBLE };
	if (a != b && skill_get_inf2_(a, perf) && skill_get_inf2_(b, perf))
		return true;
#endif
	const sc_type sa = skill_get_sc(a), sb = skill_get_sc(b);
	if (sa == SC_NONE || sb == SC_NONE || sa == sb)
		return false;
	// A common ailment is a side effect, not a buff to choose: Grand Cross blinds its caster,
	// and King's Grace, which cures Blind, is not its rival.
	if ((sa >= SC_COMMON_MIN && sa <= SC_COMMON_MAX) || (sb >= SC_COMMON_MIN && sb <= SC_COMMON_MAX))
		return false;
	const std::vector<sc_type> ends = status_db.getEndOnStart(sa);
	if (std::find(ends.begin(), ends.end(), sb) == ends.end())
		return false;
	const std::shared_ptr<s_skill_db> skill = skill_db.find(a);
	return !skill || std::find(skill->require.status.begin(), skill->require.status.end(), sb)
		== skill->require.status.end();
}

/// The class's skills it keeps up on itself (a Target: self row), in row order. Only these
/// compete: the self-buff loop skips every other row (pop_buff_would_end_own), and a debuff
/// cast on an enemy ending another (Decrease AGI ends Increase AGI) is no choice for the player.
static std::vector<uint16_t> pop_companion_self_buff_ids(uint16_t class_)
{
	std::vector<uint16_t> ids;
	const std::vector<s_pop_skill_entry>* rows = population_skill_db().find(class_);
	if (rows == nullptr || rows->empty())
		rows = population_skill_db().find(population_engine_job_base_class(class_));
	if (rows == nullptr)
		return ids;
	for (const s_pop_skill_entry& e : *rows)
		if (e.target == 1 && e.skill_id != 0
			&& std::find(ids.begin(), ids.end(), e.skill_id) == ids.end())
			ids.push_back(e.skill_id);
	return ids;
}

/// True if `sid` and another of the class's self buffs end each other's status, so only one of
/// them can run at a time: a Bard's songs, a Dancer's dances, the 3rd-job songs, some stances.
/// The panel groups these, since ticking several means the one listed first plays.
static bool pop_skill_is_exclusive(uint16_t sid, const std::vector<uint16_t> &self_buffs)
{
	if (std::find(self_buffs.begin(), self_buffs.end(), sid) == self_buffs.end())
		return false;
	for (uint16_t other : self_buffs)
		if (other != sid && (pop_skill_ends_skill(sid, other) || pop_skill_ends_skill(other, sid)))
			return true;
	return false;
}

void population_engine_companion_skill_list(uint32_t owner_account, const char* name_, int fd)
{
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0])
		return;
	uint32_t index_ = 0; bool active = false;
	if (!population_engine_companion_find(owner_account, name_, &index_, &active)) {
		clif_displaymessage(fd, "@CPSKFAIL no such companion");
		return;
	}

	// Live class wins: a companion that advanced job must offer its NEW class's
	// skills, which is the same reason the roster's live_job field exists.
	// RAGNAROKMAC: identity, not index alone - see the note in set_skill_override.
	map_session_data* live = nullptr;
	for (map_session_data* cand : g_population_engine_pcs) {
		if (cand == nullptr || !cand->state.active)
			continue;
		if (cand->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		if (cand->pop.companion_owner_account != owner_account
			|| cand->pop.companion_owner_char != pop_online_char(owner_account))
			continue;
		if (!pop_is_companion(cand))
			continue;
		live = cand;
		break;
	}
	uint16_t class_ = 0;
	bool override_active = false;
	// NULL means "never chosen": the shell is casting the whole class list, so the
	// menu must show every legal skill as selected rather than leaving the boxes blank
	// and implying the companion does nothing.
	bool never_chosen = true;
	std::vector<uint16_t> picked;
	{
		char q[320];
		snprintf(q, sizeof(q),
			"SELECT job_id, skill_preset FROM `cp_companion_persistence`"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			clif_displaymessage(fd, "@CPSKFAIL query failed");
			return;
		}
		char* data = nullptr;
		if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
			Sql_GetData(mmysql_handle, 0, &data, nullptr);
			class_ = static_cast<uint16_t>(data != nullptr ? atoi(data) : 0);
			Sql_GetData(mmysql_handle, 1, &data, nullptr);
			// A NULL column is "never chosen" (auto). An empty string is a chosen
			// empty selection; the two must not collapse.
			if (data != nullptr) {
				override_active = true;
				never_chosen = false;
				population_engine_companion_parse_skill_override(data, picked);
			}
		}
		Sql_FreeResult(mmysql_handle);
	}
	if (live != nullptr && live->status.class_ != 0)
		class_ = live->status.class_;
	if (class_ == 0) {
		clif_displaymessage(fd, "@CPSKFAIL unknown class");
		return;
	}

	const std::vector<uint16_t> legal = pop_companion_legal_skill_ids(class_, job_name(class_));
	std::vector<uint16_t> self_buffs;
	for (uint16_t sid : pop_companion_self_buff_ids(class_))
		if (std::find(legal.begin(), legal.end(), sid) != legal.end())
			self_buffs.push_back(sid);
	int emitted = 0;
	for (uint16_t sid : legal) {
		// On auto every legal skill is in effect, so every box is ticked.
		const bool selected = never_chosen
			? true
			: (std::find(picked.begin(), picked.end(), sid) != picked.end());
		char msg[128];
		// id | name | selected | level the preset casts it at | ends another listed skill (0/1)
		snprintf(msg, sizeof(msg), "@CPSK|%u|%s|%d|%u|%d",
			static_cast<unsigned>(sid), skill_get_name(sid), selected ? 1 : 0,
			static_cast<unsigned>(skill_get_max(sid)), pop_skill_is_exclusive(sid, self_buffs) ? 1 : 0);
		clif_displaymessage(fd, msg);
		++emitted;
	}
	char endmsg[160];
	snprintf(endmsg, sizeof(endmsg), "@CPSKEND|%d|%s|%d|%d",
		emitted, job_name(class_), override_active ? 1 : 0, active ? 1 : 0);
	clif_displaymessage(fd, endmsg);
}

/// RAGNAROKMAC (Phase 3): draft a brand-new companion of a chosen job, then hand
/// it to `owner` as a summoned party member. Unlike @companion summon (which
/// re-spawns a companion that was recruited and saved before), this creates the
/// persistence row itself, so the panel's Summon tab can offer "any job, any
/// quality" without the player first having to go find a matching ambient shell
/// in the world.
///
/// `quality` picks the Eden gear tier: 0 = standard (lv 60 ladder), 1 = good
/// (lv 100-145), 2 = excellent (lv 160) -- the tier only changes which GearSet
/// the profile already lists, so it never invents items.
///
/// Returns the new shell's index on success, 0 on failure. The caller owns the
/// name-clash check. Nothing in the table enforces it - the only unique key is
/// shell_index - so a duplicate would leave two rows that every by-name command
/// (summon, favorite, gear...) resolves to whichever MariaDB returns first.
uint32_t population_engine_companion_draft(map_session_data *owner, uint16_t job_id, int quality, const char *name_hint,
	char chosen_sex)
{
	if (!owner || !owner->state.active) return 0;
	if (!job_db.exists(job_id)) return 0;
	const int16_t map_id = (int16_t)owner->m;
	if (map_id < 0) return 0;

	// Find the profile that lists this job: it is what supplies stats, level
	// range and the gear pools, exactly as an ambient spawn would get.
	std::shared_ptr<PopulationEngine> prof = population_engine_db_for_shell(owner).find(job_id);
	if (prof == nullptr) {
		ShowWarning("population_engine: draft refused -- job %u has no population profile to inherit.\n", job_id);
		return 0;
	}

	const uint32_t index = population_engine_allocate_index();
	if (index == 0) return 0;

	// Open cell beside the owner, same search the recall path uses.
	int16_t x = owner->x, y = owner->y;
	map_search_freecell(owner, map_id, &x, &y, 3, 3, 0);

	// spawn_shell takes the sex as 'M' or 'F'. This was rnd() % 2 - 0 or 1, never 'M' - so
	// every hired companion came out female, a Bard drawn as a Dancer. Chosen the way an
	// ambient spawn chooses: the job's own sex, then the profile's, else either.
	// RAGNAROKMAC: a sex the player chose (@companion draft <job> m|f) comes after the
	// job's own and before the profile's - a Bard is still male, whatever was asked.
	char sex = get_job_required_sex(job_id);
	if (sex == '\0' && (chosen_sex == 'M' || chosen_sex == 'F'))
		sex = chosen_sex;
	if (sex == '\0')
		sex = prof->sex_override >= 0 ? (prof->sex_override ? 'M' : 'F') : ((rnd() % 2) ? 'M' : 'F');
	const uint8_t hair = static_cast<uint8_t>(MIN_HAIR_STYLE + rnd() % (MAX_HAIR_STYLE - MIN_HAIR_STYLE + 1));
	const uint16_t hair_color = static_cast<uint16_t>(rnd() % 8);
	const uint16_t cloth_color = static_cast<uint16_t>(rnd() % 7);

	auto pick = [](const std::vector<uint16_t> &pool) -> uint16_t {
		return pool.empty() ? 0 : pool[rnd() % pool.size()];
	};

	map_session_data *shell = population_engine_spawn_shell(
		map_id, x, y, index, job_id, sex, hair, hair_color,
		pick(prof->weapon_pool), pick(prof->shield_pool),
		pick(prof->head_top_pool), pick(prof->head_mid_pool), pick(prof->head_bottom_pool),
		0, cloth_color, pick(prof->garment_pool), prof->script, false, prof.get(),
		1 /* town category: drafting is not a map-driven spawn */, PopulationDbSource::Main);
	if (shell == nullptr)
		return 0;

	// Attach it to the owner as a summoned companion and give it a party slot.
	pop_companion_set_owner(shell, owner);
	shell->pop.flags |= PSF::Mortal;

	// Register the shell BEFORE anything else touches it. Every driver - the
	// follow/combat tick, the stale sweep, the gear poll and the live-level lookup
	// behind @companion list raw - walks g_population_engine_pcs. A drafted shell
	// that is not in it never moves, never appears in the companion window and is
	// not counted, even though its party row exists.
	g_population_engine_pcs.push_back(shell);
	g_population_engine_count++;
	g_population_engine_stats.total_created++;
	g_population_engine_stats.active_units++;

	// Join the owner's party the same way a recalled companion does, so a drafted
	// companion is a real party member (party window row included) and not just a
	// shell carrying a party id.
	pop_companion_register_local_party(shell, owner);

	// Name: the caller's hint (already checked unique), else the profile's own
	// naming. A shell with no name cannot be addressed by later commands.
	if (name_hint != nullptr && name_hint[0] != '\0')
		safestrncpy(shell->status.name, name_hint, NAME_LENGTH);
	if (shell->status.name[0] == '\0')
		safestrncpy(shell->status.name, "Companion", NAME_LENGTH);

	// No HP/SP here. spawn_shell set its placeholders before status_calc_pc and then filled
	// SP; writing 1 afterwards left a hired companion believing it had 1 SP, so it cast
	// nothing that costs SP - no heal, no buff - until a relog recalled it fresh.
	(void)quality; // gear tier is expressed by the profile's GearSet pools

	// Persist immediately: the row is the companion's identity from here on, and
	// a crash before the next gear poll must not lose a drafted companion.
	//
	// persist_companion_gear() is the recurring UPDATE and would affect zero rows
	// here (the row does not exist yet) while reporting no error - which is exactly
	// how a drafted companion stayed invisible to @companion list. Create the row.
	population_engine_persist_companion_row(shell, owner);
	// Tell an open panel about the new companion; the roster changed.
	population_engine_push_companion_list(owner);
	ShowInfo("population_engine: drafted companion '%s' (job %u) for owner %u.\n",
		shell->status.name, job_id, owner->status.account_id);
	return index;
}

// ---------------------------------------------------------------------------
// RAGNAROKMAC: hired companions (Settings -> Population -> Companions).
//
// population_engine_companion_hire:
//   0  free choice: @companion draft offers any job, as before;
//   1  hired from the Companions panel: only jobs on the player's own class
//      tier, at the player's level, for a fee;
//   2  hired from a Companion Recruiter NPC (npc/custom/population/recruiter.txt):
//      the same rules, and @companion draft sends the player to one.
// The fee is population_engine_companion_hire_zeny_per_level x the companion's
// level, and/or population_engine_companion_hire_item x ..._item_amount.
// Summoning a companion already saved stays free in every mode.
// ---------------------------------------------------------------------------

/// The class tier of a job: 1 (Novice and 1st), 2 (2nd and transcendent 2nd),
/// 3 or 4. 0 for a job rAthena does not know.
int population_engine_job_tier(uint16_t job_id)
{
	if (!job_db.exists(job_id))
		return 0;
	const uint64 mapid = pc_jobid2mapid(job_id);
	if (mapid & JOBL_FOURTH) return 4;
	if (mapid & JOBL_THIRD) return 3;
	if (mapid & JOBL_2) return 2;
	return 1;
}

/// The jobs the Summon tab and the recruiter offer, as @companion jobs names them.
static const char *const kPopHireJobs[] = {
	"Swordsman", "Mage", "Archer", "Acolyte", "Merchant", "Thief",
	"Taekwon", "Gunslinger", "Ninja",
	"Knight", "Priest", "Wizard", "Blacksmith", "Hunter", "Assassin",
	"Crusader", "Monk", "Sage", "Rogue", "Alchemist", "Bard", "Dancer",
	"LordKnight", "HighPriest", "HighWizard", "Whitesmith", "Sniper",
	"AssassinCross", "Paladin", "Champion", "Professor", "Stalker",
	"Creator", "Clown", "Gypsy", "StarGladiator", "SoulLinker",
	"RuneKnight", "Warlock", "Ranger", "ArchBishop", "Mechanic",
	"GuillotineCross", "RoyalGuard", "Sorcerer", "Minstrel", "Wanderer",
	"Sura", "Genetic", "ShadowChaser",
	"DragonKnight", "Meister", "ShadowCross", "ArchMage", "Cardinal",
	"Windhawk", "ImperialGuard", "Biolo", "AbyssChaser", "ElementalMaster",
	"Inquisitor", "Troubadour", "Trouvere", "SkyEmperor", "SoulAscetic",
	"Shinkiro", "Shiranui", "NightWatch", "HyperNovice", "SpiritHandler",
};

/// The name @companion draft and the recruiter use for a hireable job
/// ("LordKnight"), which job_name() spells for display ("Lord Knight").
const char *population_engine_hire_job_name(uint16_t job_id)
{
	for (const char *name : kPopHireJobs)
		if (population_engine_job_id_from_name(name) == job_id)
			return name;
	return job_name(job_id);
}

int population_engine_companion_hire_mode()
{
	return battle_config.population_engine_companion_hire;
}

/// How many of an item the owner carries, unequipped.
static int pop_hire_item_count(const map_session_data *owner, t_itemid fee_item)
{
	int n = 0;
	for (int i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &it = owner->inventory.u.items_inventory[i];
		if (it.nameid == fee_item && it.equip == 0)
			n += it.amount;
	}
	return n;
}

/// The jobs this owner may hire: their own tier, with a profile to draft from.
std::vector<uint16_t> population_engine_companion_hire_jobs(map_session_data *owner)
{
	std::vector<uint16_t> out;
	if (!owner)
		return out;
	const int tier = population_engine_job_tier(owner->status.class_);
	for (const char *name : kPopHireJobs) {
		const uint16_t job = population_engine_job_id_from_name(name);
		if (job == 0 || population_engine_job_tier(job) != tier)
			continue;
		if (population_engine_db_for_shell(owner).find(job) == nullptr)
			continue;
		out.push_back(job);
	}
	return out;
}

/// What hiring costs this owner now: zeny for their level, and the item.
int64_t population_engine_companion_hire_zeny(const map_session_data *owner)
{
	if (!owner)
		return 0;
	return static_cast<int64>(battle_config.population_engine_companion_hire_zeny_per_level)
		* owner->status.base_level;
}

/// Whether this owner may hire `job_id` now. On false, `why` says why.
static bool pop_hire_allowed(map_session_data *owner, uint16_t job_id, std::string &why)
{
	const int tier = population_engine_job_tier(owner->status.class_);
	if (population_engine_job_tier(job_id) != tier) {
		why = "You can only hire a companion of your own class tier.";
		return false;
	}
	const int64 zeny = population_engine_companion_hire_zeny(owner);
	if (zeny > 0 && owner->status.zeny < zeny) {
		why = "You need " + std::to_string(zeny) + " zeny to hire a companion.";
		return false;
	}
	const t_itemid fee_item = static_cast<t_itemid>(battle_config.population_engine_companion_hire_item);
	const int amount = battle_config.population_engine_companion_hire_item_amount;
	if (fee_item > 0 && amount > 0) {
		if (!itemdb_exists(fee_item)) {
			why = "The hiring fee names an item this server does not have.";
			return false;
		}
		if (pop_hire_item_count(owner, fee_item) < amount) {
			why = "You need " + std::to_string(amount) + " " + itemdb_name(fee_item) + " to hire a companion.";
			return false;
		}
	}
	return true;
}

/// Draft `job_id` for `owner` under the current hiring rules. `from_npc` is true
/// when a recruiter asks. Returns the new shell's index, or 0 with `msg` saying
/// why. On success `msg` says what was paid.
uint32_t population_engine_companion_hire(map_session_data *owner, uint16_t job_id,
	const char *name_hint, bool from_npc, std::string &msg, char sex)
{
	if (!owner)
		return 0;
	const int mode = population_engine_companion_hire_mode();
	if (mode == 0) {
		const uint32_t made = population_engine_companion_draft(owner, job_id, 1, name_hint, sex);
		if (made == 0)
			msg = "Could not draft that companion (see map-server console).";
		return made;
	}
	if (mode == 2 && !from_npc) {
		msg = "Companions are hired from a Companion Recruiter in town.";
		return 0;
	}
	if (!pop_hire_allowed(owner, job_id, msg))
		return 0;

	g_pop_draft_level = static_cast<int16_t>(owner->status.base_level);
	const uint32_t made = population_engine_companion_draft(owner, job_id, 1, name_hint, sex);
	g_pop_draft_level = 0;
	if (made == 0) {
		msg = "Could not draft that companion (see map-server console).";
		return 0;
	}

	// Paid only once the companion exists: a failed draft costs nothing.
	std::string paid;
	const int64 zeny = population_engine_companion_hire_zeny(owner);
	if (zeny > 0) {
		pc_payzeny(owner, static_cast<int32>(zeny), LOG_TYPE_NPC);
		paid = std::to_string(zeny) + " zeny";
	}
	const t_itemid fee_item = static_cast<t_itemid>(battle_config.population_engine_companion_hire_item);
	int left = battle_config.population_engine_companion_hire_item_amount;
	if (fee_item > 0 && left > 0) {
		const int amount = left;
		for (int i = 0; i < MAX_INVENTORY && left > 0; ++i) {
			const struct item &it = owner->inventory.u.items_inventory[i];
			if (it.nameid != fee_item || it.equip != 0)
				continue;
			const int take = std::min<int>(left, it.amount);
			pc_delitem(owner, i, take, 0, 0, LOG_TYPE_NPC);
			left -= take;
		}
		paid += (paid.empty() ? "" : " and ") + std::to_string(amount) + " " + itemdb_name(fee_item);
	}
	msg = paid.empty() ? std::string("Hired.") : "Hired for " + paid + ".";
	return made;
}

/// @companion terms: the hiring rules for this player, for the Companions
/// panel. @CPTERMS|mode|tier|zeny|item id|item amount|item name|jobs (':'-joined)
void population_engine_companion_terms(map_session_data *owner, int fd)
{
	if (!owner)
		return;
	std::string jobs;
	for (uint16_t job : population_engine_companion_hire_jobs(owner)) {
		if (!jobs.empty())
			jobs += ':';
		jobs += population_engine_hire_job_name(job);
	}
	const t_itemid fee_item = static_cast<t_itemid>(battle_config.population_engine_companion_hire_item);
	const int amount = battle_config.population_engine_companion_hire_item_amount;
	const bool has_item = fee_item > 0 && amount > 0 && itemdb_exists(fee_item);
	std::string line = "@CPTERMS|" + std::to_string(population_engine_companion_hire_mode())
		+ "|" + std::to_string(population_engine_job_tier(owner->status.class_))
		+ "|" + std::to_string(population_engine_companion_hire_zeny(owner))
		+ "|" + std::to_string(has_item ? fee_item : 0)
		+ "|" + std::to_string(has_item ? amount : 0)
		+ "|" + (has_item ? itemdb_name(fee_item) : "")
		+ "|" + jobs;
	clif_displaymessage(fd, line.c_str());
}

/// Global combat timer: proximity-driven (mirrors mob_ai_hard).
/// Only bots within view of a real PC tick. Bots on empty maps cost ~zero,
/// so the engine scales by real-player count, not by total bot count.
TIMER_FUNC(population_engine_global_combat_timer)
{
	PE_PERF_SCOPE("timer.combat");
	// RAGNAROKMAC (shell control API): first, so a held shell a script warped is
	// back on the map before the stale sweep would take it for gone.
	population_shell_control_sweep();
	{
		auto stale = population_engine_collect_stale_shells();
		for (auto *s : stale)
			population_engine_shell_release(s);
	}

	// Goal 2: gear re-snapshot poll — companions whose equipped items changed
	// since last tick get their persistence row updated (debounced by the hash).
	if (!g_population_engine_pcs.empty()) {
		for (map_session_data *sd : g_population_engine_pcs) {
			if (!sd || !sd->state.active || sd->prev == nullptr) continue;
			if (sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE) continue;
			// RAGNAROKMAC (growth): only recruited companions grow — ambient shells
			// stay at their spawn build. Spend accumulated stat/trait points toward
			// the profile target spread, then walk the job line at the gates.
			if (pop_is_companion(sd) && sd->pop.companion_owner_account != 0) {
				std::shared_ptr<PopulationEngine> prof = population_engine_db_for_shell(sd).find(sd->status.class_);
				// RAGNAROKMAC (growth): the extra point grant is a 3rd-job-and-up
				// privilege, so the 1st/2nd/trans ramp stays stock and the surge
				// lands exactly when the job line reaches 3rd. Expressed as an
				// EXCLUSION (novice 0, 1st 1-6, 2nd 7-23, trans 4001-4022) rather
				// than a range test, because the id space is sparse: 3rd is
				// 4054-4079, 4th is 4252-4316, and the extended lines sit at
				// 4046-4049 / 4211-4218 — a ">= 4050" test would silently skip
				// the extended jobs and an ">= 4200" one would skip every 3rd.
				const int32 jid = sd->status.class_;
				const bool pre_third = (jid == 0) || (jid >= 1 && jid <= 23)
					|| (jid >= 4001 && jid <= 4022);
				// Paid per base level gained, not per poll: this runs every combat tick
				// (population_engine_shell_timer_ms, 100 ms), and paying on each one
				// handed a 3rd-job companion its whole profile's maxima at once.
				const int16_t lv = static_cast<int16_t>(sd->status.base_level);
				if (sd->pop.points_granted_level == 0 || lv < sd->pop.points_granted_level)
					sd->pop.points_granted_level = lv;
				if (!pre_third && lv > sd->pop.points_granted_level) {
					const int grant = static_cast<int>(battle_config.population_engine_companion_points_per_level);
					if (grant > 0) {
						const int levels = lv - sd->pop.points_granted_level;
						sd->status.status_point += grant * levels;
						sd->status.trait_point  += grant * levels;
					}
				}
				sd->pop.points_granted_level = lv;
				pop_companion_spend_stat_points(sd, prof);
				(void)pop_companion_apply_job_change(sd, 0);
				// RAGNAROKMAC: the party window shows levels from the map's own party
				// data, and the stock level-up broadcast is a char-server round trip
				// that drops shells. Re-broadcast locally when the level changed.
				if (sd->pop.last_party_level_broadcast != sd->status.base_level) {
					sd->pop.last_party_level_broadcast = sd->status.base_level;
					struct party_data *pd = party_search(sd->status.party_id);
					if (pd != nullptr) {
						int32 slot;
						ARR_FIND(0, MAX_PARTY, slot, pd->data[slot].sd == sd);
						if (slot < MAX_PARTY)
							pd->party.member[slot].lv = sd->status.base_level;
						clif_party_info(*pd, nullptr);
					}
				}
			}
			const uint64_t h = pop_companion_gear_hash(sd);
			auto it = g_pop_companion_gear_hash.find(sd->id);
			if (it == g_pop_companion_gear_hash.end()) {
				g_pop_companion_gear_hash.emplace(sd->id, h);
				continue; // first sighting: baseline only, don't write
			}
			if (it->second != h) {
				it->second = h;
				population_engine_persist_companion_gear(sd);
			}
		}
		// prune hashes for shells that are gone
		for (auto it = g_pop_companion_gear_hash.begin(); it != g_pop_companion_gear_hash.end();) {
			bool found = false;
			for (map_session_data *sd : g_population_engine_pcs) {
				if (sd && sd->id == it->first) { found = true; break; }
			}
			if (!found) it = g_pop_companion_gear_hash.erase(it);
			else ++it;
		}
	}

	if (g_population_engine_pcs.empty())
		return 0;

	// Proximity-driven tick: each real PC scans its viewport for bots.
	// No round-robin / budget needed — work is bounded by real-player count.
	s_pop_combat_tick_ctx ctx;
	ctx.ticked.reserve(64);
	const t_tick now = gettick();
	for (map_session_data *sd : g_population_engine_pcs) {
		map_session_data *owner = pop_companion_owner(sd);
		if (!owner)
			continue;
		// Same-map companion corpses are deliberately inert but remain registered
		// so party Resurrection and Yggdrasil Leaf can target the original actor.
		if (pc_isdead(sd))
			continue;
		// Town-origin Wander/Support shells do not normally own a combat session.
		// Start one only after real party membership exists so every recruited
		// shell gets the same companion combat rules regardless of origin.
		if (!sd->state.population_combat) {
			const PopulationCombatStartResult started = population_engine_combat_start_session(
				sd, PopulationCombatStartMode::AutoCombat, -1, SCSTART_NOAVOID | SCSTART_LOADED);
			if (!started.started)
				continue;
		}
		// Companion movement and AI must not depend on being inside a player's
		// viewport; otherwise EXP/support stops and the follower can never catch up.
		ctx.ticked.insert(sd->id);
		if (!pop_companion_follow_owner(sd, owner, now))
			continue;
		// Party modes make their target decision before the normal combat tick, so
		// refresh the tracker here as well. Its internal interval keeps this cheap.
		population_shell_update_mob_tracker(sd);
		const uint32 desired_target = pop_companion_combat_target(sd, owner, now);
		if (static_cast<uint32>(sd->pop.target_id) != desired_target)
			population_shell_target_change(sd, static_cast<int>(desired_target));
		if (desired_target != 0 && sd->pop.companion_formation_active) {
			if (unit_is_walking(sd))
				unit_stop_walking(sd, USW_FIXPOS);
			sd->pop.companion_formation_active = false;
		}
		if (desired_target == 0) {
			sd->pop.sticky_target_id = 0;
			sd->pop.sticky_until = 0;
			unit_stop_attack(sd);
			// RAGNAROKMAC: a walk to the owner is the follow from pop_companion_follow_owner, not
			// a chase to drop. Halting it once the companion was within 4 cells, with the owner
			// still moving, made it stop, snap in place and set off again 400 ms later; the faster
			// the companion (a mounted Lord Knight), the more often it caught up and stuttered.
			if (unit_is_walking(sd) && !sd->pop.companion_formation_active &&
				sd->ud.target_to != owner->id)
				unit_stop_walking(sd, USW_FIXPOS);
		}
		if (pop_shell_rest(sd, owner, desired_target, now))
			continue;
		if (sd->state.population_combat)
			population_engine_combat_per_tick(sd, true);
		if (desired_target == 0)
			pop_companion_update_formation(sd, owner);
	}
	map_foreachpc(pop_combat_tick_per_real_pc, &ctx);
	return 0;
}

/// Respawn timer for mortal shells: fired ~5 s after death to teleport to spawn and revive.
/// Mob-style respawn: full state reset via unit_remove_map (target/timers/SCs) before re-add.
TIMER_FUNC(population_engine_respawn_shell_timer)
{
	PE_PERF_SCOPE("timer.respawn");
	map_session_data *sd = map_id2sd(static_cast<int32>(id));
	if (!sd || !population_engine_is_population_pc(sd->id)) {
		ShowDebug("PopEngine respawn: timer fired but shell %d not found (already released?).\n", id);
		return 0;
	}
	sd->pop.respawn_timer = INVALID_TIMER;
	if (!g_population_engine_running) {
		ShowDebug("PopEngine respawn: engine stopped; skipping revive for shell %u.\n", sd->id);
		return 0;
	}
	if (!pc_isdead(sd)) {
		// #373 diagnostics: the shell died (pc_dead scheduled this timer) and lost its dead flag
		// within the 5 s window, so it is never revived.
		if (status_isdead(*sd))
			ShowWarning("Population engine: [#373] respawn of shell %u (%s) skipped: 0 HP but not dead "
				"(dead_sit %d, walking %d, behavior %u, %d ms since pc_dead) on %s (%d,%d).\n",
				sd->id, sd->status.name, sd->state.dead_sit, unit_is_walking(sd) ? 1 : 0,
				static_cast<unsigned>(sd->pop.behavior),
				sd->pop.diag_death_tick ? static_cast<int>(DIFF_TICK(tick, sd->pop.diag_death_tick)) : -1,
				mapindex_id2name(sd->mapindex), sd->x, sd->y);
		return 0;
	}
	map_session_data *owner = pop_companion_owner(sd);
	const int16_t respawn_map = owner ? owner->m : sd->pop.spawn_map_id;
	struct map_data *mapdata = (respawn_map >= 0) ? map_getmapdata(respawn_map) : nullptr;
	if (mapdata == nullptr) {
		ShowWarning("Population engine: respawn map invalid for shell %u (%s); despawning.\n", sd->id, sd->status.name);
		unit_remove_map(sd, CLR_OUTSIGHT);
		return 0;
	}

	// Mob-style: tear down map presence + clear stale unit_data (target, ongoing skill timers,
	// status changes) BEFORE re-spawning at the chosen point. Without this, shells revive
	// with residual SCs / locked target / canact_tick from the moment of death.
	int16 sx = owner ? owner->x : sd->pop.spawn_x;
	int16 sy = owner ? owner->y : sd->pop.spawn_y;
	if (owner)
		map_search_freecell(owner, respawn_map, &sx, &sy, 2, 2, 0);
	else if (sx <= 0 || sy <= 0 || map_getcell(respawn_map, sx, sy, CELL_CHKNOPASS))
		map_search_freecell(nullptr, respawn_map, &sx, &sy, 4, 4, 1);

	// A shell has no client-side respawn handshake. CLR_RESPAWN can leave the
	// already-dead actor rendered as a corpse when the same GID is spawned near
	// the owner, so explicitly remove the old visual from every viewer first.
	unit_remove_map(sd, CLR_OUTSIGHT);
	if (pc_setpos(sd, mapdata->index, sx, sy, CLR_OUTSIGHT) != SETPOS_OK) {
		ShowError("Population engine: failed to respawn shell %u (%s) on map %s.\n",
			sd->id, sd->status.name, mapindex_id2name(mapdata->index));
		return 0;
	}
	// Revive while the shell is deliberately still outside the map block grid.
	// status_revive otherwise broadcasts resurrection/standing packets, followed
	// by our spawn packet, which makes some clients retain clickable duplicates.
	status_revive(sd, 100, 100);
	status_calc_pc(sd, SCO_FORCE);
	sd->ud.canmove_tick = 0;
	sd->ud.canact_tick  = 0;
	sd->pop.target_id           = 0;
	sd->pop.sticky_target_id    = 0;
	sd->pop.last_cast_skill_id  = 0;
	sd->pop.last_damage_received = 0;
	sd->pop.last_attacked_tick  = 0;
	sd->pop.last_skill_used_on_me = 0;
	sd->pop.skill_next_use_tick.clear();

	// Re-register chat state (erased by shell_release during death processing).
	{
		std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(sd).find(sd->status.class_);
		if (equipment)
			population_engine_register_shell_chat_state(sd, equipment.get());
	}

	// Re-enable wander for shells that wander when not in combat.
	const auto beh = static_cast<PopulationBehavior>(sd->pop.behavior);
	if (beh == PopulationBehavior::Wander || beh == PopulationBehavior::Guard ||
	    beh == PopulationBehavior::Support || beh == PopulationBehavior::Social)
		population_engine_register_shell_wander_state(sd);

	// Re-arm the CombatActive flag (cleared by unit_remove_map / state teardown).
	sd->pop.flags |= PSF::CombatActive;

	// Restart the combat session for battle-oriented behaviors so the combat timer picks them up.
	if (beh == PopulationBehavior::Combat || beh == PopulationBehavior::Guard)
		population_engine_combat_start_session(sd, PopulationCombatStartMode::AutoCombat, 0, 0);
	if (!pop_shell_finish_map_placement(sd)) {
		ShowError("Population engine: failed to place respawned shell %u (%s) on map %s.\n",
			sd->id, sd->status.name, mapindex_id2name(mapdata->index));
		return 0;
	}
	pop_shell_broadcast_map_placement(sd);
	if (owner)
		ShowInfo("Population engine: companion %s respawned near %s on map %s.\n",
			sd->status.name, owner->status.name, mapindex_id2name(mapdata->index));
	return 0;
}

void population_engine_on_shell_death(map_session_data *sd)
{
	if (!sd)
		return;
	sd->pop.diag_death_tick = gettick(); // #373 diagnostics: pc_dead handled this death
	population_shell_loot_clear(sd); // RAGNAROKMAC (shell looting): a corpse forgets its drops
	if (!population_engine_shell_is_mortal(sd)) {
		ShowDebug("PopEngine death: shell %u (%s) has no Mortal flag — no respawn scheduled.\n",
			sd->id, sd->status.name);
		return;
	}
	// Cancel any pending respawn (shell died twice within the 5 s window) — prevents
	// double-revive and orphaned timer slots.
	if (sd->pop.respawn_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(sd->pop.respawn_timer);
		if (td && td->func == population_engine_respawn_shell_timer)
			delete_timer(sd->pop.respawn_timer, population_engine_respawn_shell_timer);
		sd->pop.respawn_timer = INVALID_TIMER;
	}
	if (pop_is_companion(sd)) {
		// Keep the original corpse in the map grid and the real party.  Movement
		// and combat timers skip dead shells; the stale collector removes it only
		// after the owner leaves this map.
		population_shell_target_change(sd, 0);
		sd->pop.sticky_target_id = 0;
		sd->pop.sticky_until = 0;
		sd->pop.companion_formation_active = false;
		unit_stop_attack(sd);
		if (unit_is_walking(sd))
			unit_stop_walking(sd, USW_FIXPOS);
		ShowInfo("Population engine: companion %s died and remains available for resurrection.\n",
			sd->status.name);
		return;
	}
	// Ambient Mortal shells retain their original five-second respawn delay.
	sd->pop.respawn_timer = add_timer(gettick() + 5000,
		population_engine_respawn_shell_timer, sd->id, 0);
}

void population_engine_on_shell_kills_player(map_session_data *killer_sd, map_session_data *victim_sd)
{
	if (!killer_sd || !victim_sd)
		return;
	if (!battle_config.population_engine_chat_enable)
		return;

	// Pick from the pvp_kill category directly — bypasses profile lookup so any shell can trash-talk.
	const std::vector<std::string>* pool = population_chat_db().lines_for_category("pvp_kill");
	if (!pool || pool->empty()) {
		// Fallback: find the shell's profile pool.
		std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(killer_sd).find(killer_sd->status.class_);
		if (equipment)
			pool = population_chat_db().pool_for_profile(population_engine_chat_profile_key(equipment.get()));
	}
	if (!pool || pool->empty())
		return;

	const t_tick now = gettick();
	// Check cooldown — don't spam kill chat back-to-back.
	{
		auto it = g_pop_chat_next_tick.find(killer_sd->id);
		if (it != g_pop_chat_next_tick.end() && now < it->second)
			return;
	}

	const std::string& pick = (*pool)[rnd() % pool->size()];
	char buf[CHAT_SIZE_MAX];
	// Replace $victim with the victim's name in the trash-talk line.
	std::string line = pick;
	const std::string marker = "$victim";
	const size_t pos = line.find(marker);
	if (pos != std::string::npos)
		line.replace(pos, marker.size(), victim_sd->status.name);
	population_engine_format_chat_line(killer_sd, line.c_str(), buf, sizeof(buf));
	population_engine_send_public_chat_as_pc(killer_sd, buf);

	const int32 cd = battle_config.population_engine_chat_cooldown_ms;
	g_pop_chat_next_tick[killer_sd->id] = now + static_cast<t_tick>(cd > 0 ? cd : 5000);
}

// RAGNAROKMAC: Walk every live vendor shell and release those whose per-shell
// vendor_rotation_at tick has passed. The autosummon timer then refills the
// map on its next pass with new picks from the pool. We release at most
// POP_VENDOR_ROTATION_MAX_PER_TICK per tick so a storm of simultaneous
// expiries (e.g. right after a server restart that bulk-spawned a hundred
// vendors) staggers naturally across minutes rather than crashing one tick
// through a hundred teardowns.
static constexpr size_t POP_VENDOR_ROTATION_MAX_PER_TICK = 8;

TIMER_FUNC(population_engine_vendor_rotation_timer)
{
	const t_tick now = gettick();
	size_t released = 0;
	// g_population_engine_pcs mutates during release (shell removes itself),
	// so collect pointers up front and release outside the walk.
	std::vector<map_session_data*> due;
	due.reserve(g_population_engine_pcs.size());
	// RAGNAROKMAC: a mod vendor that has sold everything packs up, as a player
	// would; the mod pass puts a fresh stall in its place. rAthena only closes
	// an empty stall for autotraders, so it would otherwise sit there empty.
	// Checked first and outside the per-tick cap, so a busy rotation can't keep
	// an empty stall standing. Base vendors keep upstream's behaviour.
	for (map_session_data *sd : g_population_engine_pcs)
		if (sd && !sd->pop.vendor_spawn_id.empty() &&
		    ((sd->state.vending && sd->vend_num <= 0) ||
		     (sd->pop.vendor_buying && !sd->state.buyingstore))) // bought all it wanted, or out of zeny
			due.push_back(sd);
	const size_t cap = due.size() + POP_VENDOR_ROTATION_MAX_PER_TICK;
	for (map_session_data *sd : g_population_engine_pcs) {
		if (!sd) continue;
		if (!sd->pop.vendor_spawn_id.empty() &&
		    ((sd->state.vending && sd->vend_num <= 0) || (sd->pop.vendor_buying && !sd->state.buyingstore)))
			continue; // already taken above
		if (sd->pop.vendor_rotation_at == 0) continue; // not a rotating vendor
		if (now < sd->pop.vendor_rotation_at) continue;
		if (!sd->state.vending && !sd->state.buyingstore) continue; // already stopped vending (edge case: player interactions)
		due.push_back(sd);
		if (due.size() >= cap) break;
	}
	for (map_session_data *sd : due) {
		population_engine_shell_release(sd);
		++released;
	}
	if (released > 0)
		ShowInfo("Population engine: rotated %zu vendor shell(s).\n", released);
	// RAGNAROKMAC: the customers of players' stalls, on the same minute.
	population_customers_pass();
	return 0;
}

void do_init_population_engine() {
	// Single-threaded engine: bot pathing uses unit_walktoxy / unit_walktobl.
	add_timer_func_list(population_engine_autosummon_timer, "population_engine_autosummon_timer");
	add_timer_func_list(population_engine_chat_timer, "population_engine_chat_timer");
	add_timer_func_list(population_engine_global_combat_timer, "population_engine_global_combat_timer");
	add_timer_func_list(population_engine_respawn_shell_timer, "population_engine_respawn_shell_timer");
	add_timer_func_list(population_engine_vendor_rotation_timer, "population_engine_vendor_rotation_timer");
	population_engine_path_register_timer_funcs();
}

void do_init_population_engine_load_databases() {
	// RAGNAROKMAC: master switch, checked before anything is loaded. With the
	// engine off the nine YAML databases are never parsed and the autosummon
	// timer is never registered, so a disabled engine costs nothing at runtime.
	if (!battle_config.population_engine_enable) {
		ShowStatus("Population engine: disabled (population_engine_enable: 0).\n");
		return;
	}

	// Requires job_db (do_init_pc) and item_db (do_init_itemdb) to be ready.
	if (!population_names_db().load())
		ShowWarning("Population engine: population_names.yml missing or invalid; name generation falls back to Bot_<index>.\n");
	if (!population_chat_db().load())
		ShowWarning("Population engine: population_chat.yml missing or invalid; chat disabled until fixed.\n");
	if (!population_skill_db().load())
		ShowWarning("Population engine: population_skill_db.yml missing or invalid; no per-job skill overrides loaded.\n");
	// Shared templates DB MUST load before the three job DBs so GearSet/Profile
	// references in the job files can resolve via fallback lookup.
	if (!population_shared_db().load())
		ShowWarning("Population engine: population_gear_sets.yml missing or invalid; gear sets/profiles will fall back per-file.\n");
	if (!population_engine_db().load())
		ShowWarning("Population engine: equipment configuration file not found or has errors, using fallback equipment.\n");
	if (!population_pvp_db().load())
		ShowWarning("Population engine: population_pvp.yml missing or invalid; PvP arena will use main DB fallback.\n");
	if (!population_vendor_pop_db().load())
		ShowWarning("Population engine: population_vendor_pop.yml missing or invalid; vendor shells will use main DB fallback.\n");
	if (!population_spawn_db().load())
		ShowWarning("Population engine: population_spawn.yml missing or invalid; autosummon disabled until fixed.\n");
	if (!population_vendor_db().load())
		ShowWarning("Population engine: population_vendors.yml missing or invalid; vendor shells use built-in default stock.\n");

	extern struct Battle_Config battle_config;

	if (g_autosummon_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(g_autosummon_timer);
		if (td && td->func == population_engine_autosummon_timer)
			delete_timer(g_autosummon_timer, population_engine_autosummon_timer);
		g_autosummon_timer = INVALID_TIMER;
	}
	{
		// RAGNAROKMAC: 10s is a long time to stand in an empty town after a warp.
		// Demand-driven filling only looks at the maps in use, so the tick is
		// cheap enough to run far more often.
		const int32 interval = battle_config.population_engine_demand_spawn ? 2000 : 10000;
		// Fire immediately (100 ms) so bots are on the map as soon as the server is up,
		// then top up every 10 s like mob spawns do.
		g_autosummon_timer = add_timer_interval(gettick() + 100, population_engine_autosummon_timer, 0, 0, interval);
		if (g_autosummon_timer == INVALID_TIMER)
			ShowError("Population engine: failed to register autosummon timer; shells will not spawn automatically.\n");
	}

	if (g_pop_chat_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(g_pop_chat_timer);
		if (td && td->func == population_engine_chat_timer)
			delete_timer(g_pop_chat_timer, population_engine_chat_timer);
		g_pop_chat_timer = INVALID_TIMER;
	}
	if (battle_config.population_engine_chat_enable) {
		int32 chtick = std::max(500, battle_config.population_engine_chat_tick_ms);
		g_pop_chat_timer = add_timer_interval(gettick() + chtick, population_engine_chat_timer, 0, 0, chtick);
		if (g_pop_chat_timer == INVALID_TIMER)
			ShowError("Population engine: failed to register chat timer; ambient chat will be silent.\n");
		else
			ShowStatus("Population engine: ambient chat enabled (tick=%d ms, cooldown=%d+0..%d ms, max=%d/tick).\n",
				chtick, battle_config.population_engine_chat_cooldown_ms,
				battle_config.population_engine_chat_cooldown_jitter_ms,
				battle_config.population_engine_chat_max_per_tick);
	} else {
		ShowStatus("Population engine: ambient chat disabled by battle configuration.\n");
	}

	population_engine_path_restart_wander_timer();

	// RAGNAROKMAC: vendor rotation sweeper. One-minute cadence; sweeps live
	// vendor shells against their per-shell vendor_rotation_at tick.
	if (g_vendor_rotation_timer != INVALID_TIMER) {
		const TimerData* td = get_timer(g_vendor_rotation_timer);
		if (td && td->func == population_engine_vendor_rotation_timer)
			delete_timer(g_vendor_rotation_timer, population_engine_vendor_rotation_timer);
		g_vendor_rotation_timer = INVALID_TIMER;
	}
	g_vendor_rotation_timer = add_timer_interval(
		gettick() + POP_VENDOR_ROTATION_TICK_MS,
		population_engine_vendor_rotation_timer, 0, 0, POP_VENDOR_ROTATION_TICK_MS);
	if (g_vendor_rotation_timer == INVALID_TIMER)
		ShowError("Population engine: failed to register vendor rotation timer; Pool vendors will not rotate.\n");

	if (g_population_combat_global_timer != INVALID_TIMER) {
		const TimerData *td = get_timer(g_population_combat_global_timer);
		if (td && td->func == population_engine_global_combat_timer)
			delete_timer(g_population_combat_global_timer, population_engine_global_combat_timer);
		g_population_combat_global_timer = INVALID_TIMER;
	}
	{
		int32 ctick = std::max(10, battle_config.population_engine_shell_timer_ms);
		g_population_combat_global_timer = add_timer_interval(gettick() + ctick, population_engine_global_combat_timer, 0, 0, ctick);
		if (g_population_combat_global_timer == INVALID_TIMER)
			ShowError("Population engine: failed to register combat timer; shells will not process AI.\n");
	}
	g_population_engine_running = true;
}

bool population_engine_reload_equipment(uint32_t *out_entry_count)
{
	population_shell_returns_clear();
	if (out_entry_count != nullptr)
		*out_entry_count = 0;

	const bool names_ok = population_names_db().reload();
	if (names_ok)
		ShowStatus("Population engine: population_names.yml reloaded (%zu profiles).\n", population_names_db().profile_count());
	else
		ShowWarning("Population engine: population_names.yml reload failed; name lists may be empty until fixed.\n");

	// Shared templates first so cross-file GearSet/Profile references survive.
	const bool shared_re = population_shared_db().reload();
	if (shared_re)
		ShowStatus("Population engine: population_gear_sets.yml reloaded.\n");
	else
		ShowWarning("Population engine: population_gear_sets.yml reload failed.\n");

	const bool ok      = population_engine_db().reload();
	const bool pvp_ok  = population_pvp_db().reload();
	if (!pvp_ok)
		ShowWarning("Population engine: population_pvp.yml reload failed.\n");
	const bool vjob_ok = population_vendor_pop_db().reload();
	if (!vjob_ok)
		ShowWarning("Population engine: population_vendor_pop.yml reload failed.\n");

	const bool spawn_ok = population_spawn_db().reload();
	if (spawn_ok)
		ShowStatus("Population engine: population_spawn.yml reloaded (%u entries).\n",
			static_cast<uint32_t>(population_spawn_db().size()));
	else
		ShowWarning("Population engine: population_spawn.yml reload failed.\n");

	const bool skill_ok = population_skill_db().reload();
	if (skill_ok)
		ShowStatus("Population engine: population_skill_db.yml reloaded (%zu jobs).\n", population_skill_db().job_count());
	else
		ShowWarning("Population engine: population_skill_db.yml reload failed (missing or invalid).\n");

	const bool chat_re = population_chat_db().reload();
	if (chat_re)
		ShowStatus("Population engine: population_chat.yml reloaded (%zu profiles).\n", population_chat_db().profile_count());
	else
		ShowWarning("Population engine: population_chat.yml reload failed (missing or invalid).\n");

	const bool vendor_re = population_vendor_db().reload();
	if (vendor_re)
		ShowStatus("Population engine: population_vendors.yml reloaded (%zu entries).\n", population_vendor_db().entry_count());
	else
		ShowWarning("Population engine: population_vendors.yml reload failed (missing or invalid).\n");

	// RAGNAROKMAC: a reload may follow a mod adding or changing map monsters.
	g_pop_map_mob_level.clear();

	// Drop the dynamic-vendor cache so reloaded YAML/spawn data takes effect immediately.
	population_engine_vendor_dyn_cache_clear();
	population_engine_vendor_job_pool_clear();

	if (out_entry_count != nullptr)
		*out_entry_count = static_cast<uint32_t>(population_engine_db().size()
			+ population_pvp_db().size() + population_vendor_pop_db().size());

	if (ok)
		ShowStatus("Population engine: equipment YAML reloaded (main=%u, pvp=%u, vendor=%u job profiles).\n",
			static_cast<uint32_t>(population_engine_db().size()),
			static_cast<uint32_t>(population_pvp_db().size()),
			static_cast<uint32_t>(population_vendor_pop_db().size()));
	else
		ShowWarning("Population engine: equipment YAML reload failed (missing file or parse error).\n");

	return ok;
}

/// RAGNAROKMAC (vehicles): give a shell the mount / pet / vehicle its class entitles it to.
///
/// The stock setters already tolerate population shells - `pc_setriding` and `pc_setfalcon`
/// both carry `|| population_engine_is_population_pc(sd->id)` - but nothing ever called them,
/// so no shell has had a mount, falcon or warg from the engine. RuneKnight and DragonKnight
/// looked mounted only because stock rAthena sets the option when the skill is present and the
/// tree grant gives them that skill.
///
/// Called at spawn (AFTER the skill tree is granted, since every test here is pc_checkskill)
/// and after job advancement, so a Swordsman that levels into Knight gains the mount rather
/// than keeping a pedestrian sprite.
///
/// Idempotent: each setter checks the current option before changing it, so calling this on an
/// already-mounted shell is a no-op.
static void population_engine_sync_shell_vehicle(map_session_data *sd)
{
	if (sd == nullptr)
		return;
	// Never touch a real player: this is for shells only.
	if (!population_engine_is_population_pc(sd->id))
		return;

	// Riding: Peco Peco (Knight/Crusader line) or dragon (RuneKnight/RoyalGuard line).
	if (pc_checkskill(sd, KN_RIDING) > 0 || pc_checkskill(sd, RK_DRAGONTRAINING) > 0)
		pc_setriding(sd, 1);

	// Falcon (Hunter/Sniper line) and Warg (Ranger/Windhawk) are MUTUALLY EXCLUSIVE.
	//
	// A Ranger/Windhawk's granted tree carries RA_WUGMASTERY *and* HT_FALCON (inherited from
	// the Hunter line), so granting each option in its own `if` leaves the shell with
	// FALCON|WUG (0x00100010) and the client draws a falcon AND a warg at the same time -
	// `clif_changeoption` carries a bitmask and the client builds each vehicle independently.
	// Stock never hits this because a real player holds only one of the two skills.
	//
	// The warg wins: that is what the class is meant to show. Clearing the falcon first means
	// the announce that follows carries the warg alone.
	if (pc_checkskill(sd, RA_WUGMASTERY) > 0) {
		if (sd->sc.option & OPTION_FALCON)
			pc_setfalcon(sd, 0); // stock routes flag=0 to pc_setoption(option & ~OPTION_FALCON)

		// This pin has no pc_setwarg(); the option IS the mechanism, and stock code only ever
		// clears it when RA_WUGMASTERY is missing, so setting it here is stable.
		//
		// Deliberately NOT guarded with `!(option & OPTION_WUG)`: re-sending the same value is
		// how the option change is re-announced to the client, and pc_setoption() has no
		// early-return (it assigns and calls clif_changeoption unconditionally), so a repeat
		// call is a cheap broadcast rather than a no-op. Without that, a recall that moves the
		// shell after the first announcement leaves the client rendering no warg while the
		// server state is correct.
		pc_setoption(sd, sd->sc.option | OPTION_WUG);
	} else if (pc_checkskill(sd, HT_FALCON) > 0) {
		pc_setfalcon(sd, 1);
	}

	// Mado Gear. pc_setmadogear() early-returns unless `(class_ & MAPID_THIRDMASK) ==
	// MAPID_MECHANIC`, and a 4th job (Meister) fails that test, so the setter can never grant
	// one. Set the option directly with the robot subtype instead.
	// Same reasoning as the warg above: no guard, so a repeat call still re-announces.
	if (pc_checkskill(sd, NC_MADOLICENCE) > 0)
		pc_setoption(sd, sd->sc.option | OPTION_MADOGEAR, MADO_ROBOT);
}

// ---- RAGNAROKMAC: shells built to their level -------------------------------
//
// Upstream rolled each stat straight from the profile's range, whatever the shell's
// level, and a profile with no ranges got 90-109 in all six: a level 10 Swordsman or
// Acolyte had ~100 everywhere, which a real character of that level could never buy.
// Now the rolled values are only the shape of the build. The shell starts at 1 in every
// stat with the points a character of its level has (as pc_resetstate gives them) and
// spends them a point at a time on whichever stat is furthest behind its share of the
// target, at the stock cost and within the job's cap. What is left stays in
// status_point, for a companion's growth to spend later.

/// A build for a profile that declares no stats, by job line: what a player of that
/// line would put points into. Proportions, not values; Novice and anything not listed
/// stay even.
static void pop_shell_job_build(uint64 class_mapid, int16_t out[6])
{
	// STR, AGI, VIT, INT, DEX, LUK
	static const int16_t even[6]       = { 50, 50, 50, 50, 50, 50 };
	static const int16_t swordman[6]   = { 80, 40, 70,  1, 40, 10 };
	static const int16_t mage[6]       = {  1, 20, 30, 90, 80,  1 };
	static const int16_t archer[6]     = { 10, 70, 30, 10, 90, 30 };
	static const int16_t acolyte[6]    = {  1, 20, 60, 90, 60, 10 };
	static const int16_t merchant[6]   = { 80, 30, 60, 10, 50, 20 };
	static const int16_t thief[6]      = { 60, 90, 40,  1, 50, 30 };
	static const int16_t taekwon[6]    = { 70, 80, 40, 20, 50, 30 };
	static const int16_t gunslinger[6] = { 20, 60, 30, 10, 90, 40 };
	static const int16_t ninja[6]      = { 40, 70, 40, 60, 70, 20 };
	const int16_t *b = even;
	switch (class_mapid & MAPID_FIRSTMASK) {
		case MAPID_SWORDMAN:   b = swordman; break;
		case MAPID_MAGE:       b = mage; break;
		case MAPID_ARCHER:     b = archer; break;
		case MAPID_ACOLYTE:    b = acolyte; break;
		case MAPID_MERCHANT:   b = merchant; break;
		case MAPID_THIEF:      b = thief; break;
		case MAPID_TAEKWON:    b = taekwon; break;
		case MAPID_GUNSLINGER: b = gunslinger; break;
		case MAPID_NINJA:      b = ninja; break;
		default: break;
	}
	for (int i = 0; i < 6; ++i)
		out[i] = b[i];
}

/// Spend the level's stat points toward `target` (STR..LUK). sd->status.base_level,
/// class_ and sex must already be set; the six stats are overwritten.
static void pop_shell_spend_to_level(map_session_data *sd, const int16_t target[6])
{
	uint16 *stat[6] = { &sd->status.str, &sd->status.agi, &sd->status.vit,
		&sd->status.int_, &sd->status.dex, &sd->status.luk };
	for (int i = 0; i < 6; ++i)
		*stat[i] = 1;
	int64 points = statpoint_db.get_table_point(sd->status.base_level);
	if ((sd->class_ & JOBL_UPPER) || pc_is_primary_fourth(sd->class_))
		points += battle_config.transcendent_status_points;

	bool done[6];
	for (int i = 0; i < 6; ++i)
		done[i] = target[i] <= 1;
	for (int guard = 0; guard < 4000; ++guard) {
		// The stat furthest behind its share of the target: lowest cur/target.
		int pick = -1;
		for (int i = 0; i < 6; ++i) {
			if (done[i])
				continue;
			if (*stat[i] >= target[i]) {
				done[i] = true;
				continue;
			}
			if (pick < 0 || static_cast<int64>(*stat[i]) * target[pick] < static_cast<int64>(*stat[pick]) * target[i])
				pick = i;
		}
		if (pick < 0)
			break;
		// 0 at the job's cap; costs only rise, so a stat it cannot afford now is done.
		const int32 cost = pc_need_status_point(sd, SP_STR + pick, 1);
		if (cost <= 0 || cost > points) {
			done[pick] = true;
			continue;
		}
		points -= cost;
		++*stat[pick];
	}
	sd->status.status_point = static_cast<uint32>(points);
}

/// The same for the 4th-job trait stats (POW..CRT): they start at 0, and the shell gets
/// the trait points a character of its level has (0 up to level 200, about 4 a level
/// after it; pc_resetstate's get_trait_table_point). A class without traits has a cap of
/// 0, so nothing is spent and its traits stay 0.
static void pop_shell_spend_traits_to_level(map_session_data *sd, const int16_t target[6])
{
	uint16 *trait[6] = { &sd->status.pow, &sd->status.sta, &sd->status.wis,
		&sd->status.spl, &sd->status.con, &sd->status.crt };
	for (int i = 0; i < 6; ++i)
		*trait[i] = 0;
	int64 points = statpoint_db.get_trait_table_point(sd->status.base_level);

	bool done[6];
	for (int i = 0; i < 6; ++i)
		done[i] = target[i] <= 0;
	for (int guard = 0; guard < 2000; ++guard) {
		int pick = -1;
		for (int i = 0; i < 6; ++i) {
			if (done[i])
				continue;
			if (*trait[i] >= target[i]) {
				done[i] = true;
				continue;
			}
			if (pick < 0 || static_cast<int64>(*trait[i]) * target[pick] < static_cast<int64>(*trait[pick]) * target[i])
				pick = i;
		}
		if (pick < 0)
			break;
		const int32 cost = pc_need_trait_point(sd, SP_POW + pick, 1);
		if (cost <= 0 || cost > points) {
			done[pick] = true;
			continue;
		}
		points -= cost;
		++*trait[pick];
	}
	sd->status.trait_point = static_cast<uint32>(points);
}

static map_session_data* population_engine_spawn_shell(int16_t map_id, int x, int y, uint32_t index,
	uint16_t job_id, char sex, uint8_t hair_style, uint16_t hair_color,
	uint16_t weapon, uint16_t shield, uint16_t head_top, uint16_t head_mid,
	uint16_t head_bottom, uint32_t option, uint16_t cloth_color, uint16_t garment,
	struct script_code* init_script, bool skip_arrow, const PopulationEngine* pop_cfg,
	uint8_t map_category,
	PopulationDbSource db_source,
	const PopulationVendorEntry* mod_entry,
	const PopulationModSpawn* mod_spawn,
	int16_t mod_seat,
	const PopulationShellReturn* returning)
{
	PE_PERF_SCOPE("spawn_shell");
	(void)skip_arrow; // Legacy GearSet Arrow toggle; unified ammo is managed at runtime.
	if (map_id < 0) {
		ShowError("Population engine: Invalid map_id %d\n", map_id);
		return nullptr;
	}
	if (!map_getcell(map_id, x, y, CELL_CHKPASS)) {
		ShowWarning("Population engine: Spawn position (%d,%d) on map %d is not walkable, skipping population shell %u\n",
			x, y, map_id, index);
		return nullptr;
	}

	// Restore before equipment, skills or packets are produced. The snapshot owns
	// only identity; inventory and combat state are freshly provisioned as usual.
	if (returning) {
		sex = returning->sex;
		hair_style = returning->hair;
		hair_color = returning->hair_color;
		cloth_color = returning->cloth_color;
		option = 0; // Let normal mount initialization create its status effects first.
		weapon = shield = head_top = head_mid = head_bottom = garment = 0;
	}
	uint8_t eff_hair = hair_style;
	uint16_t eff_hair_color = hair_color;
	uint16_t eff_cloth = cloth_color;
	if (pop_cfg != nullptr && !returning) {
		if (pop_cfg->hair_min >= 0) {
			const int16_t hmax = pop_cfg->hair_max >= 0 ? pop_cfg->hair_max : pop_cfg->hair_min;
			const int16_t valid_min = cap_value(pop_cfg->hair_min, static_cast<int16_t>(MIN_HAIR_STYLE), static_cast<int16_t>(MAX_HAIR_STYLE));
			const int16_t valid_max = cap_value(hmax, static_cast<int16_t>(MIN_HAIR_STYLE), static_cast<int16_t>(MAX_HAIR_STYLE));
			eff_hair = static_cast<uint8_t>(population_roll_closed_range(valid_min, valid_max));
		}
		if (pop_cfg->hair_color_min >= 0) {
			const int16_t hmax = pop_cfg->hair_color_max >= 0 ? pop_cfg->hair_color_max : pop_cfg->hair_color_min;
			const int16_t valid_min = cap_value(pop_cfg->hair_color_min, static_cast<int16_t>(MIN_HAIR_COLOR), static_cast<int16_t>(MAX_HAIR_COLOR));
			const int16_t valid_max = cap_value(hmax, static_cast<int16_t>(MIN_HAIR_COLOR), static_cast<int16_t>(MAX_HAIR_COLOR));
			eff_hair_color = static_cast<uint16_t>(population_roll_closed_range(valid_min, valid_max));
		}
		if (pop_cfg->cloth_color_min >= 0) {
			const int16_t hmax = pop_cfg->cloth_color_max >= 0 ? pop_cfg->cloth_color_max : pop_cfg->cloth_color_min;
			const int16_t valid_min = cap_value(pop_cfg->cloth_color_min, static_cast<int16_t>(MIN_CLOTH_COLOR), static_cast<int16_t>(MAX_CLOTH_COLOR));
			const int16_t valid_max = cap_value(hmax, static_cast<int16_t>(MIN_CLOTH_COLOR), static_cast<int16_t>(MAX_CLOTH_COLOR));
			eff_cloth = static_cast<uint16_t>(population_roll_closed_range(valid_min, valid_max));
		}
	}

	std::string name = returning ? returning->name : generate_population_pc_name(index, pop_cfg);
	const uint32_t account_id = POPULATION_ENGINE_ACCOUNT_ID_BASE + index;
	const uint32_t char_id    = POPULATION_ENGINE_CHAR_ID_BASE    + index;

	map_session_data* sd = nullptr;
	CREATE(sd, map_session_data, 1);
	new (sd) map_session_data();
	// CREATE uses memset(0) which overrides C++ default member initializers.
	// Explicitly set any fields whose sentinel value is NOT zero.
	sd->pop.respawn_timer = INVALID_TIMER;

	const t_tick tick = gettick();
	pc_setnewpc(sd, account_id, char_id, 0, tick, (sex == 'M' ? SEX_MALE : SEX_FEMALE), 0);
    
	sd->group_id = 0;
	pc_group_pc_load(sd);
	if (!sd->group) {
		ShowError("Population engine: no valid group (group_id=0) for population shell %u; using minimal defaults.\n", index);
		sd->group = std::make_shared<s_player_group>();
		sd->group->id    = 0;
		sd->group->level = 0;
		sd->group->log_commands = false;
	}
	if (sd->group->has_permission(PC_PERM_ALL_SKILL)) {
		std::bitset<PC_PERM_MAX> perms = sd->permissions;
		perms.reset(PC_PERM_ALL_SKILL);
		sd->permissions = perms;
	}
    
	memset(&sd->status, 0, sizeof(struct mmo_charstatus));
	sd->status.char_id    = char_id;
	sd->status.account_id = account_id;
	sd->status.sex = (sex == 'M' ? SEX_MALE : SEX_FEMALE);
	safestrncpy(sd->status.name, name.c_str(), sizeof(sd->status.name));

	sd->status.class_ = job_id;
	uint64 class_mapid = pc_jobid2mapid(job_id);
	if (class_mapid == (uint64)-1 || !job_db.exists(job_id)) {
		ShowError("Population engine: Invalid job %d for population shell %u; skipping spawn.\n", job_id, index);
		population_engine_destroy_failed_spawn(sd);
		return nullptr;
	} else {
		sd->class_ = class_mapid;
		int32 verify_job = pc_mapid2jobid(class_mapid, (sex == 'M' ? 1 : 0));
		if (verify_job != (int32)job_id && get_job_required_sex(job_id) != '\0') {
			ShowWarning("Population engine: Job/MAPID mismatch for population shell %u: job_id=%d, mapid=%llu, sex=%c, verify_job=%d\n",
				index, job_id, (unsigned long long)class_mapid, sex, verify_job);
			sd->status.class_ = verify_job;
		}
	}

	sd->status.hair         = cap_value(eff_hair, MIN_HAIR_STYLE, MAX_HAIR_STYLE);
	sd->status.hair_color   = cap_value(eff_hair_color, MIN_HAIR_COLOR, MAX_HAIR_COLOR);
	sd->status.clothes_color = cap_value(eff_cloth, MIN_CLOTH_COLOR, MAX_CLOTH_COLOR);
	sd->status.body         = sd->status.class_;
	// status.weapon is weapon_type enum, not an item id; pc_calcweapontype sets it after equip.
	sd->status.weapon     = W_FIST;
	sd->status.shield     = shield;
	sd->status.head_top   = head_top;
	sd->status.head_mid   = head_mid;
	sd->status.head_bottom = head_bottom;
	sd->status.robe       = garment;
	sd->status.option     = option;

	// Companions must be inspectable/gradable by their owner: always allow
	// viewing their equipment, otherwise clif_parse_ViewPlayerEquip replies
	// MSI_OPEN_EQUIPEDITEM_REFUSED. Must sit after the memset of sd->status.
	sd->status.show_equip = true;

	if (returning) {
		sd->status.base_level = returning->level;
	} else if (pop_cfg != nullptr && pop_cfg->base_level_min >= 0) {
		const int16_t hi = pop_cfg->base_level_max >= 0 ? pop_cfg->base_level_max : pop_cfg->base_level_min;
		int16_t rolled = population_roll_closed_range(pop_cfg->base_level_min, hi);
		// RAGNAROKMAC: on a map with monsters, take the level from them rather
		// than from a uniform roll across the profile's band. +8 because a
		// player hunting a field is usually a little above what lives there.
		// Past the band's top if they say so, never past the class's own cap.
		if (battle_config.population_engine_level_from_map) {
			// map_id, not sd->m: the shell is only put on its map further down (pc_setpos), so
			// sd->m is still 0 here, a map without monsters, and every shell got the uniform roll.
			const int mobs = pop_map_mob_level(map_id);
			if (mobs > 0)
				rolled = static_cast<int16_t>(cap_value(mobs + 8,
					static_cast<int>(pop_cfg->base_level_min),
					std::max(static_cast<int>(hi), static_cast<int>(pc_maxbaselv(sd)))));
		}
		// RAGNAROKMAC: a hired companion comes at its owner's level, within
		// the band its profile allows (population_engine_companion_hire).
		if (g_pop_draft_level > 0)
			rolled = static_cast<int16_t>(cap_value(static_cast<int>(g_pop_draft_level),
				static_cast<int>(pop_cfg->base_level_min), static_cast<int>(hi)));
		sd->status.base_level = cap_value(rolled, 1, MAX_LEVEL);
	} else {
		// Upstream defaults an undeclared BaseLevel to 99, which is how a
		// newbie field ended up full of level 99 Novices. Every profile we ship
		// declares one; this stays as the upstream fallback.
		sd->status.base_level = 99;
	}
	if (returning) {
		sd->status.job_level = returning->job_level;
	} else if (pop_cfg != nullptr && pop_cfg->job_level_min >= 0) {
		const int16_t hi = pop_cfg->job_level_max >= 0 ? pop_cfg->job_level_max : pop_cfg->job_level_min;
		sd->status.job_level = cap_value(population_roll_closed_range(pop_cfg->job_level_min, hi), 1, MAX_LEVEL);
	} else {
		sd->status.job_level = 70;
	}
	if (pop_cfg != nullptr && pop_cfg->str_min >= 0) {
		const int16_t hi = pop_cfg->str_max >= 0 ? pop_cfg->str_max : pop_cfg->str_min;
		sd->status.str = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->str_min, hi)), 1, 999);
	} else {
		sd->status.str = static_cast<uint16_t>(90 + (rnd() % 20));
	}
	if (pop_cfg != nullptr && pop_cfg->agi_min >= 0) {
		const int16_t hi = pop_cfg->agi_max >= 0 ? pop_cfg->agi_max : pop_cfg->agi_min;
		sd->status.agi = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->agi_min, hi)), 1, 999);
	} else {
		sd->status.agi = static_cast<uint16_t>(90 + (rnd() % 20));
	}
	if (pop_cfg != nullptr && pop_cfg->vit_min >= 0) {
		const int16_t hi = pop_cfg->vit_max >= 0 ? pop_cfg->vit_max : pop_cfg->vit_min;
		sd->status.vit = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->vit_min, hi)), 1, 999);
	} else {
		sd->status.vit = static_cast<uint16_t>(90 + (rnd() % 20));
	}
	if (pop_cfg != nullptr && pop_cfg->intl_min >= 0) {
		const int16_t hi = pop_cfg->intl_max >= 0 ? pop_cfg->intl_max : pop_cfg->intl_min;
		sd->status.int_ = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->intl_min, hi)), 1, 999);
	} else {
		sd->status.int_ = static_cast<uint16_t>(90 + (rnd() % 20));
	}
	if (pop_cfg != nullptr && pop_cfg->dex_min >= 0) {
		const int16_t hi = pop_cfg->dex_max >= 0 ? pop_cfg->dex_max : pop_cfg->dex_min;
		sd->status.dex = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->dex_min, hi)), 1, 999);
	} else {
		sd->status.dex = static_cast<uint16_t>(90 + (rnd() % 20));
	}
	if (pop_cfg != nullptr && pop_cfg->luk_min >= 0) {
		const int16_t hi = pop_cfg->luk_max >= 0 ? pop_cfg->luk_max : pop_cfg->luk_min;
		sd->status.luk = cap_value(static_cast<uint16_t>(population_roll_closed_range(pop_cfg->luk_min, hi)), 1, 999);
	} else {
		sd->status.luk = static_cast<uint16_t>(90 + (rnd() % 20));
	}

	// RAGNAROKMAC: the rolls above are the shape of the build; spend the level's points
	// toward them (pop_shell_spend_to_level). A stat the profile does not declare is not
	// invested in, and a profile that declares none gets its job line's build instead of
	// upstream's 90-109 everywhere.
	{
		const bool declared[6] = {
			pop_cfg != nullptr && pop_cfg->str_min >= 0, pop_cfg != nullptr && pop_cfg->agi_min >= 0,
			pop_cfg != nullptr && pop_cfg->vit_min >= 0, pop_cfg != nullptr && pop_cfg->intl_min >= 0,
			pop_cfg != nullptr && pop_cfg->dex_min >= 0, pop_cfg != nullptr && pop_cfg->luk_min >= 0 };
		const uint16 rolled[6] = { sd->status.str, sd->status.agi, sd->status.vit,
			sd->status.int_, sd->status.dex, sd->status.luk };
		int16_t target[6];
		if (std::none_of(std::begin(declared), std::end(declared), [](bool d) { return d; })) {
			pop_shell_job_build(sd->class_, target);
		} else {
			for (int i = 0; i < 6; ++i)
				target[i] = declared[i] ? static_cast<int16_t>(rolled[i]) : 1;
		}
		pop_shell_spend_to_level(sd, target);
	}

	// RAGNAROKMAC: 4th-job trait stats (Renewal trait era). No profile default means
	// 0 — the classic-stat fallback above is fine for base stats, but traits must not
	// inherit the 90+ rnd%%20 fallback or every 1st/2nd job shell would be
	// trait-boosted. Only profiles that declare Pow/Sta/Wis/Spl/Con/Crt get them.
	if (pop_cfg != nullptr && pop_cfg->pow_min >= 0) {
		const int16_t hi = pop_cfg->pow_max >= 0 ? pop_cfg->pow_max : pop_cfg->pow_min;
		sd->status.pow = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->pow_min, hi)), 0, 999);
	}
	if (pop_cfg != nullptr && pop_cfg->sta_min >= 0) {
		const int16_t hi = pop_cfg->sta_max >= 0 ? pop_cfg->sta_max : pop_cfg->sta_min;
		sd->status.sta = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->sta_min, hi)), 0, 999);
	}
	if (pop_cfg != nullptr && pop_cfg->wis_min >= 0) {
		const int16_t hi = pop_cfg->wis_max >= 0 ? pop_cfg->wis_max : pop_cfg->wis_min;
		sd->status.wis = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->wis_min, hi)), 0, 999);
	}
	if (pop_cfg != nullptr && pop_cfg->spl_min >= 0) {
		const int16_t hi = pop_cfg->spl_max >= 0 ? pop_cfg->spl_max : pop_cfg->spl_min;
		sd->status.spl = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->spl_min, hi)), 0, 999);
	}
	if (pop_cfg != nullptr && pop_cfg->con_min >= 0) {
		const int16_t hi = pop_cfg->con_max >= 0 ? pop_cfg->con_max : pop_cfg->con_min;
		sd->status.con = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->con_min, hi)), 0, 999);
	}
	if (pop_cfg != nullptr && pop_cfg->crt_min >= 0) {
		const int16_t hi = pop_cfg->crt_max >= 0 ? pop_cfg->crt_max : pop_cfg->crt_min;
		sd->status.crt = cap_value(static_cast<int16_t>(population_roll_closed_range(pop_cfg->crt_min, hi)), 0, 999);
	}

	// RAGNAROKMAC: as for the six stats above, the trait rolls are the shape of the build
	// and the level's trait points are spent toward them. Undeclared traits stay 0.
	{
		const int16_t target[6] = {
			(pop_cfg != nullptr && pop_cfg->pow_min >= 0) ? static_cast<int16_t>(sd->status.pow) : static_cast<int16_t>(0),
			(pop_cfg != nullptr && pop_cfg->sta_min >= 0) ? static_cast<int16_t>(sd->status.sta) : static_cast<int16_t>(0),
			(pop_cfg != nullptr && pop_cfg->wis_min >= 0) ? static_cast<int16_t>(sd->status.wis) : static_cast<int16_t>(0),
			(pop_cfg != nullptr && pop_cfg->spl_min >= 0) ? static_cast<int16_t>(sd->status.spl) : static_cast<int16_t>(0),
			(pop_cfg != nullptr && pop_cfg->con_min >= 0) ? static_cast<int16_t>(sd->status.con) : static_cast<int16_t>(0),
			(pop_cfg != nullptr && pop_cfg->crt_min >= 0) ? static_cast<int16_t>(sd->status.crt) : static_cast<int16_t>(0) };
		pop_shell_spend_traits_to_level(sd, target);
	}

	// HP/SP placeholders — status_calc_pc() overwrites these from job_stats.yml (includes
	// job_aspd.yml and job_basepoints.yml), so the exact values here don't matter.
	sd->status.max_hp = 1;
	sd->status.hp     = 1;
	sd->status.max_sp = 1;
	sd->status.sp     = 1;

	const char* mapname = map_mapid2mapname(map_id);
	if (!mapname || !mapname[0]) {
		ShowError("Population engine: Invalid map name for map_id %d\n", map_id);
		population_engine_destroy_failed_spawn(sd);
		return nullptr;
	}
	safestrncpy(sd->status.last_point.map, mapname, sizeof(sd->status.last_point.map));
	sd->status.last_point.x = x;
	sd->status.last_point.y = y;
	safestrncpy(sd->status.save_point.map, mapname, sizeof(sd->status.save_point.map));
	sd->status.save_point.x = x;
	sd->status.save_point.y = y;

	sd->state.connect_new = 1;
	sd->followtimer             = INVALID_TIMER;
	sd->invincible_timer        = INVALID_TIMER;
	sd->npc_timer_id            = INVALID_TIMER;
	sd->pvp_timer               = INVALID_TIMER;
	sd->expiration_tid          = INVALID_TIMER;
	sd->autotrade_tid           = INVALID_TIMER;
	sd->respawn_tid             = INVALID_TIMER;
	sd->tid_queue_active        = INVALID_TIMER;
	sd->macro_detect.timer      = INVALID_TIMER;
	sd->skill_keep_using.tid    = INVALID_TIMER;
	sd->skill_keep_using.skill_id = 0;
	sd->skill_keep_using.level  = 0;
	sd->skill_keep_using.target = 0;

#ifdef SECURE_NPCTIMEOUT
	// Prevent timer cleanup errors from uninitialized npc_idle_timer.
	sd->npc_idle_timer    = INVALID_TIMER;
	sd->npc_idle_tick     = tick;
	sd->npc_idle_type     = NPCT_INPUT;
	sd->state.ignoretimeout = false;
#endif

	sd->canuseitem_tick   = 0;
	sd->canusecashfood_tick = 0;
	sd->canequip_tick     = 0;
	sd->cantalk_tick      = 0;
	sd->canskill_tick     = 0;
	// RAGNAROKMAC: no sd->state.autocast here. It was set to get past skill_isNotOk's cast-spam
	// check, but skill_amotion_leniency 0 (rAthena's default, which the app keeps) turns that check
	// off, and raised it would only hold a shell to its attack speed, as it does a player.
	// autocast also made every skill free (skill_consume_requirement), so shells cast without
	// paying SP.
	sd->cansendmail_tick  = 0;
	sd->idletime          = tick;

	sd->regen.tick.hp = tick;
	sd->regen.tick.sp = tick;

	for (int32 i = 0; i < MAX_SPIRITBALL; i++)
		sd->spirit_timer[i] = INVALID_TIMER;

	if (battle_config.item_auto_get)
		sd->state.autoloot = 10000;
	if (battle_config.disp_experience)
		sd->state.showexp = 1;
	if (battle_config.disp_zeny)
		sd->state.showzeny = 1;
	if (!(battle_config.display_skill_fail & 2))
		sd->state.showdelay = 1;

	memset(&sd->inventory, 0, sizeof(struct s_storage));
	// Non-vendor shells never access cart, storage, or premiumStorage.
	// Skipping their zero-init saves ~78 KB per shell — at 5k shells that is ~380 MB.
	{
		PopulationBehavior early_beh = pop_cfg ? pop_cfg->behavior : PopulationBehavior::Combat;
		if (pop_cfg) {
			PopulationBehavior ov = PopulationBehavior::None;
			if      (map_category == 1) ov = pop_cfg->town_behavior;
			else if (map_category == 2) ov = pop_cfg->field_behavior;
			else if (map_category == 3) ov = pop_cfg->dungeon_behavior;
			if (ov != PopulationBehavior::None) early_beh = ov;
		}
		if (early_beh == PopulationBehavior::Vendor) {
			memset(&sd->cart,           0, sizeof(struct s_storage));
			memset(&sd->storage,        0, sizeof(struct s_storage));
			memset(&sd->premiumStorage, 0, sizeof(struct s_storage));
		}
	}
	memset(&sd->equip_index,       -1, sizeof(sd->equip_index));
	memset(&sd->equip_switch_index, -1, sizeof(sd->equip_switch_index));

	sd->sc.option = sd->status.option;
	unit_dataset(sd);

	sd->guild_x = -1;
	sd->guild_y = -1;
	sd->delayed_damage = 0;

	for (int32 i = 0; i < MAX_EVENTTIMER; i++)
		sd->eventtimer[i] = INVALID_TIMER;
	sd->rental_timer = INVALID_TIMER;

	for (int32 i = 0; i < 3; i++)
		sd->hate_mob[i] = -1;

	sd->quest_log    = nullptr;
	sd->num_quests   = 0;
	sd->avail_quests = 0;
	sd->save_quest   = false;
	sd->count_rewarp = 0;
	sd->mail.pending_weight = 0;
	sd->mail.pending_zeny   = 0;
	sd->mail.pending_slots  = 0;

	sd->regs.vars   = i64db_alloc(DB_OPT_BASE);
	sd->regs.arrays = nullptr;
	sd->vars_dirty  = false;
	sd->vars_ok     = true;  // skip char-server auth
	sd->vars_received = 0x7;

	uint16 mapindex = mapindex_name2id(mapname);
	if (mapindex == 0) {
		ShowError("Population engine: Invalid mapname %s (cannot convert to mapindex)\n", mapname);
		population_engine_destroy_failed_spawn(sd);
		return nullptr;
	}
	enum e_setpos setpos_result = pc_setpos(sd, mapindex, x, y, CLR_OUTSIGHT);
	if (setpos_result != SETPOS_OK) {
		ShowError("Population engine: Failed to set position for population shell %u (error %d)\n", index, setpos_result);
		population_engine_destroy_failed_spawn(sd);
		return nullptr;
	}
	// pc_setpos sets warp handshake flags; clear them so unit_remove_map doesn't warn on cleanup.
	sd->state.changemap = 0;
	sd->state.connect_new = 0;
	sd->state.warping = 0;

	map_addiddb(sd);
	if (map_addblock(sd) != 0) {
		ShowError("Population engine: Failed to add population shell %u to map\n", index);
		map_deliddb(sd);
		population_engine_destroy_failed_spawn(sd);
		return nullptr;
	}

	// Skip clif_spawn — increment mapdata->users/users_pvp manually so unit_remove_map
	// doesn't warn about unexpected state when the shell is later released.
	{
		struct map_data* mapdata = map_getmapdata(sd->m);
		if (mapdata) {
			if (mapdata->users++ == 0 && battle_config.dynamic_mobs)
				map_spawnmobs(sd->m);
			if (!pc_isinvisible(sd))
				mapdata->users_pvp++;
		}
		sd->state.debug_remove_map = 0;
	}

	// Fix sex mismatch for gender-locked jobs before status_calc_pc.
	char required_sex_check = get_job_required_sex(sd->status.class_);
	if (required_sex_check != '\0') {
		const int32 req_sex_int = (required_sex_check == 'M') ? 1 : 0;
		if ((sd->status.sex == SEX_MALE ? 1 : 0) != req_sex_int) {
			ShowWarning("Population engine: Fixing sex mismatch for population shell %u: job=%d (requires %c), current_sex=%c\n",
				index, job_id, required_sex_check, (sd->status.sex == SEX_MALE) ? 'M' : 'F');
			sd->status.sex = (required_sex_check == 'M') ? SEX_MALE : SEX_FEMALE;
		}
	}

	// status_set_viewdata must be called before status_calc_pc.
	status_set_viewdata(sd, sd->status.class_);
	sd->vd.look[LOOK_HAIR]          = sd->status.hair;
	sd->vd.look[LOOK_HAIR_COLOR]    = sd->status.hair_color;
	sd->vd.look[LOOK_CLOTHES_COLOR] = sd->status.clothes_color;
	// LOOK_WEAPON / LOOK_SHIELD: set by pc_calcweapontype after equip.
	sd->vd.look[LOOK_HEAD_TOP]    = sd->status.head_top;
	sd->vd.look[LOOK_HEAD_MID]    = sd->status.head_mid;
	sd->vd.look[LOOK_HEAD_BOTTOM] = sd->status.head_bottom;
	sd->vd.look[LOOK_ROBE]        = sd->status.robe;
	sd->vd.sex = sd->status.sex;

	// base_status.mode must be set before status_calc_pc so MD_CANMOVE survives the copy.
	sd->base_status.mode = static_cast<e_mode>(MD_CANMOVE | MD_CANATTACK);
	status_calc_pc(sd, SCO_FIRST);

	// Sync HP/SP/AP to calculated maxima — status_calc_pc may change them without clamping current values.
	// status_isdead() checks battle_status.hp; leaving it at 0 makes the engine treat the shell as dead.
	if (sd->battle_status.max_hp > 0) {
		sd->status.hp         = sd->battle_status.max_hp;
		sd->battle_status.hp  = sd->battle_status.max_hp;
	}
	if (sd->battle_status.max_sp > 0) {
		sd->status.sp         = sd->battle_status.max_sp;
		sd->battle_status.sp  = sd->battle_status.max_sp;
	}
	if (sd->battle_status.max_ap > 0) {
		sd->status.ap         = sd->battle_status.max_ap;
		sd->battle_status.ap  = sd->battle_status.max_ap;
	}

	// status_calc_pc may flip the job for gender-specific combined MAPIDs (e.g. MAPID_SHINKIRO_SHIRANUI).
	if (required_sex_check != '\0') {
		const char cur_sex = get_job_required_sex(sd->status.class_);
		const int32 req_int = (required_sex_check == 'M') ? 1 : 0;
		if (cur_sex != required_sex_check || (sd->status.sex == SEX_MALE ? 1 : 0) != req_int
		    || sd->status.class_ != job_id)
		{
			ShowWarning("Population engine: Fixing gender/job mismatch for population shell %u: original_job=%d (requires %c), current_job=%d (requires %c), current_sex=%c\n",
				index, job_id, required_sex_check, sd->status.class_,
				cur_sex != '\0' ? cur_sex : '?',
				(sd->status.sex == SEX_MALE) ? 'M' : 'F');
			// Never restore a job that no longer exists in job_db.
			if (job_db.exists(job_id) && pc_jobid2mapid(job_id) != static_cast<uint64_t>(-1))
				sd->status.class_ = job_id;
			sd->status.sex = (required_sex_check == 'M') ? SEX_MALE : SEX_FEMALE;
			const uint64 fixed_mapid = pc_jobid2mapid(sd->status.class_);
			if (fixed_mapid != (uint64)-1)
				sd->class_ = fixed_mapid;
			status_set_viewdata(sd, sd->status.class_);
			sd->vd.sex = sd->status.sex;
			sd->base_status.mode = static_cast<e_mode>(MD_CANMOVE | MD_CANATTACK);
			status_calc_pc(sd, SCO_FORCE);
		}
	}

	sd->status.inventory_slots = MAX_INVENTORY;
	if (sd->base_status.max_ap > 0) {
		sd->status.max_ap        = sd->base_status.max_ap;
		sd->battle_status.max_ap = sd->base_status.max_ap;
		sd->status.ap            = sd->base_status.max_ap;
		sd->battle_status.ap     = sd->base_status.max_ap;
	}
	sd->status.sp         = sd->base_status.max_sp;
	sd->battle_status.sp  = sd->base_status.max_sp;
	if (sd->status.zeny < 100000)
		sd->status.zeny = 100000;
    
	// Grant full job skill tree (YAML Skills: true, default) or minimal basics (Skills: false).
	if (pop_cfg == nullptr || pop_cfg->grant_skill_tree) {
		// pc_calc_skilltree sets prerequisites but doesn't assign levels; grant each skill explicitly
		// so pc_checkskill() returns non-zero for the combat seeder. Without this all seeding passes
		// produce an empty list and shells fall back to melee-only.
		pc_calc_skilltree(sd);
		std::shared_ptr<s_skill_tree> tree = skill_tree_db.find(sd->status.class_);
		if (tree && !tree->skills.empty()) {
			for (const auto& [sid, entry] : tree->skills) {
				if (entry && entry->max_lv > 0)
					pc_skill(sd, sid, entry->max_lv, ADDSKILL_PERMANENT_GRANTED);
			}
			// Strip any extra skills pc_calc_skilltree may have added beyond this job's tree.
			std::set<uint16_t> valid_ids;
			for (const auto& e : tree->skills) valid_ids.insert(e.first);
			valid_ids.insert(NV_BASIC);
			valid_ids.insert(NV_FIRSTAID);
			for (uint16 i = 1; i < MAX_SKILL; i++) {
				if (sd->status.skill[i].id > 0 && valid_ids.find(sd->status.skill[i].id) == valid_ids.end()) {
					sd->status.skill[i].id   = 0;
					sd->status.skill[i].lv   = 0;
					sd->status.skill[i].flag = SKILL_FLAG_PERMANENT;
				}
			}
		} else {
			ShowWarning("Population engine: No skill tree for job %d (population shell %u)\n", sd->status.class_, index);
		}
	} else {
		memset(&sd->status.skill, 0, sizeof(sd->status.skill));
		pc_skill(sd, NV_BASIC,    1, ADDSKILL_PERMANENT_GRANTED);
		pc_skill(sd, NV_FIRSTAID, 1, ADDSKILL_PERMANENT_GRANTED);
	}

	// Ensure every skill listed in `Skills:` is granted at least up to its level cap.
	if (pop_cfg && !pop_cfg->shell_attack_skill_yaml.empty()) {
		for (const PopulationShellYamlSkill &e : pop_cfg->shell_attack_skill_yaml) {
			if (e.skill_id == 0 || !skill_get_index(e.skill_id))
				continue;
			const uint16_t smax = skill_get_max(e.skill_id);
			const uint16_t have = pc_checkskill(sd, e.skill_id);
			const uint16_t want = (e.level_cap > 0)
				? std::max(have, std::min<uint16_t>(e.level_cap, smax))
				: have;
			if (want > have)
				pc_skill(sd, e.skill_id, want, ADDSKILL_PERMANENT_GRANTED);
		}
	}

	// Recalc once after all pc_skill grants so passive bonuses (TF_DOUBLE, AC_OWL, etc.)
	// take effect immediately. pc_equipitem below also triggers a recalc, but a shell
	// with no equipment to wear would otherwise skip it and ship without passive stats.
	status_calc_pc(sd, SCO_FORCE);

	// RAGNAROKMAC (vehicles): mount / falcon / warg / mado, now that the tree is granted.
	// Must come after the grants above, because every gate is pc_checkskill().
	population_engine_sync_shell_vehicle(sd);
	population_engine_sync_shell_homunculus(sd);

	// max_weight must be raised before pc_additem: every pc_equipitem calls status_calc_pc
	// which resets max_weight to job_base + str*300, causing subsequent pc_additem to fail
	// with ADDITEM_OVERWEIGHT. The final status_calc_pc at the end restores the correct value.
	sd->max_weight = 2000000;

	if (returning) {
		for (const auto &gear : returning->gear)
			population_engine_shell_equip_item(sd, gear.item_id, index, "return", gear.position);
	} else {
	if (weapon > 0) {
		struct item tmp_item = {};
		tmp_item.nameid   = weapon;
		tmp_item.amount   = 1;
		tmp_item.identify = 1;
		enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
		if (result == ADDITEM_SUCCESS) {
			for (int16 i = 0; i < MAX_INVENTORY; i++) {
				const auto& islot = sd->inventory.u.items_inventory[i];
				if (islot.nameid == weapon && islot.amount > 0 && islot.equip == 0) {
					struct item_data* id = itemdb_search(weapon);
					if (id && id->equip) {
						(void)pc_equipitem(sd, i, id->equip, false);
					} else {
						if (!id)
							ShowWarning("Population engine: Weapon %u not found in itemdb for population shell %u\n", weapon, index);
						else if (!id->equip)
							ShowWarning("Population engine: Weapon %u has no equip flags for population shell %u\n", weapon, index);
					}
					break;
				}
			}
		} else {
			ShowWarning("Population engine: Failed to add weapon %u to population shell %u inventory (result: %d)\n", weapon, index, result);
		}
	}

    if (shield > 0) {
        struct item tmp_item = {};
        tmp_item.nameid = shield;
        tmp_item.amount = 1;
        tmp_item.identify = 1;
        tmp_item.equip = 0;
        enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
        if (result == ADDITEM_SUCCESS) {
            for (int16 i = 0; i < MAX_INVENTORY; i++) {
                if (sd->inventory.u.items_inventory[i].nameid == shield && sd->inventory.u.items_inventory[i].amount > 0
                    && sd->inventory.u.items_inventory[i].equip == 0) {
                    struct item_data* id = itemdb_search(shield);
                    if (id && id->equip) {
                        bool equip_result = pc_equipitem(sd, i, id->equip, false);
                        if (equip_result) {
                            // Update view_data manually for population shells
                            sd->vd.look[LOOK_SHIELD] = shield;
                            sd->status.shield = shield;
                        }
                        break;
                    }
                }
            }
        }
    }
    
    if (head_top > 0) {
        struct item tmp_item = {};
        tmp_item.nameid = head_top;
        tmp_item.amount = 1;
        tmp_item.identify = 1;
        tmp_item.equip = 0;
        enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
        if (result == ADDITEM_SUCCESS) {
            for (int16 i = 0; i < MAX_INVENTORY; i++) {
                if (sd->inventory.u.items_inventory[i].nameid == head_top && sd->inventory.u.items_inventory[i].amount > 0
                    && sd->inventory.u.items_inventory[i].equip == 0) {
                    struct item_data* id = itemdb_search(head_top);
                    if (id && id->equip) {
                        bool equip_result = pc_equipitem(sd, i, id->equip, false);
                        if (equip_result) {
                            sd->vd.look[LOOK_HEAD_TOP] = head_top;
                            sd->status.head_top = head_top;
                        }
                        break;
                    }
                }
            }
        }
    }

    if (head_mid > 0) {
        struct item tmp_item = {};
        tmp_item.nameid = head_mid;
        tmp_item.amount = 1;
        tmp_item.identify = 1;
        tmp_item.equip = 0;
        enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
        if (result == ADDITEM_SUCCESS) {
            for (int16 i = 0; i < MAX_INVENTORY; i++) {
                if (sd->inventory.u.items_inventory[i].nameid == head_mid && sd->inventory.u.items_inventory[i].amount > 0
                    && sd->inventory.u.items_inventory[i].equip == 0) {
                    struct item_data* id = itemdb_search(head_mid);
                    if (id && id->equip) {
                        bool equip_result = pc_equipitem(sd, i, id->equip, false);
                        if (equip_result) {
                            sd->vd.look[LOOK_HEAD_MID] = head_mid;
                            sd->status.head_mid = head_mid;
                        }
                        break;
                    }
                }
            }
        }
    }

    if (head_bottom > 0) {
        struct item tmp_item = {};
        tmp_item.nameid = head_bottom;
        tmp_item.amount = 1;
        tmp_item.identify = 1;
        tmp_item.equip = 0;
        enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
        if (result == ADDITEM_SUCCESS) {
            for (int16 i = 0; i < MAX_INVENTORY; i++) {
                if (sd->inventory.u.items_inventory[i].nameid == head_bottom && sd->inventory.u.items_inventory[i].amount > 0
                    && sd->inventory.u.items_inventory[i].equip == 0) {
                    struct item_data* id = itemdb_search(head_bottom);
                    if (id && id->equip) {
                        bool equip_result = pc_equipitem(sd, i, id->equip, false);
                        if (equip_result) {
                            sd->vd.look[LOOK_HEAD_BOTTOM] = head_bottom;
                            sd->status.head_bottom = head_bottom;
                        }
                        break;
                    }
                }
            }
        }
    }

    if (garment > 0) {
        struct item tmp_item = {};
        tmp_item.nameid = garment;
        tmp_item.amount = 1;
        tmp_item.identify = 1;
        tmp_item.equip = 0;
        enum e_additem_result result = pc_additem(sd, &tmp_item, 1, LOG_TYPE_NONE, false);
        if (result == ADDITEM_SUCCESS) {
            for (int16 i = 0; i < MAX_INVENTORY; i++) {
                if (sd->inventory.u.items_inventory[i].nameid == garment && sd->inventory.u.items_inventory[i].amount > 0
                    && sd->inventory.u.items_inventory[i].equip == 0) {
                    struct item_data* id = itemdb_search(garment);
                    if (id && id->equip) {
                        bool equip_result = pc_equipitem(sd, i, id->equip, false);
                        if (equip_result) {
                            sd->vd.look[LOOK_ROBE] = garment;
                            sd->status.robe = garment;
                        }
                        break;
                    }
                }
            }
        }
    }

    if (pop_cfg != nullptr) {
        auto pick_pool_cfg = [](const std::vector<uint16_t>& p) -> uint16_t {
            if (p.empty()) return 0;
            return p.size() == 1 ? p[0] : p[rnd() % p.size()];
        };
        population_engine_shell_equip_item(sd, pick_pool_cfg(pop_cfg->armor_pool),   index, "armor");
        population_engine_shell_equip_item(sd, pick_pool_cfg(pop_cfg->shoes_pool),   index, "shoes");
        population_engine_shell_equip_item(sd, pick_pool_cfg(pop_cfg->acc_l_pool),   index, "acc_l", EQP_ACC_L);
        population_engine_shell_equip_item(sd, pick_pool_cfg(pop_cfg->acc_r_pool),   index, "acc_r", EQP_ACC_R);
    }

	} // Fresh shells draw gear from their profile; returns keep their worn choices.

    // Stock consumable trap items for jobs that use trap skills.
    // Hunter/Sniper use Booby_Trap (1065); Ranger uses Special_Alloy_Trap (7940);
    // Genetic uses Seed_Of_Horny_Plant (6210).  Amount is generous to avoid running out.
    {
        struct { t_itemid nameid; int amount; } trap_stock[3] = {};
        int trap_count = 0;
        const bool is_hunter_line = (job_id == JOB_HUNTER || job_id == JOB_SNIPER
            || job_id == JOB_RANGER || job_id == JOB_RANGER_T);
        const bool is_ranger = (job_id == JOB_RANGER || job_id == JOB_RANGER_T);
        const bool is_genetic = (job_id == JOB_GENETIC || job_id == JOB_GENETIC_T);
        if (is_hunter_line) {
            trap_stock[trap_count++] = { 1065, 500 };  // Booby_Trap
        }
        if (is_ranger) {
            trap_stock[trap_count++] = { 7940, 500 };  // Special_Alloy_Trap
        }
        if (is_genetic) {
            trap_stock[trap_count++] = { 6210, 500 };  // Seed_Of_Horny_Plant
        }
        for (int ti = 0; ti < trap_count; ti++) {
            struct item tmp_item = {};
            tmp_item.nameid   = trap_stock[ti].nameid;
            tmp_item.amount   = 1;
            tmp_item.identify = 1;
            tmp_item.equip    = 0;
            pc_additem(sd, &tmp_item, trap_stock[ti].amount, LOG_TYPE_NONE, false);
        }
    }

    // Mark as active before run_script / status_calc_pc so script commands that
    // check sd->state.active (e.g. setriding, setarrow) execute correctly.
    sd->base_status.mode = static_cast<e_mode>(MD_CANMOVE | MD_CANATTACK);
    sd->state.active = 1;
    sd->state.pc_loaded = true;

    // Raise carry limit before status_calc_pc so setriding / setarrow do not fail.
    if (sd->max_weight <= 0 || sd->max_weight < 10000)
        sd->max_weight = 8000 + (sd->status.str * 300);

    // Shell inventories are inaccessible, so ammunition is a managed virtual
    // resource. Provision valid class/level ammunition through normal rAthena
    // equip validation; the same helper repairs it after future map changes.
    population_shell_prepare_ammo(sd);

    // Run the full Script: once to execute side-effect commands (setriding, setfalcon, etc.).
    if (init_script != nullptr)
        run_script(init_script, 0, sd->id, fake_nd->id);

    // Register the filtered Script: (side-effect commands stripped) as a persistent
    // bonus_script so bonus commands survive every future status_calc_pc call.
    if (pop_cfg != nullptr && !pop_cfg->bonus_script_str.empty()) {
        struct s_bonus_script_entry* bse = pc_bonus_script_add(
            sd,
            pop_cfg->bonus_script_str.c_str(),
            static_cast<t_tick>(86400000LL) * 365 * 10,  // ~10-year "permanent" duration
            EFST_BLANK,
            BSF_PERMANENT,
            0);
        if (bse != nullptr)
            linkdb_insert(&sd->bonus_script.head, (void*)((intptr_t)bse), bse);
    }

    // Single status_calc_pc: rebuilds item bonuses and re-runs all bonus_script entries.
    status_calc_pc(sd, SCO_NONE);

    // Restore full SP after recalc (base SP formula for shells is often 0).
    if (sd->battle_status.max_sp > 0) {
        sd->status.sp = sd->battle_status.max_sp;
        sd->battle_status.sp = sd->battle_status.max_sp;
    }

    // Re-check carry limit after recalc in case it was overwritten.
    if (sd->max_weight <= 0 || sd->max_weight < 10000)
        sd->max_weight = 8000 + (sd->status.str * 300);
    population_engine_sync_vd_weapon_shield(sd);
    sd->vd.look[LOOK_HEAD_TOP] = sd->status.head_top;
    sd->vd.look[LOOK_HEAD_MID] = sd->status.head_mid;
    sd->vd.look[LOOK_HEAD_BOTTOM] = sd->status.head_bottom;
    sd->vd.look[LOOK_ROBE] = sd->status.robe;

    if (returning) {
        const uint32 mount_options = OPTION_RIDING | OPTION_FALCON | OPTION_DRAGON
            | OPTION_WUG | OPTION_WUGRIDER | OPTION_MADOGEAR;
        pc_setoption(sd, (sd->sc.option & ~mount_options) | returning->option, MADO_ROBOT);
        sd->status.hair = sd->vd.look[LOOK_HAIR] = returning->hair;
        sd->status.hair_color = sd->vd.look[LOOK_HAIR_COLOR] = returning->hair_color;
        sd->status.clothes_color = sd->vd.look[LOOK_CLOTHES_COLOR] = returning->cloth_color;
    }

    // Elysium stress_test fake PCs: sync paper doll to the map before spawn so observers match stock AC shells.
    clif_changelook(sd, LOOK_BASE, sd->vd.look[LOOK_BASE]);
    clif_changelook(sd, LOOK_HAIR, sd->vd.look[LOOK_HAIR]);
    clif_changelook(sd, LOOK_HAIR_COLOR, sd->vd.look[LOOK_HAIR_COLOR]);
    clif_changelook(sd, LOOK_CLOTHES_COLOR, sd->vd.look[LOOK_CLOTHES_COLOR]);
    clif_changelook(sd, LOOK_WEAPON, sd->vd.look[LOOK_WEAPON]);
    clif_changelook(sd, LOOK_SHIELD, sd->vd.look[LOOK_SHIELD]);
    clif_changelook(sd, LOOK_HEAD_TOP, sd->vd.look[LOOK_HEAD_TOP]);
    clif_changelook(sd, LOOK_HEAD_MID, sd->vd.look[LOOK_HEAD_MID]);
    clif_changelook(sd, LOOK_HEAD_BOTTOM, sd->vd.look[LOOK_HEAD_BOTTOM]);
    clif_changelook(sd, LOOK_ROBE, sd->vd.look[LOOK_ROBE]);
    clif_changeoption(sd);

    if (!population_engine_combat_try_start(sd)) {
        population_engine_shell_release(sd);
        return nullptr;
    }

    clif_spawn(sd);

    // Store map category, spawn position, and resolved behavior for the combat tick.
    sd->pop.map_category = map_category;
    sd->pop.spawn_x      = static_cast<int16_t>(x);
    sd->pop.spawn_y      = static_cast<int16_t>(y);
    sd->pop.spawn_map_id = map_id;
    // RAGNAROKMAC: a mod vendor shell carries its spawn block (and seat) from the
    // start, so the mod pass counts it even if its stall fails to open.
    if (mod_entry != nullptr && mod_spawn != nullptr) {
        sd->pop.vendor_key      = mod_entry->key;
        sd->pop.vendor_spawn_id = mod_spawn->spawn_id;
        sd->pop.vendor_seat     = mod_seat;
    }

    // Resolve effective behavior: per-category override wins over the profile default.
    PopulationBehavior pe_beh = (pop_cfg != nullptr) ? pop_cfg->behavior : PopulationBehavior::Combat;
    if (pop_cfg != nullptr) {
        PopulationBehavior override_beh = PopulationBehavior::None;
        if (map_category == 1) override_beh = pop_cfg->town_behavior;
        else if (map_category == 2) override_beh = pop_cfg->field_behavior;
        else if (map_category == 3) override_beh = pop_cfg->dungeon_behavior;
        if (override_beh != PopulationBehavior::None)
            pe_beh = override_beh;
    }

    sd->pop.behavior = static_cast<uint8_t>(pe_beh);
    sd->pop.behavior_base = static_cast<uint8_t>(pe_beh);
    sd->pop.flags    = ((pop_cfg != nullptr) ? pop_cfg->flags : 0u) | PSF::CombatActive;
    sd->pop.role     = (pop_cfg != nullptr) ? static_cast<int8_t>(pop_cfg->role_type) : 0;
    sd->pop.db_source = static_cast<uint8_t>(db_source);
    sd->pop.arena_team = 0; // not in arena by default
    // Assign a per-map fake party ID so shells on the same map are treated as
    // party members by battle_check_target(BCT_PARTY).  This lets party-only
    // skills (CR_DEVOTION, PR_KYRIE on allies, etc.) cast between shells without
    // creating real party structs.  The ID is in the 0x70000000 range — far above
    // any char-server-allocated party ID — and is never saved or sent to a client.
    sd->status.party_id = static_cast<int32>(0x70000000u | static_cast<uint32>(static_cast<uint16>(sd->m)));

    if (pe_beh == PopulationBehavior::Combat || pe_beh == PopulationBehavior::Guard) {
        const PopulationCombatStartResult ac = population_engine_combat_start_session(sd, PopulationCombatStartMode::AutoCombat, -1, SCSTART_NOAVOID | SCSTART_LOADED);
        if (!ac.started) {
            ShowWarning("Population engine: population combat replica did not start for shell '%s' (reject=%s); bot will wander/chat only. "
                "With Behavior: combat/guard, skills and targeting come from db/autocombat_config.yml (not db/population_engine.yml).\n",
                sd->status.name, population_combat_reject_code_name(ac.reject_code));
        }
    }

    // Send equipment list to own client only (fake PCs usually have fd<=0).
    if (sd->fd > 0) {
        clif_equiplist(sd);
    }

    // Clear act/move locks so autocombat + wander timers can run immediately after spawn.
    sd->ud.canact_tick = 0;
    sd->ud.canmove_tick = 0;
    sd->ud.skilltimer = INVALID_TIMER;

	population_engine_register_shell_chat_state(sd, pop_cfg);
	if (pe_beh == PopulationBehavior::Combat    ||
	    pe_beh == PopulationBehavior::Wander    ||
	    pe_beh == PopulationBehavior::Support   ||
	    pe_beh == PopulationBehavior::Social)
		population_engine_register_shell_wander_state(sd);

	// Behavior-specific startup.
	if (pe_beh == PopulationBehavior::Sit) {
		pc_setsit(sd);
		clif_sitting(*sd);
	} else if (pe_beh == PopulationBehavior::Vendor) {
		pc_setsit(sd);
		clif_sitting(*sd);
		if (pop_cfg && !pop_cfg->vendor_message.empty())
			clif_messagecolor(sd, color_table[COLOR_YELLOW], pop_cfg->vendor_message.c_str(), false, AREA_WOS);

		// RAGNAROKMAC: a mod buyer opens a buying store instead of a stall.
		if (battle_config.population_engine_vending_enable && mod_entry != nullptr && mod_entry->buying) {
			sd->pop.vendor_buying = true;
			pop_shell_open_buyingstore(sd, *mod_entry);
		}
		// Vending economy: stock cart and open a real vend.
		else if (battle_config.population_engine_vending_enable) {
			// Look up optional per-job vendor config from population_vendors.yml.
			const PopulationVendorEntry *vendor_cfg = nullptr;
			if (pop_cfg && !pop_cfg->vendor_key.empty())
				vendor_cfg = population_vendor_db().find(pop_cfg->vendor_key);
			// RAGNAROKMAC: a mod vendor sells what its own entry says, whatever the
			// job or profile — several shells of one job can carry different stock.
			if (mod_entry != nullptr)
				vendor_cfg = mod_entry;

			// Determine vend title (TitleFromPool > vendor_cfg title > VendorMessage
			// > a random one of ours). RAGNAROKMAC: the stock fallback was the
			// literal "Shop", which is what most stalls end up showing because
			// most jobs have no vendor entry naming a title. TitleFromPool was
			// added so a single VendorKey can read as many different "players"
			// each with their own shop sign.
			const char *vend_title =
				POP_SHOP_TITLES[rnd() % ARRAYLENGTH(POP_SHOP_TITLES)];
			if (vendor_cfg && !vendor_cfg->title_pool.empty())
				vend_title = vendor_cfg->title_pool[rnd() % vendor_cfg->title_pool.size()].c_str();
			else if (vendor_cfg && !vendor_cfg->title.empty())
				vend_title = vendor_cfg->title.c_str();
			else if (pop_cfg && !pop_cfg->vendor_message.empty())
				vend_title = pop_cfg->vendor_message.c_str();
			// RAGNAROKMAC: {name} in a title is the shell's own name, so a sign like
			// "{name}'s Forge Goods" matches the player standing behind it. No
			// shipped title uses it, so stock titles are untouched.
			std::string vend_title_buf;
			if (strstr(vend_title, "{name}") != nullptr) {
				vend_title_buf = vend_title;
				population_engine_chat_replace_all(vend_title_buf, "{name}", std::string(sd->status.name));
				if (vend_title_buf.size() >= MESSAGE_SIZE)
					vend_title_buf.resize(MESSAGE_SIZE - 1);
				vend_title = vend_title_buf.c_str();
			}
			// RAGNAROKMAC: a mod vendor's sign is chosen once its stock is in the
			// cart (pop_mod_pick_title, below), so it never names what it lacks.

			// Build the stock list to use.
			// Priority: static vendor_cfg stock → dynamic (map mob drops) → built-in defaults.
			// RAGNAROKMAC: src points at the YAML line (refine/element/cards); null for
			// generated stock, which is always the plain item.
			struct TmpStock { t_itemid nameid; int16 amount; uint32_t price_override; const PopulationVendorStock* src = nullptr; };
			std::vector<TmpStock> stock;
			const int max_slots = vendor_cfg ? vendor_cfg->max_slots : 12;

			if (vendor_cfg && vendor_cfg->type == PopulationVendorType::Static && !vendor_cfg->stock.empty()) {
				// Static vending: use exactly the YAML-defined stock.
				for (const auto &vs : vendor_cfg->stock)
					stock.push_back({ vs.nameid, vs.amount,
						static_cast<uint32_t>(std::min<int64_t>(static_cast<int64_t>(vs.price) * pop_mod_vendor_price_pct(mod_entry) / 100, MAX_ZENY)), &vs });

			} else if (vendor_cfg && vendor_cfg->type == PopulationVendorType::Pool && !vendor_cfg->pool.empty()) {
				// RAGNAROKMAC: Pool vending. Pick pick_count distinct items from
				// the pool at random. Overfeed by 2x so pc_cart_additem rejections
				// (NoTrade / weight / equipment-slot conflicts) don't leave the
				// vend below pick_count — same approach the dynamic branch uses.
				const int pool_n = static_cast<int>(vendor_cfg->pool.size());
				int lo = vendor_cfg->pick_count_min > 0 ? vendor_cfg->pick_count_min : max_slots;
				int hi = vendor_cfg->pick_count_max > 0 ? vendor_cfg->pick_count_max : lo;
				if (hi < lo) hi = lo;
				int pick = hi > lo ? static_cast<int>(lo + (rnd() % (hi - lo + 1))) : lo;
				if (pick < 1) pick = 1;
				if (pick > max_slots) pick = max_slots;
				const int want = std::min(pool_n, pick * 2);

				// Fisher-Yates on an index vector; take the first `want` indices.
				std::vector<int> idx(pool_n);
				for (int i = 0; i < pool_n; ++i) idx[i] = i;
				for (int i = pool_n - 1; i > 0; --i) {
					const int j = static_cast<int>(rnd()) % (i + 1);
					if (j != i) std::swap(idx[i], idx[j]);
				}
				// RAGNAROKMAC: per-shell price variation. Each item's listed price
				// is rolled independently so two shells of the same vendor undercut
				// one another like a real market, and a rare "fat-finger" lists one
				// far too cheap (a dropped digit). A price of 0 means "use the item's
				// buy price", resolved later in the cart loop, so leave it untouched.
				const int jitter = vendor_cfg->price_jitter_pct;
				const int mistake_one_in = vendor_cfg->price_mistake_one_in;
				sd->pop.vendor_mistakes.clear();

				// RAGNAROKMAC: undercutting. The cheapest ask per plain item among
				// the other shell stalls on this map, built once per stall. Fat-
				// finger listings are left out, so one typo does not set the price.
				std::unordered_map<t_itemid, uint32_t> lowest;
				if (vendor_cfg->undercut_chance > 0) {
					for (map_session_data* osd : g_population_engine_pcs) {
						if (!osd || osd == sd || osd->m != sd->m || !osd->state.vending) continue;
						for (int vi = 0; vi < osd->vend_num; ++vi) {
							const int16 ci = osd->vending[vi].index;
							if (ci < 0 || ci >= MAX_CART) continue;
							const struct item& ct = osd->cart.u.items_cart[ci];
							if (ct.nameid == 0 || ct.refine != 0 || ct.card[0] != 0) continue;
							if (std::find(osd->pop.vendor_mistakes.begin(), osd->pop.vendor_mistakes.end(), ct.nameid) != osd->pop.vendor_mistakes.end()) continue;
							auto it = lowest.find(ct.nameid);
							if (it == lowest.end() || osd->vending[vi].value < it->second)
								lowest[ct.nameid] = osd->vending[vi].value;
						}
					}
				}

				// RAGNAROKMAC: the mod's price level (population_vendor_price).
				const int price_pct = pop_mod_vendor_price_pct(mod_entry);
				auto roll_price = [&](const PopulationVendorStock& vs) -> uint32_t {
					if (vs.price == 0) return 0;
					int64_t p, band_lo;
					if (vs.price_max > 0) {
						// Price: [min, max] — roll in the range.
						band_lo = vs.price;
						p = vs.price + static_cast<int64_t>(rnd() % (vs.price_max - vs.price + 1));
					} else {
						p = vs.price;
						band_lo = jitter > 0 ? p * (100 - jitter) / 100 : p;
						if (jitter > 0) {
							const int factor = (100 - jitter) + static_cast<int>(rnd() % (2 * jitter + 1));
							p = p * factor / 100;
						}
					}
					if (price_pct != 100) {
						p = p * price_pct / 100;
						band_lo = band_lo * price_pct / 100;
					}
					// RAGNAROKMAC: and the item's own price percentage, if its mod set one.
					if (const int item_pct = pop_item_price_pct(vs.nameid); item_pct != 100) {
						p = p * item_pct / 100;
						band_lo = band_lo * item_pct / 100;
					}
					const bool plain = vs.refine_max == 0 && vs.element == 0 && vs.stars == 0 && vs.cards.empty();
					if (plain && vendor_cfg->undercut_chance > 0 &&
					    static_cast<int>(rnd() % 100) < vendor_cfg->undercut_chance) {
						auto it = lowest.find(vs.nameid);
						if (it != lowest.end()) {
							const int lo_s = vendor_cfg->undercut_step_min, hi_s = vendor_cfg->undercut_step_max;
							const int step = lo_s + static_cast<int>(rnd() % static_cast<uint32_t>(hi_s - lo_s + 1));
							const int64_t under = static_cast<int64_t>(it->second) * (100 - step) / 100;
							if (under < p) p = under;
						}
					}
					// Round to a tidy figure players would actually type.
					if (p >= 10000)     p = p / 500 * 500;
					else if (p >= 1000) p = p / 50 * 50;
					else if (p >= 100)  p = p / 5 * 5;
					// Never below its own range, and never so low that selling it on
					// to an NPC turns a profit.
					if (p < band_lo) p = band_lo;
					if (std::shared_ptr<item_data> pid = item_db.find(vs.nameid))
						if (p <= static_cast<int64_t>(pid->value_sell)) p = pid->value_sell + 1;
					// Fat-finger: a very rare dropped digit, left un-rounded so it
					// reads like a genuine mistake. The one price allowed under the
					// NPC floor: that is the jackpot.
					if (mistake_one_in > 0 && (rnd() % static_cast<uint32_t>(mistake_one_in)) == 0) {
						p /= 10;
						sd->pop.vendor_mistakes.push_back(vs.nameid);
					}
					if (p < 1) p = 1;
					if (p > MAX_ZENY) p = MAX_ZENY;
					return static_cast<uint32_t>(p);
				};
				for (int i = 0; i < want; ++i) {
					const auto &vs = vendor_cfg->pool[idx[i]];
					stock.push_back({ vs.nameid, vs.amount, roll_price(vs), &vs });
				}

				// Fallthrough to built-in defaults is undesirable for Pool: an
				// empty pool is a config error, not a reason to serve potions.
				if (stock.empty())
					vendor_cfg = nullptr;

			} else if (vendor_cfg && vendor_cfg->type == PopulationVendorType::Dynamic) {
				// Dynamic vending: derive saleable items from mob drop tables across one or
				// more *source* maps (NOT the spawn map — towns have empty moblist[]).
				// Map selection priority:
				//   1) explicit SourceMaps list
				//   2) auto-discovery from population_spawn_db() filtered by SourceCategory
				//   3) legacy: spawn map only
				//
				// Both the source-map list and the per-map drop pool are cached in
				// g_pop_vendor_dyn_cache (cleared on YAML reload). This avoids
				// re-walking every map's moblist on every shell spawn.
				const uint32_t pct = vendor_cfg->price_multiplier;
				using DropEntry = PopVendorDropEntry;
				std::vector<DropEntry> drop_pool;
				std::unordered_map<t_itemid, uint32_t> seen;

				std::vector<int16> source_mids;
				{
					PopVendorCacheBucket &bucket = g_pop_vendor_dyn_cache[vendor_cfg->key];
					if (!bucket.source_mids_built) {
						if (!vendor_cfg->source_maps.empty()) {
							for (const std::string& mn : vendor_cfg->source_maps) {
								const int16 mid = map_mapname2mapid(mn.c_str());
								if (mid >= 0) bucket.source_mids.push_back(mid);
							}
						} else if (!vendor_cfg->source_category.empty()) {
							const bool want_dungeons = (vendor_cfg->source_category == "dungeon" || vendor_cfg->source_category == "both");
							const bool want_fields   = (vendor_cfg->source_category == "field"   || vendor_cfg->source_category == "both");
							std::unordered_set<int16> seen_mids;
							for (auto sit = population_spawn_db().begin(); sit != population_spawn_db().end(); ++sit) {
								if (!sit->second) continue;
								const PopulationSpawnEntry &se = *sit->second;
								auto add = [&](const std::vector<std::string> &maps) {
									for (const std::string &mn : maps) {
										const int16 mid = map_mapname2mapid(mn.c_str());
										if (mid >= 0 && seen_mids.insert(mid).second)
											bucket.source_mids.push_back(mid);
									}
								};
								if (want_dungeons) add(se.dungeons);
								if (want_fields)   add(se.fields);
							}
						} else {
							bucket.source_mids.push_back(sd->m); // legacy: spawn map only
						}
						bucket.source_mids_built = true;
					}
					source_mids = bucket.source_mids; // copy out; release lock below
				}

				// RandomizePerShell: shuffle the source list so each shell starts
				// from a different "primary" map. We still walk additional maps
				// (in shuffled order) until drop_pool reaches max_slots, so a
				// dungeon with few drops is topped up from sibling dungeons.
				if (vendor_cfg->randomize_per_shell && source_mids.size() > 1) {
					for (size_t i = source_mids.size() - 1; i > 0; --i) {
						const size_t j = static_cast<size_t>(rnd()) % (i + 1);
						std::swap(source_mids[i], source_mids[j]);
					}
				}

				// Helper: build (or fetch from cache) the drop pool for one source map.
				auto get_mid_pool = [&](int16 src_mid) -> const std::vector<DropEntry>& {
					PopVendorCacheBucket &bucket = g_pop_vendor_dyn_cache[vendor_cfg->key];
					auto it = bucket.drops_by_mid.find(src_mid);
					if (it != bucket.drops_by_mid.end()) return it->second;
					std::vector<DropEntry> built;
					struct map_data *src_map = map_getmapdata(src_mid);
					if (src_map) {
						std::unordered_map<t_itemid, uint32_t> local_seen;
						for (int i = 0; i < MAX_MOB_LIST_PER_MAP; ++i) {
							if (!src_map->moblist[i]) continue;
							const int16 mob_id = src_map->moblist[i]->id;
							if (mob_id <= 0) continue;
							auto mdb = mob_db.find(static_cast<uint32>(mob_id));
							if (!mdb) continue;
							for (const auto &drop : mdb->dropitem) {
								if (!drop || drop->nameid == 0) continue;
								auto idata = item_db.find(drop->nameid);
								if (!idata) continue;
								// Apply ItemFlags filters at cache time (filters are part of the vendor key).
								const bool is_equip = (idata->equip != 0);
								if (is_equip && !vendor_cfg->allow_equipment) continue;
								if (idata->type == IT_CARD       && !vendor_cfg->allow_cards)  continue;
								if (idata->type == IT_ETC        && !vendor_cfg->allow_etc)    continue;
								if ((idata->type == IT_HEALING ||
								     idata->type == IT_USABLE  ||
								     idata->type == IT_DELAYCONSUME) && !vendor_cfg->allow_usable) continue;
								auto sit2 = local_seen.find(drop->nameid);
								if (sit2 == local_seen.end()) {
									local_seen[drop->nameid] = drop->rate;
									built.push_back({ drop->nameid, drop->rate });
								} else if (drop->rate > sit2->second) {
									sit2->second = drop->rate;
								}
							}
						}
					}
					auto inserted = bucket.drops_by_mid.emplace(src_mid, std::move(built));
					return inserted.first->second;
				};

				// Aggregate drops from selected source maps (cached lookups).
				// We collect ~6x max_slots so the "top by drop rate" sort below
				// has a meaningful pool to pick from AND the 2x overflow stock
				// builder still has spares after rate-sorting. When randomize_
				// per_shell is set, source_mids was shuffled above so the primary
				// dungeon contributes first and siblings only top-up the deficit.
				const size_t collect_target = static_cast<size_t>(std::max(max_slots * 6, 60));
				for (int16 src_mid : source_mids) {
					if (drop_pool.size() >= collect_target) break;
					const std::vector<DropEntry> &mid_pool = get_mid_pool(src_mid);
					for (const auto &de : mid_pool) {
						if (drop_pool.size() >= collect_target) break;
						auto sit2 = seen.find(de.nameid);
						if (sit2 == seen.end()) {
							seen[de.nameid] = de.rate;
							drop_pool.push_back(de);
						} else if (de.rate > sit2->second) {
							sit2->second = de.rate;
						}
					}
				}

				// Sort by drop rate descending, take best max_slots items.
				std::sort(drop_pool.begin(), drop_pool.end(),
					[](const DropEntry &a, const DropEntry &b) { return a.rate > b.rate; });

				// MaxAmount: optional [lo,hi] range to randomize per-item stack size.
				const int dyn_lo = vendor_cfg->dyn_amount_min > 0 ? vendor_cfg->dyn_amount_min : 30;
				const int dyn_hi = vendor_cfg->dyn_amount_max > 0 ? vendor_cfg->dyn_amount_max : 30;

				// Produce a 2x overflow so the cart-add loop below has spares
				// when pc_cart_additem rejects items (NoTrade / NoCart / equipment
				// type restrictions / etc.). Without overflow a vend that loses
				// even one item to a failed add ends up below MaxSlots.
				const int stock_cap = max_slots * 2;
				int count = 0;
				for (const auto &de : drop_pool) {
					if (count >= stock_cap) break;
					auto idata = item_db.find(de.nameid);
					const uint32_t sell_val = idata ? static_cast<uint32_t>(idata->value_sell) : 0;
					const uint32_t price = std::max<uint32_t>(1, sell_val * pct / 100);
					int16 amt;
					if (idata && idata->equip != 0) {
						amt = 1; // equipment is non-stackable
					} else if (dyn_hi > dyn_lo) {
						amt = static_cast<int16>(dyn_lo + (rnd() % (dyn_hi - dyn_lo + 1)));
					} else {
						amt = static_cast<int16>(dyn_lo);
					}
					stock.push_back({ de.nameid, amt, price });
					++count;
				}
				// Fallthrough to built-in defaults if no source maps resolved any drops.
				if (stock.empty())
					vendor_cfg = nullptr; // force built-in below

			}

			if (!vendor_cfg || stock.empty()) {
				// Built-in default consumable stock.
				static const TmpStock kDefaultStock[] = {
					{ 501, 100, 0 },  // Red Potion
					{ 502, 100, 0 },  // Orange Potion
					{ 503,  50, 0 },  // Yellow Potion
					{ 504,  30, 0 },  // White Potion
					{ 506,  50, 0 },  // Green Potion
					{ 601,  50, 0 },  // Wing of Fly
					{ 602,  30, 0 },  // Wing of Butterfly
					{ 605,  50, 0 },  // Anodyne
					{ 606,  50, 0 },  // Aloevera
					{ 645,  20, 0 },  // Concentration Potion
					{ 656,  20, 0 },  // Awakening Potion
				};
				for (const auto &s : kDefaultStock)
					stock.push_back(s);
			}

			// Grant MC_VENDING and cart.
			pc_skill(sd, MC_VENDING, 10, ADDSKILL_PERMANENT_GRANTED);
			pc_setcart(sd, 1);

			// Population vendor bots are virtual — they never move, never trade beyond
			// their initial vend, and don't compete with real players for inventory.
			// The default cart_weight_max (battle_config.max_cart_weight, typically
			// 8000) is the *real cause* of vendors stocking < MaxSlots items: a
			// dynamic vendor with MaxAmount: [1, 30000] can produce stacks weighing
			// hundreds of thousands of units, so after 1–2 items pc_cart_additem
			// returns ADDITEM_OVERWEIGHT for everything else. Lift the cap here so
			// the cart can hold all max_slots stacks regardless of MaxAmount/weight.
			// (status_calc_pc may later reset this from battle_config, but the cart-
			// add loop runs synchronously here so the items are already inserted.)
			sd->cart_weight_max = INT32_MAX;

			// Stock cart and build vending data.
			int vend_count = 0;
			uint8 vend_data[MAX_VENDING * 8];
			memset(vend_data, 0, sizeof(vend_data));

			for (const auto &vs : stock) {
				if (vend_count >= max_slots) break;

				std::shared_ptr<item_data> id = item_db.find(vs.nameid);
				if (!id) continue;

				// Equipment is non-stackable: only 1 unit can occupy a cart slot,
				// so cap amount to 1 to avoid failed pc_cart_additem or bogus vend counts.
				const bool is_equip = (id->equip != 0);
				const int16 slot_amount = is_equip ? 1 : static_cast<int16>(vs.amount);

				struct item tmp_item = {};
				tmp_item.nameid = vs.nameid;
				tmp_item.amount = 1;
				tmp_item.identify = 1;
				// RAGNAROKMAC: refine, forged element or cards from the YAML line.
				if (vs.src != nullptr && is_equip) {
					const PopulationVendorStock& src = *vs.src;
					if (src.refine_max > 0)
						tmp_item.refine = static_cast<uint8>(src.refine_max > src.refine_min
							? src.refine_min + rnd() % (src.refine_max - src.refine_min + 1)
							: src.refine_min);
					if (src.element != 0 || src.stars != 0) {
						// Same layout as a Blacksmith's forge (skill_produce_mix), signed
						// by this shell, so the client names it "<shell>'s Fire Stiletto".
						tmp_item.card[0] = CARD0_FORGE;
						tmp_item.card[1] = static_cast<t_itemid>(((src.stars * 5) << 8) + src.element);
						tmp_item.card[2] = GetWord(sd->status.char_id, 0);
						tmp_item.card[3] = GetWord(sd->status.char_id, 1);
					} else {
						for (size_t ci = 0; ci < src.cards.size() && ci < MAX_SLOTS; ++ci)
							tmp_item.card[ci] = src.cards[ci];
					}
				}
				if (pc_cart_additem(sd, &tmp_item, slot_amount, LOG_TYPE_NONE) != ADDITEM_SUCCESS)
					continue;

				// Find the slot holding exactly this item: two lines may share an
				// item id with different refines or cards.
				int cart_idx = -1;
				for (int ci = 0; ci < MAX_CART; ci++) {
					const struct item& ct = sd->cart.u.items_cart[ci];
					if (ct.nameid == tmp_item.nameid && ct.refine == tmp_item.refine &&
					    ct.card[0] == tmp_item.card[0] && ct.card[1] == tmp_item.card[1] &&
					    ct.card[2] == tmp_item.card[2] && ct.card[3] == tmp_item.card[3]) {
						cart_idx = ci;
						break;
					}
				}
				if (cart_idx < 0) continue;

				// price_override 0 = use item buy price (prevents sell-back arbitrage).
				const uint32 price = vs.price_override > 0
					? vs.price_override
					: static_cast<uint32>(id->value_buy > 0 ? id->value_buy : 100);
				*(uint16*)(vend_data + vend_count * 8 + 0) = static_cast<uint16>(cart_idx + 2);
				*(uint16*)(vend_data + vend_count * 8 + 2) = static_cast<uint16>(slot_amount);
				*(uint32*)(vend_data + vend_count * 8 + 4) = price;
				vend_count++;
			}

			if (vend_count > 0) {
				// RAGNAROKMAC: a mod stall's sign, from what it actually opened with.
				if (mod_entry != nullptr) {
					std::vector<std::pair<t_itemid, uint32_t>> sold;
					for (int vi = 0; vi < vend_count; ++vi) {
						const int ci = *(uint16*)(vend_data + vi * 8 + 0) - 2;
						if (ci < 0 || ci >= MAX_CART)
							continue;
						const t_itemid nameid = sd->cart.u.items_cart[ci].nameid; // packed: copy out
						const uint32_t price = *(uint32*)(vend_data + vi * 8 + 4);
						sold.emplace_back(nameid, price);
					}
					vend_title_buf = pop_mod_pick_title(sd, *mod_entry, sold, std::string(vend_title), false);
					vend_title = vend_title_buf.c_str();
				}
				sd->state.prevend = 1;
				vending_openvending(*sd, vend_title, vend_data, vend_count, nullptr);

				// RAGNAROKMAC: Pool vendors with RotationHours > 0 get a per-shell
				// expiry. The vendor rotation timer walks shells periodically and
				// releases those whose tick has passed; the autosummon pass then
				// re-fills with a fresh pool pick + title + name. Jitter spreads
				// the respawns in time so a Prontera full of ten vendors doesn't
				// vanish and reappear in lockstep.
				int rotation_sec = vendor_cfg ? vendor_cfg->rotation_sec : 0;
				// RAGNAROKMAC: a mod vendor's rotation may come from its mod's settings.
				if (mod_entry != nullptr)
					if (const PopModVendorSettings* st = pop_mod_vendor_settings_for_key(mod_entry->key))
						if (st->rotation_min >= 0)
							rotation_sec = st->rotation_min * 60;
				if (vendor_cfg && rotation_sec > 0) {
					int jitter = vendor_cfg->rotation_jitter_sec;
					if (jitter > rotation_sec / 2) jitter = rotation_sec / 2; // a short rotation keeps its jitter in proportion
					int offset = 0;
					if (jitter > 0)
						offset = static_cast<int>(rnd() % (jitter * 2 + 1)) - jitter;
					int lifetime = rotation_sec + offset;
					if (lifetime < 60) lifetime = 60; // one-minute floor; a negative jitter must not kill newborn shells
					sd->pop.vendor_rotation_at = gettick() + static_cast<t_tick>(lifetime) * 1000;
				}
			}
		}
	}

    return sd;
}

// RAGNAROKMAC (Goal 1) ----------------------------------------------------------
// Companion persistence. A recruited companion is snapshotted into
// cp_companion_persistence so it survives a server restart. Recall re-runs
// population_engine_spawn_shell with the persisted identity index + exact
// appearance/equipment; pop_cfg=nullptr still grants the full job skill tree
// (abilities maxed out). Snapshot stats are restored and remaining equip slots
// (armor/shoes/acc) re-equipped via shell_equip_item. Release-marking ships in
// Goal 3 (sets active=0); until then every row is recalled on the owner's login.

/// Escape a companion name for a query. The name is cut to NAME_LENGTH - 1 first, so the
/// output always fits `out` (escaping can double every byte) whatever length the caller
/// passed: @companion's argument is wider than a name, so the commands can carry a trailing
/// word, and a name typed too long must miss rather than overrun a buffer.
static void pop_escape_name(char (&out)[NAME_LENGTH * 2 + 1], const char *name)
{
	char bounded[NAME_LENGTH];
	safestrncpy(bounded, name != nullptr ? name : "", sizeof(bounded));
	Sql_EscapeString(mmysql_handle, out, bounded);
}

static void population_engine_persist_companion_sql(
	uint32_t owner_account, uint32_t owner_char, uint32_t index_, const char* name_, int16_t job_id, int sex,
	int hair_style, int hair_color, int cloth_color, uint32_t garment_nameid,
	uint32_t option_, uint32_t weapon, uint32_t shield, uint32_t head_top,
	uint32_t head_mid, uint32_t head_bottom, uint32_t armor, uint32_t shoes,
	uint32_t acc_l, uint32_t acc_r,
	int base_level, int job_level, int str, int agi, int vit, int intl,
	int dex, int luk, int pow_, int sta_, int wis_, int spl_, int con_, int crt_, int16_t map_id)
{
	if (mmysql_handle == nullptr) return;
	char q[4096];
	char esc_name[NAME_LENGTH * 2 + 1];
	pop_escape_name(esc_name, name_);
	// sex is TINYINT in the DDL (0=SEX_MALE, 1=SEX_FEMALE); writing the letters
	// 'M'/'F' was rejected with ERROR 1366 on strict servers.
	//
	// INSERT ... ON DUPLICATE KEY UPDATE, not REPLACE: REPLACE deletes the old row and inserts
	// a new one, so re-inviting a companion that already has a row (expelled, then invited
	// again) reset everything this statement does not list - the player's skill selection,
	// the homunculus switch and the pet's level, favorite, stance, duty and heal thresholds.
	// Those are kept for the same owner CHARACTER and reset only when the row changes hands
	// (a row with owner_char_id 0 predates per-character ownership and counts as this
	// account's). The assignments run left to right, so the owner comparisons come before
	// the owner columns are overwritten. Costume and shadow slots are left to the gear snapshot.
	const int written = snprintf(q, sizeof(q),
		"INSERT INTO `cp_companion_persistence`"
		"(owner_account_id, owner_char_id, shell_index, name, job_id, sex, hair_style, hair_color,"
		" cloth_color, garment_nameid, option_, weapon_nameid, shield_nameid,"
		" head_top_nameid, head_mid_nameid, head_bottom_nameid, armor_nameid,"
		" shoes_nameid, acc_l_nameid, acc_r_nameid, costume_top_nameid,"
		" costume_mid_nameid, costume_low_nameid, costume_garment_nameid,"
		" shadow_armor_nameid, shadow_weapon_nameid, shadow_shield_nameid,"
		" shadow_shoes_nameid, shadow_acc_l_nameid, shadow_acc_r_nameid,"
		" base_level, job_level, str_,"
		" agi_, vit_, intl_, dex_, luk_, pow_, sta_, wis_, spl_, con_, crt_, map_id, active)"
		" VALUES(%u,%u,%u,'%s',%d,%d,%d,%d,%d,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,"
		"%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%d,%d,"
		"%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,1)"
		" ON DUPLICATE KEY UPDATE"
		" skill_preset=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), skill_preset, NULL),"
		" hom_enabled=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), hom_enabled, NULL),"
		" hom_class=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), hom_class, 0),"
		" hom_level=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), hom_level, 0),"
		" hom_exp=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), hom_exp, 0),"
		" favorite=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), favorite, 0),"
		" mode=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), mode, 1),"
		" duty=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), duty, 0),"
		" heal_at=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), heal_at, 75),"
		" emergency_at=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), emergency_at, 35),"
		" rest_below=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), rest_below, 30),"
		" rest_until=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), rest_until, 95),"
		" given_mask=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), given_mask, 0),"
		" gear_detail=IF(owner_account_id=VALUES(owner_account_id) AND owner_char_id IN (0, VALUES(owner_char_id)), gear_detail, NULL),"
		" owner_account_id=VALUES(owner_account_id), owner_char_id=VALUES(owner_char_id),"
		" name=VALUES(name), job_id=VALUES(job_id),"
		" sex=VALUES(sex), hair_style=VALUES(hair_style), hair_color=VALUES(hair_color),"
		" cloth_color=VALUES(cloth_color), garment_nameid=VALUES(garment_nameid),"
		" option_=VALUES(option_), weapon_nameid=VALUES(weapon_nameid),"
		" shield_nameid=VALUES(shield_nameid), head_top_nameid=VALUES(head_top_nameid),"
		" head_mid_nameid=VALUES(head_mid_nameid), head_bottom_nameid=VALUES(head_bottom_nameid),"
		" armor_nameid=VALUES(armor_nameid), shoes_nameid=VALUES(shoes_nameid),"
		" acc_l_nameid=VALUES(acc_l_nameid), acc_r_nameid=VALUES(acc_r_nameid),"
		" base_level=VALUES(base_level), job_level=VALUES(job_level), str_=VALUES(str_),"
		" agi_=VALUES(agi_), vit_=VALUES(vit_), intl_=VALUES(intl_), dex_=VALUES(dex_),"
		" luk_=VALUES(luk_), pow_=VALUES(pow_), sta_=VALUES(sta_), wis_=VALUES(wis_),"
		" spl_=VALUES(spl_), con_=VALUES(con_), crt_=VALUES(crt_), map_id=VALUES(map_id),"
		" active=1",
		owner_account, owner_char, index_, esc_name, job_id, sex, hair_style, hair_color, cloth_color,
		garment_nameid, option_, weapon, shield, head_top, head_mid, head_bottom,
		armor, shoes, acc_l, acc_r, 0u, 0u, 0u, 0u,
		0u, 0u, 0u, 0u, 0u, 0u,
		base_level, job_level, str, agi, vit, intl, dex, luk,
		pow_, sta_, wis_, spl_, con_, crt_, map_id);
	if (written <= 0 || static_cast<size_t>(written) >= sizeof(q)) {
		ShowError("population_engine: persist companion index %u: statement does not fit\n", index_);
		return;
	}
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		ShowError("population_engine: persist companion index %u for owner %u FAILED\n",
			index_, owner_account);
		return;
	}
	ShowInfo("population_engine: persisted companion index %u for owner %u (map id %d)\n",
		index_, owner_account, map_id);
}

/// Create (or refresh) this companion's persistence row: identity, appearance,
/// current equipment, stats, traits and map.
///
/// This is the ONLY row-creating path. persist_companion_gear() is the recurring
/// UPDATE that maintains an existing row, so a caller that reaches for it before
/// the row exists silently does nothing - which is how a drafted companion ended up
/// invisible to @companion list despite walking and fighting normally.
///
/// @return true when the row was written.
bool population_engine_persist_companion_row(map_session_data *sd, const map_session_data *owner)
{
	if (!sd || !sd->state.active || owner == nullptr || owner->status.account_id == 0
		|| population_engine_is_population_pc(owner->id))
		return false;
	if (sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE)
		return false;
	// The recruiting CHARACTER owns it, in memory and in the row.
	pop_companion_set_owner(sd, owner);
	const uint32_t index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;

	uint32_t weapon = 0, shield = 0, armor = 0, shoes = 0, acc_l = 0, acc_r = 0;
	// The headgear and garment columns were written from status.head_* and status.robe, which
	// hold each piece's LOOK: Elven Ears saved as 73, a cape without a look as 0. Recall rebuilt
	// those slots from the numbers, so they came back as nothing. The worn items go in instead.
	uint32_t head_top = 0, head_mid = 0, head_low = 0, garment = 0;
	for (int16_t i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = sd->inventory.u.items_inventory[i];
		if (!slot.nameid || !slot.equip) continue; // equipped only
		if ((slot.equip & EQP_HAND_R) && !(slot.equip & EQP_SHADOW_WEAPON))  weapon  = slot.nameid;
		else if ((slot.equip & EQP_HAND_L) && !(slot.equip & EQP_SHADOW_SHIELD)) shield = slot.nameid;
		else if (slot.equip & EQP_ARMOR)                                          armor  = slot.nameid;
		else if (slot.equip & EQP_SHOES)                                          shoes  = slot.nameid;
		else if (slot.equip & EQP_ACC_L)                                          acc_l  = slot.nameid;
		else if (slot.equip & EQP_ACC_R)                                          acc_r  = slot.nameid;
		else if (slot.equip & EQP_GARMENT)                                        garment = slot.nameid;
		else if (slot.equip & EQP_HEAD_TOP)                                       head_top = slot.nameid; // a hat over top and mid too
		else if (slot.equip & EQP_HEAD_MID)                                       head_mid = slot.nameid;
		else if (slot.equip & EQP_HEAD_LOW)                                       head_low = slot.nameid;
	}

	population_engine_persist_companion_sql(
		owner->status.account_id, owner->status.char_id, index_, sd->status.name, (int16_t)sd->status.class_, (int)sd->status.sex,
		(int)sd->status.hair, (int)sd->status.hair_color, (int)sd->status.clothes_color,
		garment, sd->status.option, weapon, shield,
		head_top, head_mid, head_low,
		armor, shoes, acc_l, acc_r, (int)sd->status.base_level, (int)sd->status.job_level, (int)sd->status.str,
		(int)sd->status.agi, (int)sd->status.vit, (int)sd->status.int_, (int)sd->status.dex, (int)sd->status.luk,
		(int)sd->status.pow, (int)sd->status.sta, (int)sd->status.wis, (int)sd->status.spl, (int)sd->status.con, (int)sd->status.crt,
		(int16_t)sd->m);
	return true;
}

// Goal 2 (trade): returns true when `target` is a population shell that belongs
// to `player` and is summoned — i.e. a trade request from `player` may be
// auto-accepted on the shell's behalf. Also checks same-map + distance.
bool population_engine_companion_can_trade_with(const map_session_data *player, const map_session_data *target)
{
	if (!player || !target) return false;
	if (!population_engine_is_population_pc(target->id)) return false;
	if (!pop_companion_owned_by(target, player)) return false;
	if (!target->state.active || target->prev == nullptr) return false;
	if (map_id2bl(target->id) != target) return false;
	if (target->m != player->m) return false;
	// Same proximity rule rathena uses for player trades.
	if (!check_distance_bl(player, target, 2)) return false; // trade.cpp's TRADE_DISTANCE
	return true;
}

/// Positions a companion is wearing player-given gear in: the given mask, narrowed to what is
/// actually worn so a stale bit (an item broken or unequipped by stock code) never matters.
static uint32_t pop_companion_given_worn(const map_session_data *shell)
{
	uint32_t worn = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = shell->inventory.u.items_inventory[i];
		if (slot.nameid && slot.equip && (slot.equip & shell->pop.companion_given_mask))
			worn |= slot.equip;
	}
	return worn;
}

/// Move one inventory entry from a companion to its owner: into the owner's bag, or onto the
/// ground at the owner's feet when the bag will not take it. Never deleted - the item was the
/// player's, and "inventory full" is not a reason for it to stop existing. Returns false (and
/// leaves the item on the companion) only when it could neither be carried nor dropped.
static bool pop_companion_hand_back(map_session_data *owner, map_session_data *shell, int16 i,
	e_log_pick_type log_type, int32 amount)
{
	struct item &slot = shell->inventory.u.items_inventory[i];
	if (!slot.nameid || slot.amount <= 0)
		return false;
	const uint32_t worn = slot.equip;
	if (worn && !pc_unequipitem(shell, i, 2))
		return false;
	shell->pop.companion_given_mask &= ~worn;
	struct item tmp = slot;
	tmp.equip = 0;
	// 0 = the whole stack. A trade passes what it added: the rest of the stack is the
	// companion's own (its potions).
	amount = (amount <= 0 || amount > slot.amount) ? slot.amount : amount;
	if (pc_additem(owner, &tmp, amount, log_type) != ADDITEM_SUCCESS
		&& map_addflooritem(&tmp, amount, owner->m, owner->x, owner->y, 0, 0, 0, 0, 0) == 0) {
		ShowWarning("population_engine: could not return item %u from companion %u to owner %u; "
			"it stays on the companion\n", tmp.nameid, shell->status.char_id, owner->status.account_id);
		return false;
	}
	pc_delitem(shell, i, amount, 0, 1, log_type);
	return true;
}

// Goal 2 (trade): after traded equipment lands in the companion's inventory,
// equip every equip-flagged item immediately (the owner gave it to be worn).
// Items without equip flags (consumables etc) are returned to the owner —
// companions are gear carriers, not mules.
void population_engine_companion_trade_snapshot(map_session_data *shell)
{
	if (!shell || !population_engine_is_population_pc(shell->id)) return;
	auto &before = shell->pop.companion_trade_before;
	before.assign(MAX_INVENTORY, {0, 0});
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = shell->inventory.u.items_inventory[i];
		before[i] = {static_cast<uint32_t>(slot.nameid), static_cast<int32_t>(slot.amount)};
	}
}

void population_engine_companion_equip_traded(map_session_data *owner, map_session_data *shell)
{
	if (!owner || !shell) return;
	// RAGNAROKMAC: act only on what this trade brought in: a new item in a slot, or a stack that
	// grew. A companion's bag also holds its own things - spare stacks of every arrow it stocks,
	// and its own gear a traded piece pushed off - and treating those as traded equipped each
	// spare stack as the player's and handed the last one to the player, thousands of arrows
	// and the companion's Ballista onto a full bag and the floor. With no snapshot (trade.cpp
	// without the hook), every unworn item counts, as before.
	std::vector<std::pair<uint32_t, int32_t>> before;
	before.swap(shell->pop.companion_trade_before);
	auto traded = [&before, shell](int16 i) {
		if (before.size() != static_cast<size_t>(MAX_INVENTORY))
			return true;
		const struct item &it = shell->inventory.u.items_inventory[i];
		return static_cast<uint32_t>(it.nameid) != before[i].first || static_cast<int32_t>(it.amount) > before[i].second;
	};
	bool equipped_any = false;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		struct item &slot = shell->inventory.u.items_inventory[i];
		if (!slot.nameid || slot.equip) continue;
		if (!traded(i)) continue;
		struct item_data *id = itemdb_search(slot.nameid);
		if (!id) continue;
		if (id->equip) {
			// Player gear this piece pushes off goes back to the player: the companion's
			// inventory is not persisted, so an item left there is gone at the next restart.
			std::vector<int16> given_before;
			for (int16 j = 0; j < MAX_INVENTORY; ++j) {
				const struct item &w = shell->inventory.u.items_inventory[j];
				if (w.nameid && w.equip && (w.equip & shell->pop.companion_given_mask))
					given_before.push_back(j);
			}
			if (pc_equipitem(shell, i, id->equip, false) && slot.equip) {
				shell->pop.companion_given_mask |= slot.equip;
				equipped_any = true;
			}
			for (int16 j : given_before) {
				if (shell->inventory.u.items_inventory[j].equip == 0)
					(void)pop_companion_hand_back(owner, shell, j, LOG_TYPE_TRADE);
			}
			shell->pop.companion_given_mask = pop_companion_given_worn(shell);
		} else {
			// Non-equipment goes back: into the owner's bag, or at their feet when it is full.
			// Only what the trade added: a potion of the kind the companion carries stacks
			// onto its own, and handing back the whole stack gave the player those too.
			const bool grew = before.size() == static_cast<size_t>(MAX_INVENTORY)
				&& static_cast<uint32_t>(slot.nameid) == before[i].first;
			(void)pop_companion_hand_back(owner, shell, i, LOG_TYPE_TRADE,
				grew ? slot.amount - before[i].second : 0);
		}
	}
	if (equipped_any)
		ShowInfo("population_engine: companion %u equipped traded gear\n", shell->status.char_id);
	// Write the companion's half now rather than on the next gear poll: trade_tradecommit saves
	// the owner's half straight after this, and a crash between two saves seconds apart is how
	// an item ends up on neither side.
	population_engine_persist_companion_gear(shell);
}

// Goal 2 (gear return): unequip every worn item on the shell and hand each
// piece to the owner. Used by @companion gear <name> so the player can take
// equipment back without hunting it in a trade window. Items are MOVED, not
// duplicated: each is removed from the shell's inventory (pc_unequipitem
// clears the equip bit, then pc_delitem removes the slot) and handed to the
// owner via pc_additem. On inventory-full the piece is dropped at the
// owner's feet instead of being lost.
/// Every position something is worn in, given or own.
static uint32_t pop_companion_worn_positions(const map_session_data *shell)
{
	uint32_t worn = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = shell->inventory.u.items_inventory[i];
		if (slot.nameid && slot.equip)
			worn |= slot.equip;
	}
	return worn;
}

/// RAGNAROKMAC: after given gear comes back, put the companion's own gear back on in the
/// positions it left empty. Gear a player trades in pushes the companion's own piece off into
/// its bag (a Minstrel's Ballista, for an instrument), and nothing put it back, so the
/// companion fought on with the slot empty. The pushed-off piece goes back on first. The bag is
/// not persisted, so after a restart it may be gone: a position still empty then gets a piece
/// from the job's gear set, the same picks spawn and job advance use.
static void pop_companion_reequip_own(map_session_data *shell, uint32_t freed)
{
	for (int16 i = 0; i < MAX_INVENTORY && freed != 0; ++i) {
		const struct item &slot = shell->inventory.u.items_inventory[i];
		if (!slot.nameid || slot.equip || slot.amount <= 0)
			continue;
		const std::shared_ptr<item_data> id = itemdb_exists(slot.nameid);
		if (id == nullptr || !(id->equip & freed))
			continue;
		uint32 pos = id->equip;
		if (pos == EQP_ACC)
			pos = (freed & EQP_ACC_L) ? EQP_ACC_L : EQP_ACC_R;
		if ((pos & pop_companion_worn_positions(shell)) || pc_isequip(shell, i) != ITEM_EQUIP_ACK_OK)
			continue;
		if (pc_equipitem(shell, i, pos, false))
			freed &= ~shell->inventory.u.items_inventory[i].equip;
	}
	if (freed == 0)
		return;
	std::shared_ptr<PopulationEngine> equipment = population_engine_db_for_shell(shell).find(shell->status.class_);
	if (!equipment)
		return;
	auto refill = [shell, &freed](const std::vector<uint16_t> &pool, uint32 slot_pos, const char *label, uint32 force_pos) {
		if (!(freed & slot_pos) || pool.empty())
			return;
		const uint16_t nameid = pool[rnd() % pool.size()];
		const std::shared_ptr<item_data> id = itemdb_exists(nameid);
		const uint32 pos = force_pos != 0 ? force_pos : (id != nullptr ? id->equip : 0);
		if (pos == 0 || (pos & pop_companion_worn_positions(shell)))
			return;
		population_engine_shell_equip_item(shell, nameid, shell->status.char_id, label, force_pos);
		freed &= ~pop_companion_worn_positions(shell);
	};
	refill(equipment->weapon_pool,      EQP_HAND_R,   "weapon",   0);
	refill(equipment->shield_pool,      EQP_HAND_L,   "shield",   0);
	refill(equipment->armor_pool,       EQP_ARMOR,    "armor",    0);
	refill(equipment->shoes_pool,       EQP_SHOES,    "shoes",    0);
	refill(equipment->garment_pool,     EQP_GARMENT,  "garment",  0);
	refill(equipment->head_top_pool,    EQP_HEAD_TOP, "head_top", 0);
	refill(equipment->head_mid_pool,    EQP_HEAD_MID, "head_mid", 0);
	refill(equipment->head_bottom_pool, EQP_HEAD_LOW, "head_low", 0);
	refill(equipment->acc_l_pool,       EQP_ACC_L,    "acc_l",    EQP_ACC_L);
	refill(equipment->acc_r_pool,       EQP_ACC_R,    "acc_r",    EQP_ACC_R);
}

int population_engine_companion_return_gear(map_session_data *owner, map_session_data *shell, uint32_t slot_mask)
{
	if (!owner || !shell) return -1;
	if (!population_engine_is_population_pc(shell->id)) return -1;

	int returned = 0, kept_own = 0;
	uint32_t freed = 0;
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		struct item &slot = shell->inventory.u.items_inventory[i];
		if (!slot.nameid || !slot.equip) continue; // equipped only
		// RAGNAROKMAC: selective gear return — when slot_mask != 0, only items whose
		// equip bits intersect the mask come back; everything else stays on the companion.
		if (slot_mask != 0 && !(slot.equip & slot_mask)) continue;
		// Only what the owner gave. The gear a companion was generated or drafted with is
		// its own; handing that out would make every draft a free set of equipment.
		if (!(slot.equip & shell->pop.companion_given_mask)) {
			++kept_own;
			continue;
		}
		// Unequip (flag 2 = ignore status-change blocks), then into the owner's bag or at
		// their feet - see pop_companion_hand_back.
		const uint32_t worn = slot.equip;
		if (pop_companion_hand_back(owner, shell, i, LOG_TYPE_NPC)) {
			++returned;
			freed |= worn;
		}
	}
	if (returned > 0) {
		pop_companion_reequip_own(shell, freed);
		ShowInfo("population_engine: returned %d worn item(s) from companion %u to owner %u\n",
			returned, shell->status.char_id, owner->status.account_id);
		// Save both halves now. Left to the owner's autosave and the gear poll, a crash in
		// between loses the item (companion row already empty, owner not yet saved) or
		// duplicates it. Owner first: if anything is lost to a crash here, it is a duplicate.
		chrif_save(owner, CSAVE_INVENTORY);
		population_engine_persist_companion_gear(shell);
	}
	if (returned == 0 && kept_own > 0 && owner->fd > 0)
		clif_displaymessage(owner->fd, "Only gear you gave a companion comes back; what it is wearing is its own.");
	return returned;
}

/// Every worn piece in full, for cp_companion_persistence.gear_detail (v11).
///
/// The *_nameid columns hold one number per slot, and that number is all recall had: a piece
/// came back with no refine, no cards and no options, and the bare copy is what `@companion
/// gear` then handed to the player - the cards were gone for good. The headgear columns are
/// worse: they are written from status.head_*, which pc_set_costume_view fills with the
/// item's LOOK, so a hat came back as whatever item has that look's number, or as nothing.
///
/// "v1" then one entry per worn piece, separated by ';': equip, nameid, refine, card0-3,
/// enchantgrade, bound, unique_id, then id,value,param for each random option. `attribute`
/// is not kept: it is rAthena's broken flag, and a broken piece is unequipped on the spot
/// and cannot be put back on, so a worn one is always 0.
static std::string pop_companion_gear_detail(const map_session_data *sd)
{
	std::string out = "v1";
	char entry[512];
	for (int16 i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &it = sd->inventory.u.items_inventory[i];
		if (!it.nameid || !it.equip || it.amount <= 0)
			continue;
		int n = snprintf(entry, sizeof(entry), ";%u,%u,%d,%u,%u,%u,%u,%u,%d,%" PRIu64,
			it.equip, (unsigned)it.nameid, (int)it.refine,
			(unsigned)it.card[0], (unsigned)it.card[1], (unsigned)it.card[2], (unsigned)it.card[3],
			(unsigned)it.enchantgrade, (int)it.bound, (uint64_t)it.unique_id);
		for (int o = 0; o < MAX_ITEM_RDM_OPT && n > 0 && static_cast<size_t>(n) < sizeof(entry); ++o)
			n += snprintf(entry + n, sizeof(entry) - n, ",%d,%d,%d",
				(int)it.option[o].id, (int)it.option[o].value, (int)it.option[o].param);
		if (n > 0 && static_cast<size_t>(n) < sizeof(entry))
			out += entry;
	}
	return out;
}

/// One gear_detail entry back into an item, or false when it is not one this build wrote.
static bool pop_companion_parse_gear_entry(const char *text, struct item &it)
{
	unsigned long long v[10 + 3 * MAX_ITEM_RDM_OPT];
	size_t count = 0;
	const char *p = text;
	while (count < sizeof(v) / sizeof(v[0])) {
		char *end = nullptr;
		const bool negative = (*p == '-');
		const unsigned long long n = strtoull(negative ? p + 1 : p, &end, 10);
		if (end == (negative ? p + 1 : p))
			return false;
		v[count++] = negative ? static_cast<unsigned long long>(-static_cast<long long>(n)) : n;
		p = end;
		if (*p != ',')
			break;
		++p;
	}
	if (count != sizeof(v) / sizeof(v[0]) || (*p != '\0' && *p != ';'))
		return false;
	it = {};
	it.equip = static_cast<uint32>(v[0]);
	it.nameid = static_cast<t_itemid>(v[1]);
	it.refine = static_cast<char>(v[2]);
	for (int c = 0; c < MAX_SLOTS; ++c)
		it.card[c] = static_cast<t_itemid>(v[3 + c]);
	it.enchantgrade = static_cast<uint8>(v[7]);
	it.bound = static_cast<char>(v[8]);
	it.unique_id = static_cast<uint64>(v[9]);
	for (int o = 0; o < MAX_ITEM_RDM_OPT; ++o) {
		it.option[o].id = static_cast<int16>(v[10 + 3 * o]);
		it.option[o].value = static_cast<int16>(v[11 + 3 * o]);
		it.option[o].param = static_cast<char>(v[12 + 3 * o]);
	}
	it.amount = 1;
	it.identify = 1;
	return it.nameid != 0 && it.equip != 0 && itemdb_exists(it.nameid) != nullptr;
}

/// Put a recalled companion's gear back the way it was saved: refine, cards, options and the
/// right item in every slot. Recall has already equipped what the *_nameid columns name; a
/// piece that matches a saved entry takes its details, and a slot holding the wrong item (a
/// hat recalled by its look number) or nothing has it replaced by the saved piece. Those
/// wrong pieces were made by recall a moment ago from a bad number - they were never anyone's.
/// A row with no detail (saved before v11) is left exactly as recall made it.
static void pop_companion_restore_gear_detail(map_session_data *shell, const char *detail)
{
	if (shell == nullptr || detail == nullptr || strncmp(detail, "v1", 2) != 0)
		return;
	for (const char *p = strchr(detail, ';'); p != nullptr; p = strchr(p + 1, ';')) {
		struct item saved;
		if (!pop_companion_parse_gear_entry(p + 1, saved))
			continue;
		int16 match = -1;
		for (int16 i = 0; i < MAX_INVENTORY && match < 0; ++i) {
			const struct item &w = shell->inventory.u.items_inventory[i];
			if (w.nameid == saved.nameid && w.equip == saved.equip && w.amount > 0)
				match = i;
		}
		if (match >= 0) {
			struct item &w = shell->inventory.u.items_inventory[match];
			w.refine = saved.refine;
			memcpy(w.card, saved.card, sizeof(w.card));
			memcpy(w.option, saved.option, sizeof(w.option));
			w.enchantgrade = saved.enchantgrade;
			w.bound = saved.bound;
			if (saved.unique_id != 0)
				w.unique_id = saved.unique_id;
			continue;
		}
		// Clear the slot: whatever recall put where the saved piece goes.
		for (int16 i = 0; i < MAX_INVENTORY; ++i) {
			const struct item &w = shell->inventory.u.items_inventory[i];
			if (w.nameid && w.equip && (w.equip & saved.equip)) {
				if (pc_unequipitem(shell, i, 2))
					pc_delitem(shell, i, w.amount, 0, 1, LOG_TYPE_NONE);
			}
		}
		shell->max_weight = 2000000; // as population_engine_shell_equip_item: status_calc resets it
		struct item add = saved;
		add.equip = 0;
		if (pc_additem(shell, &add, 1, LOG_TYPE_NONE) != ADDITEM_SUCCESS) {
			ShowWarning("population_engine: could not restore item %u on companion %u\n",
				(unsigned)saved.nameid, shell->status.char_id);
			continue;
		}
		for (int16 i = 0; i < MAX_INVENTORY; ++i) {
			const struct item &w = shell->inventory.u.items_inventory[i];
			if (w.nameid == saved.nameid && w.equip == 0 && w.amount > 0 && w.refine == saved.refine
			    && memcmp(w.card, saved.card, sizeof(w.card)) == 0) {
				// A piece the companion can no longer wear (its job or level changed since)
				// stays in its inventory, outside the owner's custody of worn slots: say so.
				if (!pc_equipitem(shell, i, saved.equip, false))
					ShowWarning("population_engine: companion %u could not wear restored item %u (slot %u); it stays unworn\n",
						shell->status.char_id, (unsigned)saved.nameid, (unsigned)saved.equip);
				break;
			}
		}
	}
}

// Goal 2: re-snapshot a summoned companion's current equipment + stats into its
// persistence row. Called (debounced) whenever the shell's equipment changes, so
// gear the owner gives the companion after recruit survives a restart too.
void population_engine_persist_companion_gear(map_session_data *sd)
{
	if (!sd || !sd->state.active) return;
	if (!population_engine_is_population_pc(sd->id)) return;
	if (sd->status.char_id < POPULATION_ENGINE_CHAR_ID_BASE) return;

	// The row's owner is the companion's registered owner (set at recruit).
	const uint32_t owner = sd->pop.companion_owner_account;
	if (owner == 0) return; // not a recruited companion

	const uint32_t index_ = sd->status.char_id - POPULATION_ENGINE_CHAR_ID_BASE;

	uint32_t weapon=0, shield=0, armor=0, shoes=0, acc_l=0, acc_r=0;
	// Goal 2: also snapshot costume / shadow / garment slots so traded vanity
	// and shadow gear survive restarts instead of vanishing on the next login.
	uint32_t c_top=0, c_mid=0, c_low=0, c_garment=0, garment=0;
	uint32_t sh_armor=0, sh_weapon=0, sh_shield=0, sh_shoes=0, sh_acc_l=0, sh_acc_r=0;
	// The worn headgear, not status.head_*: that is each piece's look, not its item.
	uint32_t head_top=0, head_mid=0, head_low=0;
	for (int16_t i = 0; i < MAX_INVENTORY; ++i) {
		const struct item &slot = sd->inventory.u.items_inventory[i];
		if (!slot.nameid || !slot.equip) continue; // equipped only
		if (slot.equip & EQP_SHADOW_WEAPON)       sh_weapon  = slot.nameid;
		else if (slot.equip & EQP_SHADOW_SHIELD)  sh_shield  = slot.nameid;
		else if (slot.equip & EQP_SHADOW_ARMOR)   sh_armor   = slot.nameid;
		else if (slot.equip & EQP_SHADOW_SHOES)   sh_shoes   = slot.nameid;
		else if (slot.equip & EQP_SHADOW_ACC_L)   sh_acc_l   = slot.nameid;
		else if (slot.equip & EQP_SHADOW_ACC_R)   sh_acc_r   = slot.nameid;
		else if (slot.equip & EQP_COSTUME_HEAD_TOP) c_top    = slot.nameid;
		else if (slot.equip & EQP_COSTUME_HEAD_MID) c_mid    = slot.nameid;
		else if (slot.equip & EQP_COSTUME_HEAD_LOW) c_low    = slot.nameid;
		else if (slot.equip & EQP_COSTUME_GARMENT)  c_garment= slot.nameid;
		else if (slot.equip & EQP_GARMENT)        garment  = slot.nameid;
		else if (slot.equip & EQP_HAND_R)         weapon   = slot.nameid;
		else if (slot.equip & EQP_HAND_L)         shield   = slot.nameid;
		else if (slot.equip & EQP_ARMOR)          armor    = slot.nameid;
		else if (slot.equip & EQP_SHOES)          shoes    = slot.nameid;
		else if (slot.equip & EQP_ACC_L)          acc_l    = slot.nameid;
		else if (slot.equip & EQP_ACC_R)          acc_r    = slot.nameid;
		else if (slot.equip & EQP_HEAD_TOP)       head_top = slot.nameid; // a hat over top and mid too
		else if (slot.equip & EQP_HEAD_MID)       head_mid = slot.nameid;
		else if (slot.equip & EQP_HEAD_LOW)       head_low = slot.nameid;
	}

	// UPDATE only the mutable columns — identity (owner, index, name, job, sex,
	// looks) never changes after recruit, and map_id tracks the owner anyway.
	if (mmysql_handle == nullptr) return;
	// Sized for the full gear detail: about 120 bytes for each worn piece.
	const std::string detail = pop_companion_gear_detail(sd);
	std::vector<char> q(1536 + detail.size());

	// The pet's own state is ours to keep - hom_id stays 0, so nothing stock can save it. Written
	// ONLY while the pet exists: a companion whose pet is switched off, or that is not an
	// alchemist, must not have a stored level wiped by a snapshot with nothing to snapshot.
	char hom_frag[160];
	hom_frag[0] = '\0';
	if (sd->hd != nullptr) {
		snprintf(hom_frag, sizeof(hom_frag), ", hom_class=%d, hom_level=%d, hom_exp=%lld",
			(int)sd->hd->homunculus.class_,
			(int)sd->hd->homunculus.level,
			(long long)sd->hd->homunculus.exp);
	}

	const int written = snprintf(q.data(), q.size(),
		"UPDATE `cp_companion_persistence` SET weapon_nameid=%u, shield_nameid=%u,"
		" head_top_nameid=%u, head_mid_nameid=%u, head_bottom_nameid=%u,"
		" armor_nameid=%u, shoes_nameid=%u, acc_l_nameid=%u, acc_r_nameid=%u,"
		" garment_nameid=%u, costume_top_nameid=%u, costume_mid_nameid=%u,"
		" costume_low_nameid=%u, costume_garment_nameid=%u,"
		" shadow_armor_nameid=%u, shadow_weapon_nameid=%u, shadow_shield_nameid=%u,"
		" shadow_shoes_nameid=%u, shadow_acc_l_nameid=%u, shadow_acc_r_nameid=%u,"
		" base_level=%d, job_level=%d, job_id=%d, str_=%d, agi_=%d, vit_=%d, intl_=%d,"
		" dex_=%d, luk_=%d, pow_=%d, sta_=%d, wis_=%d, spl_=%d, con_=%d, crt_=%d,"
		" rest_below=%d, rest_until=%d,"
		" mode=%d, duty=%d, heal_at=%d, emergency_at=%d, given_mask=%u, gear_detail='%s'%s"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		weapon, shield, head_top, head_mid, head_low,
		armor, shoes, acc_l, acc_r,
		garment, c_top, c_mid, c_low, c_garment,
		sh_armor, sh_weapon, sh_shield, sh_shoes, sh_acc_l, sh_acc_r,
		sd->status.base_level, sd->status.job_level, sd->status.class_, sd->status.str, sd->status.agi,
		sd->status.vit, sd->status.int_, sd->status.dex, sd->status.luk,
		sd->status.pow, sd->status.sta, sd->status.wis, sd->status.spl, sd->status.con, sd->status.crt,
		(int)sd->pop.companion_rest_below, (int)sd->pop.companion_rest_until,
		(int)sd->pop.companion_mode, (int)sd->pop.role,
		(int)sd->pop.companion_heal_at, (int)sd->pop.companion_emergency_at,
		pop_companion_given_worn(sd),
		detail.c_str(), hom_frag,
		owner, sd->pop.companion_owner_char, index_);
	if (written <= 0 || static_cast<size_t>(written) >= q.size()) {
		ShowError("population_engine: gear re-snapshot for companion %u does not fit\n", index_);
		return;
	}
	// Through "%s": the statement is data here, never a format.
	if (Sql_Query(mmysql_handle, "%s", q.data()) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		ShowError("population_engine: gear re-snapshot for companion %u FAILED\n", index_);
		return;
	}
	ShowInfo("population_engine: gear re-snapshotted for companion %u (owner %u)\n", index_, owner);
}

void population_engine_persist_recruited_companion(map_session_data *sd, map_session_data *peer)
{
	if (!sd || !sd->state.active) return;
	const uint32_t char_id = sd->status.char_id;
	if (char_id < POPULATION_ENGINE_CHAR_ID_BASE) return; // not a population shell
	// An invited shell may have been an ambient town VENDOR, vendored at its own spawn. It is a
	// companion now, so the stall has to go.
	population_engine_shell_close_stall(sd);

	// Ownership: Case C already set companion_owner_account in-engine. Otherwise the
	// recruiting player is `peer` — resolved from party_invite_account in
	// party_member_added before that field was cleared (Cases A/C). Last resort: the
	// first real (non-shell) member of the shell's party via map_id2sd; never scan
	// g_population_engine_pcs, which holds only shells and can never name a real player.
	// The owner is a CHARACTER: the session that recruited it. pop_companion_owner_session()
	// only answers when that exact character is logged in.
	map_session_data *owner = pop_companion_owner_session(sd);
	if (owner == nullptr && peer != nullptr && peer->state.active
	    && peer->status.account_id != 0
	    && !population_engine_is_population_pc(peer->id))
		owner = peer;
	if (owner == nullptr) {
		struct party_data *p = party_search(sd->status.party_id);
		if (p != nullptr)
			for (int j = 0; j < MAX_PARTY && owner == nullptr; ++j) {
				const uint32_t mbr_account = p->party.member[j].account_id;
				if (mbr_account == 0)
					continue;
				map_session_data *cand = map_id2sd(mbr_account);
				if (cand != nullptr && cand->status.account_id == mbr_account
					&& cand->status.char_id == p->party.member[j].char_id
					&& !population_engine_is_population_pc(cand->id))
					owner = cand;
			}
	}
	if (owner == nullptr) {
		ShowWarning("population_engine: persist companion (char_id %u, party %d): no owner resolved\n",
			char_id, sd->status.party_id);
		return;
	}

	// Same insert the draft path uses, so a recruit and a draft cannot produce
	// different rows (nor drift apart again as this one did).
	population_engine_persist_companion_row(sd, owner);

	// The roster changed (a shell was recruited into the party) - tell an open panel
	// so a right-click recruit in the world shows up without reopening the window.
	if (population_engine_is_population_pc(sd->id))
		population_engine_push_companion_list_for_shell(sd);
}

// RAGNAROKMAC (Goal 3) ----------------------------------------------------------
// Expelled/released companions: mark the persistence row inactive (active=0)
// instead of deleting it. The snapshot (name, gear, stats) is retained so the
// owner can re-invite the exact same companion later via @companion summon.
void population_engine_set_companion_active(uint32_t owner_account, uint32_t index_, bool active)
{
	if (mmysql_handle == nullptr) return;
	char q[256];
	snprintf(q, sizeof(q),
		"UPDATE `cp_companion_persistence` SET active=%d"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		active ? 1 : 0, owner_account, pop_online_char(owner_account), index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		ShowError("population_engine: set companion %u active=%d for owner %u FAILED\n",
			index_, active ? 1 : 0, owner_account);
		return;
	}
	// Activation is how summon and dismiss change the roster; push so an open
	// panel reflects it. The owner may be offline (expel from a stale session), in
	// which case there is nothing to send to.
	if (map_session_data *owner_sd = map_id2sd(owner_account))
		population_engine_push_companion_list(owner_sd);
	ShowInfo("population_engine: companion index %u for owner %u set active=%d\n",
		index_, owner_account, active ? 1 : 0);
}

void population_engine_deactivate_expelled_companion(int32_t party_id, uint32_t account_id, uint32_t char_id)
{
	// Called when a population shell is withdrawn from a party by expulsion.
	// The shell's own account id is POPULATION_ENGINE_CHAR_ID_BASE + index,
	// which is also its owner-independent identity key; the row's owner is
	// whoever persisted it — look the row up by shell_index alone.
	if (account_id < POPULATION_ENGINE_ACCOUNT_ID_BASE) return; // not a shell
	const uint32_t index_ = account_id - POPULATION_ENGINE_ACCOUNT_ID_BASE;
	if (mmysql_handle == nullptr) return;
	char q[256];
	snprintf(q, sizeof(q),
		"UPDATE `cp_companion_persistence` SET active=0 WHERE shell_index=%u",
		index_);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	ShowInfo("population_engine: expelled companion index %u marked inactive\n", index_);
}

// RAGNAROKMAC (Goal 3 / friend list) ---------------------------------------------
// @companion plumbing. Companions are stored per-owner; "summon" re-activates
// a saved companion (active=1) and recalls it next to the owner even after an
// expulsion; "favorite" toggles the flag used to sort the list.

bool population_engine_companion_set_favorite(uint32_t owner_account, const char* name_, bool favorite)
{
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0]) return false;
	char esc_name[NAME_LENGTH * 2 + 1];
	pop_escape_name(esc_name, name_);
	char q[300];
	snprintf(q, sizeof(q),
		"UPDATE `cp_companion_persistence` SET favorite=%d"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND name='%s'",
		favorite ? 1 : 0, owner_account, pop_online_char(owner_account), esc_name);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	return (Sql_NumRowsAffected(mmysql_handle) > 0);
}

/// Finds a saved companion by name for this owner. Returns true and fills
/// `out_index` on success; `out_active` reports the current active flag.
bool population_engine_companion_find(uint32_t owner_account, const char* name_,
	uint32_t* out_index, bool* out_active)
{
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0]) return false;
	char esc_name[NAME_LENGTH * 2 + 1];
	pop_escape_name(esc_name, name_);
	char q[300];
	snprintf(q, sizeof(q),
		"SELECT shell_index, active FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND name='%s' LIMIT 1",
		owner_account, pop_online_char(owner_account), esc_name);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	if (Sql_NextRow(mmysql_handle) != SQL_SUCCESS) {
		Sql_FreeResult(mmysql_handle);
		return false;
	}
	char* data = nullptr;
	Sql_GetData(mmysql_handle, 0, &data, nullptr);
	if (out_index) *out_index = data ? (uint32_t)strtoul(data, nullptr, 10) : 0;
	Sql_GetData(mmysql_handle, 1, &data, nullptr);
	if (out_active) *out_active = data != nullptr && atoi(data) != 0;
	Sql_FreeResult(mmysql_handle);
	return true;
}

/// RAGNAROKMAC (homunculus, phase 3c): the panel's per-companion pet switch.
///
/// A player never SUMMONS this pet - the engine attaches it at spawn - so this is a switch, not a
/// summon. OFF puts a live pet away with stock's own `hom_vaporize` (the same call `pc.cpp` makes
/// on logout): it stays attached but inactive, so the driver stops and the client stops drawing it.
/// ON brings it back by clearing that flag in place, or attaches a fresh one from the row when the
/// companion has no pet at all (benched, or killed - `hom_is_active` is false for a dead pet and
/// the attach restores class, level and exp).
///
/// `hom_call()` is deliberately NOT used for the ON direction: its first line is
/// `if (!sd->status.hom_id) return hom_create_request(...)`, and a shell's `hom_id` is 0 by design,
/// so it would take the CHAR-SERVER path this whole feature exists to avoid.
///
/// @param want  1 = on, 0 = off, -1 = flip
/// @return 1 when the state changed, 0 when it was already so, -1 when rejected (message in out_msg).
int population_engine_companion_set_homunculus(uint32_t owner_account, const char *name_, int want,
	char *out_msg, size_t out_msg_len)
{
	if (mmysql_handle == nullptr || name_ == nullptr || !name_[0])
		return -1;
	uint32_t index_ = 0;
	bool active = false;
	if (!population_engine_companion_find(owner_account, name_, &index_, &active)) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len, "No saved companion named %s.", name_);
		return -1;
	}

	// NULL (never chosen) reads as ON: for this class the pet is on unless the player said no.
	int enabled = -1;
	{
		char q[320];
		snprintf(q, sizeof(q),
			"SELECT hom_enabled FROM `cp_companion_persistence`"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len, "Could not read the pet switch (see map-server console).");
			return -1;
		}
		if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
			char *data = nullptr;
			Sql_GetData(mmysql_handle, 0, &data, nullptr);
			if (data != nullptr && data[0] != '\0')
				enabled = atoi(data);
		}
		Sql_FreeResult(mmysql_handle);
	}
	if (want < 0)
		want = (enabled == 0) ? 1 : 0;
	want = want ? 1 : 0;
	if (want == enabled || (want == 1 && enabled != 0)) {
		if (out_msg != nullptr)
			safesnprintf(out_msg, out_msg_len, "%s: its homunculus is already %s.",
				name_, want ? "summoned" : "put away");
		return 0;
	}

	// The row is the durable half; apply to the shell only once it is written.
	{
		char q[320];
		snprintf(q, sizeof(q),
			"UPDATE `cp_companion_persistence` SET hom_enabled=%d"
			" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
			want, owner_account, pop_online_char(owner_account), index_);
		if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
			Sql_ShowDebug(mmysql_handle);
			if (out_msg != nullptr)
				safesnprintf(out_msg, out_msg_len, "Could not save the pet switch (see map-server console).");
			return -1;
		}
	}

	// A benched companion has no shell: the stored switch is honoured by the attach at its next
	// summon, which already refuses when the column is 0.
	map_session_data *live = nullptr;
	for (map_session_data *cand : g_population_engine_pcs) {
		if (cand == nullptr || !pop_is_companion(cand))
			continue;
		if (cand->pop.companion_owner_account != owner_account
			|| cand->pop.companion_owner_char != pop_online_char(owner_account))
			continue;
		if (cand->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		live = cand;
		break;
	}

	if (live != nullptr) {
		if (want == 0) {
			if (live->hd != nullptr && live->hd->homunculus.vaporize == HOM_ST_ACTIVE)
				hom_vaporize(live, HOM_ST_ACTIVE);
		} else if (live->hd != nullptr) {
			if (live->hd->homunculus.vaporize != HOM_ST_ACTIVE) {
				hom_init_timers(live->hd);
				live->hd->homunculus.vaporize = HOM_ST_ACTIVE;
				clif_hominfo(live, live->hd, 1);
			}
		} else {
			population_engine_sync_shell_homunculus(live);
		}
	}

	if (out_msg != nullptr)
		safesnprintf(out_msg, out_msg_len, "%s: its homunculus is now %s%s.",
			name_, want ? "summoned" : "put away",
			live == nullptr ? " (applies when summoned)" : "");
	ShowInfo("population_engine: homunculus switch for companion %u set to %d (live=%s)\n",
		index_, want, live == nullptr ? "no" : "yes");
	return 1;
}


/// Goal 3 friend list: permanently DELETE one saved companion's row.
/// Irreversible — the snapshot (name, gear, stats) is gone. If the companion
/// is currently summoned, the caller must release the shell first.
///
/// By shell_index, which the caller resolved from the name: names are not unique, and a
/// DELETE by name removed every companion that happened to share it.
bool population_engine_companion_delete(uint32_t owner_account, uint32_t shell_index)
{
	if (mmysql_handle == nullptr || shell_index == 0) return false;
	char q[160];
	snprintf(q, sizeof(q),
		"DELETE FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		owner_account, pop_online_char(owner_account), shell_index);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	return (Sql_NumRowsAffected(mmysql_handle) > 0);
}

/// Does this saved companion hold gear its owner gave it? Read from the row, for a companion
/// that is not summoned (a live one is asked through pop.companion_given_mask instead).
bool population_engine_companion_holds_given_gear(uint32_t owner_account, uint32_t shell_index)
{
	if (mmysql_handle == nullptr || shell_index == 0) return false;
	char q[160];
	snprintf(q, sizeof(q),
		"SELECT given_mask FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u AND shell_index=%u",
		owner_account, pop_online_char(owner_account), shell_index);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return false;
	}
	bool holds = false;
	if (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char *data = nullptr;
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		holds = data != nullptr && strtoul(data, nullptr, 10) != 0;
	}
	Sql_FreeResult(mmysql_handle);
	return holds;
}

/// Prints the owner's saved companions (name, job, active, favorite) to the
/// player's chat via the @companion list command.
void population_engine_companion_list(uint32_t owner_account, int fd)
{
	if (mmysql_handle == nullptr) return;
	char q[400];
	snprintf(q, sizeof(q),
		"SELECT name, job_id, active, favorite, base_level FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u ORDER BY favorite DESC, name ASC",
		owner_account, pop_online_char(owner_account));
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		clif_displaymessage(fd, "Companion list query failed (see map-server console).");
		return;
	}
	clif_displaymessage(fd, "=== Saved companions (favorite first) ===");
	int count = 0;
	char* data = nullptr;
	while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char namebuf[NAME_LENGTH];
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		safestrncpy(namebuf, data != nullptr ? data : "", NAME_LENGTH);
		Sql_GetData(mmysql_handle, 1, &data, nullptr); int job_id = atoi(data);
		Sql_GetData(mmysql_handle, 2, &data, nullptr); bool active = atoi(data) != 0;
		Sql_GetData(mmysql_handle, 3, &data, nullptr); bool fav = atoi(data) != 0;
		Sql_GetData(mmysql_handle, 4, &data, nullptr); int base_lv = atoi(data);
		char msg[NAME_LENGTH + 80];
		snprintf(msg, sizeof(msg), "  %s%s — %s Lv.%d — %s",
			fav ? "* " : "  ", namebuf, job_name(job_id), base_lv,
			active ? "in party" : "saved (expelled)");
		clif_displaymessage(fd, msg);
		count++;
	}
	Sql_FreeResult(mmysql_handle);
	char msg[96];
	snprintf(msg, sizeof(msg), "%d saved companion(s). Use @companion summon <name>.", count);
	clif_displaymessage(fd, msg);
}

// ── RAGNAROKMAC: register a shell into the owner's map-local party.
//
// Why map-local and not the char server: inter_party_tosql persists membership as
// "UPDATE char SET party_id=7 WHERE account_id=? AND char_id=?", and population
// shells have NO row in the char table at all (only real characters do). So the
// char-server round-trip can never durably hold a companion - the UPDATE matches
// nothing. That is why "party join requested" appears in the log eight times while
// "party join reply" never appears and the char log shows no member added: the
// shell was left with status.party_id = 0, pop_is_companion() returned false, and
// everything downstream (stance, follow, the panel's shell count) saw nothing.
//
// Membership therefore lives in the map's own party struct, which is what draws
// the party window and what the engine's own checks read. Durability across a
// restart comes from the login recall re-registering it, exactly as the
// companions themselves are restored.
/// RAGNAROKMAC (item 9): a companion must not stand in vending mode.
///
/// The vendor block in population_engine_spawn_shell() decides from the PROFILE, not from play
/// state: a merchant-line shell resolves a vendor config (or the built-in default stock) and opens
/// a stall, whatever it is for. A companion drafted or summoned as a Blacksmith/Alchemist therefore
/// stands there with a shop instead of following - the reported workaround was to summon a Merchant
/// and level it up, which is data dodging a code bug.
///
/// Closing the stall here rather than gating that block is deliberate: the block runs BEFORE the
/// caller knows the shell is a companion. population_engine_companion_draft() and the recall path
/// both call spawn_shell() and only then assign companion_owner_account, so a companion test inside
/// spawn would never fire for them. Both of those paths reach this function, and so does a repair
/// sweep - and the recruit hook covers an ambient town VENDOR adopted by an invite, which vendored
/// at its own spawn long before anyone invited it.
///
/// `state.vending` is the LIVE flag (`vending_openvending` consumes `state.prevend` and sets it);
/// the engine's own shell drivers skip vending shells, which is why the companion stands there.
static void population_engine_shell_close_stall(map_session_data *sd)
{
	if (sd == nullptr)
		return;
	if (sd->state.vending)
		vending_closevending(sd); // clears state.vending, vender_id, the board and vending_db
	if (sd->state.buyingstore)
		buyingstore_close(sd);
	// The intent flag the spawn path sets before calling vending_openvending. openvending normally
	// clears it itself, including on its early returns, so this is belt-and-braces for a shell that
	// never got that far.
	sd->state.prevend = 0;
}

static void pop_companion_register_local_party(map_session_data *sd, map_session_data *owner)
{
	if (!sd || !owner)
		return;
	// A companion that arrives with a stall open (drafted or summoned merchant-line job) must not
	// stay in vending mode; close it before the early returns, so it happens even when the owner has
	// no usable party yet.
	population_engine_shell_close_stall(sd);
	if (owner->status.party_id <= 0 || owner->status.party_id >= 0x70000000)
		return;

	const int32 party_id = owner->status.party_id;
	struct party_data *p = party_search(party_id);

	// RAGNAROKMAC: leave the party this shell is currently registered in before it
	// becomes a member of this one.
	//
	// The roster is shared across the owner's characters, so switching characters
	// re-runs the recall and moves every companion into the newly logged-in
	// character's party. This function used to repoint sd->status.party_id and
	// write data[i].sd in the NEW party while leaving the pointer in the old one,
	// so two parties held the same shell. shell_release() scrubs only the party
	// named by status.party_id, and party_send_xy_timer iterates EVERY party in
	// party_db, so the stale pointer in the abandoned party was dereferenced after
	// the shell was freed - SIGSEGV in party_send_xy_timer+0x8c, right after the
	// death/wipe release, which is the crash the incident report caught.
	//
	// Mirrors population_engine_shell_release's teardown (leave + withdraw + null
	// the data[] slot) so "registered in at most one party" becomes an invariant of
	// this function instead of something the release path has to keep repairing.
	if (sd->status.party_id > 0 && sd->status.party_id < 0x70000000 &&
		sd->status.party_id != party_id) {
		const int32 old_party_id = sd->status.party_id;
		intif_party_leave(old_party_id, sd->status.account_id, sd->status.char_id,
			sd->status.name, PARTY_MEMBER_WITHDRAW_LEAVE);
		party_member_withdraw(old_party_id, sd->status.account_id, sd->status.char_id,
			sd->status.name, PARTY_MEMBER_WITHDRAW_LEAVE);
		// party_member_withdraw clears the member row but not the data[] slot.
		struct party_data *old_pd = party_search(old_party_id);
		if (old_pd != nullptr) {
			for (int32_t slot = 0; slot < MAX_PARTY; ++slot) {
				if (old_pd->data[slot].sd == sd) {
					old_pd->data[slot].sd = nullptr;
					old_pd->data[slot].x = 0;
					old_pd->data[slot].y = 0;
					old_pd->data[slot].hp = 0;
				}
			}
		}
	}

	sd->status.party_id = party_id;
	sd->party_joining = false;
	sd->party_invite = 0;
	sd->party_invite_account = 0;

	// The map has no struct for this party yet (the owner joined before this map
	// loaded, or the info was never requested). Ask for it; the reply runs
	// party_member_joined(), which finds this shell by party_id and registers it.
	if (p == nullptr) {
		party_request_info(party_id, owner->status.char_id);
		return;
	}

	int32 i;
	ARR_FIND(0, MAX_PARTY, i,
		p->party.member[i].account_id == sd->status.account_id &&
		p->party.member[i].char_id == sd->status.char_id);

	if (i >= MAX_PARTY) {
		ARR_FIND(0, MAX_PARTY, i, p->party.member[i].account_id == 0);
		if (i >= MAX_PARTY) {
			ShowWarning("population_engine: companion %s has no free row in party %d.\n",
				sd->status.name, party_id);
			return;
		}
		// Mirrors party_fill_member() (static to party.cpp) field for field, so the
		// row is identical to one a real member would have.
		struct party_member &m = p->party.member[i];
		memset(&m, 0, sizeof(m));
		m.account_id = sd->status.account_id;
		m.char_id = sd->status.char_id;
		safestrncpy(m.name, sd->status.name, NAME_LENGTH);
		m.class_ = sd->status.class_;
		safestrncpy(m.map, mapindex_id2name(sd->mapindex), sizeof(m.map));
		m.lv = sd->status.base_level;
		m.online = 1;
		m.leader = 0;
		p->party.count++;
	}

	p->data[i].sd = sd;
	clif_party_info(*p, nullptr);
}

/// Push the owner's companion list to their client in the panel's wire format.
///
/// Same lines as `@companion list raw`, sent unsolicited: the in-game panel listens
/// for them, so a roster change reaches an open window without polling. Called from
/// the places that actually change the roster (recruit, draft, summon, dismiss,
/// recall) rather than on a timer.
void population_engine_push_companion_list(map_session_data *owner)
{
	if (!owner || !owner->state.active || owner->fd == -1)
		return;
	if (mmysql_handle == nullptr)
		return;
	population_engine_companion_list_raw(owner->status.account_id, owner->fd);
}

/// Push the list to the owner of this companion, if they are online.
/// A convenience for the roster-changing paths, which all have the shell in hand.
void population_engine_push_companion_list_for_shell(map_session_data *shell)
{
	map_session_data *owner = pop_companion_owner_session(shell);
	if (owner != nullptr)
		population_engine_push_companion_list(owner);
}

/// Re-insert every companion belonging to this party after the map-side party
/// struct has been rebuilt from the char server.
///
/// Called from party_recv_info() (see patch 0005), which overwrites party.member[]
/// with the char server's copy and clears data[] - and the char server does not
/// know about companions, because a population shell has no row in the `char`
/// table. Without this the companions vanish from the party window and lose their
/// live session pointer on every relogin or party refresh.
void population_engine_reassert_companions(int32_t party_id)
{
	if (party_id <= 0 || party_id >= 0x70000000)
		return;

	struct party_data *p = party_search(party_id);
	if (p == nullptr)
		return;

	int reintroduced = 0;
	for (map_session_data *sd : g_population_engine_pcs) {
		if (sd == nullptr || !sd->state.active)
			continue;
		if (sd->pop.companion_owner_account == 0)
			continue;
		// Membership is by owner CHARACTER, not account: one account can have two
		// characters in different parties, and map_id2sd() resolves by account, so it
		// may return the sibling. Resolve the session whose char also belongs to THIS
		// party, otherwise a companion lands in the wrong character's party.
		map_session_data *owner = pop_companion_owner_session(sd);
		if (owner != nullptr && owner->status.party_id != party_id)
			owner = nullptr; // the owning character is in a different party
		if (owner == nullptr) {
			// Fall back to scanning the party for a real (non-shell) member whose
			// account matches, which is unambiguous when both characters are online.
			for (int32_t j = 0; j < MAX_PARTY; ++j) {
				map_session_data *cand = p->data[j].sd;
				if (cand == nullptr || cand == sd)
					continue;
				if (population_engine_is_population_pc(cand->id))
					continue;
				if (pop_companion_owned_by(sd, cand)) {
					owner = cand;
					break;
				}
			}
		}
		if (owner == nullptr)
			continue;

		int32 i;
		ARR_FIND(0, MAX_PARTY, i,
			p->party.member[i].account_id == sd->status.account_id &&
			p->party.member[i].char_id == sd->status.char_id);
		if (i >= MAX_PARTY) {
			ARR_FIND(0, MAX_PARTY, i, p->party.member[i].account_id == 0);
			if (i >= MAX_PARTY)
				continue; // party genuinely full of real players: leave it be
			struct party_member &m = p->party.member[i];
			memset(&m, 0, sizeof(m));
			m.account_id = sd->status.account_id;
			m.char_id = sd->status.char_id;
			safestrncpy(m.name, sd->status.name, NAME_LENGTH);
			m.class_ = sd->status.class_;
			safestrncpy(m.map, mapindex_id2name(sd->mapindex), sizeof(m.map));
			m.lv = sd->status.base_level;
			m.online = 1;
			m.leader = 0;
			p->party.count++;
			++reintroduced;
		}
		// Restore the live session pointer the memset cleared.
		sd->status.party_id = party_id;
		p->data[i].sd = sd;
	}

	if (reintroduced > 0) {
		ShowInfo("population_engine: re-asserted %d companion(s) in party %d after a party rebuild.\n",
			reintroduced, party_id);
		clif_party_info(*p, nullptr);
	}
}

/// RAGNAROKMAC (Phase 3): machine-readable companion list for the in-game panel.
///
/// One line per companion, fixed field order, pipe-separated:
///   @CP|name|job_name|base_level|active(0/1)|favorite(0/1)|level(current,0 if not summoned)|live_job_name|pet|duty
///
/// The last field is the class the shell is ACTUALLY running (empty when not
/// summoned). job_name above comes from the persisted row, which lags a job
/// change until the next snapshot; the panel prefers the live value.
/// terminated by a sentinel line:
///   @CPEND|count
///
/// Deliberately NOT the display format @companion list prints: that text is
/// localized and padded for humans, so a client parsing it would break the day
/// a message id changes. This one has no prose in it at all - the panel shows
/// its own labels, and only the values travel.
void population_engine_companion_list_raw(uint32_t owner_account, int fd)
{
	if (mmysql_handle == nullptr) return;
	char q[400];
	snprintf(q, sizeof(q),
		"SELECT name, job_id, active, favorite, base_level, hom_enabled, duty, job_level, heal_at, emergency_at, rest_below, rest_until FROM `cp_companion_persistence`"
		" WHERE owner_account_id=%u AND owner_char_id=%u ORDER BY favorite DESC, name ASC",
		owner_account, pop_online_char(owner_account));
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		clif_displaymessage(fd, "@CPFAIL");
		return;
	}
	int count = 0;
	char* data = nullptr;
	while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
		char namebuf[NAME_LENGTH];
		Sql_GetData(mmysql_handle, 0, &data, nullptr);
		safestrncpy(namebuf, data != nullptr ? data : "", NAME_LENGTH);
		Sql_GetData(mmysql_handle, 1, &data, nullptr); int job_id = atoi(data);
		Sql_GetData(mmysql_handle, 2, &data, nullptr); int active = atoi(data) != 0 ? 1 : 0;
		Sql_GetData(mmysql_handle, 3, &data, nullptr); int fav = atoi(data) != 0 ? 1 : 0;
		Sql_GetData(mmysql_handle, 4, &data, nullptr); int base_lv = atoi(data);
		Sql_GetData(mmysql_handle, 5, &data, nullptr);
		int hom_enabled = (data != nullptr && data[0] != '\0') ? atoi(data) : -1;
		// Field 6 is the persisted duty (upstream) and 7 the job level this fork needs for
		// rebirth readiness; both are read, and a summoned companion's live values win.
		Sql_GetData(mmysql_handle, 6, &data, nullptr);
		int duty = data != nullptr ? atoi(data) : 0;
		Sql_GetData(mmysql_handle, 7, &data, nullptr);
		int row_job_lv = (data != nullptr && data[0] != '\0') ? atoi(data) : 0;
		// The Battle tab's thresholds, so it shows what is saved instead of its defaults.
		Sql_GetData(mmysql_handle, 8, &data, nullptr); int heal_at = data != nullptr ? atoi(data) : 75;
		Sql_GetData(mmysql_handle, 9, &data, nullptr); int emergency_at = data != nullptr ? atoi(data) : 35;
		Sql_GetData(mmysql_handle, 10, &data, nullptr); int rest_below = data != nullptr ? atoi(data) : 30;
		Sql_GetData(mmysql_handle, 11, &data, nullptr); int rest_until = data != nullptr ? atoi(data) : 95;
		// and a name is player-chosen, so scrub before sending.
		for (char *c = namebuf; *c != '\0'; ++c) {
			if (*c == '|' || *c == '\n' || *c == '\r')
				*c = '_';
		}

		// Live level, when this companion is currently summoned: the persisted
		// base_level is the spawn-time snapshot, which lags a companion that has
		// been levelling in the party.
		int live_lv = 0;
		int live_jl = 0;
		const char *live_job = nullptr;
		// The live CLASS, not just its name: the pet switch's applicability is a
		// property of the class, and a shell that just advanced must be judged on the
		// class it is running rather than the persisted job_id.
		uint16_t live_class = 0;
		for (map_session_data *sd : g_population_engine_pcs) {
			if (sd == nullptr || !pop_is_companion(sd))
				continue;
			if (sd->pop.companion_owner_account != owner_account
				|| sd->pop.companion_owner_char != pop_online_char(owner_account))
				continue;
			if (strcmp(sd->status.name, namebuf) != 0)
				continue;
			live_lv = sd->status.base_level;
			// The live class too: the persisted job_id only catches up on the next
			// gear-hash snapshot, so a companion that just advanced would show its
			// OLD class in the panel. With job advancement shipped, that is the
			// normal case rather than an edge one.
			live_job = job_name(sd->status.class_);
			live_class = sd->status.class_;
			// The duty it is acting on; the row only catches up on the next snapshot.
			duty = sd->pop.role;
			heal_at = sd->pop.companion_heal_at;
			emergency_at = sd->pop.companion_emergency_at;
			rest_below = sd->pop.companion_rest_below;
			rest_until = sd->pop.companion_rest_until;
			live_jl = sd->status.job_level;
			break;
		}

		// The pet switch, as a tri-state so the panel knows whether to draw a control at
		// all: -1 = this job cannot have one, 0 = the player turned it off, 1 = on.
		// NULL (never chosen) reads as on, matching the attach's own rule.
		int hom = -1;
		const uint16_t tree_class = live_class != 0 ? live_class : static_cast<uint16_t>(job_id);
		if (population_engine_class_can_have_homunculus(tree_class))
			hom = (hom_enabled == 0) ? 0 : 1;

		// Rebirth readiness, same tri-state idea: -1 = this class cannot be reborn at all,
		// 0 = a 2nd class that has not met the gate yet, 1 = ready now. It uses the SAME
		// predicate the rebirth command does, so the panel cannot offer a control the
		// server would refuse.
		int rebirth = -1;
		{
			const int32_t rb_base = live_lv > 0 ? live_lv : base_lv;
			const int32_t rb_job = live_jl > 0 ? live_jl : row_job_lv;
			const uint16_t rb_target = pop_companion_next_job(tree_class, rb_base, rb_job,
				/*allow_rebirth=*/true);
			if (rb_target != 0 && pop_job_change_is_rebirth(tree_class, rb_target))
				rebirth = 1;
			else if (tree_class >= 7 && tree_class <= 20)
				rebirth = 0;
		}

		char msg[NAME_LENGTH + 160];
		// The duty travels so the panel can show it (kept only in the panel's memory, its
		// badge went blank on every restart or reload although the server still had it), and
		// rebirth readiness after it so both appended fields keep their positions.
		// The thresholds come last, so every field before them keeps its position.
		snprintf(msg, sizeof(msg), "@CP|%s|%s|%d|%d|%d|%d|%s|%d|%d|%d|%d|%d|%d|%d",
			namebuf, job_name(job_id), base_lv, active, fav, live_lv,
			live_job != nullptr ? live_job : "", hom, duty, rebirth,
			heal_at, emergency_at, rest_below, rest_until);
		clif_displaymessage(fd, msg);
		count++;
	}
	Sql_FreeResult(mmysql_handle);
	char endmsg[64];
	snprintf(endmsg, sizeof(endmsg), "@CPEND|%d", count);
	clif_displaymessage(fd, endmsg);
}

static void population_engine_recall_one_companion(map_session_data *owner, int16_t map_id, uint32_t index_,
	int16_t job_id, char sex, int hair_style, int hair_color, int cloth_color,
	uint32_t garment, uint32_t option_, uint32_t weapon, uint32_t shield, uint32_t head_top,
	uint32_t head_mid, uint32_t head_bottom, uint32_t armor, uint32_t shoes,
	uint32_t acc_l, uint32_t acc_r,
	int base_level, int job_level, int str, int agi, int vit, int intl, int dex, int luk,
	const char* persisted_name,
	uint32_t c_top, uint32_t c_mid, uint32_t c_low, uint32_t c_garment,
	uint32_t sh_armor, uint32_t sh_weapon, uint32_t sh_shield, uint32_t sh_shoes,
	uint32_t sh_acc_l, uint32_t sh_acc_r,
	int pow_, int sta_, int wis_, int spl_, int con_, int crt_,
	int mode_, int duty_, int heal_at_, int emergency_at_,
	const char* skill_preset, const char* gear_detail)
{
	// Deterministic spawn cell next to the owner (small ring for an open spot).
	int16_t x = 0, y = 0; bool placed = false;
	const int dx[8] = {2,-1,1,3,-2,2,-2,4}, dy[8] = {0,0,0,0,0,1,-1,1};
	for (int k = 0; k < 8 && !placed; ++k) {
		int tx = owner->x + dx[k], ty = owner->y + dy[k];
		if (tx >= 0 && ty >= 0 && map_getcell(map_id, tx, ty, CELL_CHKPASS)) { x = (int16_t)tx; y = (int16_t)ty; placed = true; }
	}
	if (!placed) { ShowWarning("population_engine: recall index %u: no open cell near owner (%d,%d)\n", index_, owner->x, owner->y); return; }

	// RAGNAROKMAC (Goal 1): if a live shell with this index is already on the
	// map (char-select relogin keeps the map-server, and the recruited
	// companion, running), do NOT spawn a duplicate: the copy would reuse the
	// same account/char id, map_addiddb would overwrite the id->shell entry,
	// and the original would turn into an unregistered ghost that the stale
	// sweep then releases out of the party. Re-sync the existing shell instead.
	for (map_session_data *existing : g_population_engine_pcs) {
		if (!existing || existing->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_)
			continue;
		if (!existing->state.active || existing->prev == nullptr || map_id2bl(existing->id) != existing)
			continue; // dead or deregistered: a fresh spawn is safe
		pop_companion_set_owner(existing, owner);
		pop_companion_register_local_party(existing, owner);
		if (existing->m != owner->m) {
			pc_setpos(existing, map_id2index(map_id), x, y, CLR_TELEPORT);
			// pc_setpos removed the shell from the block grid (prev==nullptr);
			// shells have no client LoadEndAck to re-add them, so finish the
			// placement here or the stale sweep will reap them in <100 ms.
			pop_shell_finish_map_placement(existing);
			pop_shell_broadcast_map_placement(existing);
			// Re-announce the vehicle now that the shell is definitely on the grid: the
			// option broadcast is AREA-scoped and reaches nobody while it is off-grid.
			population_engine_sync_shell_vehicle(existing);
			population_engine_sync_shell_homunculus(existing);
		} else {
			int16_t fx = existing->x, fy = existing->y;
			if (!pop_companion_formation_cell(existing, owner, fx, fy)) { fx = existing->x; fy = existing->y; }
			if (fx != existing->x || fy != existing->y) {
				pc_setpos(existing, map_id2index(map_id), fx, fy, CLR_TELEPORT);
				pop_shell_finish_map_placement(existing);
				pop_shell_broadcast_map_placement(existing);
			}
			population_engine_sync_shell_vehicle(existing);
			population_engine_sync_shell_homunculus(existing);
		}
		return;
	}

	map_session_data *shell = population_engine_spawn_shell(
		map_id, x, y, index_, job_id, sex,
		(uint8_t)hair_style, (uint16_t)hair_color, weapon, shield, head_top,
		head_mid, head_bottom, option_, cloth_color, garment, nullptr, false, nullptr, 0);

	if (!shell || shell->status.char_id != POPULATION_ENGINE_CHAR_ID_BASE + index_) {
		if (shell) population_engine_shell_release(shell);
		return;
	}

	g_population_engine_pcs.push_back(shell);
	g_population_engine_count++;
	g_population_engine_stats.total_created++;
	g_population_engine_stats.active_units++;

	// RAGNAROKMAC (Goal 1): recalled companions are spawned with pop_cfg=nullptr,
	// so pop.flags misses PSF::Mortal and status_damage treats them as immortal.
	// A companion is always mortal — it must take damage and die like a player.
	shell->pop.flags |= PSF::Mortal;

	// RAGNAROKMAC (Goal 1): restore the companion's persistent name. The name
	// was rolled randomly at recruit time and snapshotted; without this the
	// name (and so the party-window identity) re-rolls on every restart.
	if (persisted_name != nullptr && persisted_name[0] != '\0') {
		safestrncpy(shell->status.name, persisted_name, NAME_LENGTH);
		// NOTE: do NOT call status_set_viewdata here — it would wipe the
		// vd.look table spawn_shell just filled (hair/colors/weapon), making
		// the companion render with default looks (visibly a "different"
		// character). clif reads status.name for PCs; the existing vd is fine.
	}

	// Restore the exact snapshot build the companion had when recruited.
	shell->status.base_level = cap_value(base_level, 1, MAX_LEVEL);
	// RAGNAROKMAC (growth): restore grown trait stats alongside the base stats.
	shell->status.pow = static_cast<int16_t>(pow_);
	shell->status.sta = static_cast<int16_t>(sta_);
	shell->status.wis = static_cast<int16_t>(wis_);
	shell->status.spl = static_cast<int16_t>(spl_);
	shell->status.con = static_cast<int16_t>(con_);
	shell->status.crt = static_cast<int16_t>(crt_);
	// RAGNAROKMAC (Phase 1): restore the saved stance/duty so orders survive a relog
	// (previously the mode reset to Defensive every login).
	shell->pop.companion_mode = static_cast<PopulationCompanionMode>(
		(mode_ < 0 || mode_ > 2) ? 1 : mode_);
	shell->pop.role = static_cast<int8_t>(duty_);
	if (heal_at_ > 0)      shell->pop.companion_heal_at      = static_cast<int16_t>(heal_at_);
	if (emergency_at_ > 0) shell->pop.companion_emergency_at = static_cast<int16_t>(emergency_at_);
	// RAGNAROKMAC (skill selector): restore the player's skill selection. A NULL
	// column means "never chosen" and leaves the shell on the class preset list;
	// a non-NULL one is an explicit choice, even when it is empty (no skills).
	if (skill_preset != nullptr) {
		shell->pop.skill_override_active = true;
		population_engine_companion_parse_skill_override(skill_preset, shell->pop.skill_override);
		// RAGNAROKMAC: ASK FOR THE REBUILD. The shell's lists were seeded earlier in this
		// call while override_active was still false, so they hold the full class list; the
		// per-tick seeder only rebuilds when a list is empty or this flag is set, and it is
		// neither - so without this line a restored selection is stored and displayed but
		// never applied, on every login. That is exactly the state the @companion dump
		// showed: override=1 with attack_n=13 / buff_n=9 against an empty selection.
		shell->pop.skills_need_reseed = true;
	}
	shell->status.job_level  = cap_value(job_level, 1, MAX_LEVEL);
	shell->status.str = str; shell->status.agi = agi;
	shell->status.vit = vit; shell->status.int_ = intl;
	shell->status.dex = dex; shell->status.luk = luk;
	// RAGNAROKMAC: the spawn above spent level 99's points on a job build and left
	// what the build didn't need in status_point / trait_point. The saved build has
	// replaced those stats, so the leftovers are not this companion's: kept, the
	// next growth poll would spend them on top of it, on every recall.
	shell->status.status_point = 0;
	shell->status.trait_point  = 0;

	population_engine_shell_equip_item(shell, armor, index_, "armor");
	population_engine_shell_equip_item(shell, shoes, index_, "shoes");
	// Goal 2: accessories persist too
	if (acc_l) population_engine_shell_equip_item(shell, acc_l, index_, "acc_l", EQP_ACC_L);
	if (acc_r) population_engine_shell_equip_item(shell, acc_r, index_, "acc_r", EQP_ACC_R);
	// v4: costume + shadow + garment gear persists too (traded vanity/shadow items)
	if (c_top)      population_engine_shell_equip_item(shell, c_top, index_, "costume_top", EQP_COSTUME_HEAD_TOP);
	if (c_mid)      population_engine_shell_equip_item(shell, c_mid, index_, "costume_mid", EQP_COSTUME_HEAD_MID);
	if (c_low)      population_engine_shell_equip_item(shell, c_low, index_, "costume_low", EQP_COSTUME_HEAD_LOW);
	if (c_garment)  population_engine_shell_equip_item(shell, c_garment, index_, "costume_garment", EQP_COSTUME_GARMENT);
	if (sh_armor)   population_engine_shell_equip_item(shell, sh_armor, index_, "shadow_armor", EQP_SHADOW_ARMOR);
	if (sh_weapon)  population_engine_shell_equip_item(shell, sh_weapon, index_, "shadow_weapon", EQP_SHADOW_WEAPON);
	if (sh_shield)  population_engine_shell_equip_item(shell, sh_shield, index_, "shadow_shield", EQP_SHADOW_SHIELD);
	if (sh_shoes)   population_engine_shell_equip_item(shell, sh_shoes, index_, "shadow_shoes", EQP_SHADOW_SHOES);
	if (sh_acc_l)   population_engine_shell_equip_item(shell, sh_acc_l, index_, "shadow_acc_l", EQP_SHADOW_ACC_L);
	if (sh_acc_r)   population_engine_shell_equip_item(shell, sh_acc_r, index_, "shadow_acc_r", EQP_SHADOW_ACC_R);
	// Refine, cards, options and the right headgear, before the stats are worked out from them.
	pop_companion_restore_gear_detail(shell, gear_detail);
	// Fill what is still empty. The spawn above put the weapon, shield, garment and headgear on
	// before the saved level was restored (a recall spawns at 99), so a piece above 99 - a Sky
	// Emperor's level-130 book - was refused and left in the bag; and a row saved before the
	// headgear columns held items brought those slots back as nothing. The refused piece goes on
	// now, from the bag, and a slot with nothing to wear gets one from the job's gear set.
	pop_companion_reequip_own(shell, (EQP_HAND_R | EQP_HAND_L | EQP_ARMOR | EQP_SHOES | EQP_GARMENT
		| EQP_HEAD_TOP | EQP_HEAD_MID | EQP_HEAD_LOW | EQP_ACC_L | EQP_ACC_R)
		& ~pop_companion_worn_positions(shell));
	status_calc_pc(shell, SCO_NONE);

	// Mark as the owner's companion and align membership with the owner.
	pop_companion_set_owner(shell, owner);
	if (owner->status.party_id > 0 && owner->status.party_id < 0x70000000) {
		// RAGNAROKMAC: join the owner's party LOCALLY. The char-server round-trip
		// this replaced could never work: the char server persists membership as
		// "UPDATE char SET party_id=N WHERE account_id=? AND char_id=?", and a
		// population shell has no char row, so the UPDATE matched nothing and the
		// shell was left with party_id 0 - invisible to pop_is_companion(), to the
		// stance commands, and to the self-heal sweep. Map-local registration is
		// what the party window draws from and what the engine's checks read;
		// durability comes from this same recall re-running at every login.
		pop_companion_register_local_party(shell, owner);
		ShowInfo("population_engine: recall %u: companion joined party %d locally.\n",
			index_, owner->status.party_id);
	}

	int16_t fx = x, fy = y;
	if (!pop_companion_formation_cell(shell, owner, fx, fy)) { fx = x; fy = y; }
	// pc_setpos takes a map INDEX; map_id is the map's id (owner->m). Passed as-is, the move
	// failed or named another map.
	pc_setpos(shell, map_id2index(map_id), fx, fy, CLR_TELEPORT);
	// pc_setpos removes an on-grid shell from the block grid and only re-adds
	// real players later via their client's LoadEndAck. Shells have no client:
	// finish the placement explicitly, then broadcast the spawn + party dots.
	pop_shell_finish_map_placement(shell);
	pop_shell_broadcast_map_placement(shell);
	// RAGNAROKMAC (vehicles): re-announce the mount/falcon/warg/mado HERE, after the final
	// placement. spawn_shell already applied them, but this path then moves the shell with a
	// second pc_setpos; the client drops and re-adds the entity across that move and the re-add
	// carries no option, so the sprite came back bare while sc.option stayed correct (verified
	// by @companion dump: 0x00100010 WUG|FALCON with no warg drawn). Announcing after the last
	// position change is what makes the bits visible.
	population_engine_sync_shell_vehicle(shell);
	population_engine_sync_shell_homunculus(shell);
}

// RAGNAROKMAC (Goal 1): post-recall self-heal.
//
// Membership is registered locally (pop_companion_register_local_party), so there
// is no async round-trip left to lose - but a shell can still end up outside the
// party: released by the stale sweep while its owner was briefly off-map, or a
// fresh login whose recall ran before the map had the party struct. Two seconds
// after the batch, re-register any of this owner's companions whose party id does
// not match, then resync the owner's party window.
struct pop_recall_verify {
	uint32_t owner_account;
	int16_t owner_map;
};
static TIMER_FUNC(population_engine_recall_verify_timer)
{
	struct pop_recall_verify *ctx = (struct pop_recall_verify *)data;
	if (!ctx) return 0;
	map_session_data *owner = map_id2sd(ctx->owner_account);
	if (owner && owner->state.active && owner->m == ctx->owner_map) {
		const int32 party = owner->status.party_id;
		if (party > 0 && party < 0x70000000) {
			bool retried = false;
			for (map_session_data *shell : g_population_engine_pcs) {
				if (!shell || !shell->state.active) continue;
				// Match on OWNERSHIP, not on pop_is_companion(): that predicate requires
				// the party id this timer exists to repair, so filtering on it made the
				// timer blind to exactly the case it was written for.
				if (!pop_companion_owned_by(shell, owner)) continue;
				if (shell->status.party_id == party) continue;
				ShowInfo("population_engine: recall verify: shell %u (party %d) missing from party %d; re-registering.\n",
					shell->status.char_id, shell->status.party_id, party);
				pop_companion_register_local_party(shell, owner);
				retried = true;
			}
			if (retried) {
				// re-sync the party window after the repairs land
				party_request_info(party, owner->status.char_id);
			}
		}
	}
	delete ctx;
	return 0;
}

/// Recall companions for `owner`.
///
/// @param only_index  when non-zero, recall ONLY the persisted companion with this
///                    shell index. That is what `@companion summon <name>` needs:
///                    the batch form re-recalls and re-places everyone, which
///                    undoes a bench the player just made.
/// A character is leaving the map server (logout, or back to character select): its companions
/// leave with it. Each is saved and despawned now, while the owner's session and party are still
/// whole, so another character of the same account logging in next finds none of them in the
/// world; the owning character's next login recalls them (rows stay active=1, and the release
/// leaves the party with LEAVE, not EXPEL). Before this, the stale sweep released them only once
/// map_id2sd(account) came back empty - which never happens if a sibling character is already
/// logged in - so they stayed behind, listed under the other character, following nobody.
void population_engine_on_owner_quit(map_session_data *owner)
{
	if (owner == nullptr || population_engine_is_population_pc(owner->id))
		return;
	std::vector<map_session_data *> mine;
	for (map_session_data *shell : g_population_engine_pcs) {
		if (shell != nullptr && pop_companion_owned_by(shell, owner))
			mine.push_back(shell);
	}
	for (map_session_data *shell : mine) {
		if (shell->state.active)
			population_engine_persist_companion_gear(shell);
		population_engine_shell_release(shell);
	}
	if (!mine.empty())
		ShowInfo("Population engine: %s left; released %zu companion(s) until they log in again.\n",
			owner->status.name, mine.size());
}

/// Rows saved before companions belonged to a character have owner_char_id 0. The first
/// character of that account to log in after the upgrade claims all of them: those builds
/// had one shared list per account, so whichever character the player picks up first keeps
/// it intact, and nobody's companions are lost or split arbitrarily. Moving one to another
/// character afterwards is "remove" on one and recruit on the other, like any companion.
static void pop_claim_unowned_companions(const map_session_data *owner)
{
	char q[256];
	snprintf(q, sizeof(q),
		"UPDATE `cp_companion_persistence` SET owner_char_id=%u"
		" WHERE owner_account_id=%u AND owner_char_id=0",
		owner->status.char_id, owner->status.account_id);
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) {
		Sql_ShowDebug(mmysql_handle);
		return;
	}
	const uint64 claimed = Sql_NumRowsAffected(mmysql_handle);
	if (claimed > 0)
		ShowInfo("Population engine: %s claimed %llu companion(s) saved before companions were per character.\n",
			owner->status.name, static_cast<unsigned long long>(claimed));
}

int population_engine_recall_companions(map_session_data *owner, uint32_t only_index)
{
	if (!owner || mmysql_handle == nullptr) return 0;
	// The population master switch (Settings -> AI population) covers companions too. Off, the
	// engine loads no databases, so a recalled shell would have no profiles or skills; and no
	// row is read, claimed or changed, so turning it back on brings every companion back.
	if (!battle_config.population_engine_enable) return 0;
	if (population_engine_is_population_pc(owner->id)) return 0;
	pop_claim_unowned_companions(owner);
	const int16_t map_id = (int16_t)owner->m;
	char q[1024]; // must fit the full v4 recall SELECT (~590 bytes with account id)
	snprintf(q, sizeof(q),
		"SELECT shell_index, name, job_id, sex, hair_style, hair_color, cloth_color,"
		" garment_nameid, option_, weapon_nameid, shield_nameid, head_top_nameid,"
		" head_mid_nameid, head_bottom_nameid, armor_nameid, shoes_nameid,"
		" acc_l_nameid, acc_r_nameid, base_level, job_level, str_, agi_, vit_, intl_, dex_, luk_,"
		" pow_, sta_, wis_, spl_, con_, crt_, mode, duty, heal_at, emergency_at,"
		" costume_top_nameid, costume_mid_nameid, costume_low_nameid, costume_garment_nameid,"
		" shadow_armor_nameid, shadow_weapon_nameid, shadow_shield_nameid,"
		" shadow_shoes_nameid, shadow_acc_l_nameid, shadow_acc_r_nameid, skill_preset, given_mask,"
		" rest_below, rest_until, gear_detail FROM `cp_companion_persistence` WHERE owner_account_id=%u AND owner_char_id=%u AND active=1%s",
		owner->status.account_id, owner->status.char_id, only_index != 0 ? " AND shell_index=" : "");
	// The index is a number, so append it rather than parameterising the format.
	if (only_index != 0) {
		char tail[32];
		snprintf(tail, sizeof(tail), "%u", only_index);
		strncat(q, tail, sizeof(q) - strlen(q) - 1);
	}
	if (Sql_Query(mmysql_handle, q) != SQL_SUCCESS) { Sql_ShowDebug(mmysql_handle); return 0; }

	// Read every row before spawning anything. Spawning runs queries of its own on this same
	// handle (the homunculus sync reads its row), and Sql_Query frees the current result - so
	// iterating the result while recalling stopped at the first alchemist-line companion and
	// the rest of the party silently stayed behind.
	std::vector<std::vector<std::pair<bool, std::string>>> rows;
	{
		const size_t ncols = static_cast<size_t>(Sql_NumColumns(mmysql_handle));
		while (SQL_SUCCESS == Sql_NextRow(mmysql_handle)) {
			std::vector<std::pair<bool, std::string>> &r = rows.emplace_back();
			for (size_t c = 0; c < ncols; ++c) {
				char *cell = nullptr;
				Sql_GetData(mmysql_handle, static_cast<int32>(c), &cell, nullptr);
				r.emplace_back(cell != nullptr, cell != nullptr ? cell : "");
			}
		}
		Sql_FreeResult(mmysql_handle);
	}

	int recalled = 0;
	for (const std::vector<std::pair<bool, std::string>> &row : rows) {
		size_t col = 0;
		const char *data = nullptr;
		// NULL comes back as nullptr, as Sql_GetData reported it; a short row reads as NULL.
		auto next = [&row, &col]() -> const char * {
			if (col >= row.size()) { ++col; return nullptr; }
			const std::pair<bool, std::string> &cell = row[col++];
			return cell.first ? cell.second.c_str() : nullptr;
		};
		data = next(); uint32_t index_ = atoi(data);
		data = next(); char namebuf[NAME_LENGTH];
		safestrncpy(namebuf, data != nullptr ? data : "", NAME_LENGTH);
		data = next(); int16_t job_id = atoi(data);
		data = next(); int sexv = atoi(data);
		data = next(); int hair_style = atoi(data);
		data = next(); int hair_color = atoi(data);
		data = next(); int cloth_color = atoi(data);
		data = next(); uint32_t garment = atoi(data);
		data = next(); uint32_t option_ = atoi(data);
		data = next(); uint32_t weapon = atoi(data);
		data = next(); uint32_t shield = atoi(data);
		data = next(); uint32_t head_top = atoi(data);
		data = next(); uint32_t head_mid = atoi(data);
		data = next(); uint32_t head_bottom = atoi(data);
		data = next(); uint32_t armor = atoi(data);
		data = next(); uint32_t shoes = atoi(data);
		data = next(); uint32_t acc_l = atoi(data);
		data = next(); uint32_t acc_r = atoi(data);
		data = next(); int base_level = atoi(data);
		data = next(); int job_level = atoi(data);
		data = next(); int str = atoi(data);
		data = next(); int agi = atoi(data);
		data = next(); int vit = atoi(data);
		data = next(); int intl = atoi(data);
		data = next(); int dex = atoi(data);
		data = next(); int luk = atoi(data);
		data = next(); int pow_ = atoi(data);
		data = next(); int sta_ = atoi(data);
		data = next(); int wis_ = atoi(data);
		data = next(); int spl_ = atoi(data);
		data = next(); int con_ = atoi(data);
		data = next(); int crt_ = atoi(data);
		data = next(); int mode_ = atoi(data);
		data = next(); int duty_ = atoi(data);
		data = next(); int heal_at_ = atoi(data);
		data = next(); int emergency_at_ = atoi(data);
		data = next(); uint32_t c_top = atoi(data);
		data = next(); uint32_t c_mid = atoi(data);
		data = next(); uint32_t c_low = atoi(data);
		data = next(); uint32_t c_garment = atoi(data);
		data = next(); uint32_t sh_armor = atoi(data);
		data = next(); uint32_t sh_weapon = atoi(data);
		data = next(); uint32_t sh_shield = atoi(data);
		data = next(); uint32_t sh_shoes = atoi(data);
		data = next(); uint32_t sh_acc_l = atoi(data);
		data = next(); uint32_t sh_acc_r = atoi(data);
		// v7: the player's skill selection, or NULL when never chosen. A NULL
		// column must stay distinguishable from an empty one (see the selector).
		char presetbuf[512];
		data = next();
		if (data != nullptr)
			safestrncpy(presetbuf, data, sizeof(presetbuf));
		const char* skill_preset = (data != nullptr) ? presetbuf : nullptr;
		data = next(); const uint32_t given_mask = data != nullptr ? static_cast<uint32_t>(strtoul(data, nullptr, 10)) : 0;
		// v11: every worn piece in full; NULL for a row saved before it existed.
		// v12: when it rests; -1 when the row has no such columns.
		data = next(); const int rest_below_ = data != nullptr ? atoi(data) : -1;
		data = next(); const int rest_until_ = data != nullptr ? atoi(data) : -1;
		data = next(); const std::string gear_detail = data != nullptr ? data : "";
		if (index_ == 0 || job_id == 0) continue;
		// The column holds rAthena's e_sex, written from status.sex: 0 = SEX_FEMALE, 1 = SEX_MALE.
		// Read the other way round, every companion came back as the other sex at its first
		// recall and stayed that way. A job with a sex of its own (Bard, Dancer...) keeps it.
		char sex_letter = get_job_required_sex(static_cast<uint16_t>(job_id));
		if (sex_letter == '\0')
			sex_letter = sexv == SEX_MALE ? 'M' : 'F';
		population_engine_recall_one_companion(owner, map_id, index_, job_id, sex_letter,
			hair_style, hair_color, cloth_color, garment, option_, weapon, shield, head_top,
			head_mid, head_bottom, armor, shoes, acc_l, acc_r, base_level, job_level, str, agi, vit, intl, dex, luk,
			namebuf, c_top, c_mid, c_low, c_garment, sh_armor, sh_weapon, sh_shield, sh_shoes, sh_acc_l, sh_acc_r,
			pow_, sta_, wis_, spl_, con_, crt_, mode_, duty_, heal_at_, emergency_at_,
			skill_preset, gear_detail.empty() ? nullptr : gear_detail.c_str());
		// Which of the re-equipped pieces the player gave, and when it rests: restored here rather
		// than threaded through recall_one_companion, the gear narrowed to what the shell wears.
		for (map_session_data *shell : g_population_engine_pcs) {
			if (shell != nullptr && shell->status.char_id == POPULATION_ENGINE_CHAR_ID_BASE + index_) {
				shell->pop.companion_given_mask = given_mask;
				shell->pop.companion_given_mask = pop_companion_given_worn(shell);
				// v12: when it rests. 0 is a real choice (never); -1 is a row without the columns.
				if (rest_below_ >= 0 && rest_below_ <= 90 && rest_until_ >= rest_below_ + 5 && rest_until_ <= 100) {
					shell->pop.companion_rest_below = static_cast<int16_t>(rest_below_);
					shell->pop.companion_rest_until = static_cast<int16_t>(rest_until_);
				}
				break;
			}
		}
		recalled++;
	}
	if (recalled > 0) {
		ShowInfo("Population engine: recalled %d companion(s) for owner %u\n", recalled, owner->status.account_id);
		// Roster changed: refresh any open panel without making it poll.
		population_engine_push_companion_list(owner);
		// RAGNAROKMAC: re-sync the party list after a recall, from the map's own
		// data. party_request_info() was the old approach and cannot work here: it
		// asks the char server to resend a party whose companion rows the char
		// server does not have (shells have no char table row), so nothing came
		// back and the window stayed empty until a later recall pass happened to
		// register. Register every recalled companion locally and broadcast that.
		if (owner->status.party_id > 0 && owner->status.party_id < 0x70000000) {
			struct party_data *p = party_search(owner->status.party_id);
			if (p != nullptr) {
				for (map_session_data *shell : g_population_engine_pcs) {
					if (!shell || !shell->state.active) continue;
					if (!pop_companion_owned_by(shell, owner)) continue;
					pop_companion_register_local_party(shell, owner);
				}
				clif_party_info(*p, nullptr);
			}
			// Self-heal pass 2s later for anything that still did not land (a second
			// recall overlapping the first, or a shell placed after this ran).
			struct pop_recall_verify *ctx = new pop_recall_verify{ owner->status.account_id, (int16_t)owner->m };
			add_timer(gettick() + 2000, population_engine_recall_verify_timer, 0, (intptr_t)ctx);
		}
	}
	return recalled;
}

// Generate bot name Generate bot name — used as last-resort fallback.
// When population_engine_name_bot_fallback=0 (off) produces a deterministic, pronounceable
// name from the same root + consonant bridge + ending structure as population_names.yml.
// When population_engine_name_bot_fallback=1 (on) falls back to the classic "Bot_<id>" format.
static std::string generate_bot_name(uint32_t index) {
	extern struct Battle_Config battle_config;
	if (battle_config.population_engine_name_bot_fallback) {
		char name[NAME_LENGTH];
		snprintf(name, sizeof(name), "Bot_%u", index);
		return std::string(name);
	}
	// Fallback-off: deterministic pronounceable name, with no YAML dependency.
	static const char* const s_start[] = {
		"Ala","Ari","Ava","Bela","Bri","Cae","Cora","Dae",
		"Dari","Eli","Ena","Fae","Fiora","Gala","Hana","Ila",
		"Iri","Jora","Kara","Kira","Lena","Lora","Mara","Mira",
		"Nara","Neri","Ora","Rina","Sera","Tali","Vela","Yuna"
	};
	static const char* const s_mid[] = {
		"b","c","d","f","g","h","k","l","m","n","p",
		"r","s","t","v","w","z","ch","dr","ph","sh","th"
	};
	static const char* const s_end[] = {
		"a","ae","ai","an","ar","as","e","el","en","er","es","i",
		"ia","iel","in","ion","ir","is","o","on","or","os","u","us"
	};
	static constexpr size_t N0 = ARRAYLENGTH(s_start);
	static constexpr size_t NM = ARRAYLENGTH(s_mid);
	static constexpr size_t NE = ARRAYLENGTH(s_end);
	const size_t i0 = index % N0;
	const size_t im = (index / N0) % NM;
	const size_t ie = (index / (N0 * NM)) % NE;
	char name[NAME_LENGTH];
	snprintf(name, sizeof(name), "%s%s%s", s_start[i0], s_mid[im], s_end[ie]);
	return std::string(name);
}

static std::string generate_population_pc_name(uint32_t index, const PopulationEngine* cfg)
{
	const std::string profile_key = cfg != nullptr ? cfg->name_profile : std::string();
	const PopulationNameProfile* prof = population_names_db().find_profile_or_default(profile_key);
	const PopulationNameProfile::Strategy strat = population_effective_name_strategy(prof);

	for (int attempt = 0; attempt < 32; ++attempt) {
		std::string base = population_roll_base_name_from_profile(strat, prof, index, static_cast<uint32_t>(attempt));
		if (prof != nullptr && prof->max_len > 0 && static_cast<int>(base.size()) > prof->max_len)
			base.resize(static_cast<size_t>(prof->max_len));

		std::string full;
		if (cfg != nullptr)
			full += cfg->name_prefix;
		full += base;
		if (cfg != nullptr)
			full += cfg->name_suffix;

		if (full.empty())
			full = generate_bot_name(index);

		if (full.size() > static_cast<size_t>(NAME_LENGTH - 1))
			full.resize(NAME_LENGTH - 1);

		std::string lower = full;
		std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(::tolower(c)); });

		if (population_yaml_name_hits_blocklist(lower)) {
			g_population_engine_stats.name_retries++;
			continue;
		}
		// Reject if a real player online shares the name — avoids identity confusion
		// and systems that match by name. This is an online-only check (no char-DB query).
		if (map_nick2sd(full.c_str(), false) != nullptr) {
			g_population_engine_stats.name_retries++;
			continue;
		}
		return full;
	}
	return generate_bot_name(index);
}

// Get random job ID (only jobs with proper sprites - conservative whitelist)
static int16_t get_random_job_id() {
    // Conservative whitelist of jobs that definitely have proper sprites
    // Based on jobmaster.txt and standard RO jobs that are commonly used
    // Excludes jobs that may pass pcdb_checkid() but don't have client-side sprites
#ifdef RENEWAL
    static const int16_t jobs_with_sprites[] = {
        // Basic 1-1 jobs (core jobs)
        JOB_NOVICE, JOB_SWORDMAN, JOB_MAGE, JOB_ARCHER, JOB_ACOLYTE, JOB_MERCHANT, JOB_THIEF,
        // 2-1 jobs (core jobs)
        JOB_KNIGHT, JOB_PRIEST, JOB_WIZARD, JOB_BLACKSMITH, JOB_HUNTER, JOB_ASSASSIN,
        // 2-2 jobs (core jobs)
        JOB_CRUSADER, JOB_MONK, JOB_SAGE, JOB_ROGUE, JOB_ALCHEMIST, JOB_BARD, JOB_DANCER,
        // Special basic jobs (confirmed to have sprites)
        JOB_SUPER_NOVICE, JOB_GUNSLINGER, JOB_NINJA, JOB_TAEKWON,
        // High/Trans 1-1 jobs
        JOB_NOVICE_HIGH, JOB_SWORDMAN_HIGH, JOB_MAGE_HIGH, JOB_ARCHER_HIGH, JOB_ACOLYTE_HIGH, JOB_MERCHANT_HIGH, JOB_THIEF_HIGH,
        // High/Trans 2-1 jobs
        JOB_LORD_KNIGHT, JOB_HIGH_PRIEST, JOB_HIGH_WIZARD, JOB_WHITESMITH, JOB_SNIPER, JOB_ASSASSIN_CROSS,
        // High/Trans 2-2 jobs
        JOB_PALADIN, JOB_CHAMPION, JOB_PROFESSOR, JOB_STALKER, JOB_CREATOR, JOB_CLOWN, JOB_GYPSY,
        // Baby 1-1 jobs
        JOB_BABY, JOB_BABY_SWORDMAN, JOB_BABY_MAGE, JOB_BABY_ARCHER, JOB_BABY_ACOLYTE, JOB_BABY_MERCHANT, JOB_BABY_THIEF,
        // Baby 2-1 jobs
        JOB_BABY_KNIGHT, JOB_BABY_PRIEST, JOB_BABY_WIZARD, JOB_BABY_BLACKSMITH, JOB_BABY_HUNTER, JOB_BABY_ASSASSIN,
        // Baby 2-2 jobs
        JOB_BABY_CRUSADER, JOB_BABY_MONK, JOB_BABY_SAGE, JOB_BABY_ROGUE, JOB_BABY_ALCHEMIST, JOB_BABY_BARD, JOB_BABY_DANCER, JOB_SUPER_BABY,
        // Special expanded jobs (confirmed in jobmaster.txt)
        JOB_STAR_GLADIATOR, JOB_SOUL_LINKER,
        // 3rd jobs 2-1 (confirmed in jobmaster.txt)
        JOB_RUNE_KNIGHT, JOB_WARLOCK, JOB_RANGER, JOB_ARCH_BISHOP, JOB_MECHANIC, JOB_GUILLOTINE_CROSS,
        // 3rd jobs 2-1 trans (confirmed in jobmaster.txt)
        JOB_RUNE_KNIGHT_T, JOB_WARLOCK_T, JOB_RANGER_T, JOB_ARCH_BISHOP_T, JOB_MECHANIC_T, JOB_GUILLOTINE_CROSS_T,
        // 3rd jobs 2-2 (confirmed in jobmaster.txt)
        JOB_ROYAL_GUARD, JOB_SORCERER, JOB_MINSTREL, JOB_WANDERER, JOB_SURA, JOB_GENETIC, JOB_SHADOW_CHASER,
        // 3rd jobs 2-2 trans (confirmed in jobmaster.txt)
        JOB_ROYAL_GUARD_T, JOB_SORCERER_T, JOB_MINSTREL_T, JOB_WANDERER_T, JOB_SURA_T, JOB_GENETIC_T, JOB_SHADOW_CHASER_T,
        // Baby 3rd jobs (conservative - only base versions)
        JOB_BABY_RUNE_KNIGHT, JOB_BABY_WARLOCK, JOB_BABY_RANGER, JOB_BABY_ARCH_BISHOP, JOB_BABY_MECHANIC, JOB_BABY_GUILLOTINE_CROSS,
        JOB_BABY_ROYAL_GUARD, JOB_BABY_SORCERER, JOB_BABY_MINSTREL, JOB_BABY_WANDERER, JOB_BABY_SURA, JOB_BABY_GENETIC, JOB_BABY_SHADOW_CHASER,
        // Super Novice Expanded
        JOB_SUPER_NOVICE_E, JOB_SUPER_BABY_E,
        // Kagerou/Oboro (confirmed in jobmaster.txt)
        JOB_KAGEROU, JOB_OBORO,
        // Rebellion (confirmed in jobmaster.txt)
        JOB_REBELLION,
        // Baby expanded jobs (conservative - only basic ones)
        JOB_BABY_NINJA, JOB_BABY_TAEKWON, JOB_BABY_GUNSLINGER,
        // Star Emperor/Soul Reaper (only base versions - _2 variants may not have sprites)
        JOB_STAR_EMPEROR, JOB_SOUL_REAPER, JOB_BABY_STAR_EMPEROR, JOB_BABY_SOUL_REAPER,
        // 4th jobs (confirmed in jobmaster.txt - only base versions)
        JOB_DRAGON_KNIGHT, JOB_MEISTER, JOB_SHADOW_CROSS, JOB_ARCH_MAGE, JOB_CARDINAL, JOB_WINDHAWK,
        JOB_IMPERIAL_GUARD, JOB_BIOLO, JOB_ABYSS_CHASER, JOB_ELEMENTAL_MASTER, JOB_INQUISITOR, JOB_TROUBADOUR, JOB_TROUVERE,
        JOB_SKY_EMPEROR, JOB_SOUL_ASCETIC, JOB_SHINKIRO, JOB_SHIRANUI, JOB_NIGHT_WATCH, JOB_HYPER_NOVICE
    };
#else
    // Pre-RE: no 3rd/4th/Summoner-era jobs — they are absent from job_db / skill tree and break fake PC spawn.
    static const int16_t jobs_with_sprites[] = {
        JOB_NOVICE, JOB_SWORDMAN, JOB_MAGE, JOB_ARCHER, JOB_ACOLYTE, JOB_MERCHANT, JOB_THIEF,
        JOB_KNIGHT, JOB_PRIEST, JOB_WIZARD, JOB_BLACKSMITH, JOB_HUNTER, JOB_ASSASSIN,
        JOB_CRUSADER, JOB_MONK, JOB_SAGE, JOB_ROGUE, JOB_ALCHEMIST, JOB_BARD, JOB_DANCER,
        JOB_SUPER_NOVICE, JOB_GUNSLINGER, JOB_NINJA, JOB_TAEKWON,
        JOB_NOVICE_HIGH, JOB_SWORDMAN_HIGH, JOB_MAGE_HIGH, JOB_ARCHER_HIGH, JOB_ACOLYTE_HIGH, JOB_MERCHANT_HIGH, JOB_THIEF_HIGH,
        JOB_LORD_KNIGHT, JOB_HIGH_PRIEST, JOB_HIGH_WIZARD, JOB_WHITESMITH, JOB_SNIPER, JOB_ASSASSIN_CROSS,
        JOB_PALADIN, JOB_CHAMPION, JOB_PROFESSOR, JOB_STALKER, JOB_CREATOR, JOB_CLOWN, JOB_GYPSY,
        JOB_BABY, JOB_BABY_SWORDMAN, JOB_BABY_MAGE, JOB_BABY_ARCHER, JOB_BABY_ACOLYTE, JOB_BABY_MERCHANT, JOB_BABY_THIEF,
        JOB_BABY_KNIGHT, JOB_BABY_PRIEST, JOB_BABY_WIZARD, JOB_BABY_BLACKSMITH, JOB_BABY_HUNTER, JOB_BABY_ASSASSIN,
        JOB_BABY_CRUSADER, JOB_BABY_MONK, JOB_BABY_SAGE, JOB_BABY_ROGUE, JOB_BABY_ALCHEMIST, JOB_BABY_BARD, JOB_BABY_DANCER, JOB_SUPER_BABY,
        JOB_STAR_GLADIATOR, JOB_SOUL_LINKER,
    };
#endif
    
    // Cache filtered list of valid jobs (jobs with view data AND sprites)
    static std::vector<int16_t> valid_jobs;
    static bool initialized = false;
    
    if (!initialized) {
        // Require client view data, server job_db entry, and a valid MAPID (pre-RE rejects renewal-only IDs).
        for (int16_t job_id : jobs_with_sprites) {
            if (!pcdb_checkid(job_id))
                continue;
            if (!job_db.exists(static_cast<uint16_t>(job_id)))
                continue;
            if (pc_jobid2mapid(job_id) == static_cast<uint64_t>(-1))
                continue;
            valid_jobs.push_back(job_id);
        }
        initialized = true;
        
        if (valid_jobs.empty()) {
            ShowError("Population engine: No valid jobs with sprites found! Using JOB_NOVICE as fallback\n");
            valid_jobs.push_back(JOB_NOVICE);
        }
    }
    
    return valid_jobs[rnd() % valid_jobs.size()];
}

// Get a random support-oriented job (ONLY Priest classes as requested)
// Get the required gender for a job (returns 'M' for male-only, 'F' for female-only, '\0' for gender-neutral)
static char get_job_required_sex(uint16_t job_id) {
    // Male-only jobs
    if (job_id == JOB_BARD || job_id == JOB_CLOWN || 
        job_id == JOB_MINSTREL || job_id == JOB_MINSTREL_T ||
        job_id == JOB_BABY_MINSTREL || job_id == JOB_BABY_BARD ||
        job_id == JOB_KAGEROU || job_id == JOB_BABY_KAGEROU ||
        job_id == JOB_TROUBADOUR || job_id == JOB_SHINKIRO) {
        return 'M';
    }
    
    // Female-only jobs
    if (job_id == JOB_DANCER || job_id == JOB_GYPSY ||
        job_id == JOB_WANDERER || job_id == JOB_WANDERER_T ||
        job_id == JOB_BABY_WANDERER || job_id == JOB_BABY_DANCER ||
        job_id == JOB_OBORO || job_id == JOB_BABY_OBORO ||
        job_id == JOB_TROUVERE || job_id == JOB_SHIRANUI) {
        return 'F';
    }
    
    // Gender-neutral jobs
    return '\0';
}

char population_engine_job_required_sex(uint16_t job_id) {
    return get_job_required_sex(job_id);
}

/// Derive weapon/shield sprites from inventory (status.weapon is weapon_type, not a sprite id).
static void population_engine_sync_vd_weapon_shield(map_session_data* sd) {
    if (sd == nullptr)
        return;
    pc_setinventorydata(*sd);
    sd->update_look(LOOK_WEAPON);
    sd->update_look(LOOK_SHIELD);
    if (sd->equip_index[EQI_AMMO] >= 0 && sd->inventory_data[sd->equip_index[EQI_AMMO]] != nullptr) {
        const item_data* ad = sd->inventory_data[sd->equip_index[EQI_AMMO]];
        if (ad->type == IT_AMMO) {
            const t_itemid look = ad->view_id != 0 ? ad->view_id : ad->nameid;
            sd->vd.look[LOOK_SHIELD] = look;
            sd->status.shield = look;
        }
    }
}

// Helper: Find a valid equippable item by equipment type
static uint16_t find_valid_equip_item(uint32 equip_type) {
    // Iterate through actual item database instead of searching by ID
    // This avoids checking thousands of non-existent items
    for (const auto& it : item_db) {
        t_itemid item_id = it.first;
        std::shared_ptr<item_data> id = it.second;
        
        // Skip dummy items (UNKNOWN_ITEM_ID = 512)
        if (!id || id->nameid == UNKNOWN_ITEM_ID)
            continue;
        
        // Check if item matches the equipment type
        if (id->equip && (id->equip & equip_type)) {
            return (uint16_t)item_id;
        }
    }
    
    return 0; // No valid item found
}

// Get appropriate weapon item ID for a job
// Get base job class (1st class) from any job ID
static uint16_t get_base_job(uint16_t job_id) {
    // Map advanced jobs to their base 1st class
    if (job_id == JOB_SWORDMAN || (job_id >= JOB_KNIGHT && job_id <= JOB_ROYAL_GUARD) ||
        (job_id >= JOB_BABY_KNIGHT && job_id <= JOB_BABY_ROYAL_GUARD) ||
        (job_id >= JOB_RUNE_KNIGHT && job_id <= JOB_RUNE_KNIGHT_T) ||
        (job_id >= JOB_ROYAL_GUARD && job_id <= JOB_ROYAL_GUARD_T) ||
        (job_id >= JOB_BABY_RUNE_KNIGHT && job_id <= JOB_BABY_ROYAL_GUARD) ||
        (job_id >= JOB_DRAGON_KNIGHT && job_id <= JOB_IMPERIAL_GUARD)) {
        return JOB_SWORDMAN;
    }
    if (job_id == JOB_MAGE || (job_id >= JOB_WIZARD && job_id <= JOB_SORCERER) ||
        (job_id >= JOB_BABY_MAGE && job_id <= JOB_BABY_SORCERER) ||
        (job_id >= JOB_WARLOCK && job_id <= JOB_WARLOCK_T) ||
        (job_id >= JOB_SORCERER && job_id <= JOB_SORCERER_T) ||
        (job_id >= JOB_BABY_WARLOCK && job_id <= JOB_BABY_SORCERER) ||
        (job_id >= JOB_ARCH_MAGE && job_id <= JOB_ELEMENTAL_MASTER)) {
        return JOB_MAGE;
    }
    if (job_id == JOB_ARCHER ||
        (job_id >= JOB_HUNTER      && job_id <= JOB_RANGER) ||
        (job_id >= JOB_BABY_ARCHER && job_id <= JOB_BABY_RANGER) ||
        (job_id >= JOB_RANGER      && job_id <= JOB_RANGER_T) ||
        job_id == JOB_BABY_RANGER ||
        job_id == JOB_WINDHAWK) {
        return JOB_ARCHER;
    }
    if (job_id == JOB_ACOLYTE || (job_id >= JOB_PRIEST && job_id <= JOB_CARDINAL) ||
        (job_id >= JOB_BABY_ACOLYTE && job_id <= JOB_BABY_ARCH_BISHOP) ||
        (job_id >= JOB_ARCH_BISHOP && job_id <= JOB_ARCH_BISHOP_T) ||
        (job_id >= JOB_BABY_ARCH_BISHOP) ||
        (job_id >= JOB_CARDINAL && job_id <= JOB_INQUISITOR)) {
        return JOB_ACOLYTE;
    }
    if (job_id == JOB_MERCHANT || (job_id >= JOB_BLACKSMITH && job_id <= JOB_GENETIC) ||
        (job_id >= JOB_BABY_MERCHANT && job_id <= JOB_BABY_GENETIC) ||
        (job_id >= JOB_MECHANIC && job_id <= JOB_MECHANIC_T) ||
        (job_id >= JOB_GENETIC && job_id <= JOB_GENETIC_T) ||
        (job_id >= JOB_BABY_MECHANIC && job_id <= JOB_BABY_GENETIC) ||
        (job_id >= JOB_MEISTER && job_id <= JOB_BIOLO)) {
        return JOB_MERCHANT;
    }
    if (job_id == JOB_THIEF || (job_id >= JOB_ASSASSIN && job_id <= JOB_SHADOW_CHASER) ||
        (job_id >= JOB_BABY_THIEF && job_id <= JOB_BABY_SHADOW_CHASER) ||
        (job_id >= JOB_GUILLOTINE_CROSS && job_id <= JOB_GUILLOTINE_CROSS_T) ||
        (job_id >= JOB_SHADOW_CHASER && job_id <= JOB_SHADOW_CHASER_T) ||
        (job_id >= JOB_BABY_GUILLOTINE_CROSS && job_id <= JOB_BABY_SHADOW_CHASER) ||
        (job_id >= JOB_SHADOW_CROSS && job_id <= JOB_ABYSS_CHASER)) {
        return JOB_THIEF;
    }
    // Default to Novice for unknown jobs
    return JOB_NOVICE;
}

uint16_t population_engine_job_base_class(uint16_t job_id)
{
	return get_base_job(job_id);
}

const PopulationEngine *population_engine_resolve_equipment(uint16_t job_id)
{
	auto equipment = population_engine_find_any(job_id);
	if (equipment)
		return equipment.get();
	const uint16_t base_job = get_base_job(job_id);
	if (base_job != job_id) {
		equipment = population_engine_find_any(base_job);
		if (equipment)
			return equipment.get();
	}
	return nullptr;
}

static uint16_t get_job_weapon(uint16_t job_id) {
    // First, try to load from YAML equipment database (exact job match)
    auto equipment = population_engine_find_any(job_id);
    if (equipment && !equipment->weapon_pool.empty()) {
        uint16_t picked = equipment->weapon_pool.size() == 1
            ? equipment->weapon_pool[0]
            : equipment->weapon_pool[rnd() % equipment->weapon_pool.size()];
        if (picked > 0) {
            struct item_data* id = itemdb_search(picked);
            if (id && id->nameid != UNKNOWN_ITEM_ID)
                return picked;
        }
    }

    // Try base job class if exact match not found
    uint16_t base_job = get_base_job(job_id);
    if (base_job != job_id) {
        equipment = population_engine_find_any(base_job);
        if (equipment && !equipment->weapon_pool.empty()) {
            uint16_t picked = equipment->weapon_pool.size() == 1
                ? equipment->weapon_pool[0]
                : equipment->weapon_pool[rnd() % equipment->weapon_pool.size()];
            if (picked > 0) {
                struct item_data* id = itemdb_search(picked);
                if (id && id->nameid != UNKNOWN_ITEM_ID)
                    return picked;
            }
        }
    }
    
    // Fallback to old logic if YAML doesn't have this job
    uint32 equip_type = 0;
    
    // Swordman line - Swords, Spears
    if (job_id == JOB_SWORDMAN || job_id == JOB_KNIGHT || job_id == JOB_CRUSADER ||
        job_id == JOB_LORD_KNIGHT || job_id == JOB_PALADIN || job_id == JOB_RUNE_KNIGHT ||
        job_id == JOB_ROYAL_GUARD || job_id == JOB_BABY_KNIGHT || job_id == JOB_BABY_CRUSADER ||
        job_id == JOB_BABY_RUNE_KNIGHT || job_id == JOB_BABY_ROYAL_GUARD) {
        equip_type = EQP_HAND_R; // Try 1H or 2H weapons
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        // Fallback to common IDs
        uint16_t weapons[] = {1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110,
                              1111, 1112, 1113, 1114, 1115, 1116, 1117, 1118, 1119, 1120,
                              1301, 1302, 1303, 1304, 1305, 1306, 1307, 1308, 1309, 1310};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Mage line - Staves
    if (job_id == JOB_MAGE || job_id == JOB_WIZARD || job_id == JOB_SAGE ||
        job_id == JOB_HIGH_WIZARD || job_id == JOB_PROFESSOR || job_id == JOB_WARLOCK ||
        job_id == JOB_SORCERER || job_id == JOB_BABY_MAGE || job_id == JOB_BABY_WIZARD ||
        job_id == JOB_BABY_SAGE || job_id == JOB_BABY_WARLOCK || job_id == JOB_BABY_SORCERER) {
        equip_type = EQP_HAND_R;
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        uint16_t weapons[] = {1601, 1602, 1603, 1604, 1605, 1606, 1607, 1608, 1609, 1610,
                              1701, 1702, 1703, 1704, 1705, 1706, 1707, 1708, 1709, 1710};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Archer line - Bows
    if (job_id == JOB_ARCHER || job_id == JOB_HUNTER || job_id == JOB_SNIPER ||
        job_id == JOB_RANGER || job_id == JOB_BABY_ARCHER || job_id == JOB_BABY_HUNTER ||
        job_id == JOB_BABY_RANGER) {
        equip_type = EQP_HAND_R;
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        uint16_t weapons[] = {1701, 1702, 1703, 1704, 1705, 1706, 1707, 1708, 1709, 1710,
                              1711, 1712, 1713, 1714, 1715, 1716, 1717, 1718, 1719, 1720};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Acolyte line - Maces
    if (job_id == JOB_ACOLYTE || job_id == JOB_PRIEST || job_id == JOB_MONK ||
        job_id == JOB_HIGH_PRIEST || job_id == JOB_CHAMPION || job_id == JOB_ARCH_BISHOP ||
        job_id == JOB_CARDINAL || job_id == JOB_BABY_ACOLYTE || job_id == JOB_BABY_PRIEST ||
        job_id == JOB_BABY_MONK || job_id == JOB_BABY_ARCH_BISHOP) {
        equip_type = EQP_HAND_R;
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        uint16_t weapons[] = {1501, 1502, 1503, 1504, 1505, 1506, 1507, 1508, 1509, 1510,
                              1511, 1512, 1513, 1514, 1515, 1516, 1517, 1518, 1519, 1520};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Thief line - Daggers, Katars
    if (job_id == JOB_THIEF || job_id == JOB_ASSASSIN || job_id == JOB_ROGUE ||
        job_id == JOB_ASSASSIN_CROSS || job_id == JOB_STALKER || job_id == JOB_GUILLOTINE_CROSS ||
        job_id == JOB_SHADOW_CHASER || job_id == JOB_BABY_THIEF || job_id == JOB_BABY_ASSASSIN ||
        job_id == JOB_BABY_ROGUE || job_id == JOB_BABY_GUILLOTINE_CROSS || job_id == JOB_BABY_SHADOW_CHASER) {
        equip_type = EQP_HAND_R;
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        uint16_t weapons[] = {1201, 1202, 1203, 1204, 1205, 1206, 1207, 1208, 1209, 1210,
                              1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 1259, 1260};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Merchant line - Axes, Maces
    if (job_id == JOB_MERCHANT || job_id == JOB_BLACKSMITH || job_id == JOB_ALCHEMIST ||
        job_id == JOB_WHITESMITH || job_id == JOB_CREATOR || job_id == JOB_MECHANIC ||
        job_id == JOB_GENETIC || job_id == JOB_BABY_MERCHANT || job_id == JOB_BABY_BLACKSMITH ||
        job_id == JOB_BABY_ALCHEMIST || job_id == JOB_BABY_MECHANIC || job_id == JOB_BABY_GENETIC) {
        equip_type = EQP_HAND_R;
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
        uint16_t weapons[] = {1401, 1402, 1403, 1404, 1405, 1406, 1407, 1408, 1409, 1410,
                              1421, 1422, 1423, 1424, 1425, 1426, 1427, 1428, 1429, 1430};
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Bard/Dancer line - Musical/Whip
    if (job_id == JOB_BARD || job_id == JOB_DANCER || job_id == JOB_CLOWN || job_id == JOB_GYPSY ||
        job_id == JOB_MINSTREL || job_id == JOB_WANDERER || job_id == JOB_TROUBADOUR || job_id == JOB_TROUVERE ||
        job_id == JOB_BABY_BARD || job_id == JOB_BABY_DANCER || job_id == JOB_BABY_MINSTREL || job_id == JOB_BABY_WANDERER) {
        // Musical (Bard) or Whip (Dancer)
        if (job_id == JOB_BARD || job_id == JOB_CLOWN || job_id == JOB_MINSTREL || job_id == JOB_TROUBADOUR ||
            job_id == JOB_BABY_BARD || job_id == JOB_BABY_MINSTREL) {
            uint16_t weapons[] = {1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909, 1910}; // Musical
            return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
        } else {
            uint16_t weapons[] = {1801, 1802, 1803, 1804, 1805, 1806, 1807, 1808, 1809, 1810}; // Whip
            return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
        }
    }
    
    // Ninja line - Huuma
    if (job_id == JOB_NINJA || job_id == JOB_KAGEROU || job_id == JOB_OBORO ||
        job_id == JOB_BABY_NINJA || job_id == JOB_BABY_KAGEROU || job_id == JOB_BABY_OBORO) {
        uint16_t weapons[] = {1951, 1952, 1953, 1954, 1955, 1956, 1957, 1958, 1959, 1960}; // Huuma
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Taekwon line - Knuckle
    if (job_id == JOB_TAEKWON || job_id == JOB_STAR_GLADIATOR || job_id == JOB_SOUL_LINKER ||
        job_id == JOB_BABY_TAEKWON || job_id == JOB_BABY_STAR_GLADIATOR || job_id == JOB_BABY_SOUL_LINKER) {
        uint16_t weapons[] = {1851, 1852, 1853, 1854, 1855, 1856, 1857, 1858, 1859, 1860}; // Knuckle
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Gunslinger line - Revolver, Rifle, Gatling, Shotgun
    if (job_id == JOB_GUNSLINGER || job_id == JOB_REBELLION || job_id == JOB_BABY_GUNSLINGER || job_id == JOB_BABY_REBELLION) {
        uint16_t weapons[] = {13101, 13102, 13103, 13104, 13105, 13106, 13107, 13108, 13109, 13110, // Revolver
                              13151, 13152, 13153, 13154, 13155, 13156, 13157, 13158, 13159, 13160, // Rifle
                              13201, 13202, 13203, 13204, 13205, 13206, 13207, 13208, 13209, 13210, // Gatling
                              13251, 13252, 13253, 13254, 13255, 13256, 13257, 13258, 13259, 13260}; // Shotgun
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Sura - Book
    if (job_id == JOB_SURA || job_id == JOB_SURA_T || job_id == JOB_BABY_SURA) {
        uint16_t weapons[] = {1901, 1902, 1903, 1904, 1905, 1906, 1907, 1908, 1909, 1910}; // Book
        return weapons[rnd() % (sizeof(weapons) / sizeof(weapons[0]))];
    }
    
    // Default: No weapon
    return 0;
}

// Get random headgear item ID
static uint16_t get_random_headgear(uint8_t slot) {
    uint32 equip_type = 0;
    if (slot == 0) equip_type = EQP_HEAD_TOP;
    else if (slot == 1) equip_type = EQP_HEAD_MID;
    else if (slot == 2) equip_type = EQP_HEAD_LOW;
    
    // Try to find a valid item first
    if (equip_type != 0) {
        uint16_t found = find_valid_equip_item(equip_type);
        if (found) return found;
    }
    
    // Fallback: Common headgear item IDs (standard RO item IDs)
    // Head Top (slot 0)
    if (slot == 0) {
        uint16_t headgears[] = {5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008, 5009, 5010,
                                5011, 5012, 5013, 5014, 5015, 5016, 5017, 5018, 5019, 5020,
                                5021, 5022, 5023, 5024, 5025, 5026, 5027, 5028, 5029, 5030};
        return headgears[rnd() % (sizeof(headgears) / sizeof(headgears[0]))];
    }
    // Head Mid (slot 1)
    else if (slot == 1) {
        uint16_t headgears[] = {5101, 5102, 5103, 5104, 5105, 5106, 5107, 5108, 5109, 5110,
                                5111, 5112, 5113, 5114, 5115, 5116, 5117, 5118, 5119, 5120};
        return headgears[rnd() % (sizeof(headgears) / sizeof(headgears[0]))];
    }
    // Head Bottom (slot 2)
    else {
        uint16_t headgears[] = {5201, 5202, 5203, 5204, 5205, 5206, 5207, 5208, 5209, 5210,
                                5211, 5212, 5213, 5214, 5215, 5216, 5217, 5218, 5219, 5220};
        return headgears[rnd() % (sizeof(headgears) / sizeof(headgears[0]))];
    }
}

// Get random costume/robe item ID
static uint16_t get_random_costume_robe() {
    // Try to find a valid robe/garment first
    uint16_t found = find_valid_equip_item(EQP_GARMENT);
    if (found) return found;
    
    // Fallback: Common costume/robe item IDs (standard RO item IDs)
    uint16_t robes[] = {25001, 25002, 25003, 25004, 25005, 25006, 25007, 25008, 25009, 25010,
                        25011, 25012, 25013, 25014, 25015, 25016, 25017, 25018, 25019, 25020};
    return robes[rnd() % (sizeof(robes) / sizeof(robes[0]))];
}

bool population_engine_start(const PopulationEngineConfig& config, PopulationEngineStats& stats) {
    int16_t map_id = config.map_id;
    if (g_population_engine_running) {
        ShowWarning("Population engine: Already running, stop it first\n");
        return false;
    }
    struct map_data* mapdata = map_getmapdata(map_id);
    if (!mapdata) {
        ShowError("Population engine: Invalid map_id %d\n", map_id);
        return false;
    }
    {
        std::vector<map_session_data*> prev_shells = std::move(g_population_engine_pcs);
        g_population_engine_count = 0;
        g_next_population_engine_index.store(1);
        population_engine_path_clear_all();
        g_population_engine_stats = PopulationEngineStats();
        g_current_config = config;
        for (auto* prev_sd : prev_shells)
            population_engine_shell_release(prev_sd);
    }

    mapdata = map_getmapdata(map_id);
    if (!mapdata) {
        ShowError("Population engine: Map %d no longer valid after shell cleanup.\n", map_id);
        return false;
    }

    std::vector<map_session_data*> new_shells;
    uint32_t local_errors = 0;

    // Check global population shell limit
    extern struct Battle_Config battle_config;
    size_t current_fake_count = g_population_engine_count.load();
    uint32_t max_allowed = battle_config.population_engine_max_count;
    uint32_t num_to_spawn = config.num_units;
    
    // Adjust num_to_spawn if it would exceed the global limit
    if (current_fake_count + num_to_spawn > max_allowed) {
        num_to_spawn = (current_fake_count < static_cast<size_t>(max_allowed)) ? static_cast<uint32_t>(static_cast<size_t>(max_allowed) - current_fake_count) : 0;
        if (num_to_spawn < config.num_units) {
            ShowWarning("Population engine: Requested %u players but only %u can be spawned (global limit: %u, current: %zu)\n",
                config.num_units, num_to_spawn, max_allowed, current_fake_count);
        }
    }
    
    ShowStatus("Population engine: Spawning %u population PCs on map %d.\n", num_to_spawn, map_id);
    
    for (uint32_t i = 0; i < num_to_spawn; i++) {
        // Check global limit before each spawn (may have changed during loop)
        if (g_population_engine_count.load() >= max_allowed) {
            break; // Reached global limit
        }
        // Find spawn position
        int x = config.spawn_x;
        int y = config.spawn_y;
        
        if (config.spread_units || x <= 0 || y <= 0) {
            // Find a valid walkable position on map
            int16_t search_x = 0, search_y = 0;
            bool found_valid = false;
            
            if (mapdata->xs > 0 && mapdata->ys > 0) {
                // Try multiple times to find a valid walkable cell
                for (int attempts = 0; attempts < 50; attempts++) {
                    // Try map_search_freecell first (finds walkable cells)
                    if (map_search_freecell(nullptr, map_id, &search_x, &search_y, 
                        std::min(20, (int)(mapdata->xs/2)), std::min(20, (int)(mapdata->ys/2)), 1)) {
                        // Double-check it's walkable
                        if (map_getcell(map_id, search_x, search_y, CELL_CHKPASS)) {
                            x = search_x;
                            y = search_y;
                            found_valid = true;
                            break;
                        }
                    }
                    
                    // Fallback: try random position and validate
                    search_x = 50 + (rnd() % std::max(1, static_cast<int>(mapdata->xs - 100)));
                    search_y = 50 + (rnd() % std::max(1, static_cast<int>(mapdata->ys - 100)));
                    search_x = static_cast<int16_t>(std::max(0, std::min(static_cast<int>(search_x), static_cast<int>(mapdata->xs - 1))));
                    search_y = static_cast<int16_t>(std::max(0, std::min(static_cast<int>(search_y), static_cast<int>(mapdata->ys - 1))));
                    
                    if (map_getcell(map_id, search_x, search_y, CELL_CHKPASS)) {
                        x = search_x;
                        y = search_y;
                        found_valid = true;
                        break;
                    }
                }
                
                if (!found_valid) {
                    // Last resort: use a safe default position
                    x = std::max(50, std::min(100, (int)(mapdata->xs / 2)));
                    y = std::max(50, std::min(100, (int)(mapdata->ys / 2)));
                }
            } else {
                // Fallback for maps without size info
                x = 100 + (i % 20) * 5;
                y = 100 + (i / 20) * 5;
            }
        } else {
            // Validate provided coordinates - ensure they're walkable
            x = std::max(0, std::min(x, (int)(mapdata->xs - 1)));
            y = std::max(0, std::min(y, (int)(mapdata->ys - 1)));
            
            // If not walkable, try to find nearby walkable cell
            if (!map_getcell(map_id, x, y, CELL_CHKPASS)) {
                int16_t search_x = x, search_y = y;
                if (!map_search_freecell(nullptr, map_id, &search_x, &search_y, 5, 5, 1)) {
                    // If still can't find, use default
                    x = std::max(50, std::min(100, (int)(mapdata->xs / 2)));
                    y = std::max(50, std::min(100, (int)(mapdata->ys / 2)));
                } else {
                    x = search_x;
                    y = search_y;
                }
            }
        }
        
        // Random appearance - get a job with valid view data
        uint16_t job_id = get_random_job_id();
        
        // Double-check the job has valid view data before spawning
        if (!pcdb_checkid(job_id)) {
            ShowWarning("Population engine: Job %d has no view data, skipping population shell %u", job_id, i);
            g_population_engine_stats.errors++;
            continue;
        }
        
        // Use the client-supported palette limits; spawn profiles may narrow these ranges.
        uint8_t hair_style = MAX_HAIR_STYLE; // Fixed to max (42)
        uint16_t hair_color = static_cast<uint16_t>(population_roll_closed_range(MIN_HAIR_COLOR, MAX_HAIR_COLOR));
        // Try to load equipment from YAML first (exact job match)
        PopulationDbSource pop_src = PopulationDbSource::Main;
        auto equipment = population_engine_find_any(job_id, &pop_src);

        // If not found, try base job class
        if (!equipment) {
            uint16_t base_job = get_base_job(job_id);
            if (base_job != job_id) {
                equipment = population_engine_find_any(base_job, &pop_src);
            }
        }

        // Gender: job-locked classes first; else optional YAML Sex on equipment row
        char sex;
        char required_sex = get_job_required_sex(job_id);
        if (required_sex != '\0') {
            sex = required_sex;
        } else if (equipment && equipment->sex_override >= 0) {
            sex = equipment->sex_override ? 'M' : 'F';
        } else {
            sex = (rnd() % 2) ? 'M' : 'F';
        }
        
        uint16_t weapon, shield, head_top, head_mid, head_bottom, garment;
        struct script_code* init_script = nullptr;
        bool skip_arrow = false;

        auto pick_pool = [](const std::vector<uint16_t>& p) -> uint16_t {
            if (p.empty()) return 0;
            return p.size() == 1 ? p[0] : p[rnd() % p.size()];
        };

        if (equipment) {
            // Use YAML configuration
            weapon      = pick_pool(equipment->weapon_pool);
            shield      = pick_pool(equipment->shield_pool);
            head_top    = pick_pool(equipment->head_top_pool);
            head_mid    = pick_pool(equipment->head_mid_pool);
            head_bottom = pick_pool(equipment->head_bottom_pool);
            garment     = pick_pool(equipment->garment_pool);
            init_script = equipment->script;
            skip_arrow  = equipment->skip_arrow;
        } else {
            // Fallback to old random logic
            weapon = get_job_weapon(job_id);  // Job-specific weapon
            // Try to find a valid shield first
            shield = find_valid_equip_item(EQP_SHIELD);
            if (shield == 0) {
                // Fallback: 50% chance for shield (basic shield ID 2101)
                shield = (rnd() % 2 == 0) ? 2101 : 0;
            }
            head_top = (rnd() % 3 == 0) ? get_random_headgear(0) : 0; // 33% chance for head top
            head_mid = (rnd() % 3 == 0) ? get_random_headgear(1) : 0; // 33% chance for head mid
            head_bottom = (rnd() % 3 == 0) ? get_random_headgear(2) : 0; // 33% chance for head bottom
            garment = (rnd() % 2 == 0) ? get_random_costume_robe() : 0; // 50% chance for random garment / robe look
        }
        
        uint32_t option = 0;
        uint16_t cloth_color = static_cast<uint16_t>(population_roll_closed_range(MIN_CLOTH_COLOR, MAX_CLOTH_COLOR));

        // Collision-safe allocation from the 5 M ID pool.
        uint32_t spawn_index = population_engine_allocate_index();
        if (spawn_index == 0) {
            local_errors++;
            continue; // pool fully exhausted
        }
        const PopulationEngine* pop_cfg = equipment ? equipment.get() : nullptr;
        map_session_data* sd = population_engine_spawn_shell(map_id, x, y, spawn_index, job_id, sex, hair_style,
            hair_color, weapon, shield, head_top, head_mid, head_bottom, option, cloth_color, garment,
            init_script, skip_arrow, pop_cfg, /*map_category=*/0, pop_src);
        
        if (sd) {
            new_shells.push_back(sd);
            g_population_engine_count++;
        } else {
            local_errors++;
        }
    }

    for (auto* sd : new_shells) {
        g_population_engine_pcs.push_back(sd);
        g_population_engine_stats.total_created++;
        g_population_engine_stats.active_units++;
    }
    g_population_engine_stats.errors += local_errors;
    g_population_engine_stats.unit_ids.clear();
    for (auto* sd : g_population_engine_pcs) {
        if (sd) g_population_engine_stats.unit_ids.push_back(sd->id);
    }
    stats = g_population_engine_stats;
    g_population_engine_running = true;
    ShowStatus("Population engine: Created %u population PCs.\n", g_population_engine_stats.total_created);
    return true;
}

void population_engine_stop() {
	population_shell_returns_clear();
    // Cancel all timers first so no stale timer fires after running=false is set
    // or after a subsequent start() sets running=true again.
    // Timer operations are main-thread-only and must not be done under the mutex.
    if (g_autosummon_timer != INVALID_TIMER) {
        const TimerData* td = get_timer(g_autosummon_timer);
        if (td && td->func == population_engine_autosummon_timer)
            delete_timer(g_autosummon_timer, population_engine_autosummon_timer);
        g_autosummon_timer = INVALID_TIMER;
    }
    if (g_pop_chat_timer != INVALID_TIMER) {
        const TimerData* td = get_timer(g_pop_chat_timer);
        if (td && td->func == population_engine_chat_timer)
            delete_timer(g_pop_chat_timer, population_engine_chat_timer);
        g_pop_chat_timer = INVALID_TIMER;
    }
    if (g_population_combat_global_timer != INVALID_TIMER) {
        const TimerData* tdc = get_timer(g_population_combat_global_timer);
        if (tdc && tdc->func == population_engine_global_combat_timer)
            delete_timer(g_population_combat_global_timer, population_engine_global_combat_timer);
        g_population_combat_global_timer = INVALID_TIMER;
    }
    // RAGNAROKMAC: Pool-vendor rotation timer.
    if (g_vendor_rotation_timer != INVALID_TIMER) {
        const TimerData* tdv = get_timer(g_vendor_rotation_timer);
        if (tdv && tdv->func == population_engine_vendor_rotation_timer)
            delete_timer(g_vendor_rotation_timer, population_engine_vendor_rotation_timer);
        g_vendor_rotation_timer = INVALID_TIMER;
    }
    population_engine_path_stop_wander_timer();

    if (!g_population_engine_running && g_population_engine_pcs.empty())
        return;
    ShowStatus("Population engine: Stopping and cleaning up %zu population shells.\n", g_population_engine_pcs.size());
    std::vector<map_session_data*> to_release = std::move(g_population_engine_pcs);
    g_population_engine_count = 0;
    g_next_population_engine_index.store(1);
    g_population_engine_stats = PopulationEngineStats();
    g_population_engine_running = false;
    g_pop_chat_next_tick.clear();
    g_pop_vendor_last_callout.clear();
    population_engine_path_clear_all();
    g_chat_cursor = 0;
    for (map_session_data* sd : to_release)
        population_engine_shell_release(sd);
    population_engine_write_count_sql(0);
    ShowStatus("Population engine: Stopped.\n");
}

// Get statistics
PopulationEngineStats population_engine_get_stats() {
    return g_population_engine_stats;
}

bool population_engine_is_running() {
    return g_population_engine_running;
}

size_t population_engine_get_count() {
	return g_population_engine_count.load();
}

/// Returns true if `id` belongs to a population shell (checks account_id range).
bool population_engine_is_population_pc(int32_t id) {
	block_list *bl = map_id2bl(id);
	if (bl && bl->type == BL_PC) {
		map_session_data *sd = BL_CAST(BL_PC, bl);
		if (sd && IS_POPULATION_ENGINE_ACCOUNT_ID(sd->status.account_id))
			return true;
	}
	return false;
}

bool population_engine_shell_is_mortal(const map_session_data *sd) {
	return sd != nullptr && (sd->pop.flags & PSF::Mortal) != 0;
}

void population_engine_on_shell_damaged(map_session_data *sd, struct block_list *src) {
	if (!sd || !IS_POPULATION_ENGINE_ACCOUNT_ID(sd->status.account_id))
		return;
	sd->pop.last_attacked_tick = gettick();
	sd->pop.last_attacker_id   = (src != nullptr) ? static_cast<uint32_t>(src->id) : 0u;
	// #373 diagnostics: the hit that kills a shell lands here with HP already 0, before pc_dead.
	if (status_isdead(*sd))
		sd->pop.diag_zero_hp_tick = sd->pop.last_attacked_tick;
	// last_damage_received is set by the caller (pc_damage) before calling here.
	// Capture the skill_id from the attacker's unit_data (if any) for SkillUsed condition.
	// unit_data::skill_id holds the skill currently being/just executed by the attacker;
	// it is still set at the point pc_damage is called from skill_attack/skill_castend.
	if (src != nullptr) {
		const unit_data *src_ud = unit_bl2ud(src);
		if (src_ud != nullptr && src_ud->skill_id != 0) {
			sd->pop.last_skill_used_on_me      = src_ud->skill_id;
			sd->pop.last_skill_used_on_me_tick = gettick();
		}
	}
	// Immediately attempt reactive buff casts (fog wall, hide, etc.) mirroring
	// mob_skill_db closedattacked / longrangeattacked event-driven semantics.
	// SelfTargeted / MeleeAttacked / RangeAttacked conditions are satisfied right
	// now (last_attacked_tick is fresh), so don't wait for the next poll tick.
	// RAGNAROKMAC (shell control API): a held shell does not fight back; a mob
	// train has to stay a train.
	if (!population_engine_shell_is_held(sd))
		population_engine_shell_reactive_cast(sd);
}

void population_engine_combat_shell_stop(map_session_data *sd)
{
	if (!sd || !sd->state.population_combat)
		return;
	population_engine_combat_shell_teardown(sd);
}

static std::vector<std::string> population_companion_command_tokens(const char *message)
{
	std::vector<std::string> tokens;
	std::string current;
	if (!message)
		return tokens;
	for (const unsigned char c : std::string(message)) {
		if (std::isalnum(c) || c == '_') {
			current.push_back(static_cast<char>(std::tolower(c)));
		} else if (!current.empty()) {
			tokens.push_back(current);
			current.clear();
		}
	}
	if (!current.empty())
		tokens.push_back(current);
	return tokens;
}

static bool population_companion_has_token(const std::vector<std::string> &tokens, const char *wanted)
{
	return std::find(tokens.begin(), tokens.end(), wanted) != tokens.end();
}

static void population_companion_clear_target(map_session_data *sd)
{
	if (!sd)
		return;
	population_shell_target_change(sd, 0);
	sd->pop.sticky_target_id = 0;
	sd->pop.sticky_until = 0;
	unit_stop_attack(sd);
	if (unit_is_walking(sd))
		unit_stop_walking(sd, USW_FIXPOS);
}

void population_engine_on_party_chat(map_session_data *from_sd, const char *message)
{
	if (!from_sd || !message || !message[0])
		return;
	if (population_engine_is_population_pc(from_sd->id) || from_sd->status.party_id == 0)
		return;
	// Leadership is resolved at command time. A transferred party immediately
	// transfers command authority without rewriting companion ownership.
	if (!party_isleader(from_sd))
		return;

	const std::vector<std::string> tokens = population_companion_command_tokens(message);
	if (tokens.empty())
		return;

	std::set<PopulationCompanionMode> requested_modes;
	if (population_companion_has_token(tokens, "attack"))
		requested_modes.insert(PopulationCompanionMode::Attack);
	if (population_companion_has_token(tokens, "defensive"))
		requested_modes.insert(PopulationCompanionMode::Defensive);
	if (population_companion_has_token(tokens, "passive"))
		requested_modes.insert(PopulationCompanionMode::Passive);
	// Short behavior aliases are deliberately accepted only as the complete
	// message so ordinary discussions about ATK/DEF stats cannot issue orders.
	if (tokens.size() == 1) {
		if (tokens[0] == "atk")
			requested_modes.insert(PopulationCompanionMode::Attack);
		else if (tokens[0] == "def")
			requested_modes.insert(PopulationCompanionMode::Defensive);
		else if (tokens[0] == "pass")
			requested_modes.insert(PopulationCompanionMode::Passive);
	}

	if (requested_modes.size() > 1) {
		clif_displaymessage(from_sd->fd, "Companion command ignored: multiple combat modes found.");
	} else if (requested_modes.size() == 1) {
		const PopulationCompanionMode mode = *requested_modes.begin();
		int changed = 0;
		for (map_session_data *bot : g_population_engine_pcs) {
			if (!pop_is_companion(bot) || bot->status.party_id != from_sd->status.party_id)
				continue;
			bot->pop.companion_mode = mode;
			population_companion_clear_target(bot);
			population_engine_persist_companion_gear(bot); // stance survives restart
			changed++;
		}
		const char *mode_name = mode == PopulationCompanionMode::Attack ? "Attack"
			: mode == PopulationCompanionMode::Passive ? "Passive" : "Defensive";
		char reply[CHAT_SIZE_MAX];
		safesnprintf(reply, sizeof(reply), "Companions: %s mode enabled for %d shell%s.",
			mode_name, changed, changed == 1 ? "" : "s");
		clif_displaymessage(from_sd->fd, reply);
		ShowInfo("Population engine: party leader %s set companion mode %s for party %d (%d shells).\n",
			from_sd->status.name, mode_name, from_sd->status.party_id, changed);
	}

	std::set<PopulationRoleType> requested_roles;
	if (population_companion_has_token(tokens, "tank") || population_companion_has_token(tokens, "tk"))
		requested_roles.insert(PopulationRoleType::Tank);
	if (population_companion_has_token(tokens, "support") || population_companion_has_token(tokens, "supp"))
		requested_roles.insert(PopulationRoleType::Support);
	if (population_companion_has_token(tokens, "attacker") || population_companion_has_token(tokens, "dd"))
		requested_roles.insert(PopulationRoleType::Attacker);
	// A role needs exactly one role word, and only applies to the companion named in the
	// message. Not an early return: the orders below must still be read from a message
	// that sets no role, which is every "taunt" and "recall" the panel sends.
	if (requested_roles.size() == 1) {
		const PopulationRoleType role = *requested_roles.begin();
		for (map_session_data *bot : g_population_engine_pcs) {
			if (!pop_is_companion(bot) || bot->status.party_id != from_sd->status.party_id)
				continue;
			std::string shell_name(bot->status.name);
			std::transform(shell_name.begin(), shell_name.end(), shell_name.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			if (!population_companion_has_token(tokens, shell_name.c_str()))
				continue;
			bot->pop.role = static_cast<int8_t>(role);
			population_companion_clear_target(bot);
			population_engine_persist_companion_gear(bot); // duty survives restart
			const char *role_name = role == PopulationRoleType::Tank ? "Tank"
				: role == PopulationRoleType::Support ? "Support" : "Attacker";
			char reply[CHAT_SIZE_MAX];
			// Send this through the real party channel as the shell. The party-chat
			// command hook only handles packets from real clients, so this reply cannot
			// recursively issue another command.
			safesnprintf(reply, sizeof(reply), "%s : Understood. My role is now %s.",
				bot->status.name, role_name);
			party_send_message(bot, reply, strlen(reply) + 1);
			ShowInfo("Population engine: party leader %s set companion %s role to %s.\n",
				from_sd->status.name, bot->status.name, role_name);
		}
	}

	// --- Orders ---
	// "taunt": the defender (tank-role) companion grabs the owner's current target
	// and drags it in. "recall": teleport every summoned companion to the owner.
	if (population_companion_has_token(tokens, "taunt") || population_companion_has_token(tokens, "pull")) {
		unit_data *owner_ud = unit_bl2ud(from_sd);
		uint32 target = 0;
		if (owner_ud && owner_ud->target > 0)
			target = static_cast<uint32>(owner_ud->target);
		else if (owner_ud && owner_ud->skilltimer != INVALID_TIMER && owner_ud->skilltarget > 0)
			target = static_cast<uint32>(owner_ud->skilltarget);
		int assigned = 0;
		if (target != 0) {
			for (map_session_data *bot : g_population_engine_pcs) {
				if (!pop_is_companion(bot) || bot->status.party_id != from_sd->status.party_id)
					continue;
				if (static_cast<PopulationRoleType>(bot->pop.role) != PopulationRoleType::Tank)
					continue;
				if (pc_isdead(bot)) continue;
				bot->pop.sticky_target_id = static_cast<int>(target);
				bot->pop.sticky_until = gettick() + 15000;
				population_shell_target_change(bot, static_cast<int>(target));
				assigned++;
			}
		}
		char reply[CHAT_SIZE_MAX];
		if (assigned > 0)
			safesnprintf(reply, sizeof(reply), "Companions: defender pulling your target.");
		else if (target == 0)
			safesnprintf(reply, sizeof(reply), "Companions: no target — attack a monster first, then taunt.");
		else
			safesnprintf(reply, sizeof(reply), "Companions: no defender in the party (set one with \"<name> tank\").");
		clif_displaymessage(from_sd->fd, reply);
	}
	if (population_companion_has_token(tokens, "recall")) {
		int moved = 0;
		for (map_session_data *bot : g_population_engine_pcs) {
			if (!pop_is_companion(bot) || bot->status.party_id != from_sd->status.party_id)
				continue;
			if (pc_isdead(bot)) continue;
			if (bot->m == from_sd->m && distance_bl(bot, from_sd) <= 3) continue;
			int16_t tx = from_sd->x, ty = from_sd->y;
			map_search_freecell(from_sd, from_sd->m, &tx, &ty, 2, 2, 0);
			if (pc_setpos(bot, from_sd->mapindex, tx, ty, CLR_TELEPORT) == SETPOS_OK) {
				pop_shell_finish_map_placement(bot);
				pop_shell_broadcast_map_placement(bot);
				moved++;
			}
		}
		char reply[CHAT_SIZE_MAX];
		safesnprintf(reply, sizeof(reply), "Companions: recalled %d to your side.", moved);
		clif_displaymessage(from_sd->fd, reply);
	}
}

void population_engine_on_whisper_to_population_pc(map_session_data* from_sd, map_session_data* bot_sd, const char* message)
{
	if (!from_sd || !bot_sd || !message)
		return;
	if (population_engine_is_population_pc(from_sd->id))
		return;
	if (!population_engine_is_population_pc(bot_sd->id))
		return;
	// RAGNAROKMAC (shell control API): a held shell answers through its script.
	if (population_shell_control_whisper(from_sd, bot_sd, message))
		return;

	// Party request: if the player whispers a party-related keyword the shell accepts or
	// creates a party and invites the player back (mirrors autocombat accept_party_request).
	const bool has_msg = message[0] != '\0';
	if (has_msg) {
		const char* kw_party[]  = { "party", "pt", "join", "invite" };
		bool is_party_request = false;
		for (const char* kw : kw_party) {
			if (stristr(message, kw) != nullptr) {
				is_party_request = true;
				break;
			}
		}
		if (is_party_request) {
			const bool already_recruited = pop_is_companion(bot_sd) &&
				pop_companion_owned_by(bot_sd, from_sd);
			if (!already_recruited && !population_engine_can_recruit_companion(from_sd)) {
				char limit_reply[CHAT_SIZE_MAX];
				safesnprintf(limit_reply, sizeof(limit_reply), "You already have %zu companions.",
					pop_companion_limit());
				clif_wis_message(from_sd, bot_sd->status.name, limit_reply, strlen(limit_reply) + 1,
					pc_get_group_level(bot_sd));
				return;
			}
			// Case A: the player is already in a party and invites the shell → accept immediately.
			if (bot_sd->party_invite > 0 && bot_sd->party_invite_account == from_sd->status.account_id) {
				party_add_member(bot_sd->party_invite, *bot_sd);
				// Acknowledge via a whisper reply.
				const std::vector<std::string>* accept_pool = population_chat_db().lines_for_category("party_invite_accept");
				if (accept_pool && !accept_pool->empty()) {
					const std::string& line = (*accept_pool)[rnd() % accept_pool->size()];
					char buf[CHAT_SIZE_MAX];
					population_engine_format_chat_line(bot_sd, line.c_str(), buf, sizeof(buf));
					clif_wis_message(from_sd, bot_sd->status.name, buf, strlen(buf) + 1, pc_get_group_level(bot_sd));
				}
				return;
			}
			// Case B: shell has a party → invite the player.
			if (bot_sd->status.party_id > 0 && bot_sd->status.party_id < 0x70000000) {
				// Only real (char-server) parties can be extended.
				party_invite(*bot_sd, from_sd);
				return;
			}
			// Case C: nobody has a party → bot creates one and invites immediately after creation.
			// Creating a real party requires char-server round-trip; instead enable accept_party_request
			// so that when the player sends a formal invite the bot auto-accepts.
			bot_sd->pop.accept_party_request = true;
			bot_sd->pop.party_request_account = from_sd->status.account_id;
			bot_sd->pop.party_request_until = gettick() + 60000;
			pop_companion_set_owner(bot_sd, from_sd);
			// Shells can otherwise wander away or reacquire a combat target while
			// the player is trying to open the context menu and send the invite.
			population_shell_target_change(bot_sd, 0);
			bot_sd->pop.sticky_target_id = 0;
			bot_sd->pop.sticky_until = 0;
			bot_sd->pop.last_attacked_tick = 0;
			bot_sd->pop.last_attacker_id = 0;
			bot_sd->pop.detection_cache.cached_monsters.clear();
			bot_sd->pop.detection_cache.last_update = 0;
			bot_sd->pop.mob_tracker.tracked_mobs.clear();
			bot_sd->pop.mob_tracker.last_scan = 0;
			unit_stop_attack(bot_sd);
			unit_stop_walking(bot_sd, USW_FIXPOS);
			// Hint to the player via whisper.
			const std::vector<std::string>* pool = population_chat_db().lines_for_category("party_invite_accept");
			if (pool && !pool->empty()) {
				const std::string& line = (*pool)[rnd() % pool->size()];
				char buf[CHAT_SIZE_MAX];
				population_engine_format_chat_line(bot_sd, line.c_str(), buf, sizeof(buf));
				clif_wis_message(from_sd, bot_sd->status.name, buf, strlen(buf) + 1, pc_get_group_level(bot_sd));
			}
			return;
		}
	}

	population_engine_deliver_chat_reply_locked(bot_sd, from_sd);
}

void population_engine_on_global_chat_mention(map_session_data* from_sd, const char* message)
{
	if (!from_sd || !message || !message[0])
		return;
	if (population_engine_is_population_pc(from_sd->id))
		return;

	extern struct Battle_Config battle_config;
	if (!battle_config.population_engine_chat_enable || !battle_config.population_engine_chat_reply_enable)
		return;

	for (map_session_data* bot : g_population_engine_pcs) {
		if (!bot || !bot->state.active || bot->prev == nullptr)
			continue;
		if (map_id2bl(bot->id) != bot)
			continue;
		if (bot->m != from_sd->m)
			continue;
		if (bot->id == from_sd->id)
			continue;
		if (!bot->status.name[0])
			continue;
		if (population_engine_shell_is_held(bot))
			continue;
		if (stristr(message, bot->status.name) == nullptr)
			continue;
		population_engine_deliver_chat_reply_locked(bot, nullptr);
	}
}

// RAGNAROKMAC: shell control API for mods' NPC scripts (see the file).
#include "population_engine/runtime/population_shell_control.cpp"
#include "population_engine/runtime/population_shell_selling.cpp"

void do_final_population_engine() {
	// Stop first so shells are released while all DB shared_ptrs are still valid.
	// Clearing the DBs before stop() would leave teardown code with null lookups.
	population_engine_stop();
	population_engine_db().clear();
	population_pvp_db().clear();
	population_vendor_pop_db().clear();
	population_shared_db().clear();
	population_chat_db().clear();
	population_spawn_db().clear();
	population_names_db().clear();
	population_skill_db().clear();
}

// ============================================================
// Arena PvP API
// ============================================================

/// Spawn `shell_count` population shells on `map_name` configured for PvP.
/// Shells target real (non-shell) players so a player can observe and engage the AI.
/// spawn_x/y set the spawn-center (0 = random spread).
/// map_search_freecell guarantees walkability for all spawn positions.
/// Shells share fake party ID 0x71000000|map_id so they don't fight each other.
/// Returns the number of shells actually spawned (0 on error).
int population_engine_arena_start(const char* map_name, int shell_count,
                                   int spawn_x, int spawn_y,
                                   uint16_t job_override, int team_id)
{
	if (!map_name || shell_count <= 0 || shell_count > 25)
		return 0;
	const int16 mid = map_mapname2mapid(map_name);
	if (mid < 0) {
		ShowWarning("population_engine_arena_start: unknown map '%s'.\n", map_name);
		return 0;
	}

	// NOTE: We intentionally do NOT call population_engine_arena_stop() here.
	// Scripts (see npc/custom/population/arena.txt) call start() in a loop —
	// once per slot — so they can present a per-slot job menu. Stopping every
	// call would wipe all prior spawns and leave only the last shell standing
	// (which is what produced "5v5 ended up 1v1"). Callers that want a clean
	// arena should call population_arena_stop("<map>") explicitly first; the
	// arena script already does this once before its spawn loop.

	extern struct Battle_Config battle_config;
	const size_t max_global = static_cast<size_t>(battle_config.population_engine_max_count);

	// Job composition selection priority:
	//   1. Explicit job_override (caller passed a single JOB_ id) -> all shells = that job.
	//   2. YAML ArenaJobPool (if non-empty) -> sample with replacement.
	//   3. Built-in fallback compositions keyed on shell_count.
	std::vector<uint16_t> job_pool;
	// Arena composition lives in db/population_pvp.yml. Fall back to the main DB
	// only if the PvP DB has no ArenaJobPool defined (transitional setups).
	const std::vector<uint16_t>& yaml_pool = !population_pvp_db().arena_job_pool().empty()
		? population_pvp_db().arena_job_pool()
		: population_engine_db().arena_job_pool();
	if (job_override != 0) {
		// Validate job_override resolves to a known equipment profile (or its base job).
		// We still spawn even if no profile matches; the spawn path falls back to
		// get_job_weapon() and an empty equipment set (same behaviour as before).
		job_pool.assign(static_cast<size_t>(shell_count), job_override);
	} else if (!yaml_pool.empty()) {
		// Fill shell_count slots by sampling randomly (with replacement) from the YAML pool.
		// This ensures variety — no two consecutive summons will necessarily be the same job.
		job_pool.reserve(static_cast<size_t>(shell_count));
		for (int i = 0; i < shell_count; ++i)
			job_pool.push_back(yaml_pool[rnd() % yaml_pool.size()]);
	} else {
		// Built-in fixed compositions: tank/healer/dps presets for common counts.
		static const uint16_t s_attackers[3] = {
			static_cast<uint16_t>(JOB_ASSASSIN_CROSS),
			static_cast<uint16_t>(JOB_SNIPER),
			static_cast<uint16_t>(JOB_LORD_KNIGHT),
		};
		if (shell_count == 5) {
			job_pool = {
				static_cast<uint16_t>(JOB_PALADIN),
				static_cast<uint16_t>(JOB_HIGH_PRIEST),
				static_cast<uint16_t>(JOB_ASSASSIN_CROSS),
				static_cast<uint16_t>(JOB_SNIPER),
				static_cast<uint16_t>(JOB_LORD_KNIGHT),
			};
		} else if (shell_count == 3) {
			job_pool = {
				static_cast<uint16_t>(JOB_PALADIN),
				static_cast<uint16_t>(JOB_HIGH_PRIEST),
				s_attackers[rnd() % 3],
			};
		} else {
			// 1 or other counts: random attacker; vary the choice so repeated calls differ.
			for (int i = 0; i < shell_count; ++i)
				job_pool.push_back(s_attackers[rnd() % 3]);
		}
	}

	struct map_data* mapdata = map_getmapdata(mid);
	if (!mapdata || !mapdata->cell)
		return 0;

	// Helper: find a walkable cell near (cx,cy) using map_search_freecell.
	// If cx/cy are 0 or invalid, falls back to a random passable cell.
	auto find_spawn_cell = [&](int cx, int cy, int &out_x, int &out_y) -> bool {
		const int radius = 10;
		if (cx > 0 && cy > 0
		    && cx < mapdata->xs && cy < mapdata->ys) {
			// map_search_freecell: when src=nullptr the initial *x/*y is the center.
			int16_t sx = static_cast<int16_t>(cx);
			int16_t sy = static_cast<int16_t>(cy);
			if (map_search_freecell(nullptr, mid, &sx, &sy,
			    static_cast<int16_t>(radius), static_cast<int16_t>(radius), 1)) {
				out_x = sx;
				out_y = sy;
				return true;
			}
		}
		// Fallback: random passable cell anywhere on the map.
		for (int attempt = 0; attempt < 20; ++attempt) {
			int16_t sx = static_cast<int16_t>(std::max(0, std::min(
				static_cast<int>(50 + rnd() % std::max(1, static_cast<int>(mapdata->xs - 100))),
				static_cast<int>(mapdata->xs - 1))));
			int16_t sy = static_cast<int16_t>(std::max(0, std::min(
				static_cast<int>(50 + rnd() % std::max(1, static_cast<int>(mapdata->ys - 100))),
				static_cast<int>(mapdata->ys - 1))));
			if (map_getcell(mid, sx, sy, CELL_CHKPASS)) {
				out_x = sx;
				out_y = sy;
				return true;
			}
		}
		// Last-resort: map_search_freecell across half the map.
		{
			int16_t sx = 0, sy = 0;
			if (map_search_freecell(nullptr, mid, &sx, &sy,
			    static_cast<int16_t>(std::min(20, static_cast<int>(mapdata->xs / 2))),
			    static_cast<int16_t>(std::min(20, static_cast<int>(mapdata->ys / 2))), 1)) {
				out_x = sx;
				out_y = sy;
				return true;
			}
		}
		return false;
	};

	int spawned = 0;
	// Arena shells bypass the PvE autosummon population cap (max_global) — arenas spawn
	// at most 25 shells and must work even when the PvE engine is at capacity. We still
	// honour an absolute hard ceiling to protect the index pool.
	const size_t arena_hard_cap = max_global + static_cast<size_t>(shell_count) + 8u;
	(void)arena_hard_cap; // reserved for future bookkeeping
	for (int i = 0; i < shell_count; ++i) {
		int x = 0, y = 0;
		// Jitter the spawn center per-iteration so multiple shells don't stack on the
		// same cell (map_search_freecell with stack=1 can return the same cell for
		// consecutive identical centers). Spread ~3 cells in a small ring.
		const int jx = spawn_x + ((i % 3) - 1) * 3;
		const int jy = spawn_y + (((i / 3) % 3) - 1) * 3;
		if (!find_spawn_cell(jx, jy, x, y))
			continue;

		// Pick the job for this shell from the arena composition.
		uint16_t job_id = job_pool[static_cast<size_t>(i)];
		PopulationDbSource pop_src = PopulationDbSource::Pvp;
		auto equipment = population_pvp_db().find(job_id);
		if (!equipment) {
			const uint16_t base_job = get_base_job(job_id);
			if (base_job != job_id) equipment = population_pvp_db().find(base_job);
		}
		if (!equipment) {
			// Backward-compatibility fallback: arena composition might still live in
			// db/population_engine.yml during transition. Tag the shell with the DB
			// that actually owned the entry so runtime lookups stay consistent.
			equipment = population_engine_find_any(job_id, &pop_src);
			if (!equipment) {
				const uint16_t base_job = get_base_job(job_id);
				if (base_job != job_id) equipment = population_engine_find_any(base_job, &pop_src);
			}
		}

		char sex;
		const char req_sex = get_job_required_sex(job_id);
		if (req_sex != '\0') sex = req_sex;
		else if (equipment && equipment->sex_override >= 0) sex = equipment->sex_override ? 'M' : 'F';
		else sex = (rnd() % 2) ? 'M' : 'F';

		const uint8_t  hair_style  = MAX_HAIR_STYLE;
		const uint16_t hair_color  = static_cast<uint16_t>(population_roll_closed_range(MIN_HAIR_COLOR, MAX_HAIR_COLOR));
		const uint16_t cloth_color = static_cast<uint16_t>(population_roll_closed_range(MIN_CLOTH_COLOR, MAX_CLOTH_COLOR));

		auto pick_pool = [](const std::vector<uint16_t>& p) -> uint16_t {
			if (p.empty()) return 0;
			return p.size() == 1 ? p[0] : p[rnd() % p.size()];
		};

		uint16_t weapon = 0, shield = 0, head_top = 0, head_mid = 0, head_bottom = 0, garment = 0;
		struct script_code* init_script = nullptr;
		bool skip_arrow = false;
		if (equipment) {
			weapon      = pick_pool(equipment->weapon_pool);
			shield      = pick_pool(equipment->shield_pool);
			head_top    = pick_pool(equipment->head_top_pool);
			head_mid    = pick_pool(equipment->head_mid_pool);
			head_bottom = pick_pool(equipment->head_bottom_pool);
			garment     = pick_pool(equipment->garment_pool);
			init_script = equipment->script;
			skip_arrow  = equipment->skip_arrow;
		} else {
			weapon = get_job_weapon(job_id);
		}

		uint32_t index = population_engine_allocate_index();
		if (index == 0)
			continue; // pool fully exhausted

		const PopulationEngine* pop_cfg = equipment ? equipment.get() : nullptr;
		// Arena shells are always mortal — force the Mortal flag.
		const uint32_t arena_flags = (pop_cfg ? pop_cfg->flags : 0u) | PSF::Mortal | PSF::CombatActive;

		map_session_data* sd = population_engine_spawn_shell(
			mid, x, y, index, job_id, sex, hair_style,
			hair_color, weapon, shield, head_top, head_mid, head_bottom,
			0, cloth_color, garment, init_script, skip_arrow, pop_cfg, 3 /*dungeon category*/, pop_src);

		if (sd) {
			// Override flags to ensure mortal and set arena team marker.
			sd->pop.flags = arena_flags;
			sd->pop.arena_team = static_cast<int8_t>(team_id);

			// Team-specific party ID: team-1 and team-2 shells don't buff each other.
			const uint32_t team_base = (team_id == 2) ? 0x72000000u : 0x71000000u;
			sd->status.party_id = static_cast<int32>(team_base
				| static_cast<uint32>(static_cast<uint16>(mid)));

			g_population_engine_pcs.push_back(sd);
			g_population_engine_count++;
			g_population_engine_stats.total_created++;
			g_population_engine_stats.active_units++;
			++spawned;
		}
	}
	return spawned;
}

/// Remove all arena shells from `map_name` and release them.
void population_engine_arena_stop(const char* map_name)
{
	if (!map_name)
		return;
	const int16 mid = map_mapname2mapid(map_name);
	if (mid < 0)
		return;

	// Partition arena shells out of g_population_engine_pcs FIRST so that the
	// global vector never holds freed pointers. The combat/chat timers iterate
	// g_population_engine_pcs between ticks; leaving freed entries there causes
	// UB when the next sweep reads sd->id from deallocated memory.
	std::vector<map_session_data*> to_release;
	auto new_end = std::remove_if(g_population_engine_pcs.begin(), g_population_engine_pcs.end(),
		[mid, &to_release](map_session_data *sd) {
			if (!sd || sd->pop.arena_team == 0 || sd->m != mid)
				return false;
			to_release.push_back(sd);
			return true;
		});
	const size_t removed = static_cast<size_t>(g_population_engine_pcs.end() - new_end);
	g_population_engine_pcs.erase(new_end, g_population_engine_pcs.end());
	if (g_population_engine_count.load() >= removed)
		g_population_engine_count -= removed;
	else
		g_population_engine_count = 0;

	for (map_session_data *sd : to_release)
		population_engine_shell_release(sd);
}


// -----------------------------------------------------------------------------
// Public accessor: arena PvP job pool (auto-derived from db/population_pvp.yml)
// Used by the buildin script command population_arena_jobs() so NPCs can build
// dynamic Arena Manager menus instead of hard-coding job lists.
// -----------------------------------------------------------------------------
std::vector<uint16_t> population_engine_arena_job_pool()
{
    return population_pvp_db().arena_job_pool();
}

// -----------------------------------------------------------------------------
// Arena PvP — battle target relation hook
// -----------------------------------------------------------------------------
// Bridges the arena_team tag (set by population_engine_arena_start) into
// rAthena's friend-vs-foe machinery. Without this hook, ally shells (team 2)
// have no party/guild/bg link to the real player and `battle_check_target`
// classifies them as neutral — autosupport then refuses to buff/heal the
// player and AoE skills land friend-fire.
//
// Convention used by the arena (see population_arena_start docs):
//   team 1 = enemy shells     (hostile to player + team 2 shells)
//   team 2 = allied shells    (friendly to player + each other)
//   real player on the arena map is implicitly treated as team 2.
//
// Returns +1 (allies), -1 (enemies), 0 (no opinion — let normal logic run).
// Same-map check guarantees we don't leak relations across maps.
// -----------------------------------------------------------------------------
int population_engine_arena_relation(const block_list *s_bl, const block_list *t_bl)
{
    if (!s_bl || !t_bl)
        return 0;
    if (s_bl == t_bl)
        return 0;
    if (s_bl->m != t_bl->m)
        return 0;
    if (s_bl->type != BL_PC || t_bl->type != BL_PC)
        return 0;

    const map_session_data *s_sd = reinterpret_cast<const map_session_data*>(s_bl);
    const map_session_data *t_sd = reinterpret_cast<const map_session_data*>(t_bl);

    const int s_team = s_sd->pop.arena_team;
    const int t_team = t_sd->pop.arena_team;

    // Effective team: real players on a map that has any arena shell are
    // implicitly team 2 (the player's side). For a relation to apply, at
    // least one side must actually be a tagged arena shell — otherwise we
    // have two real players and the engine has no opinion.
    const bool s_is_shell = s_team > 0;
    const bool t_is_shell = t_team > 0;
    if (!s_is_shell && !t_is_shell)
        return 0;

    const int s_eff = s_is_shell ? s_team : 2;
    const int t_eff = t_is_shell ? t_team : 2;

    return (s_eff == t_eff) ? 1 : -1;
}

// PC-only convenience used by the population shell ally scan callbacks so a
// team-2 ally shell will recognise the real player on the same map as a valid
// heal/buff target. Same logic as population_engine_arena_relation but bool.
bool population_engine_arena_is_ally(const map_session_data *a, const map_session_data *b)
{
    if (!a || !b || a == b)
        return false;
    return population_engine_arena_relation(
        reinterpret_cast<const block_list*>(a),
        reinterpret_cast<const block_list*>(b)) > 0;
}
