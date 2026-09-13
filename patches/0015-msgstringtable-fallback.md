# An empty `msgstringtable.txt` is a miss, not an answer

`data/msgstringtable.txt` holds every system message the client prints: the
chat tab labels, death and disconnect notices, and everything the server says
through a message id rather than plain text. `DBManager.lazyInit` loads it and,
if that load fails, falls through to `data/msgstringtable.csv`.

A client that ships the file but leaves it **empty** falls through neither way.
The read succeeds, the loader stores nothing, and every lookup afterwards
renders as `NO MSG <id>` — the chat tabs come up as `NO MSG 12!` and a server
notice as `NO MSG 2580`.

That is what a Latin American client does. Its `data/msgstringtable.txt` is
zero bytes and the real table, 52 KB of Portuguese, sits beside it as
`data/msgstringtablel.txt`. It only becomes visible with **Settings → Game
text → your client's own text**, because the bundled English translation
overlays a full `msgstringtable.txt` in front of the empty one.

This patch splits the loader's callbacks out so the second name can be tried,
and tries it only when the primary table produced no entries. A client with a
normal `msgstringtable.txt` loads exactly what it loaded before and never
requests the second name.

## What this does not fix

The Latin American table under the second name is an older one: 1,394 entries
against the 4,023 the English translation ships. The client's complete table is
`data/msgstringtable_ml.csv` — 4,328 rows of base64, keyed by message *name*
with one column per language — which roBrowser does not read, and which would
need a language column chosen per client to be useful. Message ids past the end
of the short table still render as `NO MSG <id>`; the English translation
covers them.

## Verification

Run against a real Latin American client (`data.grf`, May 2025) with the
translation switched off, in a disposable test world. Before: chat tabs
`NO MSG 12!`. After: `Público` and `Batalha`, with the accents intact, the map
title reading `A Capital de Rune-Midgard`, and the three startup notices still
`NO MSG` as described above. The patch is idempotent — `patch-client.sh` run
twice reports it already applied — and the rebuilt bundle loads, logs in and
enters the map.
