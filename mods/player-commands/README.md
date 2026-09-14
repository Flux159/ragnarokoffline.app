# player-commands

`@autoloot` and `@showexp` for everybody, not just the account the app made.

**It ships switched off.** Settings → Mods → tick it → Apply, then relog.

## The problem it fixes

rAthena sorts atcommands into player groups. Group 1, *Super Player*, holds the
quality-of-life set — `@autoloot`, `@showexp`, `@mobinfo` and friends. Group 0,
*Player*, is what every new account gets, and it holds exactly two commands:

```yaml
- Id: 0
  Name: Player
  Commands:
    changedress: true
    resurrect: true
```

Playing on your own you never notice, because `sql/03-account.sql` creates the
`ragnarok` account as group 99 (Admin, `all_commands: true`) and everything
works. It shows up the moment somebody joins your LAN server and makes their own
account with `_M` / `_F`: they land in group 0, type `@autoloot`, and get
*Unknown command*.

GM level is per **account**, not per character, so this is not something a
player can fix by making a new character.

## What it grants

Seventeen commands, all of them ones rAthena already considers player-safe —
every one is taken from Super Player, nothing is invented here.

| | |
|---|---|
| Loot | `@autoloot` `@alootid` `@autoloottype` |
| What a kill was worth | `@showexp` `@showzeny` `@showdelay` |
| Discoverability | `@commands` `@help` |
| Information | `@rates` `@mobinfo` `@iteminfo` `@whodrops` `@servertime` `@uptime` |
| Convenience | `@noks` `@noask` `@refresh` |

`@commands` and `@help` are in there on purpose: without them a player has no
way to discover that any of the rest arrived.

## `@go`, as an option

Free warping to any town changes how the game is played, so it is not in the
list above. It is one tick away: **Settings → Mods → player-commands → Also
give everyone @go**, then Apply.

Two things to know before you tick it:

- **`@go` goes to a fixed list.** Its destinations are compiled into the map
  server (`ACMD_FUNC(go)` in `src/map/atcommand.cpp`): the main towns, and —
  added in our rAthena fork, in renewal only — `@go eden` and `@go para` (Para
  Market). Both are renewal content: in pre-renewal their maps have no NPCs and
  no way out, so they are not offered there. Type `@go` on its own for the
  list. A name it does not know shows that list rather
  than warping you anywhere. Dungeons and fields are not on it; the warper in
  `common-npcs` covers those.
- **It is the only one of these that changes the game** rather than informing
  you about it, which is why it is behind its own switch — the same reason
  `common-npcs` ships its warper switched off.

The option is `conf/when/allow_go/groups.yml`: a file that is part of the mod
only while the setting of that name is on. See *Options that change the
server* in [docs/MODDING.md](../../docs/MODDING.md).

Also left out: `@autotrade`, `@request`, `@breakguild`, `@channel`, `@langtype`,
`@whereis`, `@jailtime`, `@hominfo`, `@homstats`. Nothing is wrong with them;
they are just not what this mod is for.

## How it works

`conf/groups.yml` is one of only two files a mod may supply **whole** rather
than key by key — `atcommands.yml` is the other. Both are documents, not lists
of settings, so there is no sensible way to express them as `key: value` lines.
See `CONF_WHOLE_FILE` in `stack/src/mods.rs`.

The supervisor writes it to `state/conf/groups.yml`, which is bound into the
container at `/rathena/conf/import`, and rAthena's own `conf/groups.yml` already
ends with:

```yaml
Footer:
  Imports:
  - Path: conf/import/groups.yml
```

So dropping the file in place is the entire mechanism. Switching the mod off
**removes** the file, so a grant cannot outlive the mod that made it.

## Two things to know if you edit it

**It merges, it does not replace.** `PlayerGroupDatabase::parseBodyNode` looks
the group up first, and for one that already exists neither `Name` nor `Level`
is required — only the fields present are touched. That is why this file lists
no `Permissions`: group 0 keeps `can_trade`, `can_party` and `attendance` from
the base file. Redefining them here would be a way to take them away by
accident.

**A command the group already has is taken out for you.** rAthena's
`parseCommands` treats a repeat as an error and aborts the *whole* group node,
so group 0 would be left exactly as it was. The supervisor removes any command a
group already holds — from rAthena's own `groups.yml` or from another mod that
loaded first — before the server sees it, and says so in the log:

```
mods: my-mod gives group 0 @autoloot, which player-commands already gives it -- left out, ...
```

That is also why two mods can both grant commands now: every enabled mod's
`groups.yml` is combined into one, rather than the last one replacing the rest.

Adding commands to group 0 is safe for the groups above it. Groups 1, 2 and the
rest inherit Player, and inheritance skips anything the child already has
(`if( !util::vector_exists( group->commands, command ) )`), so no duplicate is
ever created.
