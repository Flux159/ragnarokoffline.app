# Companion homunculus (alchemist line)

A companion of the alchemist line can carry a homunculus that fights beside it, matches a real
player's homunculus, and is switched per companion from the companion panel.

## Agreed scope

1. **Alchemist line only** — gated on the skill tree, not a job whitelist (see *Gate*).
2. **It grows** — level and exp persist per companion.
3. **Per-companion toggle** in the companion panel, beside the skill button.
4. **Picks its own target** — nearest enemy, not a mirror of the shell's target.

## Why the stock path cannot be used

Creation, loading and saving all round-trip to the **char-server**:

| Call | Site |
| --- | --- |
| `intif_homunculus_create` | `homunculus.cpp:1276` (inside `hom_create_request`) |
| `intif_homunculus_requestload` | `homunculus.cpp:1123`, `:1297`, `pc.cpp:2491` (login) |
| `intif_homunculus_requestsave` | `homunculus.cpp:838` |
| `intif_homunculus_requestdelete` | `homunculus.cpp:1053`, `unit.cpp:4148` (on block free) |

Population shells have **synthetic identities** — `char_id == CHAR_ID_BASE + index`
(`population_engine.cpp:471`) — and no `char` table row, so there is nothing for the
char-server to key a `homunculus` row against. Bending that path would mean teaching the
char-server about synthetic characters.

**What we use instead:** `hom_alloc(map_session_data *sd, struct s_homunculus *hom)`
(`homunculus.cpp:1058`). It allocates `homun_data`, sets `type = BL_HOM`,
`id = npc_get_new_npc_id()`, `master = sd`, resolves `homunculus_db.homun_search(class)`,
runs `status_set_viewdata` + `unit_dataset`, and drops the pet at a valid spot beside the
player. Given a filled `s_homunculus`, it produces a live, spawned, visible homunculus with no
char-server involvement.

This mirrors the precedent already set twice: `pc_setmadogear` cannot work for a 4th job, so
the vehicle option is set directly; `pc_setwarg` does not exist, so `OPTION_WUG` is set
directly.

## Why the companion needs a server-side driver

A homunculus's AI is **client-side Lua**, not server logic. `docs/CUSTOM_HOMUNCULUS_AI.md`
documents how a player drops AzzyAI into `AI/USER_AI/` beside `data.grf` and switches it on
with `/hoai`. The client decides, then sends the resulting move, attack and skill commands to
the map server - which is exactly why every homunculus action arrives as a client packet
(`clif_parse_UseSkillToId_homun`, `clif_parse_UseSkillToPos_homun`, `clif.cpp:12774`, `:12802`).

A population shell has no client, so it can never obtain AI that way: there is no `/hoai` to
type and no Lua to run on its behalf. Server-side decision-making is therefore not a shortcut
but the only possibility, and it belongs where the shell's own combat decisions are already
made.

## Design

**Attach.** Build `struct s_homunculus` in memory from `homunculus_db` (class, level, stats
scaled `*10`, `intimacy = 2100`, `hunger = 32`, `char_id = sd->status.char_id`) exactly as
`hom_create_request` does — then call `hom_alloc` instead of the intif call.

**`sd->status.hom_id` stays 0.** That keeps the login load at `pc.cpp:2491` from firing for a
shell, and makes the row delete in `unit.cpp:4148` match nothing. It does **not** make a save a
no-op: the char server's `mapif_homunculus_save()` reads `hom_id == 0` as a new homunculus and
INSERTs a `homunculus` row (and its `skill_homunculus` rows) on every `hom_save()`. Patch 0012
therefore drops `intif_homunculus_requestsave()` for population accounts, as `chrif_save` and
`intif_saveregistry` already do.

**Gate.** `pc_checkskill(sd, AM_CALLHOMUN) > 0` — the alchemist line's own skill
(`db/re/skill_db.yml:6824`), the same shape as `HT_FALCON` / `RA_WUGMASTERY` in the vehicle
helper. A skill gate means job progression needs no whitelist: an Alchemist that advances to
Creator keeps it, and our data already records `JOB_ALCHEMIST = 18`, `JOB_CREATOR = 4019`.

**Persistence.** Extend `cp_companion_persistence` (created at `stack/src/cmds.rs:1487`; the
`ADD COLUMN IF NOT EXISTS` helper is at `:1587`) with the homunculus state, following the
`skill_preset` (v7) model:

- `hom_enabled` — the toggle: `NULL` = never chosen, which is ON for this class; `1` = on;
  `0` = the player switched it off
- `hom_class`, `hom_level`, `hom_exp`

**Stock table.** `docs/DATABASE.md` documents the stock homunculus failure modes (a
`char.homun_id` pointing at a missing row) and the `rostack sql` repair CLI, and records that
`char` and `homunculus` are MyISAM tables **with no foreign keys** - so a row for a synthetic
`char_id` would not be rejected on referential grounds. We do not write one anyway: keeping
`hom_id = 0` skips the char-server round trip entirely and leaves those stock diagnostics
meaningful for real players.

**Toggle.** Same channel as the skill picker: extend the `@CPSKEND|<count>|<job>|<chosen>|<summoned>`
summary with the homunculus field, or add a parallel `@CPHOM|...` line, and add the control to
`patches/CompanionPanel.js` beside the skill button.

## Phases

**Phase 1 — it exists, and survives bench/recall.**
`population_engine_sync_shell_homunculus(sd)`, hooked at the same sites as the vehicle sync:
after the skill-tree grant at spawn, after job change, and **after the recall placement last**.
Bench/recall frees the block and re-attaches after placement.
*Acceptance:* the homunculus (class/level/alive) is present after bench → summon → resummon.

**Phase 2 — it acts.**
Per-tick driver mirroring the shell AI (`population_engine_combat.cpp` uses
`unit_attack`/`unit_skilluse_id`/`unit_skilluse_pos` at `:1128`–`:1181`): pick the nearest
enemy, `unit_attack(hom, ...)`, follow the master when idle or out of range, handle
dead/vaporized states.
*Acceptance:* the homunculus attacks on its own and returns to the companion.

**Implemented.** `population_engine_homunculus_per_tick(sd)` and its target picker live in
`population_engine/runtime/population_engine_combat.cpp`, called from the shell's own combat tick
(`population_engine_combat_per_tick`), so the pet inherits that tick's cadence and lifecycle
instead of owning a timer. It acts through the calls rAthena's own homunculus AI script commands
use (`setunitdata UHOM_TARGETID` -> `unit_attack(hd, id, 1)`, `unit_stop_attack(hd)` for 0), and
chasing is left to `unit_attack`, which walks the unit into range itself - the same thing the mob
AI relies on. Targets are ranked by distance to the pet (agreed scope 4) and must also sit inside
the master's 12-cell command radius; past 12 cells from the master the pet leashes home with
`unit_walktobl(hd, sd, 2, 1)`.

Not covered: the arena-observation branch of the tick returns before the hook, and a sitting or
vending companion leaves its pet standing - both deliberate, since a companion that is not in a
fight should not be picking one.

**Phase 3 — growth, persistence, toggle.**
Level/exp from kills, written through `cp_companion_persistence`; panel toggle; the v8
migration.

**Persistence — implemented (v8).** The pet's class, level and exp live in
`cp_companion_persistence` as `hom_class` / `hom_level` / `hom_exp`, alongside `hom_enabled` for the
toggle: NULL means "never chosen", which is ON for this class because the pet is part of an
alchemist-line companion, while 0 is an explicit no - so an upgrade can never re-enable a pet a
player switched off. The columns are declared in both the CREATE TABLE literal and the ALTER list,
as `skill_preset` (v7) is, so a fresh install and an upgraded one cannot disagree. The attach reads
the row and resumes the stored class and level; restoring the level also restores `exp_next`, since
`hom_alloc` derives it from the level - a pet restored at 1 with a level-40 threshold would look
permanently stalled. A stored class the data set no longer has falls back to the derived one rather
than costing the companion its pet. The recurring gear snapshot writes the pet's live state only
while the pet exists, so a switched-off companion cannot have its stored level overwritten with 0.
**The panel control — implemented (phase 3c).** The companion row carries a `Pet on` / `Pet off`
button, drawn only for a companion whose CLASS can have a pet. The roster line carries the switch as
a tri-state (`-1` = this job cannot have one, `0` = off, `1` = on), and applicability is answered
from the granted skill tree (`skill_tree_db.find(class_)`, whose `Inherit` is flattened at load)
because the attach's own gate needs a live shell and a benched companion has none.
`@companion homunculus <name> [on|off]` (`pet` is an alias; a bare name flips) ships in
`patches/0011-companion-homunculus-toggle.patch`, so it works for a benched companion too — the
stored column is honoured at its next summon.

Both directions are deliberate, and the obvious call is the wrong one for ON:

| Direction | What it does | Why not the obvious one |
| --- | --- | --- |
| OFF | `hom_vaporize(sd, HOM_ST_ACTIVE)` | Stock's own "put it away" (what `pc.cpp` calls on logout): the pet stays attached but inactive, so `hom_is_active` goes false and the driver stops on its own |
| ON | clears `homunculus.vaporize` in place, then `hom_call`'s own follow-ups (`hom_init_timers`, `clif_hominfo`) | **`hom_call()` must not be used.** Its first line is `if (!sd->status.hom_id) return hom_create_request(...)`, and a shell's `hom_id` is 0 by design, so it would take the char-server path this whole feature exists to avoid |
| ON, no pet at all | `population_engine_sync_shell_homunculus(sd)` | Attaches from the row, so a killed or never-attached pet returns with its class, level and exp |

Only the setter writes `hom_enabled`: the recurring gear snapshot must not touch it, or the next tick
would re-enable a pet the player switched off.

**Growth — already stock, and verified safe (no award code was written).** `mob.cpp` pays
`hom_gainexp(tmpsd[i]->hd, base_exp * battle_config.homunculus_exp_gain / 100)` to every exp
receiver that owns a homunculus, so a companion's in-memory pet is paid on its own kills like a
player's. Every notify on that path is safe for a shell: `clif_homunculus_updatestatus` sends
with `clif_send(..., SELF)`, SELF is guarded by `clif_session_isValid(sd)`, and the AREA paths use
`session_isActive(fd)` — which is built on `session_isValid(fd)`, i.e. `fd > 0 && ...`, so a
shell's `fd == 0` makes them no-ops rather than writes into `session[0]`. `hom_alloc` already sets
`hd->homunculusDB` and `hd->exp_next`, which is exactly what `hom_levelup` needs, and the class
this feature picks (`HM_CLASS_BASE + index % 8`, i.e. 6001-6008) is precisely the block
`hom_class2mapid` accepts. The engine therefore writes no exp of its own, by design — a second
award path would double-pay.

## Traps

| Trap | Handling |
| --- | --- |
| `hom_vaporize()`, `hom_call()` and `unit_free()` call `hom_save()` → char-server save | **Not** harmless: with `hom_id = 0` the char server INSERTs a new row each time. Patch 0012 drops the request for population accounts; our own schema is the persistence |
| `unit.cpp:4148` deletes the row on free | Safe only while `hom_id == 0` — assert it |
| `clif_send_homdata` guards `master == nullptr` but **not** `fd <= 0` | A shell has no client; verify what `clif_send` does with the shell's fd before relying on stock notify paths |
| Hunger/intimacy timers call save paths | Short-circuit for shells |
| The homunculus has **no AI of its own** (no `hom_ai` in `src/map/`) | Phase 2 is mandatory, not optional |
| Spawn ordering | The vehicle bug, exactly: announce only after the shell is definitively on the grid |
| Creature sprites resolve by job name | See the vehicle sprite lesson — verify the homunculus class resolves to real data before judging a missing sprite |

## Verification

- Calibrated tests (fail on the parent, pass after) asserting: the alchemist line reaches
  `hom_alloc`; `hom_id` is never set; no `intif_homunculus_*` call is reachable for a shell.
- **Not verifiable by test:** whether it is drawn and moves. That is the client's word.
- The `@companion dump` diagnostic (patch 0010, `@SHELL*` lines) used while developing this was
  temporary and has been removed.

## To resolve at implementation time

- The exact `HM_CLASS_BASE` / `HM_CLASS_MAX` values and the class ids in
  `db/homunculus_db.yml`.
- The 4th-job (Biolo) constant and id — not in the tree under `JOB_BIOLO`.
- Which class an alchemist-line companion receives, and how class scales with the
  companion's own level.
