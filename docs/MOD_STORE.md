# The mod store: data a mod keeps for itself

> **Experimental (new in 1.5.2).** The API may still change before 1.6, after
> mod developers have tried it ([#440](https://github.com/Flux159/ragnarokoffline.app/issues/440)).
> Data a mod stores now is kept across such changes.

A mod can keep its own data between server starts: **key/value storage** with
three scopes. NPC scripts and Lua hooks read and write it; the mod's client
UI can read what the mod puts under `client`.
- **Writes** go through the store, never through SQL. Mods' `query_sql` and
  `query_logsql` are read-only.
- **Isolation:** a mod only ever sees its own store.

| Scope | For | Lives |
|---|---|---|
| **global** | the mod's own state: a market, a leaderboard, a season | until the player resets the mod's data |
| **account** | per account: unlocks, a rank every character shares | with the account |
| **char** | per character: quest or bounty progress | with the character, deleted when it is |

## Keys and values

- **A key** is a path: `"rank"`, `"bounty.kills"`, `"market.items.501.price"`.
  - Each segment is letters, digits and `_`, and segments are joined by `.`.
  - A path can be at most 255 characters and 8 segments deep.
  - A path can't be exactly `global`, `account` or `char`.
- **A value** is an integer (64-bit) or a string.
  - From Lua, `true`/`false` are stored as `1`/`0`.
  - A table is written as the paths under its key.
  - Non-integer numbers are refused.
- **Dots are only for grouping:** they let you list or rank everything under a
  prefix. A key with no dots is plain key/value.
- **It's a tree:** a path holds a value *or* entries under it, never both.
  With `season.name` set, setting `season` is refused, and with `season` set,
  so is `season.name`: delete one first. That's what lets Lua and the client
  read `season` back as a table.

## From an NPC script

The first argument can name the scope: `"global"` (the default), `"account"`
or `"char"`. The last two use the attached player.

```c
modstore_set "season.name", "Autumn";                  // 1 if stored, 0 if not
.@price = modstore_get("market.items.501.price", 50);  // 50 if it isn't set
.@name$ = modstore_get("season.name");                 // a string needs a $ variable
.@kills = modstore_inc("char", "bounty.kills", 1);     // the new value
.@rank  = modstore_get("account", "rank", 0);

.@n = modstore_keys("market.items", .@ids$);           // child names: "501", "502", ...
.@n = modstore_count("market.items");
.@n = modstore_top("board", 10, .@who$, .@score);      // highest first
if (modstore_exists("market.news"))
	modstore_delete "market.news";                     // and everything under it

.@max = modstore_limit("global");                      // bytes allowed
.@now = modstore_used();                               // bytes in use (global)
```

Only a mod's own scripts can use the store, that is, files under the mod's
`npc/` folder. A failed call returns `0` (or the default) and logs why. The
script carries on.

## From a Lua hook

```lua
store.inc("hits", 1)                                -- global
store.set("season", { name = "Autumn", week = 3 })  -- season.name, season.week

local me = store.char(c.caster)                     -- c.caster or c.target, a player
me.inc("bounty.kills", 1)
local unlocks = store.account(c.caster).get("unlocks.fire", 0)

for _, row in ipairs(store.top("board", 10)) do
  log(row.name .. ": " .. row.value)
end

local season = store.get("season")                  -- { name = "Autumn", week = 3 }
store.set("recent", { "Alice", "Bob" })
store.get("recent")                                 -- { "Alice", "Bob" }: integer keys come back as integers

local ok, why = store.set("x", 1.5)                 -- nil, "numbers in the store are integers"
local l = store.limits()                            -- l.global, l.account, l.char, l.value, l.depth
```

The functions are `get`, `set`, `inc`, `delete`, `exists`, `keys`, `count`,
`top` and `used`. `store` also has `limits`, `char` and `account`.

- **`get` on a path with entries under it** returns them as a table, the
  same shape `set` wrote. `get()` with no path returns the whole document.

- **Errors are returned, not raised:** a write that fails returns `nil` and a
  reason.
- **Instruction limit:** each call counts towards the hook's existing limit.
- **Load time works too:** the store is available while a mod's Lua file
  loads, not only inside hooks.

A mod's scripts and its Lua share one store, so a script can set something a
hook reads, and the other way round.

A Lua [status](MODDING.md#statusname-----buffs-and-debuffs) with
`persist = true` is kept in its mod's char store under `_statuses` while the
player is away, and counts toward that store's limit. Leave that path to it.

## From the mod's client UI

A client plugin reads with `api.store.get(scope, path)`. It resolves with a
number, a string, an object of them, or `null` if nothing is there:

```js
const board = await api.store.get('global', 'client.board');   // { Alice: 30, Bob: 50 }
const mine  = await api.store.get('char', 'client.bounty');    // this character's
```

- **Only paths under `client`.** A mod keeps what its UI may show there, and
  everything else stays on the server. Keep a copy under `client` of anything
  the window needs: `modstore_set "client.board." + .@name$, .@kills;`.
- **The player's own data:** `account` and `char` are the logged-in player's.
- **Not secret:** what's under `client` can be read by the player, and by any
  plugin, so don't keep anything there a player shouldn't see.
- **It asks the map server** (the `@modstore` command, as a server request),
  so it works only in game, and an answer over about 36 KB is refused: read a
  smaller path.
- **Read-only:** a client changes the store through the mod's own server
  script, with `api.server.request` or `api.server.command`.

## Querying

Everything runs in memory, so reads and writes never wait for the database:
- **`keys(path)`:** a path's children.
- **`count(path)`:** how many there are.
- **`top(path, n)`:** the children holding numbers, highest first.

A ranking across all characters ("the 10 with the most kills") can't read
characters who are offline. Keep it in the global store as it happens:
`store.set("board." .. c.caster.name, kills)`.

## Limits

| Setting | Now | Limits |
|---|---|---|
| `mod_store_global_bytes` | 1 MiB | one mod's global data |
| `mod_store_account_bytes` | 64 KiB | one mod's data for one account |
| `mod_store_char_bytes` | 64 KiB | one mod's data for one character |
| `mod_store_value_bytes` | 4 KiB | one string |
| `mod_store_depth` | 8 | segments in a path |

A key counts its own length, plus 8 bytes for a number or the string's length.

The app sets these each start (`MOD_STORE_LIMITS` in `stack/src/cmds.rs`), so
**a release can raise them** without anything else changing.
- **Going over a limit:** the write fails, alone. The map-server log names the
  mod, the scope, the path and the sizes.
- **Shrinking always works:** a write that doesn't make the data bigger never
  fails, so data saved under a higher limit stays editable.
- **Needing more:** if a mod needs more room than the oldest app it supports,
  it says so with `"requires": { "app": ">=<version>" }`. Older apps then refuse
  to install it, instead of the mod's writes failing later.
- **Reading the limits:** `modstore_limit()` and `store.limits()` return the
  current ones, so a mod can trim old entries before it runs out.

## Where it's kept

The map server keeps each document in memory. It saves changes:
- every minute, so a crash loses at most the last minute (rAthena saves its
  own `$` variables and characters every five);
- when a player logs out (their account and char data);
- when the server stops.

The data is in the world's own database, in a table only the map server
writes. So it's part of every database backup and restore, and each era (and
world) has its own.

**Resetting a mod's data:** Settings → Mods → the mod → **Reset data…**, or
`ragnarok-stack mod-data-reset <mod>`. Either way:
- the game is stopped around the reset, because the map server would
  otherwise write its copy back;
- a backup is saved first.

**Removing a mod keeps its data,** so reinstalling it picks up where it was.
Reset it first if you want it gone.

The table is hidden from the SQL login mods use, so `query_sql` can't read
any mod's store, including your own: use the store commands.
