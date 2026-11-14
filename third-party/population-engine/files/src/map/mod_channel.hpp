// Copyright (c) rAthena Dev Teams - Licensed under GNU GPL
// For more information, see LICENCE in the main folder
//
// Mod channel: client mods and NPC scripts talk over their own packets instead of chat.
//
//   CZ_MOD_MSG 0x0cfe / ZC_MOD_MSG 0x0cff, variable length:
//   [u16 id][u16 length][char channel[16]][u32 request][values...]
//   value = [u8 type][data]: 1 int32, 2 int64, 3 string (u16 bytes + bytes), 4 int32 array (u16 count + int32s),
//           5 string array (u16 count + strings)
//   The ids are the last two of rAthena's packet table (MAX_PACKET_DB), far from the official ones (0x0bfb in
//   2025): a new official packet must not land on ours. Protocol 1 used 0x0b81 / 0x0bbb, both inside that range.
//   A client reads a packet's length from its own table, and roBrowser's can't take a new id yet (no hook): such a
//   client says so in its hello and gets ZC as HEADER_ZC_KNOWN instead, an id its table already has as variable.
//   A ZC message over MAX_FRAME bytes goes in parts, each led by T_PART (more to come) or T_LAST, which the
//   client puts back together (same channel and request): no packet over 2 KB on the wire.
//
// Behind the server extension `mod_channel` (db/extension_db.yml, off by default): while it is off, packets are
// ignored and the script commands do nothing. A client sends nothing until a script told it the extension is on
// (getextension("mod_channel")); a stock server drops the connection on an unknown packet. The server sends
// nothing to a session that did not say hello on channel "sys", so a client that can't read 0x0cff never gets
// one. Channel "ask" is answered here (where, mobs, scan, status), without any script, within the player's sight
// (area_size). A packet on another
// channel runs the label a script bound with modchannel: with no player attached (.@mc_cid / .@mc_aid say who), so
// an open NPC dialog is not in the way; or, bound with flag 1, with the player attached, after their dialog ends
// (flag 2: attached, but dropped while a dialog is open, for polls).
//
// A client packet must stay well under 2 KB, and a client must not send many at once: rAthena parses 3 packets of a
// client per cycle and drops the connection without a word when its 2 KB receive buffer fills (common/socket.cpp).

#ifndef MOD_CHANNEL_HPP
#define MOD_CHANNEL_HPP

#include <cstddef>
#include <cstdint>
#include <cinttypes>
#include <cstring>
#include <vector>

#include <common/cbasetypes.hpp>

class map_session_data;

namespace mod_channel {
constexpr uint16 HEADER_CZ = 0x0cfe;
constexpr uint16 HEADER_ZC = 0x0cff;
constexpr uint16 HEADER_ZC_KNOWN = 0x0bbb;  ///< for a client whose packet table has no room for HEADER_ZC
constexpr size_t CHANNEL_LEN = 16;          ///< bytes on the wire, NUL padded: 15 characters at most
constexpr size_t HEADER_LEN = 4 + CHANNEL_LEN + 4;
constexpr size_t MAX_PACKET = 16384;       ///< a whole message, all its parts
constexpr size_t MAX_FRAME = 2000;         ///< one ZC packet
constexpr int32 PROTOCOL = 2;              ///< also extension value "protocol", which the client's NPC reads

enum : uint8 { T_INT32 = 1, T_INT64 = 2, T_STR = 3, T_INT_ARRAY = 4, T_STR_ARRAY = 5, T_PART = 0xf0, T_LAST = 0xf1 };

/// Builds the values part of a packet.
struct writer {
	std::vector<uint8> buf;
	bool overflow = false;

	void u8(uint8 v) { buf.push_back(v); }
	void u16(uint16 v) { u8(v & 0xff); u8(v >> 8); }
	void i32(int32 v) { for (int i = 0; i < 4; i++) u8((uint32)v >> (8 * i) & 0xff); }
	void i64(int64 v) { for (int i = 0; i < 8; i++) u8((uint64)v >> (8 * i) & 0xff); }
	void raw_str(const char* s) {
		size_t n = strlen(s);
		if (n > 0xffff) { overflow = true; n = 0xffff; }
		u16((uint16)n);
		buf.insert(buf.end(), s, s + n);
	}
	void num(int64 v) {
		if (v >= INT32_MIN && v <= INT32_MAX) { u8(T_INT32); i32((int32)v); }
		else { u8(T_INT64); i64(v); }
	}
	void str(const char* s) { u8(T_STR); raw_str(s); }
	/// Starts an array of `n` values; then call i32 (T_INT_ARRAY) or raw_str (T_STR_ARRAY) n times.
	void array(uint8 type, uint32 n) {
		if (n > 0xffff) { overflow = true; n = 0xffff; }
		u8(type); u16((uint16)n);
	}
	bool fits() const { return !overflow && HEADER_LEN + buf.size() <= MAX_PACKET; }
};
}

/// Script command modchannel: a packet on `channel` runs `event` ("<NPC>::On<Label>"), detached, or with the player
/// attached for flag 1 (then it waits while they are in an NPC dialog) or flag 2 (dropped while they are in one).
/// False for a bad name.
bool mod_channel_bind(const char* channel, const char* event, int32 flags);
/// Sends ZC_MOD_MSG to `sd`. False when the session has not said hello or the packet is too big.
bool mod_channel_send(map_session_data* sd, const char* channel, uint32 request, const std::vector<uint8>& values);
bool mod_channel_ready(map_session_data* sd);
bool mod_channel_enabled();
/// CZ_MOD_MSG handler (clif_packetdb.hpp).
void clif_parse_mod_msg(int32 fd, map_session_data* sd);

#endif /* MOD_CHANNEL_HPP */
