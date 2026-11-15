// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Mod channel: see mod_channel.hpp for the wire format and the rules.

#include "mod_channel.hpp"

#include <algorithm>
#include <cinttypes>
#include <deque>
#include <string>
#include <unordered_map>

#include <common/showmsg.hpp>
#include <common/socket.hpp>
#include <common/strlib.hpp>
#include <common/timer.hpp>
#include <common/utils.hpp>

#include "battle.hpp"
#include "extensions.hpp"
#include "map.hpp"
#include "mob.hpp"
#include "npc.hpp"
#include "pc.hpp"
#include "script.hpp"
#include "skill.hpp"
#include "status.hpp"

struct mc_binding {
	std::string event;  ///< "<NPC>::<label>"
	bool attach;        ///< run with the player attached (waits while they are in an NPC dialog)
	bool drop;          ///< attached, but dropped instead while they are in an NPC dialog
};
static std::unordered_map<std::string, mc_binding> mc_bindings;

/// A packet for an attached handler, kept while its player is in an NPC dialog.
struct mc_waiting_packet {
	std::string channel;
	uint32 request;
	std::vector<uint8> values;
};
static std::unordered_map<int32, std::deque<mc_waiting_packet>> mc_waiting; ///< char id -> packets
static int32 mc_waiting_timer = INVALID_TIMER;
constexpr size_t MC_WAITING_MAX = 16;

bool mod_channel_enabled() {
	return extension_enabled("mod_channel");
}

bool mod_channel_ready(map_session_data* sd) {
	return sd != nullptr && sd->mc_ready && mod_channel_enabled();
}

bool mod_channel_bind(const char* channel, const char* event, int32 flags) {
	size_t n = strlen(channel);
	if (n == 0 || n >= mod_channel::CHANNEL_LEN || strcmp(channel, "sys") == 0 || strcmp(channel, "ask") == 0)
		return false;
	mc_bindings[channel] = { event, (flags & 3) != 0, (flags & 2) != 0 };
	return true;
}

bool mod_channel_send(map_session_data* sd, const char* channel, uint32 request, const std::vector<uint8>& values) {
	if (!mod_channel_ready(sd) || !session_isActive(sd->fd))
		return false;
	if (mod_channel::HEADER_LEN + values.size() > mod_channel::MAX_PACKET)
		return false;
	// One packet when it fits in MAX_FRAME; else parts, each led by T_PART or (the last) T_LAST.
	constexpr size_t room = mod_channel::MAX_FRAME - mod_channel::HEADER_LEN - 1;
	bool split = mod_channel::HEADER_LEN + values.size() > mod_channel::MAX_FRAME;
	int32 fd = sd->fd;
	size_t at = 0;
	do {
		size_t n = split ? std::min(room, values.size() - at) : values.size();
		size_t len = mod_channel::HEADER_LEN + (split ? 1 : 0) + n;
		WFIFOHEAD(fd, len);
		WFIFOW(fd, 0) = sd->mc_zc;
		WFIFOW(fd, 2) = (uint16)len;
		memset(WFIFOP(fd, 4), 0, mod_channel::CHANNEL_LEN);
		safestrncpy(WFIFOCP(fd, 4), channel, mod_channel::CHANNEL_LEN);
		WFIFOL(fd, 4 + mod_channel::CHANNEL_LEN) = request;
		uint8* p = WFIFOP(fd, mod_channel::HEADER_LEN);
		if (split)
			*p++ = at + n == values.size() ? mod_channel::T_LAST : mod_channel::T_PART;
		if (n > 0)
			memcpy(p, values.data() + at, n);
		WFIFOSET(fd, len);
		at += n;
	} while (at < values.size());
	return true;
}

/// One decoded value.
struct mc_value {
	uint8 type;
	int64 num = 0;
	std::string str;
	std::vector<int32> ints;
	std::vector<std::string> strs;
};

/// Bytes -> values. False on a malformed packet.
static bool mc_parse(const uint8* p, size_t n, std::vector<mc_value>& out) {
	size_t at = 0;
	auto has = [&](size_t k) { return at + k <= n; };
	auto u16 = [&]() { uint16 v = p[at] | p[at + 1] << 8; at += 2; return v; };
	auto i32 = [&]() { int32 v = (int32)((uint32)p[at] | (uint32)p[at + 1] << 8 | (uint32)p[at + 2] << 16 | (uint32)p[at + 3] << 24); at += 4; return v; };
	auto str = [&](std::string& s) -> bool {
		if (!has(2)) return false;
		uint16 len = u16();
		if (!has(len)) return false;
		s.assign((const char*)p + at, len);
		at += len;
		return true;
	};
	while (at < n) {
		mc_value v;
		v.type = p[at++];
		switch (v.type) {
			case mod_channel::T_INT32:
				if (!has(4)) return false;
				v.num = i32();
				break;
			case mod_channel::T_INT64: {
				if (!has(8)) return false;
				uint64 lo = (uint32)i32(), hi = (uint32)i32();
				v.num = (int64)(lo | hi << 32);
				break;
			}
			case mod_channel::T_STR:
				if (!str(v.str)) return false;
				break;
			case mod_channel::T_INT_ARRAY: {
				if (!has(2)) return false;
				uint16 count = u16();
				if (!has((size_t)count * 4)) return false;
				for (uint16 i = 0; i < count; i++)
					v.ints.push_back(i32());
				break;
			}
			case mod_channel::T_STR_ARRAY: {
				if (!has(2)) return false;
				uint16 count = u16();
				for (uint16 i = 0; i < count; i++) {
					v.strs.emplace_back();
					if (!str(v.strs.back())) return false;
				}
				break;
			}
			default:
				return false;
		}
		out.push_back(std::move(v));
	}
	return true;
}

/// Values -> a script state's .@mc_* variables.
static void mc_set_vars(script_state* st, const std::vector<mc_value>& values) {
	std::string fmt;
	for (size_t k = 0; k < values.size(); k++) {
		const mc_value& v = values[k];
		std::string arr = ".@mc_arr" + std::to_string(k);
		switch (v.type) {
			case mod_channel::T_INT32:
			case mod_channel::T_INT64:
				setd_sub_num(st, nullptr, ".@mc_int", (int32)k, v.num, nullptr);
				fmt += 'i';
				break;
			case mod_channel::T_STR:
				setd_sub_str(st, nullptr, ".@mc_str$", (int32)k, v.str.c_str(), nullptr);
				fmt += 's';
				break;
			case mod_channel::T_INT_ARRAY:
				for (size_t i = 0; i < v.ints.size(); i++)
					setd_sub_num(st, nullptr, arr.c_str(), (int32)i, v.ints[i], nullptr);
				setd_sub_num(st, nullptr, ".@mc_int", (int32)k, (int64)v.ints.size(), nullptr);
				fmt += 'I';
				break;
			case mod_channel::T_STR_ARRAY:
				arr += "$";
				for (size_t i = 0; i < v.strs.size(); i++)
					setd_sub_str(st, nullptr, arr.c_str(), (int32)i, v.strs[i].c_str(), nullptr);
				setd_sub_num(st, nullptr, ".@mc_int", (int32)k, (int64)v.strs.size(), nullptr);
				fmt += 'S';
				break;
		}
	}
	setd_sub_num(st, nullptr, ".@mc_n", 0, (int64)values.size(), nullptr);
	setd_sub_str(st, nullptr, ".@mc_fmt$", 0, fmt.c_str(), nullptr);
}

/// Runs a channel's label. Detached (no player attached, .@mc_cid / .@mc_aid say who) unless the binding asks for
/// the player; then the player has no script open (mc_dispatch made sure), and the label may talk to them.
static void mc_run(map_session_data* sd, const mc_binding& b, const char* channel, uint32 request, const std::vector<mc_value>& values) {
	npc_data* nd;
	int32 pos;
	if (!npc_event_resolve(b.event.c_str(), &nd, &pos)) {
		ShowWarning("mod_channel: channel '%s' is bound to '%s', which is not an event.\n", channel, b.event.c_str());
		return;
	}
	if (nd->is_invisible)
		return;
	script_state* st = script_alloc_state(nd->u.scr.script, pos, b.attach ? sd->id : 0, nd->id);
	setd_sub_num(st, nullptr, ".@mc_id", 0, request, nullptr);
	setd_sub_num(st, nullptr, ".@mc_cid", 0, sd->status.char_id, nullptr);
	setd_sub_num(st, nullptr, ".@mc_aid", 0, sd->status.account_id, nullptr);
	mc_set_vars(st, values);
	run_script_main(st);
}

/// Every 100 ms while packets wait: run them for players whose dialog has ended.
static TIMER_FUNC(mc_waiting_tick) {
	mc_waiting_timer = INVALID_TIMER;
	for (auto it = mc_waiting.begin(); it != mc_waiting.end();) {
		map_session_data* sd = map_charid2sd(it->first);
		if (sd == nullptr || !sd->mc_ready) {
			it = mc_waiting.erase(it); // logged out, or a new connection: what waited was for the old one
			continue;
		}
		while (!it->second.empty() && sd->npc_id == 0 && sd->st == nullptr) {
			mc_waiting_packet w = std::move(it->second.front());
			it->second.pop_front();
			auto b = mc_bindings.find(w.channel);
			std::vector<mc_value> values;
			if (b != mc_bindings.end() && mc_parse(w.values.data(), w.values.size(), values))
				mc_run(sd, b->second, w.channel.c_str(), w.request, values);
		}
		it = it->second.empty() ? mc_waiting.erase(it) : std::next(it);
	}
	if (!mc_waiting.empty())
		mc_waiting_timer = add_timer(gettick() + 100, mc_waiting_tick, 0, 0);
	return 0;
}

// ---- channel "ask": what the server knows, answered here, no script ----

/// Monster flags in mobs / scan.
enum : int32 { MCF_AGGRESSIVE = 1, MCF_BOSS = 2, MCF_ON_ME = 4, MCF_ON_PARTY = 8, MCF_ON_OTHER = 16 };

struct mc_mob_list {
	map_session_data* sd;
	std::vector<int32> gid, cls, x, y, hp, maxhp, target, flags;
	const std::vector<int32>* only = nullptr; ///< scan: these classes only (empty: all)
	size_t cap;
};

static int32 mc_collect_mob(block_list* bl, va_list ap) {
	mc_mob_list* l = va_arg(ap, mc_mob_list*);
	mob_data* md = (mob_data*)bl;
	if (l->gid.size() >= l->cap || md->status.hp == 0)
		return 0;
	// Only what the player's client shows: no hidden / cloaked monster, unless they see those (Maya Purple).
	if (!l->sd->special_state.intravision && !status_check_visibility(l->sd, bl, false))
		return 0;
	if (l->only != nullptr && !l->only->empty() && std::find(l->only->begin(), l->only->end(), (int32)md->mob_id) == l->only->end())
		return 0;
	int32 f = 0;
	if (status_has_mode(&md->status, MD_AGGRESSIVE)) f |= MCF_AGGRESSIVE;
	if (md->status.class_ == CLASS_BOSS) f |= MCF_BOSS;
	if (md->target_id != 0) {
		if (md->target_id == l->sd->id)
			f |= MCF_ON_ME;
		else if (map_session_data* tsd = map_id2sd(md->target_id); tsd != nullptr) {
			if (l->sd->status.party_id != 0 && tsd->status.party_id == l->sd->status.party_id)
				f |= MCF_ON_PARTY;
			else
				f |= MCF_ON_OTHER;
		}
	}
	l->gid.push_back(md->id);
	l->cls.push_back(md->mob_id);
	l->x.push_back(md->x);
	l->y.push_back(md->y);
	l->hp.push_back((int32)md->status.hp);
	l->maxhp.push_back((int32)md->status.max_hp);
	l->target.push_back(md->target_id);
	l->flags.push_back(f);
	return 1;
}

static void mc_put_ints(mod_channel::writer& w, const std::vector<int32>& v) {
	w.array(mod_channel::T_INT_ARRAY, (uint32)v.size());
	for (int32 x : v)
		w.i32(x);
}

/// Every int value and int array value from index `from` on, as one list.
static std::vector<int32> mc_ints(const std::vector<mc_value>& values, size_t from) {
	std::vector<int32> out;
	for (size_t k = from; k < values.size(); k++) {
		if (values[k].type == mod_channel::T_INT32 || values[k].type == mod_channel::T_INT64)
			out.push_back((int32)values[k].num);
		else if (values[k].type == mod_channel::T_INT_ARRAY)
			out.insert(out.end(), values[k].ints.begin(), values[k].ints.end());
	}
	return out;
}

///   where                 -> s map, i x, i y, i town (1/0)
///   mobs {r}              -> i x, i y, I gid, I class, I x, I y, I hp, I maxhp, I target, I flags   (within r cells, 14)
///   scan {classes...}     -> I gid, I class, I x, I y, I flags   (the classes given, or all)
///   status <sc ids...>    -> I left: ms to go, -1 without an end, 0 when not on
///   buffs <skill ids...>  -> I left: the same for the status each skill gives (skill_db Status), -2 when it gives none
/// flags: 1 aggressive, 2 boss, 4 fights me, 8 fights my party, 16 fights another player. Dead monsters left out.
/// mobs and scan see only what the player's client is shown anyway (area_size cells around them, no hidden or
/// cloaked monster unless they have intravision): no map hack, no attacking what they can't see.
/// The key ask lists the verbs answered at all; another is answered s "off", s verb.

static void mc_ask(map_session_data* sd, uint32 request, const std::vector<mc_value>& values) {
	if (values.empty() || values[0].type != mod_channel::T_STR)
		return;
	const std::string& verb = values[0].str;
	mod_channel::writer w;
	std::string on = " " + extension_string("mod_channel", "ask", "where mobs scan status buffs") + " ";
	if (on.find(" " + verb + " ") == std::string::npos) {
		w.str("off");
		w.str(verb.c_str());
	} else if (verb == "where") {
		w.str(map_getmapdata(sd->m)->name);
		w.num(sd->x);
		w.num(sd->y);
		w.num(map_getmapflag(sd->m, MF_TOWN) ? 1 : 0);
	} else if (verb == "mobs" || verb == "scan") {
		int32 sight = battle_config.area_size;
		mc_mob_list l;
		l.sd = sd;
		std::vector<int32> only;
		if (verb == "mobs") {
			int32 r = values.size() > 1 && values[1].type == mod_channel::T_INT32 ? (int32)values[1].num : 14;
			r = cap_value(r, 1, sight);
			l.cap = 300;
			map_foreachinallrange(mc_collect_mob, sd, r, BL_MOB, &l);
			w.num(sd->x);
			w.num(sd->y);
		} else {
			only = mc_ints(values, 1);
			l.only = &only;
			l.cap = 600;
			map_foreachinallrange(mc_collect_mob, sd, sight, BL_MOB, &l);
		}
		mc_put_ints(w, l.gid);
		mc_put_ints(w, l.cls);
		mc_put_ints(w, l.x);
		mc_put_ints(w, l.y);
		if (verb == "mobs") {
			mc_put_ints(w, l.hp);
			mc_put_ints(w, l.maxhp);
			mc_put_ints(w, l.target);
		}
		mc_put_ints(w, l.flags);
	} else if (verb == "status" || verb == "buffs") {
		status_change* sc = status_get_sc(sd);
		std::vector<int32> left;
		for (int32 id : mc_ints(values, 1)) {
			if (verb == "buffs") {
				id = (id > 0 && id <= INT16_MAX) ? skill_get_sc((int16)id) : SC_NONE;
				if (id <= SC_NONE) {
					left.push_back(-2);
					continue;
				}
			}
			status_change_entry* sce = (sc != nullptr && id > SC_NONE && id < SC_MAX) ? sc->getSCE((uint32)id) : nullptr;
			int32 ms = 0;
			if (sce != nullptr) {
				const TimerData* td = sce->timer != INVALID_TIMER ? get_timer(sce->timer) : nullptr;
				ms = td != nullptr ? (int32)cap_value(DIFF_TICK(td->tick, gettick()), 1, INT32_MAX) : -1;
			}
			left.push_back(ms);
		}
		mc_put_ints(w, left);
	} else {
		w.str("unknown");
		w.str(verb.c_str());
	}
	if (!w.fits()) {
		ShowWarning("mod_channel: ask '%s' answer too big for '%s'.\n", verb.c_str(), sd->status.name);
		return;
	}
	mod_channel_send(sd, "ask", request, w.buf);
}

/// Channel "sys": hello (start sending to this session) and ping (the values come back, for round-trip times).
static void mc_sys(map_session_data* sd, uint32 request, const uint8* p, size_t n, const std::vector<mc_value>& values) {
	if (values.empty() || values[0].type != mod_channel::T_STR)
		return;
	mod_channel::writer w;
	if (values[0].str == "hello") { // s "hello", i protocol, i the ZC id the client reads (HEADER_ZC without it)
		bool known = values.size() > 2 && values[2].type == mod_channel::T_INT32 && values[2].num == mod_channel::HEADER_ZC_KNOWN;
		sd->mc_zc = known ? mod_channel::HEADER_ZC_KNOWN : mod_channel::HEADER_ZC;
		sd->mc_ready = true;
		w.str("hello");
		w.num(mod_channel::PROTOCOL);
		w.num(extension_int("mod_channel", "rate", 200));
	} else if (values[0].str == "ping") {
		w.buf.assign(p, p + n);
	} else {
		return;
	}
	mod_channel_send(sd, "sys", request, w.buf);
}

void clif_parse_mod_msg(int32 fd, map_session_data* sd) {
	if (sd == nullptr || !mod_channel_enabled())
		return;
	size_t len = RFIFOW(fd, 2);
	if (len < mod_channel::HEADER_LEN)
		return;

	t_tick now = gettick();
	int64 rate = extension_int("mod_channel", "rate", 200);
	if (DIFF_TICK(now, sd->mc_window) >= 1000) {
		sd->mc_window = now;
		sd->mc_count = 0;
	}
	if (++sd->mc_count > rate) {
		if (sd->mc_count == rate + 1)
			ShowWarning("mod_channel: '%s' sends more than %" PRId64 " packets a second; dropping the rest of this second.\n", sd->status.name, rate);
		return;
	}

	char channel[mod_channel::CHANNEL_LEN + 1];
	safestrncpy(channel, RFIFOCP(fd, 4), sizeof(channel));
	uint32 request = RFIFOL(fd, 4 + mod_channel::CHANNEL_LEN);
	const uint8* raw = RFIFOP(fd, mod_channel::HEADER_LEN);
	size_t n = len - mod_channel::HEADER_LEN;
	std::vector<mc_value> values;
	if (!mc_parse(raw, n, values)) {
		ShowWarning("mod_channel: malformed packet on channel '%s' from '%s'.\n", channel, sd->status.name);
		return;
	}

	if (strcmp(channel, "sys") == 0) {
		mc_sys(sd, request, raw, n, values);
		return;
	}
	if (!sd->mc_ready)
		return;
	if (strcmp(channel, "ask") == 0) {
		mc_ask(sd, request, values);
		return;
	}

	auto it = mc_bindings.find(channel);
	if (it == mc_bindings.end())
		return;
	if (!it->second.attach) {
		mc_run(sd, it->second, channel, request, values);
		return;
	}
	// The player's one script slot is taken by an NPC dialog: keep the packet, whole, until it ends.
	auto& q = mc_waiting[sd->status.char_id];
	if (q.empty() && sd->npc_id == 0 && sd->st == nullptr) {
		mc_waiting.erase(sd->status.char_id);
		mc_run(sd, it->second, channel, request, values);
		return;
	}
	if (it->second.drop)
		return;
	if (q.size() >= MC_WAITING_MAX) {
		ShowWarning("mod_channel: '%s' has %d packets waiting for their NPC dialog to end; dropping the oldest.\n", sd->status.name, (int32)MC_WAITING_MAX);
		q.pop_front();
	}
	q.push_back({ channel, request, std::vector<uint8>(raw, raw + n) });
	static bool named = false;
	if (!named) {
		add_timer_func_list(mc_waiting_tick, "mc_waiting_tick");
		named = true;
	}
	if (mc_waiting_timer == INVALID_TIMER)
		mc_waiting_timer = add_timer(gettick() + 100, mc_waiting_tick, 0, 0);
}
