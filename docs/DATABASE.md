# Reading and repairing the database

Everything the server remembers — accounts, characters, what is in their bags,
their homunculi, their guilds — is rows in a MariaDB database called
`ragnarok`. Settings shows a little of it and changes less. This is the door to
the rest.

Almost nobody needs it. It is here for the two cases where nothing else works:
a character that has got into a state the game has no button for, and a
question about what the server actually stored, as opposed to what the client
is drawing.

```
ragnarok-stack sql [--write] [--file <path>] [<statement>]
```

## Where the command is

The supervisor binary ships inside the app and is the same one the app itself
runs. It is not on your `PATH`; give the full path, or alias it.

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Ragnarok Offline/runtime/bin/ragnarok-stack` |
| Linux | `~/.local/share/Ragnarok Offline/runtime/bin/ragnarok-stack` |
| Windows | `%APPDATA%\Ragnarok Offline\runtime\bin\ragnarok-stack.exe` |

A shortcut, so the rest of this page can say `rostack`:

```sh
# macOS
alias rostack="$HOME/Library/Application Support/Ragnarok Offline/runtime/bin/ragnarok-stack"

# Linux
alias rostack="$HOME/.local/share/Ragnarok Offline/runtime/bin/ragnarok-stack"
```

```powershell
# Windows, in PowerShell
Set-Alias rostack "$env:APPDATA\Ragnarok Offline\runtime\bin\ragnarok-stack.exe"
```

```
rostack status
```

It needs no arguments and no environment. It finds the engine, the database and
the app's state from its own location.

**The examples below are written for a POSIX shell**, where `` \` `` escapes the
backquotes that `char` needs. PowerShell uses the backquote as its own escape
character, so quote those statements with single quotes instead and nothing
needs escaping:

```powershell
rostack sql 'SELECT char_id, name, homun_id FROM `char`'
```

Heredocs are POSIX-only as well. On PowerShell, put a multi-statement script in
a file and pass `--file`.

**The server has to be running.** The database lives in a container, inside the
microVM, on a network that publishes no port to your machine, which is why
there is no host and port to connect a normal client to and why this command
exists at all. If the app is closed, the answer is "Start this era's server
first" — open the app and press play, or run `ragnarok-stack up`.

**Renewal and pre-renewal are two separate databases**, with separate
characters. The command always talks to the one that is running, and refuses if
the running database and the selected era disagree.

## Reading

A read runs against the live server and changes nothing. No flag needed:

```sh
rostack sql "SELECT char_id, name, base_level, class FROM \`char\`"
```

Statements arrive as an argument, on standard input, or in a file:

```sh
rostack sql <<'SQL'
SELECT COUNT(*) FROM login;
SELECT COUNT(*) FROM `char`;
SQL

rostack sql --file ~/look.sql
```

Rows come back as tab-separated values with a header row, on stdout. Everything
else — progress, errors — goes to stderr, so a pipe gets clean data. A failing
statement exits non-zero and prints what MariaDB said, including the line.

Anything that is not `SELECT`, `SHOW`, `DESCRIBE` or `EXPLAIN` is refused
without a `--write` flag. That is a guard against a mistyped `UPDATE`, not a
security boundary — the owner of the machine can already do anything.

## Writing

```sh
rostack sql --write "UPDATE \`char\` SET homun_id = 0 WHERE char_id = 150000"
```

`--write` does three things before your statements run, and they are the reason
to use it rather than reaching for the container yourself:

1. **It saves a backup**, into `state/backups/before-sql-<era>-<random>.sql`,
   and prints the path. `char` and `homunculus` are MyISAM tables with no
   transaction to roll back, so this is the undo.
2. **It stops the game servers**, and starts again afterwards whichever ones
   were running. This is the part that matters. rAthena holds characters,
   homunculi, pets and inventories in memory and writes them back on save, so
   an edit made underneath a running map server is overwritten within the
   minute — and nothing tells you. The `UPDATE` reports a row changed, the game
   goes on with the old value, and it looks like the database ignored you.
3. **It checks which era's database is mounted**, so an edit cannot land in the
   world you are not playing.

Anyone logged in is disconnected while this runs. On a single-player install
that is you, and you should be at the character select screen or out of the
game entirely.

Batch related changes into one invocation rather than one `--write` per
statement: each one is a full stop and start.

## Limits

A statement may be up to 16 KiB, a result up to 64 KiB, and a call has 30
seconds. Narrow a large read with `LIMIT` or fewer columns. These are the
bounds the rest of the app's database plumbing has always used; nothing here is
meant to be a reporting tool.

## What is in there

rAthena's schema, unmodified, plus one table of ours. The full definitions are
in `vendor/rathena/sql-files/main.sql`; these are the ones worth knowing.

| Table | Holds |
|---|---|
| `login` | accounts: `userid`, `user_pass`, `group_id` (99 is GM), `state` (0 normal, 5 banned) |
| `char` | characters, and the pointers to everything attached to one: `homun_id`, `pet_id`, `party_id`, `guild_id` |
| `inventory`, `cart_inventory`, `storage`, `guild_storage` | items, by `char_id` or `account_id` |
| `homunculus`, `skill_homunculus` | homunculi and their skills, by `homun_id` |
| `pet`, `mercenary`, `elemental` | the other things that follow a character |
| `skill` | learned skills, by `char_id` |
| `quest`, `achievement`, `friends`, `hotkey`, `memo` | per-character odds and ends |
| `char_reg_num`, `char_reg_str`, `global_acc_reg_num`, `global_acc_reg_str` | script variables — where most NPC and quest state actually lives |
| `sc_data` | status changes saved across a logout |
| `guild`, `party`, `mail`, `vendings` | the social side |
| `cp_population_stats` | ours, not rAthena's: the population engine's live shell count |

`char` is quoted in SQL — `` `char` `` — because it is also a type name.

## A homunculus that is not there

The worked example, because it is the one that brought this page into
existence. The symptom: the homunculus is invisible, autofeed has stopped
consuming food, and Call, Rest and Resurrect all fail with no message — and so
does feeding it a new Embryo, because the game is sure you already have one.

Start with what the character points at, and what is on the other end:

```sh
rostack sql "SELECT c.char_id, c.name, c.homun_id, h.homun_id AS row_found, h.name AS homun,
                    h.class, h.level, h.vaporize, h.hp, h.max_hp, h.hunger, h.intimacy
             FROM \`char\` c LEFT JOIN homunculus h ON h.homun_id = c.homun_id
             WHERE c.name = 'YourCharacter'"
```

`char.homun_id` is 0 when the character has no homunculus. Anything else is a
pointer into `homunculus`, and two columns there explain almost every case.

| What you see | What it is | The fix |
|---|---|---|
| `vaporize` 0, `hp` above 0 | out and active | nothing is wrong in the database; look at the client |
| `vaporize` 0, `hp` 0 | **dead** | Call refuses a homunculus that was never vaporized, and Resurrect needs the Alchemist skill and a Blue Gemstone, so a player without both is stuck |
| `vaporize` 1 | resting | normal; Call brings it back |
| `vaporize` 2 | **morphing** | the real dead end, below |
| `row_found` is `NULL` | the row is gone | the homunculus no longer exists; clear the pointer |

Revive a dead one and put it to rest, so Call works:

```sh
rostack sql --write "UPDATE homunculus SET hp = max_hp, sp = max_sp, vaporize = 1 WHERE homun_id = <row_found>"
```

State 2 is the Homunculus S mutation, half done. `morphembryo` in an NPC script
vaporizes the homunculus into that state and hands over a Strange Embryo;
`homunculus_mutate` takes the Strange Embryo back and undoes it. Lose the item
between the two and there is no way out: rAthena tests for state 2 by name in
`hom_call`, `hom_vaporize` and `hom_ressurect`
(`vendor/rathena/src/map/homunculus.cpp`) and refuses each one, while
`char.homun_id` stays set and blocks creating another. It takes an evolved
homunculus at level 99 to get into, so it is only possible for a character that
went through that quest.

```sh
rostack sql --write "UPDATE homunculus SET vaporize = 1 WHERE homun_id = <row_found>"
```

If `row_found` came back `NULL`, the character points at a homunculus that is
not in the table. Clear the pointer; the next Embryo makes a new one, and the
old homunculus is gone either way.

```sh
rostack sql --write "UPDATE \`char\` SET homun_id = 0 WHERE char_id = <char_id>"
```

`alive` is in the table and means nothing — the char server neither reads nor
writes it. `hp` is the column that decides whether a homunculus is dead.

While you are here, look at `state/crashes/`. An unexpected map-server exit is
preserved there, and a crash is one of the ways a homunculus and its character
stop agreeing about what happened.

Log in afterwards and check the change took. If it seems to have been
forgotten, the game was running when you made it — that is exactly what
`--write` is for, so make sure you passed it.

## Other things people ask for

Make an account a GM, or take it back. Settings → Accounts creates, disables
and re-passwords accounts but does not change groups, so this is the only way:

```sh
rostack sql "SELECT account_id, userid, group_id FROM login"
rostack sql --write "UPDATE login SET group_id = 99 WHERE userid = 'name'"
```

Find where a character is stranded, and move it:

```sh
rostack sql "SELECT name, last_map, last_x, last_y, online FROM \`char\`"
rostack sql --write "UPDATE \`char\` SET last_map = 'prontera', last_x = 156, last_y = 191 WHERE char_id = <id>"
```

See what a character is carrying:

```sh
rostack sql "SELECT i.nameid, i.amount, i.equip, i.refine
             FROM inventory i JOIN \`char\` c USING (char_id)
             WHERE c.name = 'YourCharacter'"
```

Characters left marked online by a crash. The char server clears these when it
starts, so reach for this only if one survives a restart:

```sh
rostack sql "SELECT name, online FROM \`char\` WHERE online <> 0"
rostack sql --write "UPDATE \`char\` SET online = 0"
```

Unban an account. `state` is 0 for a normal account and 5 for a banned one:

```sh
rostack sql --write "UPDATE login SET state = 0, unban_time = 0 WHERE userid = 'name'"
```

## Backups

`--write` saves one every time, into the app's own backup directory, which is
inside the state folder and is not cleaned up for you. Delete the ones you do
not want.

For a backup you keep, use Settings → **Save Data** → Backup, or:

```sh
rostack backup ~/Desktop/ragnarok.sql
rostack restore ~/Desktop/ragnarok.sql
```

`restore` replaces the whole database and takes its own pre-restore backup
first. Both stop the game; `backup` starts it again afterwards and `restore`
leaves it stopped, so restart the server yourself once a restore is done.

## For an agent working on someone's install

Everything above, condensed:

- The binary is at the path in the table above, takes no environment, and needs
  the server running. `ragnarok-stack status` says whether it is.
- `sql` reads. `sql --write` writes, and stopping the game around the write is
  not optional — a write against a running map server is silently lost.
- Output is TSV with a header on stdout; errors are on stderr with a non-zero
  exit. Results are capped at 64 KiB, so page with `LIMIT`.
- `vendor/rathena/sql-files/main.sql` is the schema. `vendor/rathena/src/map/`
  is the code that decides what a value means — read that before inferring a
  rule from a column name.
- Take a copy of anything before changing it, and check the change survived a
  login before saying it worked.
