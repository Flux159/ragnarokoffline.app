# AI companion development guide

This document is the technical handoff and roadmap for Ragnarok Offline's
Population Engine companion work. It is written to let a new maintainer or
coding agent distinguish the tested implementation from planned work before
changing anything.

For player-facing instructions, see [COMPANIONS.md](COMPANIONS.md). For the
vendored engine and its broader Ragnarok Offline changes, see
[`third-party/population-engine/README.md`](../third-party/population-engine/README.md).

## Source of truth

Snapshot date: **2026-09-13**.

| Item | Current value |
|---|---|
| Repository | `Alex-crows/ragnarokoffline.app` fork of `Flux159/ragnarokoffline.app` |
| Feature branch | `feature/recruitable-ai-companions` |
| Upstream base | `upstream/main` at `f8465f7` |
| Draft PR | `Flux159/ragnarokoffline.app#128` |
| App baseline | Ragnarok Offline 1.2.3 |
| rAthena pin | `e985006171d2eb320ee512a653f4c83aea3d81b6` |
| roBrowserLegacy pin | `6a177d9b4e8da41d6af76f6e7c527d52beb781c3` |

The Git branch is authoritative. Files under `@Mods/party-invite-test`, the
packaged app payload, the user runtime, and Docker images are local test and
deployment artifacts. Never reconstruct source changes from those artifacts
when the branch is available, and never commit their binaries or archives.

PR #128 is a complete, tested baseline. Future fixes should normally use a new
branch based on the then-current `upstream/main` after PR #128 is merged. If a
fix is required during review, add it deliberately to the PR branch and update
its verification notes.

## Language contract

All source documentation, user-facing text, log text, PR text, and commands are
English. The supported party-chat commands are:

| Purpose | Long command | Quick command |
|---|---|---|
| Engage nearby monsters | `attack` | `atk` |
| Assist and protect the party | `defensive` | `def` |
| Ignore monsters | `passive` | `pass` |
| Tank role | `tank` | `tk` |
| Support role | `support` | `supp` |
| Attacker role | `attacker` | `dd` |

Long combat-mode commands are whole-word, case-insensitive tokens and may
appear in a sentence. Quick combat-mode commands are accepted only when they
are the complete party-chat message. Role assignment requires the exact shell
name and exactly one role token. Keep the long-form mode commands exactly as
listed above.

## Implemented and verified baseline

### Recruitment

- A real player whispers `party`, `pt`, `join`, or `invite` to a Population
  Engine shell.
- Consent is bound to that account for 60 seconds. During the window the shell
  stops walking and fighting so the player can use the context menu.
- A formal rAthena party invitation is still required. The shell has no client
  socket, so the server completes its acceptance path directly.
- The shell's synthetic population-party ID is cleared before it joins the
  real char-server party.
- One real party can have no more than four recruited companions. Normal
  rAthena party-member limits still apply.
- Removing a companion from the party releases the binding and shell.

### Ownership, following, and formation

- The recruiting account becomes `companion_owner_account`.
- The shell follows that owner rather than retaining its town or field origin
  behaviour.
- It walks toward the owner at ordinary distances and teleports to a nearby
  free cell when it leaves the visible area or the owner changes maps.
- Server-side placement performs the work a real client's `LoadEndAck` would
  normally finish. Stale cleanup preserves the brief off-grid state created by
  rapid map changes until following repairs it.
- Up to four idle companions choose stable, unobstructed formation cells around
  the owner. Combat, support movement, and owner movement take priority.
- Ordinary rAthena party EXP sharing is unchanged.

### Party control

- Only the current real-player party leader can issue commands.
- Only party chat is parsed. Public chat, whispers, guild chat, and messages
  from shells do not control companions.
- Attack mode independently selects the closest valid monster within 12 cells
  of the owner.
- Defensive mode follows the owner's target and reacts to monsters threatening
  party members. It is the default.
- Passive mode clears monster targets while follow, buff, heal, and resurrection
  processing remains enabled.
- Conflicting combat-mode words in one message are rejected.

### Roles

- Tank prioritises party threats, intercepts nearby attackers, and bypasses
  normal low-HP flee and boss-avoidance behaviour.
- Support approaches injured allies and retains ally-targeted skill selection.
- Attacker skips ally-targeted support skills so its offensive rotation is not
  delayed.
- Roles shape the shell's existing skills; they never grant class-inappropriate
  abilities.
- A successful role assignment is confirmed by the named shell in party chat.

### Death and resurrection

- A dead companion remains the same player actor, in the party and targetable
  on the map, while its owner remains on that map.
- Priest, High Priest, Arch Bishop, trans Arch Bishop, and Cardinal shells can
  use fixed level 3 Resurrection on dead real party members and companions.
- Level 3 restores 50% HP. Normal SP and timing apply.
- The Blue Gemstone requirement is intentionally virtual and unlimited because
  a shell has no player-accessible inventory.
- A real player can use a Yggdrasil Leaf on a dead companion.
- If the owner leaves the map while the companion is dead, stale cleanup
  releases it and removes it from the party.
- Ambient mortal shells retain their original timed respawn.
- roBrowserLegacy keeps a dead PC's GID registered until a true removal packet
  arrives, allowing resurrection to update the corpse instead of creating a
  duplicate visual actor.

### Population polish included in the baseline

- Hair and clothing colours use rAthena's client-supported palette bounds
  rather than invalid hard-coded ranges.
- YAML and compiled fallback naming use 16,896 pronounceable root/bridge/ending
  combinations.
- Ambient auto-chat runs from the existing configurable categories and reports
  its effective timer configuration at startup.

## Implementation map

| Path | Responsibility |
|---|---|
| `third-party/population-engine/files/src/map/population_engine.cpp` | Recruitment messages, consent window, ownership, four-companion limit, following, map repair, formation, combat-mode and role parsing, death lifecycle, names, appearance, and chat timer |
| `third-party/population-engine/files/src/map/population_engine/runtime/population_engine_combat.cpp` | Role-aware combat and support behaviour, party ally selection, and Priest-line Resurrection |
| `third-party/population-engine/files/src/map/population_engine/runtime/population_engine_path.cpp` | Stops ambient wandering during consent and after recruitment |
| `third-party/population-engine/files/src/map/population_engine/core/population_engine_core.hpp` | `PopulationCompanionMode` |
| `third-party/population-engine/files/src/map/population_engine/core/population_shell_state.hpp` | Companion runtime state in the normal engine layout |
| `third-party/population-engine/files/src/map/population_engine/core/population_shell_combat_skills.hpp` | Matching runtime state in the combat-skills layout; keep both state definitions aligned |
| `third-party/population-engine/patches/0001-population-engine-hooks.patch` | rAthena-owned hooks, including party acceptance, membership callbacks, damage/death integration, and population ally semantics |
| `scripts/apply-party-chat-hook.py` | Idempotently inserts the party-chat command hook into pinned `clif.cpp` without a fragile line-number patch |
| `scripts/apply-server-mods.sh` | Copies engine-owned files, applies rAthena patches, then installs the party-chat hook |
| [Flux159/roBrowserLegacy](https://github.com/Flux159/roBrowserLegacy/commits/ragnarokoffline) | The dead-PC GID lifecycle correction, as the commit "Entity: keep a dead player's GID so resurrection finds the corpse" on `ragnarokoffline`; its message carries the rationale ([FORKS.md](FORKS.md)) |
| `third-party/population-engine/files/db/population_names.yml` | Configurable name components |
| `third-party/population-engine/files/db/population_engine.yml` | Class profiles, roles, appearance ranges, skills, and equipment references |
| `third-party/population-engine/files/db/population_skill_db.yml` | Configurable skill lists and conditions |
| `third-party/population-engine/files/db/population_gear_sets.yml` | Configurable equipment sets |
| `third-party/population-engine/files/db/population_chat.yml` | Ambient chat categories and messages |

The Population Engine is vendored as its own files plus patches against pinned
rAthena. Do not edit `vendor/rathena` as the source of truth. Regenerate or
update files under `third-party/population-engine`, then prove they apply to a
clean pin.

## Invariants that must not regress

1. A shell is never treated as recruited solely because it has a real-looking
   party ID; `companion_owner_account` must also identify its owner.
2. Consent is one-player, one-shell, and time-limited. Another account cannot
   consume it.
3. The four-companion check must work after kick/recruit cycles and cannot rely
   on a monotonically increasing counter.
4. Recruited shells are not returned to their original spawn map by ambient
   cleanup while alive.
5. A same-map dead companion keeps the original actor and GID. Do not implement
   resurrection by despawning and creating a replacement shell.
6. A dead companion cannot follow its owner to a new map; it must be released.
7. Party commands remain leader-only and party-chat-only.
8. Passive mode suppresses monster acquisition but not support or resurrection.
9. Roles do not invent skills. YAML/class capability remains authoritative.
10. Client GID retention applies only to dead PCs. Mobs and other actors must
    still release reusable GIDs immediately.
11. `population_shell_state.hpp` and `population_shell_combat_skills.hpp`
    contain parallel `s_population` layouts and must remain synchronised.
12. Local binaries, Docker images, app payloads, runtime files, GRFs, logs, and
    test archives must never enter Git.

## Verification record for PR #128

Manual Windows 1.2.3 acceptance covered:

- town and field recruitment, kick/recruit replacement, and the four-shell cap;
- ordinary and rapid map changes, off-screen catch-up, and off-grid recovery;
- non-bouncing idle formation;
- party-chat-only commands, leader authority, mode transitions, role changes,
  and shell confirmation;
- town- and field-origin companions following the same combat policy;
- Priest buffs and Resurrection on both a player and another shell;
- Yggdrasil Leaf resurrection;
- same-map corpse retention, removal after leaving the map, and no duplicate
  corpse actor;
- varied hair/clothing colours, pronounceable names, and ambient auto-chat.

Automated and build verification covered:

- all five GitHub checks on PR #128: server patch/diagnostics, complete client
  build, and supervisor/lifecycle suites on Linux, macOS, and Windows;
- server patch application to a clean pinned rAthena worktree;
- client patch application twice to a clean pinned roBrowserLegacy worktree;
- JavaScript syntax validation for the patched entity lifecycle;
- Python bytecode validation for hook scripts;
- a fresh Linux compile and link of the exact PR-head
  `population_engine.cpp`, producing map-server SHA-256
  `f953290d14f13243a7f71360858cfb8429e0d2cfab03fc189d0940560ba59320`;
- clean `git diff --check` and a mergeable, conflict-free Draft PR.

## Current limitations

- Companions are recruited from the ambient population. There is no Adventurer's
  Guild board, hiring UI, or custom companion builder.
- Companion identity, recruitment, role, and mode are runtime-only and do not
  survive a full server/app shutdown. Returning to character select without
  stopping the server does not end the runtime session.
- A shell's class, level, equipment, skills, looks, and dialogue come from the
  current Population Engine generation and YAML data.
- There is no refusal roll based on level difference yet. Eligible shells
  always consent if the party has room.
- Behaviour coverage is only as good as each class's generated resources and
  configured skill lists.

## Planned fixes and features

The items below are **not implemented in PR #128**. Each needs its own evidence
and should not be marked complete merely because a likely code location was
found.

### 1. Priest self-buffs in a player party

Observed concern: recruited Priests buff party members but do not appear to
apply suitable buffs to themselves.

Investigation:

- Reproduce with expired Blessing/Increase AGI and record both player and shell
  status icons or server status state.
- Trace self-buff maintenance separately from ally-targeted skill selection in
  `population_engine_combat.cpp`.
- Check whether party ally scans exclude the caster by design and whether the
  same skill appears only in an ally list rather than the self-buff list.
- Verify all combat modes, especially Passive, because support must remain
  active there.

Acceptance criteria:

- A Priest-line companion maintains configured self-applicable buffs on itself.
- It continues to buff appropriate party members and does not spam duplicate
  casts while a status is active.
- The change does not grant or force unconfigured skills.

### 2. Hide HP bars for non-party shells

Observed concern: ambient Population Engine shells expose health bars even when
they are not members of the player's party.

Investigation:

- Determine whether the bar is created from server HP packets, party state, or
  unconditional roBrowser player rendering before choosing a server or client
  fix.
- Compare an ambient shell, recruited shell, real party member, and ordinary
  non-party player.

Acceptance criteria:

- Ambient/non-party shells do not show persistent HP bars.
- Recruited companions retain useful party HP/status display.
- Real players, monsters, targets, and party-window updates are unchanged.
- Joining or leaving the party updates visibility without a map reload.

### 3. Peco Peco colour corruption

Observed concern: some mounted Peco Pecos use invalid or visibly corrupted
colours.

Investigation:

- Capture the affected rider class, sex, body palette, and mount state.
- Separate rider clothing palette selection from mount sprite/palette lookup.
- Confirm the client-supported range for mounted classes rather than assuming
  ordinary clothing bounds apply to the Peco sprite.

Acceptance criteria:

- Every supported Peco rider renders with a valid palette across generated
  shell appearances.
- Fixing mounts does not collapse ordinary character colour variety.

### 4. Town-origin Gunslinger companions do not fight

Observed concern: Gunslingers recruited in town follow the party but remain
non-combatant. Missing ammunition is the leading hypothesis, not a confirmed
cause.

Investigation:

- Compare town- and field-origin Gunslinger runtime state after recruitment.
- Inspect combat-session startup, weapon type, equipped ammunition, and
  `population_shell_ammo.*` provisioning before changing AI targeting.
- Record failed basic attacks and skill requirements in the map-server log.

Acceptance criteria:

- A recruited Gunslinger from town attacks under Attack and Defensive triggers.
- Required ammunition is provisioned through the shell's virtual resource
  model without exposing or depending on a player inventory.
- Passive mode remains passive and non-Gunslinger classes do not regress.

### 5. Persist companions across session end

Goal: recruited companions survive a full app/server restart and rejoin their
owner when play resumes.

Design work required:

- Choose durable identity and ownership. Account-only ownership is insufficient
  if different characters on one account should have different parties.
- Persist enough generation data to recreate the same shell: identity/name,
  class, level/build inputs, appearance, equipment/profile reference, role,
  mode, and party relationship.
- Define whether a companion persists while dead and how missing or changed YAML
  profiles migrate.
- Reconcile real rAthena party rows with recreated fake PCs without stale
  pointers, duplicate members, or orphaned party entries.
- Restore only after the real owner character is authenticated and on a map.

Acceptance criteria:

- After a clean app shutdown and restart, each saved companion appears once near
  the correct character and is present once in the party window.
- Role, mode, identity, class, and appearance are restored consistently.
- Kicked/released companions do not return.
- Crashes or interrupted shutdowns do not duplicate or permanently corrupt the
  party.
- Configuration changes and app upgrades have an explicit safe fallback.

### 6. Expand data lists and class variety

Goal: increase useful and visible variety without hiding behaviour bugs behind
randomness.

Work areas:

- Audit class coverage in `population_engine.yml`, including advanced and
  extended classes actually supported by the pinned rAthena/client era.
- Expand role-appropriate tasks and skill conditions in
  `population_skill_db.yml` only after verifying each skill's target type,
  catalyst/ammunition needs, range, cooldown, and prerequisites.
- Add balanced equipment-set variants by class and level band in
  `population_gear_sets.yml`.
- Extend appearance choices within verified client palette/sprite bounds.
- Add chat lines and optional trigger responses without turning normal player
  conversation into accidental commands.

Acceptance criteria:

- Every added class can follow, idle, fight, and use its core resources without
  server errors.
- Tank, Support, and Attacker assignments produce meaningful differences where
  the class has relevant abilities.
- No invalid item, sprite, palette, skill, or catalyst references appear at
  load or runtime.
- Deterministic test profiles exist for behaviours that would otherwise be hard
  to reproduce through random population generation.

### 7. Level-gap-dependent recruitment refusal

Goal: shells far above the requesting player should increasingly refuse party
requests. Example requirement: a level 10 player asking a level 60 shell should
have only a 1% chance, or no chance, of success.

Rules already decided:

- Compare the requesting player's level with the target shell's level.
- A shell at or below the player should not be penalised.
- Acceptance probability decreases in stages as the positive shell-minus-player
  level gap grows.
- A refusal must be visible through an English shell response and must not open
  the 60-second formal-invite window.
- The result is rolled once per consent request, not again during the formal
  party packet.

Open product decisions before implementation:

- Exact gap bands and probabilities.
- Whether a gap of 50 or more has a 1% chance or is an absolute refusal.
- Whether refusal attempts need a short per-player/shell cooldown to prevent
  immediate whisper spam from defeating the probability.
- Whether Charisma, party role, reputation, or other future systems may modify
  the chance. None should be invented in the first implementation.

Recommended first-pass shape for discussion, **not an approved balance table**:

| Shell level minus player level | Acceptance chance |
|---:|---:|
| 0 or less | 100% |
| 1–10 | 100% |
| 11–20 | To decide |
| 21–30 | To decide |
| 31–40 | To decide |
| 41–49 | To decide |
| 50 or more | 1% or 0%; explicit decision required |

Acceptance criteria:

- Boundary levels for every configured band are unit- or integration-tested.
- The four-companion cap, consent ownership, expiry, and formal invitation path
  continue to work.
- Acceptance and refusal responses are distinct, English, and configurable if
  they use `population_chat.yml`.
- Logs record the gap, selected band, and outcome without flooding normal logs
  or exposing private account data.

## Recommended next sequence

1. Keep PR #128 reviewable as the baseline and respond to maintainer feedback.
2. Reproduce and fix Priest self-buffs and town Gunslinger combat; both exercise
   server-side skill/resource paths and should be small, isolated branches.
3. Investigate HP-bar visibility and Peco palettes together as client-rendering
   work, but commit them separately if their causes differ.
4. Agree on the level-gap probability table, then implement refusal as a focused
   recruitment-policy change with deterministic boundary tests.
5. Design persistence before coding it. It changes lifecycle and durable data
   ownership and is the highest-risk item in this roadmap.
6. Expand YAML content incrementally after the behaviour and persistence model
   is stable.

## New-session checklist

A new coding agent should do this before editing:

1. Read `AGENTS.md`, `CLAUDE.md`, this document, `docs/COMPANIONS.md`, and
   `third-party/population-engine/README.md`.
2. Run `git status --short --branch`, inspect both remotes, and fetch them.
3. Check PR #128 and its review/check status. Do not assume the snapshot above
   is still current.
4. Confirm the app release and `config/VENDOR_PINS` before reusing an old build
   artifact.
5. Reproduce one roadmap item in isolation and collect logs or visual evidence
   before modifying code.
6. Use `apply_patch` for source edits and preserve unrelated user changes.
7. Apply server and client patch sets twice to clean pinned worktrees to prove
   both compatibility and idempotence.
8. Compile the map server for C++ changes. Run the repository CI-equivalent
   checks relevant to any client, supervisor, or documentation changes.
9. Keep all user-facing terminology English and update this document when a
   roadmap item becomes implemented and verified.

Useful read-only commands:

```sh
git status --short --branch
git remote -v
git log --oneline --decorate -10
gh pr view 128 --repo Flux159/ragnarokoffline.app
gh pr checks 128 --repo Flux159/ragnarokoffline.app
```
