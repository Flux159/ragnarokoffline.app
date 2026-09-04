# common-npcs

The four NPCs almost every private server has: a **job changer**, a **warper**,
a **healer** and a **stylist**, in every major town.

**It ships switched off.** Free warps and instant job changes are a big change
to how the game plays, and that should be a decision rather than something that
happened to you. Settings → Mods → tick it → Apply.

## What to look at first

`stock-npc.txt`, and the fact that this mod contains **no scripts**.

rAthena already ships all four, fully written and maintained upstream, in
`npc/custom/`. They are inside the container image right now. What it does not
do is load them: every line in `scripts_custom.conf` is commented out.

So this mod is a list of paths. The supervisor turns each into an `npc:` line in
the generated `map_conf.txt`, which is the same mechanism that loads a mod's own
scripts:

```
npc/custom/warper.txt
npc/custom/jobmaster.txt
```

Nothing is copied, nothing is forked, and upstream's fixes arrive with the next
image rebuild. If you want to *change* one, copy it into your own mod's `npc/`
and leave it out of your `stock-npc.txt` — a mod's own scripts load after the
stock ones.

Paths are checked, not trusted: they must be under `npc/`, end in `.txt`, and
cannot climb out with `..`.

## Where they turn up

`warper` and `healer` are `-  script … -1` definitions with `duplicate()`
instances placed in every major town, so you get one per city without anybody
choosing coordinates. `jobmaster` stands in Prontera at `153,193` and `stylist`
at `170,180`.

If you also run the [quest-npc](../../examples/mods/quest-npc) example, note
that its Herbalist is at `prontera 150,193` — a few cells from the Job Master.
They do not conflict; they are just neighbours.

## Era

`jobmaster` reads its own `.ThirdClass` setting and does the right thing on
both sides, so this is marked `"era": "any"`. Pre-renewal stops at second
classes and rebirth, which is correct there rather than broken.

## The four that are deliberately left out

`resetnpc`, `platinum_skills`, `breeder` and `card_remover` are listed as
comments in `stock-npc.txt`. They are a bigger change than a warp or a haircut,
and are better chosen than defaulted. Copy the file into a mod of your own and
uncomment what you want.
