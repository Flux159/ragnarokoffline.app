# start-in-your-town

New characters wake up on your island instead of in the tutorial room. This is
the one that makes a set of mods read as *your* server rather than as somebody
else's with your things added.

**Install [custom-map](../custom-map) first** — this points the start point at
`ro_isle`, and a start point on a map that does not exist is a character you
cannot log in with. The char-server says so:

```
mapindex_init: Default map 'ro_isle' not found in cache!
```

## What to look at first

`conf/char_conf.txt`, and the fact that this layer exists at all.

The supervisor rewrites `char_conf.txt` on **every** server start, from the era
and the app's own settings — deliberately, because settings and server config
drifting apart caused a real bug. That means a hand edit to the generated file
does not survive a restart, and until this layer existed a mod had no way in.

So mods get a `conf/` layer with a **narrow allowlist**. A mod may set:

```
char_conf.txt   start_point  start_point_pre  start_zeny  start_items
                start_status_points  char_name_letters  char_name_option
```

and nothing else. The list is short on purpose: `conf/` is also where
`login_ip`, `char_ip` and `map_ip` live, and a mod that could write those could
point a player's client at somebody else's server while looking exactly like a
mod that works. Anything a mod asks for that is not on the list is **named in
the log and ignored**, never quietly applied:

```
mods: start-in-your-town asked to set "char_ip" in conf/char_conf.txt, which mods may not set -- ignoring
```

If you need a key that is not there, that is a change to `CONF_ALLOWED` in
`stack/src/mods.rs` and a conversation about what it lets a mod do.

## Both era keys

`start_point` and `start_point_pre` are set to the same place. A pre-renewal
char-server reads only `start_point_pre`; a renewal one reads only
`start_point`. Setting one leaves new characters with no start point at all in
the other era, and the app can switch era from Settings.

## Testing it

The start point only applies to characters created **after** the change, and
each era keeps its characters in its own database volume. So: restart the
server, go to character select, make a *new* character, and enter the game.

## Applying it

`conf/` is read when the **server** starts, alongside `db/` and `npc/`.
