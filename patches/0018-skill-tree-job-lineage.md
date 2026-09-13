# Rendering a skill window rewrote the skill tree

A High Priest cannot put a point into Safety Wall. Clicking it offers to spend
**13 skill points**, which is Napalm Beat 7 + Soul Strike 5 + the point itself —
the Mage prerequisites, on a job that has never been a Mage. Magnus Exorcismus
sits behind Safety Wall 1, so it is unreachable too. A plain Priest is fine, and
can max both.

This is ours to fix, not rAthena's. The server's tree is right, in renewal and
pre-renewal alike (`db/re/skill_tree.yml:382`):

```yaml
  - Job: Priest
      - Name: MG_SAFETYWALL
        Requires: PR_ASPERSIO 4, PR_SANCTUARY 3
  - Job: High_Priest
    Inherit: { Novice: true, Acolyte: true, Priest: true }
```

High Priest inherits Priest, so the server would accept the point. It is never
asked for one.

## Safety Wall belongs to two jobs, and the client knows it

`MG_SAFETYWALL` is in the Mage tree *and* the Priest tree, with different
prerequisites in each. `SkillInfo.js` carries both: a generic `_NeedSkillList`
holding the Mage pair, and a `NeedSkillList` keyed by job for the exceptions.

```js
_NeedSkillList: [[SK.MG_NAPALMBEAT, 7], [SK.MG_SOULSTRIKE, 5]],
NeedSkillList: { [JobId.PRIEST]: [[SK.PR_SANCTUARY, 3], [SK.PR_ASPERSIO, 4]] }
```

Only `JobId.PRIEST` is listed, so `resolveSkillRequirements()` walks the job's
ancestry — `SkillTreeView[job].beforeJob`, repeatedly — and takes the first
entry it finds. High Priest's `beforeJob` is Priest, so one hop finds it. That
part works. It is the tree underneath it that does not survive being drawn.

## The merge that wrote back into the database

```js
positions[SkillTreeView[JobId]['list']] = SkillTreeView[JobId];
...
positions[list] = positions[list] ? Object.assign(positions[list], items) : items;
```

`getSkillPosition()` collects a job's skills by walking the same `beforeJob`
chain and merging each ancestor's tree into an array indexed by tab. The values
it merges are the module-level `SkillTreeView` objects themselves, not copies,
so `Object.assign` writes the ancestor's keys **into the live database**.

Merging the skills is the point. The damage is the other two keys those objects
carry. `SkillTreeView[PRIEST_H]` and `SkillTreeView[PRIEST]` are both
`list: 2` — trans skills share the second tab with the second-class ones — so
the Priest entry lands on top of the High Priest entry and takes `list` and
`beforeJob` with it:

| | `beforeJob` |
|---|---|
| `SkillTreeView[PRIEST_H]`, as written in the DB | `PRIEST` |
| after a High Priest's skill window is drawn once | `ACOLYTE` |

Priest is now missing from High Priest's ancestry. `resolveSkillRequirements()`
walks High Priest → Acolyte → Novice, never finds `NeedSkillList[PRIEST]`, and
falls back to the generic list. Safety Wall becomes a Mage skill.

Nothing puts it back. The DB is module state, so the tree stays broken until
the page reloads — and it breaks again the moment the window is reopened.

The skill positions collide harmlessly, which is why this was only ever visible
through the prerequisites: High Priest occupies slots 10, 17, 19 and 22 and
Priest uses none of those. The merge is doing what it was meant to do. It is
just doing it to the original.

**70 job trees are corrupted this way**, every trans second class among them —
Lord Knight loses Knight, High Wizard loses Wizard, Sniper loses Hunter — plus
every first class, whose `beforeJob: NOVICE` is overwritten with `null`.

27 skills carry a job-specific `NeedSkillList`. Drawing every job's tree once
changes the answer for **13 of them, across 123 (skill, job) pairs**:

| skill | correct | after drawing | jobs |
|---|---|---|---|
| Safety Wall | Sanctuary 3, Aspersio 4 | Napalm Beat 7, Soul Strike 5 | 7 — High Priest, Arch Bishop, Cardinal, … |
| Heal | Faith 10, Demon Bane 5 | *(none)* | 11 — Crusader High, Royal Guard, Imperial Guard, … |
| Divine Protection | Cure 1 | *(none)* | 11 — same |
| Cure | Faith 5 | Heal 2 | 11 — same |
| Lullaby | Whistle 10 | *(none)* | 12 — Bard/Dancer High, Minstrel, Wanderer, Troubadour, Trouvere, … |
| Drum on the Battlefield | Apple of Idun 10 | *(none)* | 12 — same |
| Loki's Veil | Assassin Cross of Sunset 10 | *(none)* | 12 — same |
| Invulnerable Siegfried | Bragi's Poem 10 | *(none)* | 12 — same |
| Vulture's Eye | *(none)* | Owl's Eye 3 | 7 — Rogue High, Shadow Chaser, Abyss Chaser, … |
| Double Strafe | Vulture's Eye 10 | *(none)* | 7 — same |
| Remove Trap | Double Strafe 5 | Land Mine 1 | 7 — same |
| Earth Spike | Seismic Weapon 1 | Stone Curse 1 | 7 — Sage High, Sorcerer, Elemental Master, … |
| Heaven's Drive | Earth Spike 1 | Earth Spike 3 | 7 — same |

Two shapes of breakage. The six that get *different* requirements — Safety
Wall among them — demand skills the job cannot reach, so the point can never be
spent; that is the reported symptom. The seven that fall through to *nothing*
are the opposite: the client offers a skill whose real prerequisites it has
forgotten, sends the packet, and the server refuses it. Either way the point
does not land, and Safety Wall is simply the one whose dialogue puts a number
on it.

## The fix

Copy the job's own entry before merging anything into it. One line.

```js
positions[SkillTreeView[JobId]['list']] = { ...SkillTreeView[JobId] };
```

Every later placement into `positions` comes from a recursive call that has
already copied, so `Object.assign` only ever mutates the array's own copies.

## Verification

`SkillTreeView`, `SkillInfo` and `SkillRequirements.js` taken from the pinned
`vendor/roBrowserLegacy`, with `getSkillPosition()` lifted verbatim out of
`SkillListCommon.js` before and after the patch, then every job's tree drawn
once:

| | before | after |
|---|---|---|
| job trees mutated by drawing them | 70 | 0 |
| (skill, job) prerequisite lists that change | 123 | 0 |
| `SkillTreeView[PRIEST_H].beforeJob` afterwards | `ACOLYTE` (4) | `PRIEST` (8) |
| Safety Wall for a High Priest | Napalm Beat 7, Soul Strike 5 | Sanctuary 3, Aspersio 4 |
| Safety Wall for an Arch Bishop | Napalm Beat 7, Soul Strike 5 | Sanctuary 3, Aspersio 4 |
| Safety Wall for a Priest | Sanctuary 3, Aspersio 4 | Sanctuary 3, Aspersio 4 |
| skills drawn in the High Priest tree | 41 | 41 |

And the first point in Safety Wall, as a High Priest holding Heal 1 and Aqua
Benedicta 1, in skill-up packets:

```
before  13 points  Napalm Beat ×7 -> Soul Strike ×5 -> Safety Wall
after   11 points  Sanctuary ×3 -> Impositio ×3 -> Aspersio ×4 -> Safety Wall
```

The before line is the bug as reported, down to the number on the dialogue.

**Read the 13 carefully.** It is not evidence on its own: the correct Priest
chain from an empty tree costs 13 too (Heal 1 + Sanctuary 3 + Aqua Benedicta 1 +
Impositio 3 + Aspersio 4 + Safety Wall 1). What identifies the fault is that a
Priest can do this and a High Priest cannot, and the Priest is only spared
because it is the first job in its own ancestry — found before the broken link
matters.

**What this has not been checked against.** The prerequisites, the staged cost
and the packet order are verified against the real data; a High Priest actually
spending the point in a running client is not. There is no test here either —
the behaviour needs `vendor/roBrowserLegacy`, which the test suite does not
have.

## Upstream

roBrowserLegacy's, not ours, and not specific to how this app runs it. The
job-aware resolver it defeats is recent (`b67c591e`, 2026-08-23); the in-place
merge is much older, which is why the resolver looked correct when it landed.
Worth sending upstream.
