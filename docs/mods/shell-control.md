# Directing the AI characters from a script

The AI characters ("shells") run themselves: they fight, wander, sit and chat
by the population engine's rules. A mod that wants one to do something
particular — say "gz" when you level, hold a conversation, wall off a warp,
drag a mob train to you — takes it away from the engine for a while and
drives it from an NPC script.

[Making mods](../MODDING.md) is the general guide. This page is the reference
for the `population_*` commands that make the hand-over possible. The
[shell-gz example](../../examples/mods/shell-gz) uses them, and its
`npc:shelltest` NPC lets a GM try each one in game.

## A shell is a real character

That is the whole trick. A shell is a `map_session_data` on the map like any
player, so the stock commands that take a unit id already work on it:

| to make it | use |
|---|---|
| walk to a cell | `unitwalk <gid>, <x>, <y>{, "<npc>::<label>"}` — the label runs when it arrives |
| walk to someone | `unitwalkto <gid>, <target gid>` |
| follow someone | `pcfollow <gid>, <target gid>` / `pcstopfollow <gid>` — through portals too; see below |
| attack | `unitattack <gid>, <target gid>, 1` — 1 keeps attacking; it walks into range first |
| cast | `unitskilluseid <gid>, "<skill>", <level>{, <target gid>}` / `unitskillusepos` |
| say something | `unittalk <gid>, rid2name(<gid>) + " : text"` |
| emote | `emotion <emotion>, <gid>` |
| sit or stand | `sit rid2name(<gid>)` / `stand rid2name(<gid>)` |
| warp | `unitwarp <gid>, "<map>", <x>, <y>` |
| tell its level, job | `readparam(BaseLevel, rid2name(<gid>))`, `readparam(Class, rid2name(<gid>))` — by name: a number there is a character id, not a unit id |

`unittalk` shows its text exactly as given. Real chat reads `Name : text`, so
put the name in front yourself, as above.

Three of these lean on the player's game client for part of their work, and a
shell has none, so **the engine does that part for a shell you hold**:

- `unitattack` only swings at a target already in reach; for anything further
  the server asks the client to walk over. A held shell is walked into range
  instead, and keeps chasing a target that moves.
- `unitwarp` moves the character and waits for the client to say the new map
  has loaded. A held shell's warp is finished within a tenth of a second
  instead. On a shell nobody holds, it leaves the shell off the map and the
  engine clears it away.
- `pcfollow` follows the way a player can. rAthena's own follow teleports a
  follower onto a target it cannot reach, which no player can do after a fly
  wing, so for a held shell the engine runs the follow itself:
  - **through a portal**, the shell notices a moment later, walks into the same
    portal and comes out where you did, a second or two behind you;
  - **any other way out** — a fly wing, a butterfly wing, a Kafra, a Warp
    Portal — the follow ends where it is, and `population_lost_event` tells
    your script so it can react.

  One gap: `pcfollow` takes its first step at once, through rAthena, so a
  target already out of reach when you call it gets the old teleport. Start
  a follow with the target nearby.

**But the engine is driving it too.** Without a hold, the shell's own AI
overrides your `unitwalk` on its next tick. That is what the commands below
are for.

## The commands

Flags and kinds are plain numbers; there are no named constants for them.

### `population_is_shell(<gid>)`

`0` not a shell (a real player, or nothing), `1` ambient, `2` vendor (a
vending stall or buying store), `3` companion (recruited into a player's
party, or with an invitation pending). Event labels such as
`OnPCBaseLvUpEvent` fire for companions too; this is how to skip them.

### `population_shells("<map>", <x>, <y>, <range>, <array>{, <flags>})`

Fills `<array>` with the unit ids of the shells within `<range>` cells of
(x, y), **nearest first**, and returns how many it found, or `-1` for an
unknown map. `<range>` below 0 searches the whole map. Like `getunits`, it
does not clear what the array held past that count, so loop to the returned
number.

With no flags you get only shells you could take: live, ambient, and not held
by any script. Flags add more:

| flag | adds |
|---|---|
| `1` | vendors |
| `2` | shells a script holds, your own included |
| `4` | the dead |

Companions are never listed.

### `population_hold(<gid>{, <milliseconds>})`

Takes the shell away from the engine for that long: default 60000, at least
1000, at most 1800000 (30 minutes). It stops what it was doing, and until the
hold ends the engine does not:

- fight, or fight back when hit
- wander
- say ambient chat lines, or reply to someone mentioning its name
- answer whispers (see `population_whisper_event`)
- warp it back to its own map

Calling it again from the same NPC extends the hold. Returns 1 when held, and
0 for a companion, a vendor, a shell being removed, or one **another NPC**
holds. Holds belong to the NPC that took them, so two mods never fight over
one actor.

A held shell is still a character: monsters can hit it and it can die. A
shell that dies respawns where the engine put it, as usual.

### `population_unhold(<gid>)`

Hands the shell back. Only the NPC that holds it may. Its AI picks up where
the engine sees fit, standing it up first if your script sat it down.

Two cases log out instead of going back:

- a shell `population_spawn` made, unless it was spawned to stay;
- a shell your script left on a map other than its own, which the engine
  would otherwise warp home in plain view.

**A hold also ends by itself** when it lapses or when its NPC no longer
exists (a script reload), in exactly the same way. A script that ends early —
the player logged out mid-`sleep2` — never leaves a frozen shell behind.

### `population_spawn("<map>", <x>, <y>, <job>{, <base level>{, "<name>"{, <sex>{, <flags>}}}})`

Makes one shell, for a character that has to be a particular someone: a
rival, a card hunter, a mentor. `<job>` is an id or a name (`"Wizard"`,
`"High Priest"`); its gear, stats and skills come from that job's population
profile, exactly as an ambient spawn's do, so a job with no profile is
refused. So is a name it does not know (`"Wizzard"`), with a warning in the
map server's log, rather than spawning a Novice.

- `(0, 0)` picks a random cell on the map; a blocked cell moves to a free one
  nearby.
- `<base level>` 0 keeps the profile's roll. Any other level is clamped to the
  profile's band.
- `"<name>"` must not belong to anyone online. `""` keeps a generated one.
  Only characters online are checked: a player who is offline can still have
  that name, and whispers to it reach whichever of the two is found first once
  they log in, so pick names no player would.
- `<sex>` is `SEX_FEMALE`, `SEX_MALE`, or `-1` (the default) to choose. A Bard
  is male whatever you ask.
- Flag `1` keeps it as an ordinary ambient shell once released, instead of
  logging it out.

It arrives **already held by your NPC for 60 seconds**; extend that with
`population_hold`. It counts toward the population limit, not toward the
map's own headcount. Returns its unit id, or 0.

### `population_despawn(<gid>{, <style>})`

Takes a shell out of the world on the next tick: style `0` as a logout (it
just goes), `1` with the teleport-out effect of a fly or butterfly wing.

Only a shell this NPC holds (its own actor), or a free ambient one: never a
vendor (a player may be trading at its stall), a companion, or a shell another
NPC holds for its own scene. Returns 1 when the shell goes, 0 otherwise.

### `population_whisper_event(<gid>, "<npc>::<label>")`

While your NPC holds the shell, a whisper to it runs that label instead of a
canned reply, with the whisperer attached and two variables set:

| | |
|---|---|
| `@shell_gid` | the shell that was whispered |
| `@shell_msg$` | what was said |

`""` turns it off. A held shell with no whisper event does not answer
whispers at all. Releasing the hold clears it.

### `population_whisper(<gid>, "<message>")`

The shell whispers `<message>` to the attached player. Any shell, held or not.

### `population_lost_event(<gid>, "<npc>::<label>")`

While your NPC holds the shell, the label runs when its `pcfollow` loses the
player it follows, with that player attached and two variables set:

| | |
|---|---|
| `@shell_gid` | the shell |
| `@shell_lost` | why: `1` they vanished from the map without a portal (fly wing, a skill); `2` they left the map without one (butterfly wing, Kafra, Warp Portal); `3` they took a portal the shell did not reach within 15 seconds; `4` they went somewhere it cannot walk to |

A portal is not a loss: the shell follows through it. The follow has ended
by the time the label runs, and the shell stands where it is, still held, so
the script decides what comes next — a whisper ("where'd you go?"), a walk,
waiting, or `population_despawn`. Nothing runs for a follow you stopped
yourself, or when the player logs out. `""` turns it off; releasing the hold
clears it.

## Hooks: deaths, chat, chat rooms, guilds and war

These work on ambient shells whether or not your NPC holds them.

### `population_face(<gid>, <body 0-7>{, <head 0 forward, 1 right, 2 left>})`

Turns the shell on the spot, sitting or standing, as the arrow keys turn a
player; everyone around sees it. Body directions run counter-clockwise from 0
(north). Returns `1`, or `0` for something that is not a shell.

### `population_respawn(<gid>, <milliseconds>)`

How long this shell's body lies the next times it dies: that many
milliseconds, `0` for the server's own delay (`population_engine_respawn_min_ms`
to `_max_ms`, 5 s by default), `-1` never — it stays down until
`population_revive` or `population_despawn`. Use `-1` to bring a shell back
yourself: at a Kafra, at a map's portal after a while, after a PvP timer.

### `population_revive(<gid>{, "<map>", <x>, <y>})`

Stands a dead shell up with full HP and SP, where it lies or on the cell given.
`1` done, `0` not a dead shell.

### `population_death_event("<npc>::<label>")`

Runs that label every time an ambient shell dies, with `$@pop_dead_gid` set to
it, before the engine decides when it stands up — so the label can call
`population_respawn` for this death. One label for the whole server; `""` turns
it off. A shell at war (`population_war`) that dies on a PvP or GvG map comes
here too, rather than being sent to its save point as a player is.

### `population_chat_event("<npc>::<label>")`

Runs that label, attached to the player, whenever a real player says something
in public chat; `@pop_chat$` is the text. Not while they are in an NPC dialog.
For a shell that answers "anyone got an orc dungeon warp?".

### `population_chatroom(<gid>, "<title>", <limit>{, <public>})` / `population_chatroom_close(<gid>)`

Opens a chat room owned by the shell, as a player does with Alt+C: the sign over
its head, and anyone can walk in. The limit is 2-20; public defaults to 1.
`1` opened (or closed), `0` not a shell or already in (or not in) a room.

### `population_guild("<name>", <n>, "<master>"{, "<emblem>"{, "<titles>"}})`

Makes shell guild `n` (1-9999) and returns its guild id, `1900000000 + n`; `0`
for an `n` out of range. Calling it again for the same `n` updates the name,
titles and emblem in place.

- The emblem is a 24×24 BMP as a hex string (magenta is see-through); `""`
  keeps the one it has.
- Titles are `"Guild Master|Officer|Member"`, position 0 first.
- A shell guild exists only in the map server: it is never saved, so make it
  again in `OnInit`. The char server never hears of it, and a real player
  cannot join it.

### `population_guild_join(<gid>, <guild id>{, <title>})` / `population_guild_leave(<gid>)`

Puts a shell in a shell guild with that title (default 2). Its name, title and
emblem show over its head, and GvG and WoE treat it as that guild. The shell
named as master takes the master's slot. `0` for a shell already in a real guild,
a guild that is not a shell guild, or a full one (76 members).

### `population_guild_ally(<guild id>, <guild id>, <how>)`

`0` makes two shell guilds allies (they do not fight on GvG maps), `1` enemies
(the guild window's antagonist), `-1` neither.

### `population_war(<gid>, <1 on, 0 off>)`

Puts a shell at war: it becomes mortal, and its combat picks whoever the map's
rules make its enemy — other guilds on a GvG or WoE map, anyone outside its
guild on a PvP map, real players included — and on GvG maps the Emperium and the
guardians, after the people around them. Heals and buffs go to its guild and
allies only. A held shell at war still fights. `0` puts it back as it was.

For the castle to go to the shell's guild when it breaks the Emperium, turn on
`setbattleflag "population_engine_shell_kill_events", 1;` (off by default): the
castle's `OnAgitBreak` then runs with the shell attached, as it does for a
player. `2` does the same for every monster's death event, not only the
Emperium's and the guardians'.

A shell guild is never saved as a castle's owner: the char server is told the
castle is unowned, while this map server keeps it as the shell guild's. After a
restart the castle is unowned until your script gives it back (remember the
owner in a permanent variable and `setcastledata` it again in `OnAgitInit`), so
nothing in the database points at a guild that no longer exists.

### `population_engine_who_extra`

A battle flag, not a command: `setbattleflag "population_engine_who_extra", <n>;`
adds `n` to the online count `/w` shows. For a mod that counts people it does
not spawn, to spare the server. 0 (the default) shows the real count.

The engine fights only where a real player can see it (that is what keeps
dozens of maps cheap), so a war you are not watching is the script's to decide —
a roll for which guild holds each castle — and the shells fight it out where you
are.

## A scene, start to finish

```c
// Every ten minutes, a wizard near the south gate walls it off and flies away.
// (Written for this page and not yet run in game.)
-	script	gate_prank	-1,{
OnTimer600000:
	initnpctimer; // again in ten minutes
	.@n = population_shells("prontera", 156, 40, 25, .@gid);
	for (.@i = 0; .@i < .@n; .@i++)
		if (readparam(Class, rid2name(.@gid[.@i])) == Job_Wizard && population_hold(.@gid[.@i], 90000))
			break;
	if (.@i == .@n) end;
	.@w = .@gid[.@i];
	unitwalk .@w, 156, 44;
	sleep 6000;
	unitskillusepos .@w, "WZ_ICEWALL", 5, 156, 40;
	sleep 1500;
	unittalk .@w, rid2name(.@w) + " : lol";
	emotion ET_HNG, .@w;
	sleep 3000;
	population_despawn .@w, 1;  // fly-wings off before anyone catches them
	end;
OnInit:
	initnpctimer;
	end;
}
```

## What is not here

- **Picking up a particular item, or speaking on a channel** have no stock
  command and no shell command yet.
- **Ambient behaviour** — shells logging out on their own, emotes when hit,
  fewer of them at night — is the engine's business, not a script's.
