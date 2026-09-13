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

**`@go` is deliberately left out.** Free warping to any town changes how the
game is played, and that belongs behind its own decision — see `common-npcs`,
which ships its warper switched off for the same reason. If you want it, add
`go: true` to `conf/groups.yml`.

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

**Never list a command the group already has.** `parseCommands` treats that as
an error and returns false, which aborts the *whole* group node — the server
starts, logs one warning, and group 0 is left exactly as it was. This is why
`@changedress` and `@resurrect` do not appear above.

Adding commands to group 0 is safe for the groups above it. Groups 1, 2 and the
rest inherit Player, and inheritance skips anything the child already has
(`if( !util::vector_exists( group->commands, command ) )`), so no duplicate is
ever created.
