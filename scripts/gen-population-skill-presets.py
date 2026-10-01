#!/usr/bin/env python3
"""Regenerate the companion skill presets in third-party/population-engine.

WHY this exists: the curated presets in
`third-party/population-engine/files/db/population_skill_db.yml` are what a
companion AI actually casts. They were hand-written per job and went stale at the
top end - the 4th jobs had 3-5 rows each while their class trees grant 56-119
skills, so a drafted Cardinal ran 5 of its 81 legal skills and auto-attacked the
rest of its life. Hand-writing ~1,000 rows is how typos and invented skill names
get in, so the rows are DERIVED from the pinned server databases and this script
is the record of how.

WHAT IT EMITS, per missing legal skill (legal = in the class's skill_tree closure,
i.e. what population_engine_spawn_shell actually grants):

  TargetType  NoDamage  Status   ->  row shape
  Attack      no        -        ->  enemy rotation            { Rate: 9000 }
  Attack      no        - splash ->  enemy rotation            { Rate: 7000, enemy_count_nearby 2 }
  Attack      YES       -        ->  SKIPPED - a stance/combo, not a rotation skill.
                                     9 of 129 4th-job Attack skills, e.g.
                                     DK_CHARGINGPIERCE, a 3-minute buff typed Attack.
  Ground      -         -        ->  enemy rotation, placed near the target
                                     { AroundRange: 2, enemy_count_nearby 2 }
  Support     -         yes      ->  ally buff  { Target: ally, not_ally_status, SC_<status> }
  Support     -         no       ->  ally + self restorative { ally_hp_below, hp_below }
  Self        -         yes      ->  self buff  { Target: self, not_self_status, SC_<status> }
  Self        -         no       ->  SKIPPED. The buff loop's recast gate resolves a
                                     skill's SC through skill_get_sc() - a C++ table,
                                     independent of this YAML - so a Status-less self
                                     skill cannot be gated by anything written here and
                                     would re-cast every tick, draining SP.

Only the 4th-job classes are regenerated in depth. The 2nd/3rd-job presets carry
hand-tuned conditions and combos (`damaged_gt`, `after_skill`, `skill_used`) that no
generator reproduces, so for those only missing Attack/Ground skills are added and
every existing row is left byte-identical.

GATES (the run aborts rather than emitting something the server cannot use):
  * every CondValue status must exist in `src/map/script_constants.hpp` (the table
    script_get_constant reads), else the engine's resolve_sc_name returns -1 and the
    condition silently never matches
  * rows are inserted INSIDE their `- JobId:` block, above the Footer - appending to
    this file lands them in the Footer's Imports list and kills the map server at boot

Usage:
    python3 scripts/gen-population-skill-presets.py                  # dry run: print the plan
    python3 scripts/gen-population-skill-presets.py --write          # apply
    python3 scripts/gen-population-skill-presets.py --rathena ../rathena

After writing, always run the project's own checker and the data guards:
    python3 third-party/population-engine/validate.py     # must print "population data OK"
    node tests/companion-skill-presets.test.cjs
"""
import argparse
import collections
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
YAML_REL = "third-party/population-engine/files/db/population_skill_db.yml"

_ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
_ap.add_argument("--rathena", default=os.environ.get("RATHENA_DIR", os.path.join(ROOT, "vendor", "rathena")),
                 help="pinned rAthena checkout holding db/re/*.yml (default: vendor/rathena, which "
                      "scripts/vendor-fetch.sh puts on the pin)")
_ap.add_argument("--repo", default=ROOT, help="ragnarokoffline.app checkout (default: this script's repo)")
_ap.add_argument("--write", action="store_true", help="apply the plan (default: dry run)")
_ap.add_argument("--list-skipped", action="store_true",
                 help="print every skipped skill and its reason, not just the counts")
_ap.add_argument("--all-shapes", action="store_true",
                 help="apply the full row-shape table to 2nd/3rd jobs too (default: only "
                      "Attack/Ground there, because their buffs are hand-tuned)")
ARGS = _ap.parse_args()

RATHENA = ARGS.rathena
DB = f"{RATHENA}/db/re/skill_db.yml"
TREE = f"{RATHENA}/db/re/skill_tree.yml"
STATUS_HPP = f"{RATHENA}/src/map/status.hpp"
YAML = os.path.join(ARGS.repo, YAML_REL)

DRY = not ARGS.write

for _p in (DB, TREE):
    if not os.path.exists(_p):
        sys.exit(f"missing {_p} - pass --rathena pointing at the pinned checkout "
                 f"(see config/VENDOR_PINS)")
if not os.path.exists(YAML):
    sys.exit(f"missing {YAML} - pass --repo pointing at the app checkout")

# ---------------------------------------------------------------- skill_db.yml
def load_skill_db():
    txt = open(DB, encoding="utf-8", errors="replace").read()
    out = {}
    for b in re.split(r"\n  - Id: ", txt)[1:]:
        m = re.search(r"^    Name: (\w+)", b, re.M)
        if not m:
            continue
        name = m.group(1)
        def fld(f, default=None):
            mm = re.search(r"^    " + f + r":\s*(\S+)", b, re.M)
            val = mm.group(1) if mm else default
            return val

        def num(f, default=0):
            v = fld(f, None)
            return int(v) if v and re.fullmatch(r"-?\d+", v) else default

        out[name] = {
            "tt": fld("TargetType", "Passive"),
            "max": num("MaxLevel", 1),
            "nodmg": "NoDamage: true" in b,
            "status": fld("Status", "") or "",
            "dur": bool(re.search(r"^    Duration1:", b, re.M)),
            "splash": bool(re.search(r"^    SplashArea:", b, re.M)),
            "range": num("Range", 0),
            "cooldown": num("Cooldown", 0),
        }
    return out

def load_tree():
    txt = open(TREE, encoding="utf-8", errors="replace").read()
    own, inh = {}, {}
    for b in txt.split("\n  - Job: ")[1:]:
        name = b.split("\n", 1)[0].strip()
        d = {}
        m = re.search(r"^    Inherit:\n((?:      \w+: \w+\n)+)", b, re.M)
        if m:
            for line in m.group(1).strip().split("\n"):
                k, v = line.strip().split(":")
                d[k.strip()] = v.strip().lower() == "true"
        inh[name] = d
        tr = re.search(r"^    Tree:\n(.*?)(?=\n    \w+:|\Z)", b, re.M | re.S)
        sk = {}
        if tr:
            for mm in re.finditer(r"- Name: (\w+)\n\s+MaxLevel: (\d+)", tr.group(1)):
                sk[mm.group(1)] = int(mm.group(2))
        own[name] = sk

    cache = {}
    def closure(n, seen=None):
        if n in cache:
            return cache[n]
        seen = seen or {}
        out = {}
        for p, on in inh.get(n, {}).items():
            if on and p in own:
                out.update(closure(p, seen))
        out.update(own.get(n, {}))
        cache[n] = out
        return out
    return closure, own

# ------------------------------------------------------- status constant gate
def sc_constants():
    """The constants the ENGINE can actually resolve.

    script_get_constant() reads the exported script constant table, so
    script_constants.hpp is the oracle; a name present only in status.hpp would
    resolve to -1 and the condition would never match. Both are folded in so an
    enum-only constant still passes.
    """
    out = set()
    for path in (f"{RATHENA}/src/map/script_constants.hpp", STATUS_HPP):
        try:
            txt = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        out |= set(re.findall(r"\b(SC_[A-Z0-9_]+)\b", txt))
    return out

# ------------------------------------------------- journal
# 4th jobs: ids come from the engine's kJobNameMap (population_config.cpp).
FOURTH = {
    "Dragon_Knight": 4252, "Meister": 4253, "Shadow_Cross": 4254, "Arch_Mage": 4255,
    "Cardinal": 4256, "Windhawk": 4257, "Imperial_Guard": 4258, "Biolo": 4259,
    "Abyss_Chaser": 4260, "Elemental_Master": 4261, "Inquisitor": 4262,
    "Troubadour": 4263, "Trouvere": 4264, "Sky_Emperor": 4302, "Soul_Ascetic": 4303,
    "Shinkiro": 4304, "Shiranui": 4305, "Night_Watch": 4306, "Hyper_Novice": 4307,
    "Spirit_Handler": 4308,
}
# 2nd/3rd jobs: add missing ATTACK skills only. Buffs there are already hand-curated
# with tuned conditions, and regenerating them would churn a working file.
SECOND_THIRD = {
    "Knight": 7, "Priest": 8, "Wizard": 9, "Blacksmith": 10, "Hunter": 11,
    "Assassin": 12, "Crusader": 14, "Monk": 15, "Sage": 16, "Rogue": 17,
    "Alchemist": 18, "Bard": 19, "Dancer": 20,
    "Lord_Knight": 4008, "High_Priest": 4009, "High_Wizard": 4010,
    "Whitesmith": 4011, "Sniper": 4012, "Assassin_Cross": 4013, "Paladin": 4015,
    "Champion": 4016, "Professor": 4017, "Stalker": 4018, "Creator": 4019,
    "Clown": 4020, "Gypsy": 4021,
    "Rune_Knight": 4054, "Warlock": 4055, "Ranger": 4056, "Arch_Bishop": 4057,
    "Mechanic": 4058, "Guillotine_Cross": 4059, "Royal_Guard": 4066,
    "Sorcerer": 4067, "Minstrel": 4068, "Wanderer": 4069, "Sura": 4070,
    "Genetic": 4071, "Shadow_Chaser": 4072,
}

# Non-combat / AI-hostile families: quest items, party-wide utilities, soul-link
# skills that need a target PC, homunculus and vending plumbing, copy skills.
SKIP = re.compile(
    r"^(NV_|WE_|ALL_"
    r"|MO_CALLSPIRITS|MO_EXPLOSIONSPIRITS|MO_SPIRITSRECOVERY|CH_SOULCOLLECT"
    r"|SL_|SU_"
    r"|AM_CALLHOMUN|AM_REST|AM_RESURRECTHOMUN|AM_PHARMACY|AM_TWILIGHT|AM_BIOETHICS|AM_LEARNINGPOTION"
    r"|MC_|BS_GREED|BS_HILTBINDING|BS_FINDINGORE|BS_REPAIRWEAPON"
    r"|RG_PLAGIARISM|RG_COMPULSION|SC_|PF_|SA_ABRACADABRA|SA_COMA|SA_ELEMENTWATER|SA_CREATECON"
    r"|HP_MANARECHARGE|HP_MEDITATIO|HP_BASILICA|HP_ASSUMPTIO"
    r"|HT_MAKINGARROW|AC_MAKINGARROW|HT_TALKIEBOX|HT_REMOVETRAP|HT_SPRINGTRAP|HT_PHANTASMIC"
    r"|TF_STEAL|TF_PICKSTONE|TF_THROWSTONE|TF_SPRINKLESAND"
    r"|WS_CARTBOOST|BS_ADRENALINE2|NC_|GN_|KO_|OB_|RL_|NJ_|TK_|SG_|SO_EL_|SO_SPELLFISH|SO_ELEMENTAL_SHIELD)"
)

# Skills the Support-without-Status branch cannot shape correctly. Only the CURES need this: their
# gate must be "the ally HAS this status" (one row per status, and the status list lives in the
# skill's impl - `status_change_end` - which no YAML field carries), where the branch's generic
# "ally is hurt" gate fires on a healthy ally and wastes the cast. Everything else that lands in
# that branch (AM_BERSERKPITCHER, SR_POWERVELOCITY, MO_KITRANSLATION, MO_ABSORBSPIRITS,
# WM_DEADHILLHERE) keeps the branch's shape, which is what the 4th jobs already ship - Biolo has an
# AM_BERSERKPITCHER row and Troubadour/Trouvere have WM_DEADHILLHERE, so excluding them for the
# 2nd/3rd jobs would make this file inconsistent with its own settled policy.
HAND_WRITTEN = {
    "AL_CURE": "cure: needs Condition: ally_status per status, from cure.cpp",
    "TF_DETOXIFY": "cure: needs Condition: ally_status per status, from detoxify.cpp",
    "GC_ANTIDOTE": "cure: needs Condition: ally_status per status, from antidote.cpp",
}

def q(skill, extra):
    return f"      - {{ SkillId: {skill}, {extra} }}"

def rows_for(skill, meta, sc_ok, deep):
    """Return (list_of_yaml_lines, category) for one missing skill, or (None, why)."""
    tt, maxlv, nodmg, status, dur, splash, rng = (
        meta["tt"], meta["max"], meta["nodmg"], meta["status"], meta["dur"],
        meta["splash"], meta["range"])
    lv = maxlv if maxlv > 0 else 1

    if tt == "Attack":
        if nodmg:
            return None, "attack-without-damage (a stance/combo, not a rotation skill)"
        extra = f"Level: {lv}, Rate: 9000"
        if splash and rng > 1:
            extra = f"Level: {lv}, Rate: 7000, Condition: enemy_count_nearby, CondValue: 2"
        return [q(skill, extra)], "attack"

    if tt == "Ground":
        return [q(skill, f"Level: {lv}, Rate: 7000, AroundRange: 2, Condition: enemy_count_nearby, CondValue: 2")], "ground"

    if tt == "Support":
        if status:
            sc = "SC_" + status.upper()
            if sc not in sc_ok:
                return None, f"status constant {sc} not in status.hpp"
            return [q(skill, f"Level: {lv}, Rate: 8000, Target: ally, Condition: not_ally_status, CondValue: {sc}")], "ally-buff"
        # No status -> restorative/utility support: heal an ally and self.
        if not deep:
            return None, "support with no status (2nd/3rd buffs stay hand-curated)"
        return [
            q(skill, f"Level: {lv}, Rate: 10000, Target: ally, Condition: ally_hp_below, CondValue: 70"),
            q(skill, f"Level: {lv}, Rate: 10000, Target: self, Condition: hp_below, CondValue: 50"),
        ], "ally-heal"

    if tt == "Self":
        if not status:
            return None, "self skill with no Status (recast cannot be gated from YAML)"
        sc = "SC_" + status.upper()
        if sc not in sc_ok:
            return None, f"status constant {sc} not in status.hpp"
        return [q(skill, f"Level: {lv}, Rate: 8000, Target: self, Condition: not_self_status, CondValue: {sc}")], "self-buff"

    return None, f"target type {tt}"

def main():
    meta = load_skill_db()
    closure, _ = load_tree()
    sc_ok = sc_constants()
    ytext = open(YAML, encoding="utf-8").read()

    # Existing blocks, by span.
    spans = []
    for m in re.finditer(r"\n  - JobId: (\d+)\n    Skills:\n", ytext):
        spans.append((int(m.group(1)), m.start(), m.end()))

    existing = {}
    for i, (jid, s, e) in enumerate(spans):
        end = spans[i + 1][1] if i + 1 < len(spans) else len(ytext)
        body = ytext[e:end]
        existing[jid] = set(re.findall(r"SkillId:\s*([A-Z][A-Z0-9_]*)", body))

    plan = {}   # jid -> list of (line, skill, category)
    skipped = collections.Counter()
    reasons = collections.Counter()
    why = collections.defaultdict(list)

    for name, jid in list(FOURTH.items()) + list(SECOND_THIRD.items()):
        deep = ARGS.all_shapes or jid in FOURTH.values()
        cl = closure(name, )
        cur = existing.get(jid, set())
        for skill in sorted(k for k in cl if k not in cur):
            if SKIP.match(skill):
                skipped["family-skip"] += 1
                why["family-skip"].append(f"{skill} ({name})")
                continue
            m = meta.get(skill)
            if not m:
                skipped["no skill_db entry"] += 1
                continue
            if m["tt"] == "Passive":
                skipped["passive"] += 1
                why["passive"].append(f"{skill} ({name})")
                continue
            if skill in HAND_WRITTEN:
                skipped["needs a hand-written row"] += 1
                why["hand-written"].append(f"{skill} ({name}) - {HAND_WRITTEN[skill]}")
                continue
            lines, cat = rows_for(skill, m, sc_ok, deep)
            if lines is None:
                skipped[cat.split(" (")[0]] += 1
                reasons[cat] += 1
                key = "attack-without-damage" if cat.startswith("attack-without-damage") \
                    else "support-no-status" if cat.startswith("support with no status") \
                    else "self-no-status" if cat.startswith("self skill with no Status") \
                    else cat.split(" (")[0]
                why[key].append(f"{skill} ({name})")
                continue
            plan.setdefault(jid, []).append((lines, skill, cat))

    total_rows = sum(len(v) for v in plan.values())
    print("=== PLAN ===")
    print(f"job blocks to extend: {len(plan)}")
    print(f"skills to add      : {sum(len(v) for v in plan.values())}")
    print(f"yaml rows to add   : {total_rows}")
    print()
    print("--- skipped, by reason ---")
    for k, v in skipped.most_common(14):
        print(f"  {v:5d}  {k}")
    print()
    if ARGS.list_skipped:
        print("--- skipped, by skill ---")
        for k in sorted(why, key=lambda k: -len(why[k])):
            print(f"  [{k}] {len(why[k])}")
            for item in sorted(why[k]):
                print(f"      {item}")
        print()
    print("--- per job ---")
    for jid in sorted(plan):
        cats = collections.Counter(c for _, _, c in plan[jid])
        label = next((n for n, i in {**FOURTH, **SECOND_THIRD}.items() if i == jid), str(jid))
        det = ", ".join(f"{k}={v}" for k, v in sorted(cats.items()))
        print(f"  {label:17s} id={jid:<5d} +{len(plan[jid]):3d} skills  ({det})")

    if DRY:
        print("\n(dry run: pass --write to apply)")
        return

    # ------------------------------------------------------------- splice in place
    out = []
    last = 0
    for i, (jid, s, e) in enumerate(spans):
        end = spans[i + 1][1] if i + 1 < len(spans) else len(ytext)
        out.append(ytext[last:e])          # header line + "Skills:" up to body start
        body = ytext[e:end]
        if jid in plan:
            # Insert before the trailing blank line, i.e. inside the block.
            add = "".join(line + "\n" for lines, _, _ in plan[jid] for line in lines)
            stripped = body.rstrip("\n")
            trail = body[len(stripped):]
            body = stripped + "\n" + add + trail.lstrip("\n")
        out.append(body)
        last = end
    out.append(ytext[last:])
    new_text = "".join(out)

    if new_text == ytext:
        # A no-op run is the EXPECTED outcome on an up-to-date file, so it must not
        # look like a failure to a caller (or to CI).
        print(f"\nnothing to add - {YAML} is already generated")
        return
    open(YAML, "w", encoding="utf-8", newline="").write(new_text)
    print(f"\nwrote {YAML}")

main()
