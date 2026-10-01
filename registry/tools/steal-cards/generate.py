#!/usr/bin/env python3
"""Regenerate registry/mods/steal-cards/db/mob_db.yml from rAthena's mob table.

A development tool, run by whoever updates the mod -- never by the app. The
mod is the generated db/mob_db.yml, committed; nothing a player installs runs
Python. It lives outside the mod folder for that reason (and because the
registry index does not carry .py files).

    python3 registry/tools/steal-cards/generate.py            # rewrite it
    python3 registry/tools/steal-cards/generate.py --check    # fail if stale

By default it reads vendor/rathena/db/re/mob_db.yml, which should be the
rAthena commit config/VENDOR_PINS names: `scripts/vendor-fetch.sh rathena
vendor/rathena` puts it there, and prints `already at <sha>` when it is. The
pinned commit is written into the output's header so a reader can tell which
table the indexes were taken from. `--source` reads another copy instead.

For every non-MVP monster whose Drops table contains a card, this writes an
override entry that targets the card's existing slot by Index and flips
StealProtected: false. That is the whole change; rAthena's `pc_steal_item`
filters on that flag and does the rest. Item and Rate are not restated: the
fork's MobDatabase::parseDropNode (Flux159/rathena#4) keeps the stock values
for any field an override of an existing Index leaves out.

MVPs are excluded. "MVP" here is the strict rAthena meaning: `MvpDrops:` is
present, or `Modes.Mvp: true` is set. Mini-bosses (Angeling, Ghostring,
Vagabond Wolf and friends) are `Class: Boss` without either, so their cards
stay in.

Renewal only. Pre-renewal's db/pre-re/mob_db.yml puts the card in a different
slot for about a fifth of the monsters both tables have, and a mod cannot ship
a table per era, so the mod declares `"era": "renewal"` rather than flip the
wrong drop on a pre-renewal server.

Standard library only, so there is nothing to install. The stock table is
regular enough to read line by line; the shape it relies on is checked, and a
table it does not recognise is an error rather than a quietly short output.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SOURCE = ROOT / "vendor" / "rathena" / "db" / "re" / "mob_db.yml"
DEFAULT_OUT = ROOT / "registry" / "mods" / "steal-cards" / "db" / "mob_db.yml"

# Per-mob Rate: overrides, keyed by the mob's Id. Leave a mob out and its stock
# drop rate is used (both on-kill and Steal track whatever rAthena ships). A
# value here changes both the on-kill drop and the Steal weighting -- there is
# no field that affects only Steal. rAthena's rate unit is 0.01%.
RATE_OVERRIDES: dict[int, int] = {}

ENTRY = re.compile(r"^  - Id: (\d+)\s*$")
FIELD = re.compile(r"^    (\w+):\s*(.*?)\s*$")
SUBFIELD = re.compile(r"^      (\w+):\s*(.*?)\s*$")
DROP = re.compile(r"^      - Item: (\S+)\s*$")
DROP_INDEX = re.compile(r"^        Index: (\d+)\s*$")


def pinned_rathena() -> str:
    """The rathena commit config/VENDOR_PINS names, or '' if unreadable."""
    try:
        for line in (ROOT / "config" / "VENDOR_PINS").read_text().splitlines():
            parts = line.split()
            if len(parts) >= 3 and parts[0] == "rathena":
                return parts[2]
    except OSError:
        pass
    return ""


def checkout_commit(source: Path) -> str:
    """HEAD of the git checkout the source file is in, or '' if it is not one."""
    try:
        out = subprocess.run(["git", "-C", str(source.parent), "rev-parse", "HEAD"],
                             capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def read_mobs(text: str):
    """Yield one dict per monster: id, aegis, name, class, mvp_drops, mode_mvp,
    drops [[item, index]]."""
    mob = None
    section = None
    in_body = False
    for line in text.splitlines():
        if line.startswith("Body:"):
            in_body = True
            continue
        if not in_body or not line.strip() or line.lstrip().startswith("#"):
            continue
        m = ENTRY.match(line)
        if m:
            if mob:
                yield mob
            mob = {"id": int(m.group(1)), "aegis": "?", "name": "?", "class": "",
                   "mvp_drops": False, "mode_mvp": False, "drops": []}
            section = None
            continue
        if mob is None:
            raise SystemExit(f"unexpected line before the first entry: {line!r}")
        m = FIELD.match(line)
        if m:
            key, value = m.groups()
            section = key
            if key == "AegisName":
                mob["aegis"] = unquote(value)
            elif key == "Name":
                mob["name"] = unquote(value)
            elif key == "Class":
                mob["class"] = unquote(value)
            elif key == "MvpDrops":
                mob["mvp_drops"] = True
            continue
        if section == "Modes":
            m = SUBFIELD.match(line)
            if m and m.group(1) == "Mvp" and m.group(2).lower() == "true":
                mob["mode_mvp"] = True
            continue
        if section == "Drops":
            m = DROP.match(line)
            if m:
                mob["drops"].append([m.group(1), None])
                continue
            m = DROP_INDEX.match(line)
            if m and mob["drops"]:
                mob["drops"][-1][1] = int(m.group(1))
    if mob:
        yield mob


def is_mvp(mob) -> bool:
    """True for actual MVPs. `Class: Boss` on its own is not enough: Angeling,
    Deviling, Ghostring, Vagabond Wolf and dozens of other mini-bosses are
    Class: Boss but not MVPs, and their cards are precisely the ones a Thief
    wants. For a stricter mod, add `or mob["class"] == "Boss"` here."""
    return mob["mvp_drops"] or mob["mode_mvp"]


def find_card_drop(mob):
    """(index, item) of the mob's first card drop, or None.

    Index is the drop's explicit `Index:` if it has one, otherwise its position
    in the list -- which is how rAthena assigns slots when they are not spelled
    out."""
    for pos, (item, index) in enumerate(mob["drops"]):
        if item.endswith("_Card"):
            return (pos if index is None else index), item
    return None


def render(source: Path, text: str) -> tuple[str, dict]:
    stats = {"cards": 0, "mvp": 0, "no_card": 0, "total": 0}
    entries = []
    for mob in read_mobs(text):
        stats["total"] += 1
        if is_mvp(mob):
            stats["mvp"] += 1
            continue
        found = find_card_drop(mob)
        if found is None:
            stats["no_card"] += 1
            continue
        entries.append((mob["id"], mob["aegis"], mob["name"]) + found)
    if stats["total"] < 1000:
        raise SystemExit(f"{source}: only {stats['total']} monsters read -- not a mob_db.yml this understands")
    entries.sort()
    stats["cards"] = len(entries)

    pin = pinned_rathena()
    head = checkout_commit(source)
    origin = head or pin or "unknown"
    lines = [
        "# Generated by registry/tools/steal-cards/generate.py -- do not",
        "# hand-edit. Rerun it when config/VENDOR_PINS moves rAthena; see",
        "# README.md.",
        f"# Source: Flux159/rathena {origin}, db/re/mob_db.yml",
        "#",
        "# For every non-MVP monster that already drops a card, this file",
        "# flips StealProtected: false on the exact slot the card sits at.",
        "# Item and Rate are not restated: MobDatabase::parseDropNode treats",
        "# them as optional on an override targeting an existing Index, so",
        "# the stock values stay whatever rAthena ships. rAthena's",
        "# pc_steal_item filters out steal_protected drops; flipping the",
        "# flag is the whole change. Renewal's slots: pre-renewal differs.",
        "Header:",
        "  Type: MOB_DB",
        "  Version: 5",
        "",
        "Body:",
    ]
    for mob_id, aegis, name, idx, card in entries:
        lines.append(f"  - Id: {mob_id} # {name} ({aegis}) -- {card}")
        lines.append("    Drops:")
        lines.append(f"      - Index: {idx}")
        if mob_id in RATE_OVERRIDES:
            lines.append(f"        Rate: {RATE_OVERRIDES[mob_id]}")
        lines.append("        StealProtected: false")
    if head and pin and head != pin:
        print(f"warning: {source} is at {head}, but config/VENDOR_PINS pins {pin}", file=sys.stderr)
    return "\n".join(lines) + "\n", stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                    help="rAthena's renewal mob_db.yml (default: vendor/rathena/db/re/mob_db.yml)")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="output file (default: the mod's db/mob_db.yml)")
    ap.add_argument("--check", action="store_true",
                    help="write nothing; fail if the output is not what the source generates")
    args = ap.parse_args()

    if not args.source.is_file():
        raise SystemExit(f"{args.source}: not found -- scripts/vendor-fetch.sh rathena vendor/rathena, or pass --source")
    out, stats = render(args.source, args.source.read_text(encoding="utf-8"))

    print(f"monsters read:                 {stats['total']}", file=sys.stderr)
    print(f"mobs with a card drop, non-MVP: {stats['cards']}", file=sys.stderr)
    print(f"skipped MVPs:                  {stats['mvp']}", file=sys.stderr)
    print(f"mobs without a card:           {stats['no_card']}", file=sys.stderr)

    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != out:
            print(f"{args.out} is out of date; rerun without --check", file=sys.stderr)
            return 1
        print(f"{args.out} is up to date", file=sys.stderr)
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(out, encoding="utf-8")
    print(f"wrote:                         {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
