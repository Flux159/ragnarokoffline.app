#!/usr/bin/env python3
"""Build prontera-vendors' two YAML files from rAthena's own data.

    python3 registry/tools/prontera-vendors/build_vendors.py [--refresh-prices | --all-prices] [--reprice]

Each theme below says *what* a stall sells: a hand list, a rule over the item
database, or "whatever the monsters of these dungeons drop". The script
resolves that against vendor/rathena (renewal item, mob and spawn databases),
prices every item, and writes:

    db/population_vendors.yml      one VendorKey per theme, with its Pool
    db/population_vendor_pop.yml   one PlacementBound shell profile per theme

Prices come from registry/tools/prontera-vendors/prices.json, a cache of iRO player-market averages
(ragnastats.com, roughly 2013-2020 data). --refresh-prices fetches any item
the cache lacks; --all-prices fetches every tradeable item (about an hour),
so rule themes rank by what players really traded. Delete an entry to fetch
it again.

Prices also go to db/population_vendor_prices/prontera-vendors.csv
(Id,Name,Min,Max), which the server reads and which wins over the YAML. A
re-run keeps every row already there, so hand edits survive; --reprice
rebuilds it from market data instead. Those averages include
refined and carded copies, so for equipment an NPC also sells, the NPC price
wins, and averages that are wildly out of line with an item's NPC value are
treated as trolling and ignored.

The output is ordinary YAML: tune it by hand if you like, but a re-run
overwrites it, so lasting changes belong in this script.
"""
import json
import os
import random
import re
import subprocess
import sys
import time

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
# This script lives in registry/tools/prontera-vendors/, out of the mod: the
# registry ships every file in a mod's folder to players, and this and its
# price caches are for building the mod, not for playing it.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
MOD = os.path.join(REPO, "registry", "mods", "prontera-vendors")
# Which era to build for. Renewal writes db/; --era pre-re builds from
# rAthena's pre-renewal tables into pre-re/db/, which mod.json's
# "prerenewalFolder" lays over db/ on a pre-renewal server.
ERA = "pre-re" if "--era" in sys.argv and sys.argv[sys.argv.index("--era") + 1] in ("pre-re", "prere", "pre-renewal") else "re"
OTHER_ERA = "re" if ERA == "pre-re" else "pre-re"
OUT_DB = os.path.join(MOD, "pre-re", "db") if ERA == "pre-re" else os.path.join(MOD, "db")
RA = os.path.join(REPO, "vendor", "rathena")
PRICES = os.path.join(HERE, "prices.json")
# The price table the server reads (Id,Name,Min,Max). Rows already in it are
# kept as they are, so hand edits survive a re-run; new items are appended.
TABLE_CSV = os.path.join(OUT_DB, "population_vendor_prices", "prontera-vendors.csv")
# Sell stalls; buy shops will live under prontera-vendors/buy/, so each
# group can be counted and switched on its own.
PREFIX = "prontera-vendors/sell/"
MARKET = PREFIX + "sidewalks"
CANDIDATE_CAP = 80
# Rule-built themes leave out anything dearer than this: kRO's endgame gear and
# costumes list for hundreds of millions, which no solo player can reach and
# which would crowd out the stock people buy. Hand-listed items are exempt.
POOL_MAX = 50_000_000

Loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


# Stalls per market by default, and the most the settings allow.
STALLS = 30
STALLS_MAX = 100
# How full a lane gets (% of its usable cells, rolled per lane) before stalls
# open on the next one: the gaps a real street has.
LANE_FILL = "[70, 80]"

# Prontera's sidewalks: west (x=147) and east (x=164) of the main road, and
# the two rows east of the fountain (y=110 and y=125). The market fills them
# one lane at a time in this order ("Fill: Lanes"), each stall next to the
# last, as players crowd into a street that is already busy: the lanes at the
# top (north) first, then the bottom, then the left, then the right.
AREAS = [
    {"X1": 147, "Y1": 136, "X2": 147, "Y2": 170},  # top, west
    {"X1": 164, "Y1": 135, "X2": 164, "Y2": 173},  # top, east
    {"X1": 147, "Y1": 52, "X2": 147, "Y2": 111},   # bottom, west
    {"X1": 164, "Y1": 52, "X2": 164, "Y2": 111},   # bottom, east
    {"X1": 172, "Y1": 125, "X2": 207, "Y2": 125},  # right, upper row
    {"X1": 172, "Y1": 110, "X2": 207, "Y2": 110},  # right, lower row
]

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def load_items():
    by_name, by_id = {}, {}
    for f in ("item_db_equip.yml", "item_db_usable.yml", "item_db_etc.yml"):
        body = yaml.load(open(os.path.join(RA, "db", ERA, f), encoding="utf-8"), Loader=Loader).get("Body") or []
        for e in body:
            by_name[e["AegisName"].lower()] = e
            by_id[e["Id"]] = e
    return by_name, by_id


def load_mobs():
    body = yaml.load(open(os.path.join(RA, "db", ERA, "mob_db.yml"), encoding="utf-8"), Loader=Loader)["Body"]
    return {m["Id"]: m for m in body}


def npc_shop_prices():
    """Item id -> the lowest zeny price any NPC sells it for: shop and
    marketshop NPCs (-1 = the item's own Buy price), and what scripts stock
    them with (npcshopupdate; a price of 0 there leaves it unchanged)."""
    prices = {}

    def note(iid, price):
        if price == -1:
            price = (ITEMS_BY_ID.get(iid) or {}).get("Buy") or 0
        if price > 0:
            prices[iid] = min(prices.get(iid, price), price)

    for root, _, files in os.walk(os.path.join(RA, "npc")):
        if OTHER_ERA in os.path.relpath(root, os.path.join(RA, "npc")).split(os.sep):
            continue
        for f in files:
            if not f.endswith(".txt"):
                continue
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                # A commented-out shop sells nothing: renewal's shops.txt keeps
                # a disabled test shop that "sold" Old Card Albums at 10,000z,
                # which capped every OCA price to that.
                if line.lstrip().startswith("//"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 4 and parts[1] in ("shop", "marketshop"):
                    for tok in parts[3].split(",")[1:]:
                        m = re.match(r"(\d+):(-?\d+)", tok)
                        if m:
                            note(int(m.group(1)), int(m.group(2)))
                m = re.search(r'npcshopupdate\s+"[^"]+"\s*,\s*(\d+)\s*,\s*(-?\d+)', line)
                if m:
                    note(int(m.group(1)), int(m.group(2)))
    return prices


def npc_shop_items():
    """Item ids an NPC sells for zeny: shop and marketshop NPCs, and what
    scripts restock them with."""
    ids = set()
    for root, _, files in os.walk(os.path.join(RA, "npc")):
        if OTHER_ERA in os.path.relpath(root, os.path.join(RA, "npc")).split(os.sep):
            continue
        for f in files:
            if not f.endswith(".txt"):
                continue
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                if line.lstrip().startswith("//"):
                    continue
                parts = line.rstrip("\n").split("\t")
                # Plain zeny shops and market shops (id:price[:stock])...
                if len(parts) >= 4 and parts[1] in ("shop", "marketshop"):
                    for tok in parts[3].split(",")[1:]:
                        m = re.match(r"(\d+):", tok)
                        if m:
                            ids.add(int(m.group(1)))
                # ...and what scripts stock them with (the refiners' ores).
                m = re.search(r'npcshopupdate\s+"[^"]+"\s*,\s*(\d+)\s*,', line)
                if m:
                    ids.add(int(m.group(1)))
    return ids


def mob_ref(tok):
    """A spawn line's monster, by id ("1161,...") or Aegis name ("GAN_CEANN,...")."""
    ref = tok.split(",")[0].strip()
    if ref.isdigit():
        return int(ref)
    return MOBS_BY_AEGIS.get(ref.upper())


def spawns(files):
    """(mob id, is_boss_monster) for every spawn line in npc/re/mobs/<file>
    (a bare file name means dungeons/)."""
    out = []
    for f in files:
        path = os.path.join(RA, "npc", ERA, "mobs", f if "/" in f else os.path.join("dungeons", f))
        if not os.path.exists(path):
            continue  # this era has no such place
        for line in open(path, encoding="utf-8", errors="replace"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 4 and parts[1].startswith(("monster", "boss_monster")):
                mid = mob_ref(parts[3])
                if mid:
                    out.append((mid, parts[1].startswith("boss_monster")))
    return out


ITEMS, ITEMS_BY_ID = load_items()
MOBS = load_mobs()
MOBS_BY_AEGIS = {m["AegisName"].upper(): i for i, m in MOBS.items()}
NPC_PRICE = npc_shop_prices()
NPC_SOLD = set(NPC_PRICE)
MVP_IDS = {i for i, m in MOBS.items() if m.get("MvpExp", 0) > 0}


def item(name):
    return ITEMS.get(name.lower())


def tradeable(e):
    t = e.get("Trade") or {}
    return not (t.get("NoTrade") or t.get("NoCart") or t.get("NoDrop"))


def is_equip(e):
    return e.get("Type") in ("Weapon", "Armor", "ShadowGear")


# Cards that MVPs drop are never sold: on a real server they are the
# million-zeny trophies nobody parts with on a sidewalk.
MVP_CARDS = set()
for _mid in MVP_IDS:
    for _d in MOBS[_mid].get("Drops") or []:
        _e = item(_d["Item"])
        if _e and _e.get("Type") == "Card":
            MVP_CARDS.add(_e["Id"])

# What a pre-renewal server can actually give a player. rAthena's pre-renewal
# item database also holds what came with renewal and later (third-job gear,
# runes and spell books, cash-shop and event items, slotted variants nothing
# drops), with nothing in pre-renewal that hands them out; a stall selling
# those would put renewal items into a pre-renewal world. So the pre-renewal
# set lists only what has a source there. Renewal lists as it always did.
SCRIPT_GIVES = re.compile(r"\b(getitem[23]?|getitembound[23]?|getnameditem|makeitem[23]?|callfunc|callsub)\b")
SCRIPT_SPAWNS = re.compile(r"\b(areamonster|monster|summon)\b")


def era_scripts():
    """The NPC script files this era's server loads: npc/<era>/scripts_main.conf
    and what it imports (so nothing from npc/custom or a switched-off event)."""
    seen, out = set(), []

    def conf(path):
        if path in seen or not os.path.exists(path):
            return
        seen.add(path)
        for line in open(path, encoding="utf-8", errors="replace"):
            m = re.match(r"(npc|import)\s*:\s*(\S+)", line.split("//")[0].strip())
            if not m:
                continue
            target = os.path.join(RA, m.group(2))
            if m.group(1) == "import":
                conf(target)
            elif os.path.exists(target):
                out.append(target)

    conf(os.path.join(RA, "npc", ERA, "scripts_main.conf"))
    return out


def era_obtainable():
    """Ids of the items this era's server hands out somewhere:
    - a monster that is out there drops them: one with a spawn line, one a
      script spawns, a dead branch's summons, their slaves and what they turn
      into, and the castles' treasure chests;
    - an NPC sells them (for zeny, items or points) or a script gives them:
      quest rewards, exchanges, socket enchants;
    - players make them (produce_db, or arrow crafting from something
      obtainable), or they are a pet's egg, taming item, food or accessory;
    - something obtainable holds them: a box's item group, or an item whose
      own script gives them."""
    got = set()
    live = set()

    def tokens(text):
        return re.findall(r"[A-Za-z_0-9']+", text)

    def give(tok, numbers=True):
        if tok.isdigit():
            if numbers and int(tok) in ITEMS_BY_ID:
                got.add(int(tok))
        elif len(tok) > 3:
            e = item(tok)
            if e:
                got.add(e["Id"])

    castles = False
    for path in era_scripts():
        castles = castles or os.sep + "guild" in path
        for line in open(path, encoding="utf-8", errors="replace"):
            if line.lstrip().startswith("//"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 4 and parts[1].startswith(("monster", "boss_monster")):
                mid = mob_ref(parts[3])
                if mid in MOBS:
                    live.add(mid)
                continue
            if len(parts) >= 4 and parts[1] in ("shop", "marketshop", "itemshop", "pointshop"):
                for tok in parts[3].split(",")[1:]:
                    give(tok.split(":")[0].strip())
                continue
            code = line.split("//")[0]
            if os.sep + "mobs" + os.sep in path:
                # A spawn script that rolls one of a run of monsters (the
                # Bio Lab's MVPs): rand(1646,1651).
                for lo, hi in re.findall(r"\brand\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", code):
                    if int(lo) in MOBS and int(hi) in MOBS and 0 <= int(hi) - int(lo) < 50:
                        live.update(i for i in range(int(lo), int(hi) + 1) if i in MOBS)
            if SCRIPT_SPAWNS.search(code):
                for tok in tokens(code):
                    mid = int(tok) if tok.isdigit() else MOBS_BY_AEGIS.get(tok.upper())
                    if mid in MOBS and (not tok.isdigit() or mid > 1000):
                        live.add(mid)
            if SCRIPT_GIVES.search(code) or "npcshop" in code:
                for tok in tokens(code):
                    give(tok)
            elif "setarray" in code:
                # A reward list: ids outside the monsters' range, or names.
                # In a spawn file it is the monsters a script picks from.
                for tok in tokens(code):
                    give(tok, numbers=not (tok.isdigit() and 1000 < int(tok) < 4000))
                    if os.sep + "mobs" + os.sep in path and tok.isdigit() and int(tok) in MOBS:
                        live.add(int(tok))
    if castles:
        live.update(i for i, m in MOBS.items() if m["AegisName"].startswith("TREASURE_BOX"))
    summons = yaml.load(open(os.path.join(RA, "db", ERA, "mob_summon.yml"), encoding="utf-8"), Loader=Loader).get("Body") or []
    for g in summons:
        for s in g.get("Summon") or []:
            mid = MOBS_BY_AEGIS.get(str(s["Mob"]).upper())
            if mid:
                live.add(mid)
    skills = [l.strip().split(",") for l in open(os.path.join(RA, "db", ERA, "mob_skill_db.txt"), encoding="utf-8", errors="replace")
              if l[:1].isdigit()]
    grew = True
    while grew:
        grew = False
        for p in skills:
            if len(p) > 16 and int(p[0]) in live and re.search(r"SUMMON|METAMORPHOSIS|TRANSFORMATION", p[1]):
                for v in p[12:17]:
                    if v.isdigit() and int(v) in MOBS and int(v) not in live:
                        live.add(int(v))
                        grew = True
    for mid in live:
        for d in (MOBS[mid].get("Drops") or []) + (MOBS[mid].get("MvpDrops") or []):
            e = item(d["Item"])
            if e:
                got.add(e["Id"])
    produce = os.path.join(RA, "db", ERA, "produce_db.txt")
    if os.path.exists(produce):
        for line in open(produce, encoding="utf-8", errors="replace"):
            parts = line.split("//")[0].strip().split(",")
            if len(parts) > 1 and parts[1].strip().isdigit() and int(parts[1]) in ITEMS_BY_ID:
                got.add(int(parts[1]))
    pets = yaml.load(open(os.path.join(RA, "db", ERA, "pet_db.yml"), encoding="utf-8"), Loader=Loader).get("Body") or []
    for p in pets:
        if MOBS_BY_AEGIS.get(str(p.get("Mob", "")).upper()) in live:
            for k in ("EggItem", "TameItem", "EquipItem", "FoodItem"):
                e = item(str(p.get(k) or ""))
                if e:
                    got.add(e["Id"])
    # What an obtainable item leads to: the group its script opens (a box),
    # what its script gives outright, and the arrows crafted from it.
    opens, gives = {}, {}
    for e in ITEMS_BY_ID.values():
        script = str(e.get("Script") or "")
        for g in re.findall(r"\bIG_([A-Za-z_0-9]+)", script):
            opens.setdefault(g.upper(), set()).add(e["Id"])
        for tok in re.findall(r"\bgetitem[23]?\s*\(?\s*\"?([A-Za-z_0-9']+)", script):
            t = ITEMS_BY_ID.get(int(tok)) if tok.isdigit() else item(tok)
            if t:
                gives.setdefault(e["Id"], set()).add(t["Id"])
    groups = yaml.load(open(os.path.join(RA, "db", ERA, "item_group_db.yml"), encoding="utf-8"), Loader=Loader).get("Body") or []
    arrows = []
    for path in (os.path.join(RA, "db", "create_arrow_db.yml"), os.path.join(RA, "db", ERA, "create_arrow_db.yml")):
        if os.path.exists(path):
            arrows += yaml.load(open(path, encoding="utf-8"), Loader=Loader).get("Body") or []
    grew = True
    while grew:
        before = len(got)
        for g in groups:
            if opens.get(str(g["Group"]).upper(), set()) & got:
                for sub in g.get("SubGroups") or []:
                    for row in sub.get("List") or []:
                        e = item(str(row["Item"]))
                        if e:
                            got.add(e["Id"])
        for src in [i for i in gives if i in got]:
            got.update(gives[src])
        for a in arrows:
            src = item(str(a.get("Source") or ""))
            if src and src["Id"] in got:
                for row in a.get("Make") or []:
                    e = item(str(row["Item"]))
                    if e:
                        got.add(e["Id"])
        grew = len(got) > before
    return got


OBTAINABLE = era_obtainable() if ERA == "pre-re" else None


def obtainable(e):
    return OBTAINABLE is None or e["Id"] in OBTAINABLE


# ---------------------------------------------------------------------------
# Prices
# ---------------------------------------------------------------------------

try:
    CACHE = json.load(open(PRICES))
except FileNotFoundError:
    CACHE = {}


def fetch(iid):
    try:
        raw = subprocess.run(["curl", "-s", "-m", "20", "-A", "Mozilla/5.0", f"https://ragnastats.com/item/{iid}"],
                             capture_output=True, timeout=30).stdout
    except subprocess.TimeoutExpired:
        return [None, 0]
    h = raw.decode("utf-8", errors="replace")
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", h))
    m = re.search(r"Average Price ([\d,]+)z", t)
    n = re.search(r"Seen (\d+) times", t)
    return [int(m.group(1).replace(",", "")) if m else None, int(n.group(1)) if n else 0]


_fetched = 0


def market(iid, refresh):
    global _fetched
    k = str(iid)
    if k not in CACHE and refresh:
        CACHE[k] = fetch(iid)
        _fetched += 1
        if _fetched % 25 == 0:
            json.dump(CACHE, open(PRICES, "w"), indent=0, sort_keys=True)
            print(f"    {_fetched} prices fetched", file=sys.stderr)
        time.sleep(0.3)
    return CACHE.get(k, [None, 0])


def price(e, refresh=False):
    """The price a stall asks, on the chosen scale, or None to leave it out."""
    p, _ = priced(e, refresh)
    return p


def priced(e, refresh=False):
    """(price, source) on the chosen SCALE, or (None, None).

    A price fixed in PRICE_SET wins, then a row edited by hand in the price
    table. Then the main source's market price, then the other source's
    converted with the per-category factor, then the NPC-based floor."""
    fixed = PRICE_SET.get(e["AegisName"])
    if fixed:
        return sum(fixed) // 2, "set"
    row = TABLE.get(e["Id"])
    if row and row[2] == "manual" and row[0] > 0:
        return (row[0] + row[1]) // 2, "manual"
    p, src = _priced(e, refresh)
    # Nobody pays a player more than an NPC charges for the same thing; asking
    # prices above it are listings that never sell, and they drag a median up
    # (kRO's Phracon "sells" for 10k beside a 200z NPC).
    npc = NPC_PRICE.get(e["Id"], 0)
    if e.get("Type") in PET_EGG_TYPES + PET_GEAR_TYPES:
        npc = 0  # only event shops hand these out, at placeholder prices
    if p is not None and src != "npc" and npc > 0 and p > npc:
        p = npc
    return p, src


def _priced(e, refresh):
    iro, iro_origin = iro_price(e, refresh)
    kro = kro_price(e)
    f = FACTOR.get(category(e), FACTOR.get("*", 1.0))
    if SCALE == "kro":
        if kro is not None:
            return kro, "kro"
        if iro is not None:
            return (iro, "npc") if iro_origin == "npc" else (max(1, int(iro * f)), "ragnastats")
    else:
        if iro is not None:
            return iro, ("npc" if iro_origin == "npc" else "ragnastats")
        if kro is not None:
            return max(1, int(kro / f)), "kro"
    # No market price: a same-named item's (Knife -> Knife [3]), then the
    # estimate model's. Both only once train_fallbacks() has run.
    sib = SIBLING.get(base_name(e["Name"]))
    if sib:
        return sib, "sibling"
    if ESTIMATOR is not None:
        q = ESTIMATOR.predict(e)
        if q:
            return max(q, (e.get("Sell") or 0) + 1), "estimate"
    return None, None


SIBLING = {}
ESTIMATOR = None


def base_name(name):
    return re.sub(r"\s*\[\d\]$", "", name).strip().lower()


def train_fallbacks():
    """Learn the fallbacks from the items that have a market price."""
    global ESTIMATOR
    import statistics
    import estimate
    known, by_name = [], {}
    for e in ITEMS_BY_ID.values():
        if not tradeable(e):
            continue
        p, src = priced(e)
        if p and src in ("kro", "ragnastats"):
            known.append((e, p))
            by_name.setdefault(base_name(e["Name"]), []).append(p)
    SIBLING.update({k: int(statistics.median(v)) for k, v in by_name.items()})
    model = estimate.Model(category, NPC_SOLD, estimate.drop_stats(MOBS, item, MVP_IDS))
    err = model.evaluate(known)
    print(f"  estimate model: {err['all'][0]} known items, typical error x{err['all'][1]:.2f}", file=sys.stderr)
    ESTIMATOR = model.fit(known)


KRO_PATH = os.path.join(HERE, "prices_kro.json")
try:
    KRO = json.load(open(KRO_PATH))
except FileNotFoundError:
    KRO = {}
# Which economy the stalls follow. "kro": RagMAYA's kRO medians, the cheaper
# and steadier scale, with ragnastats' iRO averages converted into it where
# kRO has nothing; "iro": the other way round.
SCALE = "kro"
KRO_MIN_SAMPLES = 3

# Prices set here rather than taken from a market, as [min, max] per era. They
# live in the script, not as hand edits in the price table, so --reprice keeps
# them and the reason stays beside the number.
# Card albums: kRO's median (~300k) is a cash-shop price, and on this price
# list an Old Card Album rolls a card worth ~975k on average in renewal (~667k
# pre-renewal), so it sells for about that, under the 2.5M the Eden market NPC
# asks. A Mystical Card Album is a shot at the rare cards: three OCAs' worth.
PRICE_SET = {
    "re": {"Old_Card_Album": (900_000, 1_100_000), "Magic_Card_Album": (2_700_000, 3_300_000)},
    "pre-re": {"Old_Card_Album": (600_000, 750_000), "Magic_Card_Album": (1_800_000, 2_250_000)},
}[ERA]


def popularity(e):
    """How much an item is traded: iRO sightings plus kRO listings (weighted
    to a similar scale), for ranking a rule theme's candidates."""
    v = KRO.get(str(e["Id"])) or [None, 0, None]
    return market(e["Id"], False)[1] + 20 * (v[1] or 0)


def kro_price(e):
    v = KRO.get(str(e["Id"]))
    if not v or not v[0] or v[1] < KRO_MIN_SAMPLES:
        return None
    if is_equip(e) and v[0] < 50:
        return None
    return max(v[0], (e.get("Sell") or (e.get("Buy") or 0) // 2) + 1)


def category(e):
    t = e.get("Type")
    if t == "Armor":
        l = locs(e)
        if l & {"Head_Top", "Head_Mid", "Head_Low"}:
            return "headgear"
        if l & {"Right_Accessory", "Left_Accessory", "Both_Accessory"}:
            return "accessory"
        return "armor"
    return t or "*"


FACTOR = {}


def calibrate():
    """kRO / iRO per category, from items both sources price well."""
    import statistics
    ratios = {}
    for e in ITEMS_BY_ID.values():
        iro, origin = iro_price(e, False)
        kro = kro_price(e)
        if iro and kro and origin == "market":
            ratios.setdefault(category(e), []).append(kro / iro)
    every = [r for rs in ratios.values() for r in rs]
    FACTOR["*"] = statistics.median(every) if every else 1.0
    for c, rs in ratios.items():
        if len(rs) >= 10:
            FACTOR[c] = statistics.median(rs)
    print("  kRO/iRO per category: " + ", ".join(f"{c} {FACTOR[c]:.2f}" for c in sorted(FACTOR)) , file=sys.stderr)


def iro_price(e, refresh):
    """(price, "market" | "npc") on iRO's scale from ragnastats, or (None, None)."""
    r = _iro_price(e, refresh)
    if r is None:
        return None, None
    return r


def _iro_price(e, refresh):
    buy = e.get("Buy") or 0
    sell = e.get("Sell") or buy // 2
    avg, seen = market(e["Id"], refresh)
    # Some items carry a placeholder NPC price of 20z; only a real one counts.
    if is_equip(e) and e["Id"] in NPC_SOLD and buy >= 100:
        # Players undercut the NPC a little rather than match it.
        return max(int(buy * 0.9), sell + 1), "npc"
    if avg is None or seen < 20:
        # Eggs and pet gear only ever come from a market price: the NPCs that
        # hand them out are event shops with placeholder prices.
        if e.get("Type") in PET_EGG_TYPES + PET_GEAR_TYPES:
            return None
        if e["Id"] in NPC_SOLD and (buy >= 100 or not is_equip(e)):
            return max(buy, sell + 1), "npc"
        return None
    if e.get("Type") == "Card":
        return (avg, "market") if avg <= 30_000_000 else None
    if e.get("Type") in PET_EGG_TYPES + PET_GEAR_TYPES:
        # Their NPC price is a 20z placeholder, so the troll check below would
        # throw away every real price.
        return (avg, "market") if 50 <= avg <= 50_000_000 else None
    if is_equip(e):
        # An average far above an item's NPC value is carded and refined
        # copies talking; a plain one sells near the NPC price.
        if buy >= 100 and avg > buy * 20:
            return max(int(buy * 0.9), sell + 1), "npc"
        if 40 <= buy < 100 and avg > buy * 500:
            return max(buy * 20, 1000), "npc"
        # Equipment "worth" a few zeny is a junk listing, not a price.
        return (avg, "market") if 50 <= avg <= 15_000_000 else None
    # Consumables and loot: an average hundreds of times the NPC value is a
    # troll listing (Green Potion "99,990,000z") pulling the mean.
    ref = max(buy, sell * 2, 1)
    if avg > ref * 400 and avg > 50_000:
        return max(ref, sell + 1), "npc"
    return max(avg, sell + 1), "market"


def tidy(p):
    if p >= 10000:
        return p // 500 * 500
    if p >= 1000:
        return p // 50 * 50
    if p >= 100:
        return p // 5 * 5
    return max(p, 1)


REFINE_ORE = {1: "Phracon", 2: "Emveretarcon", 3: "Oridecon", 4: "Oridecon", 0: "Elunium"}
# Success chance for each level past the safe limit; a failure destroys the item.
OVER_SAFE_ODDS = [0.6, 0.4, 0.4, 0.2, 0.2, 0.1]


def safe_limit(e):
    if e.get("Type") == "Weapon":
        return {1: 7, 2: 6, 3: 5, 4: 4}.get(e.get("WeaponLevel", 1), 4)
    return 4


def refine_steps(name):
    e = item(name)
    if not e:
        return []
    s = safe_limit(e)
    return [s, s + 1, s + 2, s + 3]


def refined_price(e, base, r, refresh):
    """What it cost to make, plus a little: ore up to the safe limit, then the
    expected cost of each further level, failures and lost items included."""
    ore = item(REFINE_ORE[e.get("WeaponLevel", 1) if e.get("Type") == "Weapon" else 0])
    ore_p = price(ore, refresh) or 1000
    s = safe_limit(e)
    cost = base + min(r, s) * ore_p
    for k in range(max(0, r - s)):
        cost = (cost + ore_p) / OVER_SAFE_ODDS[min(k, len(OVER_SAFE_ODDS) - 1)]
    return int(cost * 1.15)


PET_EGG_TYPES = ("PetEgg", "Petegg")


def load_pet_eggs():
    """Eggs that are real pets (rAthena's pet_db), the only ones that hatch."""
    path = os.path.join(RA, "db", ERA, "pet_db.yml")
    body = yaml.load(open(path, encoding="utf-8"), Loader=Loader).get("Body") or []
    return {str(p.get("EggItem", "")).lower() for p in body}


PET_EGGS = load_pet_eggs()
PET_GEAR_TYPES = ("PetArmor", "Petarmor")


def amount_for(e, p, rng):
    # Equipment, cards, eggs and pet gear don't stack: one per stall line.
    if is_equip(e) or e.get("Type") in ("Card",) + PET_EGG_TYPES + PET_GEAR_TYPES:
        return 1
    if p < 1_000:
        return rng.choice([50, 100, 150, 200, 300])
    if p < 20_000:
        return rng.choice([10, 20, 30, 50])
    if p < 200_000:
        return rng.choice([3, 5, 10])
    return rng.choice([1, 2, 3])

# ---------------------------------------------------------------------------
# Themes
# ---------------------------------------------------------------------------
#
# key:    VendorKey suffix (prontera-vendors/<key>)
# job:    the shell's sprite; a job that can vend on a real server
# pick:   items per stall [min, max]; max_slots caps it (MC_VENDING 10 = 12 max)
# titles: shop signs; {name} is the stall owner's own name
# weight: share of the Vendors setting (Count in Spawns)
# one of:
#   items: hand list: "Aegis_Name", or dict(item=, refine=, element=, stars=, cards=, price=)
#   rule:  function(item_entry) -> bool over the whole item database
#   area:  spawn files in npc/re/mobs/dungeons whose monsters' drops it sells
#   boss:  True -> what bosses and MVPs drop that ordinary monsters don't

def weapon(e, *subtypes, lv=None):
    if e.get("Type") != "Weapon":
        return False
    if subtypes and e.get("SubType") not in subtypes:
        return False
    if lv and e.get("WeaponLevel", 1) not in lv:
        return False
    return True


def locs(e):
    return set((e.get("Locations") or {}).keys())


FORGE_BASE = {  # plain forged price, before stars
    "Knife": 12000, "Cutter": 15000, "Main_Gauche": 22000, "Dirk": 35000, "Dagger": 35000,
    "Stiletto": 70000, "Gladius": 110000, "Damascus": 160000,
    "Katar": 90000, "Jur": 120000, "Jamadhar": 160000,
}


def forged(name, element, stars=0):
    p = FORGE_BASE[name] * (1 + stars) * (4 if stars == 3 else 1)
    return dict(item=name, element=element, stars=stars, price=p)


ELEMENTS = ["Fire", "Water", "Earth", "Wind"]

THEMES = [
    dict(key="general_gear", job="Merchant", pick=[6, 10], weight=1,
         titles=["wts potz n stuff fs", "cheap gear, bargains", "fresh wares, come in", "stocked up, buy now",
                 "AFK vending <3", "wts random stuff fs", "junk n jewels", "clearing stash, buy", "{name}'s Shop"],
         items=["Red_Potion", "Orange_Potion", "Yellow_Potion", "White_Potion", "Blue_Potion", "Wing_Of_Fly",
                "Wing_Of_Butterfly", "Awakening_Potion", "Center_Potion", "Knife", "Sword", "Buckler", "Cotton_Shirt",
                "Sandals", "Hood", "Jellopy", "Fluff", "Clover", "Phracon", "Emveretarcon", "Elunium", "Oridecon"]),
    dict(key="forge_supplies", job="Whitesmith", pick=[5, 8], weight=1,
         titles=["ores n elu fs", "wts forging mats", "oridecon elunium cheap", "upgrade mats here",
                 "smith supplies fs", "stones n ores", "{name}'s Forge Goods"],
         items=["Phracon", "Emveretarcon", "Oridecon", "Elunium", "Steel", "Iron", "Iron_Ore", "Coal",
                "Flame_Heart", "Mistic_Frozen", "Rough_Wind", "Great_Nature", "Star_Crumb", "Oridecon_Stone",
                "Elunium_Stone", "Boody_Red", "Crystal_Blue", "Wind_Of_Verdure", "Yellow_Live"]),
    dict(key="potions", job="Alchemist", pick=[6, 10], weight=1,
         titles=["S> pots", "potion seller", "wts whites n blues", "pots cheaper than npc", "{name}'s Pharmacy",
                 "fresh pots"],
         items=["Red_Potion", "Orange_Potion", "Yellow_Potion", "White_Potion", "Blue_Potion", "Awakening_Potion",
                "Berserk_Potion", "Panacea", "Royal_Jelly", "Yggdrasilberry", "Seed_Of_Yggdrasil", "Center_Potion",
                "Grape", "Honey", "Strawberry", "Speed_Up_Potion", "Anodyne", "Aloebera", "Fruit_Of_Mastela",
                "Leaf_Of_Yggdrasil", "Box_Of_Thunder", "Wing_Of_Fly", "Wing_Of_Butterfly"]),
    dict(key="common_cards", job="HighMerchant", pick=[4, 8], weight=1,
         titles=["cards cheap", "S> cards", "common cards fs", "card shop", "{name}'s Card Binder", "cards cards cards"],
         rule=lambda e: e.get("Type") == "Card" and e["Id"] in COMMON_CARDS),
    dict(key="rare_cards", job="HighMerchant", pick=[2, 4], weight=1,
         titles=["rare cards", "S> good cards", "cards, no lowballs", "{name}'s Rare Cards"],
         rule=lambda e: e.get("Type") == "Card" and e["Id"] in RARE_CARDS),
    dict(key="headgear", job="Blacksmith", pick=[5, 9], weight=1,
         titles=["S> hats", "headgear sale", "hats n masks", "look good, buy hats", "{name}'s Hat Rack"],
         rule=lambda e: e.get("Type") == "Armor" and locs(e) & {"Head_Top", "Head_Mid", "Head_Low"}
         and not any(l.startswith("Costume") for l in locs(e)) and e.get("Slots", 0) == 0),
    dict(key="low_weapons", job="Blacksmith", pick=[6, 10], weight=1,
         titles=["weapons for newbies", "S> starter weapons", "cheap weapons", "lvl 1 weps fs"],
         rule=lambda e: weapon(e, lv={1}) and e["Id"] in NPC_SOLD),
    dict(key="mid_weapons", job="Whitesmith", pick=[5, 9], weight=1,
         titles=["S> weapons", "weapons shop", "lvl 2-3 weapons", "{name}'s Armory", "good weps fs"],
         rule=lambda e: weapon(e, lv={2, 3}) and e.get("Slots", 0) > 0),
    dict(key="elemental_daggers", job="Whitesmith", pick=[5, 9], weight=1,
         titles=["S> elemental daggers", "fire/ice/wind/earth daggers", "forged daggers fs", "{name}'s Forge",
                 "ele daggers, very strong too"],
         items=[forged(d, el, st) for d in ("Main_Gauche", "Dirk", "Stiletto", "Gladius", "Damascus")
                for el in ELEMENTS for st in (0,)] + [forged("Stiletto", el, 1) for el in ELEMENTS]
         + [forged("Gladius", el, 3) for el in ("Fire", "Water")]),
    dict(key="katars", job="Whitesmith", pick=[4, 8], weight=1,
         titles=["katars only", "S> katars", "sin weapons", "for assassins", "{name}'s Katars"],
         rule=lambda e: weapon(e, "Katar") and e.get("Slots", 0) > 0,
         extra=[forged(k, el) for k in ("Katar", "Jur", "Jamadhar") for el in ELEMENTS]),
    dict(key="costumes", job="Alchemist", pick=[3, 6], weight=1,
         titles=["costumes fs", "look cute", "S> costumes", "{name}'s Wardrobe", "fashion sale"],
         rule=lambda e: e.get("Type") == "Armor" and any(l.startswith("Costume") for l in locs(e))),
    dict(key="ice_pick", job="Whitesmith", pick=[1, 1], weight=1,
         titles=["S> Ice Pick", "S>Ice Pick", "Ice Pick here", "wts ice pick"],
         items=["House_Auger"]),
    dict(key="accessories", job="Merchant", pick=[4, 8], weight=1,
         titles=["accessories", "S> rings n stuff", "unslotted accs cheap", "{name}'s Jewelry"],
         rule=lambda e: e.get("Type") == "Armor" and locs(e) & {"Right_Accessory", "Left_Accessory", "Both_Accessory"}
         and e.get("Slots", 0) == 0),
    dict(key="converters", job="Alchemist", pick=[3, 6], weight=1,
         titles=["converters", "S> ele converters", "fire/water/wind/earth conv", "endow stuff fs"],
         items=["Elemental_Fire", "Elemental_Water", "Elemental_Earth", "Elemental_Wind", "Fire_Converter_Box",
                "Water_Converter_Box", "Wind_Converter_Box", "Earth_Converter_Box", "Boody_Red", "Crystal_Blue",
                "Wind_Of_Verdure", "Yellow_Live", "Holy_Water"]),
    dict(key="starter_gear", job="Merchant", pick=[6, 10], weight=1,
         titles=["newbie gear", "S> starter set", "for new players", "cheap noob gear", "{name}'s Starter Kits"],
         items=["Knife_", "Cutter_", "Main_Gauche_", "Sword_", "Falchion_", "Bow_", "Rod_", "Club_", "Cotton_Shirt_",
                "Adventurere's_Suit_", "Wooden_Mail_", "Guard_", "Buckler_", "Hood_", "Muffler_",
                "Sandals_", "Shoes_", "Bandana", "Cap", "Hat", "Red_Potion", "Wing_Of_Fly"]),
    dict(key="refined_weapons", job="Whitesmith", pick=[3, 6], weight=1,
         titles=["+7 weapons", "refined weapons", "S> high refine weps", "{name}'s Refinery", "+8 +9 weapons fs"],
         items=[dict(item=w, refine=r) for w in ("Knife_", "Main_Gauche_", "Stiletto", "Gladius", "Damascus", "Katar",
                                                  "Composite_Bow", "Mace", "Bastard_Sword", "Pike", "Rod_", "Jur")
                for r in refine_steps(w)]),
    dict(key="refined_armor", job="Whitesmith", pick=[3, 6], weight=1,
         titles=["refined armor", "+4 to +7 armor", "S> safe armor", "{name}'s Armory", "high refine armor fs"],
         items=[dict(item=a, refine=r) for a in ("Chain_Mail_", "Saint_Robe_", "Silk_Robe_", "Formal_Suit",
                                                  "Guard_", "Buckler_", "Manteau_", "Muffler_", "Boots_", "Shoes_", "Helm_")
                for r in (4, 5, 6, 7)]),
    dict(key="gemstones", job="Merchant", pick=[5, 9], weight=1,
         titles=["S> gems", "jewels n gemstones", "blue gems cheap", "{name}'s Jeweler", "diamonds fs"],
         items=["Blue_Gemstone", "Yellow_Gemstone", "Red_Gemstone", "Dark_Red_Jewel", "Violet_Jewel", "Skyblue_Jewel",
                "Azure_Jewel", "Scarlet_Jewel", "Cardinal_Jewel", "Blue_Jewel", "White_Jewel", "Golden_Jewel",
                "Bluish_Green_Jewel", "Crystal_Jewel", "Crystal_Jewel_", "Crystal_Jewel__", "Crystal_Jewel___"]),
    dict(key="healing", job="Alchemist", pick=[6, 10], weight=1,
         titles=["S> herbs n food", "healing items", "cheap heals", "{name}'s Kitchen", "food fs"],
         items=["Red_Herb", "Yellow_Herb", "White_Herb", "Blue_Herb", "Green_Herb", "Apple", "Banana", "Grape",
                "Carrot", "Meat", "Honey", "Royal_Jelly", "Strawberry", "Lemon", "Orange", "Cheese", "Popped_Rice",
                "Chocolate", "Bread", "Sweet_Potato_", "Yggdrasilberry", "Fruit_Of_Mastela"]),
    dict(key="undies", job="Merchant", pick=[2, 4], weight=1,
         titles=["undershirt + pantie", "S> undies", "Undershirt n Pantie fs", "{name}'s Laundry"],
         items=["Undershirt", "Undershirt_", "G_Strings", "G_Strings_", "Old_Pant", "Tiger_Skin_Panties"]),
    dict(key="supplies", job="Alchemist", pick=[6, 10], weight=1,
         titles=["gems n arrows", "S> blue gems", "skill supplies", "arrows cheap", "{name}'s Supplies"],
         items=["Blue_Gemstone", "Yellow_Gemstone", "Red_Gemstone", "Holy_Water", "Silver_Arrow", "Fire_Arrow",
                "Crystal_Arrow", "Arrow_Of_Wind", "Stone_Arrow", "Immatrial_Arrow", "Sleep_Arrow", "Oridecon_Arrow",
                "Acid_Bottle", "Fire_Bottle", "Empty_Bottle", "Medicine_Bowl", "Detrimindexta", "Karvodailnirol"]),
    dict(key="pets", job="Merchant", pick=[4, 8], weight=1,
         titles=["taming items", "S> pet stuff", "pet food n taming items", "{name}'s Pet Shop", "tame a poring"],
         items=["Pet_Food", "Unripe_Apple", "Orange_Juice", "Earthworm_The_Dude", "Rotten_Fish", "Bitter_Herb",
                "Monster_Juice", "Book_Of_Devil", "Fatty_Chubby_Earthworm", "Silver_Knife_Of_Chaste",
                "Monster_Oxygen_Mask", "Bark_Shorts", "Pet_Incubator", "Stuffed_Doll", "Green_Lace", "Sweet_Milk",
                "Shining_Stone", "Singing_Flower"]),
    dict(key="boss_loot", job="HighMerchant", pick=[3, 6], weight=1,
         titles=["boss loot", "mini boss drops", "rare drops", "{name}'s Trophies", "S> boss stuff"],
         boss=True),
]

THEMES += [
    dict(key="mvp_items", job="HighMerchant", pick=[2, 5], weight=1,
         titles=["MVP items", "S> mvp drops", "mvp loot fs", "{name}'s MVP Spoils", "rare mvp stuff"],
         mvp=True),
    dict(key="bloody_branches", job="Merchant", pick=[1, 2], weight=1,
         titles=["S> BB", "BBs cheap", "bloody branch fs", "BB / DB", "S>Bloody Branch"],
         items=["Bloody_Dead_Branch", "Branch_Of_Dead_Tree"]),
    dict(key="old_boxes", job="Merchant", pick=[1, 3], weight=1,
         titles=["S> OBB OPB", "OBB / OPB", "old boxes fs", "gamble boxes", "S>OPB"],
         items=["Old_Blue_Box", "Old_Violet_Box", "Old_Card_Album"]),
    dict(key="card_albums", job="HighMerchant", pick=[1, 2], weight=1,
         titles=["S> OCA MCA", "OCA / MCA", "card albums", "S>OCA", "try your luck: OCA"],
         items=["Old_Card_Album", "Magic_Card_Album"]),
    dict(key="crimson_weapons", job="Whitesmith", pick=[3, 6], weight=1, era="re",
         titles=["Crimson weapons", "S> crimson", "crimson katar/mace/dagger", "{name}'s Crimson Arsenal", "S> +7 crimson"],
         rule=lambda e: e.get("Type") == "Weapon" and e["Name"].startswith("Crimson ") and not e["AegisName"].endswith("_LT"),
         extra=[dict(item=w, refine=r) for w in ("Scarlet_Katar", "Scarlet_Mace", "Scarlet_Dagger", "Scarlet_Saber",
                                                  "Scarlet_Twohand_Sword") for r in (7, 9)]),
    dict(key="shadow_gear", job="Creator", pick=[3, 6], weight=1,
         titles=["shadow gear", "S> shadow equips", "shadows fs", "{name}'s Shadows"],
         rule=lambda e: e.get("Type") in ("ShadowGear", "Shadowgear")),
    dict(key="hunters_haul", job="Blacksmith", pick=[6, 10], weight=1,
         titles=["Stuff", "loot from today", "random drops", "cleaning my cart", "hunting haul", "{name}'s Leftovers"],
         rule=lambda e: e.get("Type") in ("Weapon", "Armor", "Card") and market(e["Id"], False)[1] >= 300),
    dict(key="ygg_ori_elu", job="Creator", pick=[3, 5], weight=1,
         titles=["YGG/ORI/ELU", "ygg ori elu", "S> yggs", "ori elu ygg fs"],
         items=["Yggdrasilberry", "Seed_Of_Yggdrasil", "Leaf_Of_Yggdrasil", "Oridecon", "Elunium",
                "Oridecon_Stone", "Elunium_Stone"]),
    dict(key="slim_potions", job="Creator", pick=[2, 3], weight=1,
         titles=["slims", "S> slim whites", "condensed pots", "{name}'s Slims", "slim potions cheap"],
         items=["Red_Slim_Potion", "Yellow_Slim_Potion", "White_Slim_Potion"]),
]
# A theme marked era="re" is renewal's alone: pre-renewal has the Crimson
# Bolt and none of the weapons its signs promise.
THEMES = [t for t in THEMES if t.get("era", ERA) == ERA]

# Class shops: gear that a class (family) can wear and few others can,
# the kind of stall that reads "for Wizards" or "Knight gear".
# (key, titles, jobs that make it theirs)
def class_gear(jobs):
    def rule(e):
        if e.get("Type") not in ("Weapon", "Armor") or not tradeable(e):
            return False
        allowed = {k for k, v in (e.get("Jobs") or {}).items() if v}
        if not allowed or "All" in allowed or not allowed & jobs:
            return False
        return len(allowed - jobs) <= 3
    return rule


for _key, _titles, _jobs in [
    ("class_knight", ["Knight gear", "for knights", "S> spears n 2h swords", "peco knight stuff"], {"Knight", "Swordman"}),
    ("class_crusader", ["Crusader gear", "for crusaders", "S> shields n spears", "paladin stuff"], {"Crusader"}),
    ("class_wizard", ["Wizard gear", "for wizards", "S> staffs n robes", "mage stuff fs"], {"Wizard", "Mage"}),
    ("class_sage", ["Sage gear", "for sages", "S> books", "professor stuff"], {"Sage"}),
    ("class_hunter", ["Hunter gear", "for hunters", "S> bows", "archer stuff"], {"Hunter", "Archer"}),
    ("class_bard_dancer", ["Bard/Dancer gear", "S> instruments n whips", "for bards n dancers", "music shop"], {"BardDancer"}),
    ("class_priest", ["Priest gear", "for priests", "S> maces n rods", "acolyte stuff"], {"Priest", "Acolyte"}),
    ("class_monk", ["Monk gear", "for monks", "S> knuckles", "champ stuff"], {"Monk"}),
    ("class_assassin", ["Assassin gear", "for sins", "S> katars n daggers", "sinx stuff"], {"Assassin", "Thief"}),
    ("class_rogue", ["Rogue gear", "for rogues", "S> rogue stuff", "stalker stuff"], {"Rogue"}),
    ("class_blacksmith", ["Blacksmith gear", "for smiths", "S> axes", "WS stuff"], {"Blacksmith", "Merchant"}),
    ("class_alchemist", ["Alchemist gear", "for alchemists", "S> alche stuff", "creator stuff"], {"Alchemist"}),
    ("class_taekwon", ["Taekwon gear", "for TK / SG / SL", "star gladiator stuff", "soul linker gear"], {"Taekwon", "StarGladiator", "SoulLinker"}),
    ("class_ninja", ["Ninja gear", "for ninjas", "S> huuma n kunai", "kagerou/oboro stuff"], {"Ninja", "KagerouOboro"}),
    ("class_gunslinger", ["Gunslinger gear", "for gunslingers", "S> guns", "rebel stuff"], {"Gunslinger", "Rebellion"}),
    ("class_super_novice", ["Super Novice gear", "for SN", "S> SN stuff", "super novice only"], {"SuperNovice", "Novice"}),
    ("class_summoner", ["Doram gear", "for summoners", "S> doram stuff", "kitty gear"], {"Summoner", "Spirit_Handler"}),
]:
    THEMES.append(dict(key=_key, job=random.Random(_key).choice(["Merchant", "Blacksmith", "Whitesmith", "Alchemist", "Creator"]),
                       pick=[5, 9], weight=1, rule=class_gear(_jobs), titles=_titles + [f"{{name}}'s {_titles[0]}"]))

def is_dyestuff(e):
    # Mysterious Dyestuff is a quest token an NPC hands out for 1z, not a dye.
    return "Dyestuff" in e["Name"] and "Mysterious" not in e["Name"]


# Dyestuffs: a stall that sells nothing else says so on every sign, with no
# generic titles mixed in.
THEMES.append(dict(key="dyes", job="Alchemist", pick=[5, 9], weight=1, generic=0,
                   titles=["S> Dyestuffs", "wts dyestuffs cheap", "Dyestuffs, every color", "Rainbow Dyestuffs",
                           "Dyestuffs n pigments", "Dye ur hats! Dyestuffs", "Paint the town: Dyestuffs",
                           "Black n White Dyestuffs here", "Dyestuffs for hat quests", "{name}'s Dyestuffs"],
                   rule=lambda e: e.get("Type") == "Etc" and is_dyestuff(e)))

# Shops by weapon type and by armor slot, the way many players sort a cart.
def wtype(*subtypes):
    return lambda e: e.get("Type") == "Weapon" and e.get("SubType") in subtypes


def aslot(*slots):
    return lambda e: e.get("Type") == "Armor" and bool(locs(e) & set(slots)) and not any(
        l.startswith("Costume") for l in locs(e))


for _key, _titles, _rule in [
    ("type_daggers", ["daggers", "S> daggers", "knives n daggers"], wtype("Dagger")),
    ("type_swords", ["swords", "S> 1h swords", "blades fs"], wtype("1hSword")),
    ("type_twohanders", ["2h weapons", "S> two-handers", "big swords n axes"], wtype("2hSword", "2hAxe")),
    ("type_spears", ["spears", "S> spears n lances", "pointy things"], wtype("1hSpear", "2hSpear")),
    ("type_axes", ["axes", "S> axes", "axes for smiths"], wtype("1hAxe", "2hAxe")),
    ("type_maces", ["maces", "S> maces", "blunt weapons"], wtype("Mace")),
    ("type_staves", ["staves n rods", "S> staffs", "magic sticks"], wtype("Staff", "2hStaff")),
    ("type_bows", ["bows", "S> bows", "bows n crossbows"], wtype("Bow")),
    ("type_books", ["books", "S> books", "reading material"], wtype("Book")),
    ("type_knuckles", ["knuckles", "S> claws", "fists"], wtype("Knuckle")),
    ("type_music", ["instruments n whips", "S> whips", "music n dance"], wtype("Musical", "Whip")),
    ("type_guns", ["guns", "S> guns", "pew pew"], wtype("Revolver", "Rifle", "Gatling", "Shotgun", "Grenade")),
    ("type_huuma", ["huuma", "S> huuma shuriken", "ninja stars"], wtype("Huuma")),
    ("slot_garments", ["garments", "S> capes", "manteaus n mufflers"], aslot("Garment")),
    ("slot_footgear", ["shoes n boots", "S> footgear", "boots fs"], aslot("Shoes")),
    ("slot_shields", ["shields", "S> shields", "guards n bucklers"], aslot("Left_Hand")),
    ("slot_armor", ["armor", "S> body armor", "suits n robes"], aslot("Armor")),
    ("slotted_gear", ["slotted gear", "S> [1] slot stuff", "slotted equips"],
     lambda e: e.get("Type") == "Armor" and e.get("Slots", 0) > 0 and not any(l.startswith("Costume") for l in locs(e))),
    ("ammo", ["ammo", "S> arrows n bullets", "ammo cheap", "kunai n bullets"],
     lambda e: e.get("Type") == "Ammo"),
    ("scrolls", ["scrolls", "S> magic scrolls", "spell scrolls fs"],
     lambda e: e.get("Type") in ("Usable", "DelayConsume") and "Scroll" in e["Name"]),
    # Dyestuffs have a stall of their own (below), so this one shows the rest.
    ("rare_etc", ["rare loot", "collector items", "S> rare etc"],
     lambda e: e.get("Type") == "Etc" and (price(e) or 0) >= 100_000 and not is_dyestuff(e)),
]:
    THEMES.append(dict(key=_key, job=random.Random(_key).choice(["Merchant", "Blacksmith", "Whitesmith", "Alchemist", "Creator"]),
                       pick=[5, 9], weight=1, rule=_rule, titles=_titles + [f"{{name}}'s {_titles[0].capitalize()}"]))

# Mostly random stalls: a broad pool each, sampled at random rather than by
# popularity, with mostly generic signs. Each reads like a different player
# emptying a different kind of cart.
for _key, _titles, _rule in [
    ("random_loot", ["junk n loot", "drops", "loot"], lambda e: e["Id"] in ANY_DROP and e.get("Type") == "Etc"),
    ("random_consumables", ["consumables", "useables", "stuff for hunting"],
     lambda e: e.get("Type") in ("Healing", "Usable", "DelayConsume")),
    ("random_equipment", ["equips", "gear", "old gear"],
     lambda e: e.get("Type") in ("Weapon", "Armor") and (price(e) or 0) <= 2_000_000),
    ("random_cheap", ["Cart Clearance", "MEGA CLEARANCE", "everything cheap", "dirt cheap"],
     lambda e: e.get("Type") != "Card" and 0 < (price(e) or 0) <= 5_000),
    ("random_mixed", ["random", "a bit of everything", "misc"],
     lambda e: e.get("Type") in ("Weapon", "Armor", "Card", "Etc", "Usable", "Healing") and market(e["Id"], False)[1] >= 100),
]:
    THEMES.append(dict(key=_key, job=random.Random(_key).choice(["Merchant", "Blacksmith", "Alchemist", "Creator"]),
                       pick=[6, 10], weight=1, rule=_rule, sample="random", limit=60, generic=6,
                       titles=_titles))

# Loot by monster level: drops of ordinary monsters in a level band that
# spawn somewhere. (key, title, low, high)
for _key, _title, _lo, _hi in [("loot_lv1_20", "lvl 1-20 mob loot", 1, 20), ("loot_lv21_40", "lvl 21-40 mob loot", 21, 40),
                               ("loot_lv41_60", "lvl 41-60 mob loot", 41, 60), ("loot_lv61_80", "lvl 61-80 mob loot", 61, 80),
                               ("loot_lv81_99", "lvl 81-99 mob loot", 81, 99)]:
    THEMES.append(dict(key=_key, job="Merchant", pick=[6, 10], weight=1, levels=(_lo, _hi),
                       titles=[_title, f"lv {_lo}-{_hi} drops", f"loot from {_lo}-{_hi} mobs", "mob loot cheap",
                               f"{{name}}'s Loot Bag"]))

# Generic shop signs. Real stalls often say nothing about what they sell;
# these are the kind sampled from iRO shops (no player names). Each theme
# gets a few, so about a third of signs are like this. A sign that offers
# goods ("SALE") only goes on a stall that sells, a "WTB" only on a buyer;
# the neutral ones fit either.
GENERIC_TITLES = ["Happy hunting!", "...", "zzz", "Things.", "etc", "AFK-----AFK", "Come on", "Come here u", "See"]
SELL_TITLES = ["Stuff", "SALE", "sale", "Sell", "cheap stuff", "cheap stuff 2", "junk shop", "Goodies",
               "This looks good", "Stuff you might want", "Bringing Simples You Need Cheap", "random"]
# Only over stalls of mixed goods, where the sign was never going to say what
# is for sale anyway; a stall of one kind of thing keeps signs that say so.
SELL_CHEEKY = ["S> my sanity, cheap", "S> regrets, 1z ea", "S> life advice, free", "S> ex's stuff", "S> mom's cart",
               "S> stuff I found", "S> don't ask", "S> definitely not stolen", "S> moving out sale",
               "S> bad decisions", "S> cart too heavy pls", "S> things. maybe."]
CHEEKY_SELL_THEMES = {"general_gear", "hunters_haul", "random_loot", "random_consumables", "random_equipment",
                      "random_cheap", "random_mixed"}
BUY_TITLES = ["Buying", "B>", "WTB", "buying stuff", "B> paying well", "B> > npc price", "WTB, fair prices",
              # The cheeky ones every street has. None names a real item, so
              # none can promise what the store does not want.
              "B> your mom", "WTB> a happy life", "B> friends pls", "WTB> GF", "B> motivation", "B> sleep",
              "WTB> luck +10", "B> ur soul, good price", "WTB> MVP card for 10z", "B> hugs", "B> coffee",
              "WTB> a reason to log off", "B> anything shiny", "WTB> patience", "B> time, any amount",
              "WTB> 100% refine rate"]

# Signs that name what is for sale go out as StockTitles: the engine only
# hangs one over a stall whose own pick bears it out, and fills {item} and
# {price} from a line it really has ("S> Elunium 13k"). A server too old to
# know StockTitles shows the other signs only, never one that lies.
# Each theme gets two of these.
SELL_STOCK_SIGNS = ["S> {item} {price}", "{item} {price}", "S> {item} cheap", "{item} n more", "wts {item}"]
BUY_STOCK_SIGNS = ["B> {item} {price}", "B> {item}", "WTB {item} {price}", "buying {item}", "B> {item} n more"]
# Signs that name items, and what a stall must carry to show them: (all of,
# any of). A theme without the items in its pool simply never shows the sign.
TITLE_NEEDS = {
    "ores n elu fs": (["Elunium"], []),
    "oridecon elunium cheap": (["Oridecon", "Elunium"], []),
    "wts whites n blues": (["White_Potion", "Blue_Potion"], []),
    "blue gems cheap": (["Blue_Gemstone"], []),
    "diamonds fs": ([], ["Crystal_Jewel", "Crystal_Jewel_", "Crystal_Jewel__", "Crystal_Jewel___"]),
    "S> blue gems": (["Blue_Gemstone"], []),
    "undershirt + pantie": ([], ["Undershirt", "Undershirt_"]),
    "Undershirt n Pantie fs": ([], ["Undershirt", "Undershirt_"]),
    "tame a poring": (["Unripe_Apple"], []),
    "fire/water/wind/earth conv": ([], ["Elemental_Fire", "Elemental_Water", "Elemental_Earth", "Elemental_Wind"]),
    "S> BB": (["Bloody_Dead_Branch"], []),
    "BBs cheap": (["Bloody_Dead_Branch"], []),
    "bloody branch fs": (["Bloody_Dead_Branch"], []),
    "S>Bloody Branch": (["Bloody_Dead_Branch"], []),
    "BB / DB": (["Bloody_Dead_Branch", "Branch_Of_Dead_Tree"], []),
    "S> OBB OPB": (["Old_Blue_Box", "Old_Violet_Box"], []),
    "OBB / OPB": (["Old_Blue_Box", "Old_Violet_Box"], []),
    "S>OPB": (["Old_Violet_Box"], []),
    "S> OCA MCA": (["Old_Card_Album", "Magic_Card_Album"], []),
    "OCA / MCA": (["Old_Card_Album", "Magic_Card_Album"], []),
    "S>OCA": (["Old_Card_Album"], []),
    "try your luck: OCA": (["Old_Card_Album"], []),
    "YGG/ORI/ELU": (["Yggdrasilberry", "Oridecon", "Elunium"], []),
    "ygg ori elu": (["Yggdrasilberry", "Oridecon", "Elunium"], []),
    "ori elu ygg fs": (["Yggdrasilberry", "Oridecon", "Elunium"], []),
    "S> yggs": (["Yggdrasilberry"], []),
    "S> slim whites": (["White_Slim_Potion"], []),
    "Black n White Dyestuffs here": (["Black_Dyestuffs", "White_Dyestuffs"], []),
    "B> ori elu": (["Oridecon", "Elunium"], []),
    "B> Oridecon / Elunium": (["Oridecon", "Elunium"], []),
    "WTB elu ori rough": (["Elunium_Stone", "Oridecon_Stone"], []),
    "B> rough ori / rough elu": (["Oridecon_Stone", "Elunium_Stone"], []),
    "B> steel iron coal": (["Steel", "Iron", "Coal"], []),
    "B> star crumbs": (["Star_Crumb"], []),
    "buying flame hearts etc": (["Flame_Heart"], []),
    "B> converters": ([], ["Elemental_Fire", "Elemental_Water", "Elemental_Earth", "Elemental_Wind"]),
    "buying green herbs": (["Green_Herb"], []),
    "B> red/yellow herbs": ([], ["Red_Herb", "Yellow_Herb"]),
    "buying bottles n bowls": (["Empty_Bottle", "Medicine_Bowl"], []),
    "B> witched starsand": (["Starsand_Of_Witch"], []),
    "B> straws": (["Strawberry"], []),
    "buying strawberries": (["Strawberry"], []),
    "B> straws, good price": (["Strawberry"], []),
    "B> strawberry grape honey": (["Strawberry", "Grape", "Honey"], []),
    "B> jellopy n fluff": (["Jellopy", "Fluff"], []),
    "B> shells feathers etc": (["Shell", "Feather"], []),
    "B> fluff/grit/huge leaf": ([], ["Fluff", "Grit", "Great_Leaf"]),
    "WTB scarlet/white dyestuffs": ([], ["Scarlet_Dyestuffs", "White_Dyestuffs"]),
    "B> OCA": (["Old_Card_Album"], []),
    "WTB albums": ([], ["Old_Card_Album", "Magic_Card_Album"]),
    "B> OBB OPB": (["Old_Blue_Box", "Old_Violet_Box"], []),
    "B> BB / DB": ([], ["Bloody_Dead_Branch", "Branch_Of_Dead_Tree"]),
    "B> yggs": (["Yggdrasilberry"], []),
    "buying ygg berries": (["Yggdrasilberry"], []),
    "WTB ygg seed": (["Seed_Of_Yggdrasil"], []),
    "B> whites": (["White_Potion"], []),
    "WTB awakening/berserk": ([], ["Awakening_Potion", "Berserk_Potion"]),
    "B> blue gems": (["Blue_Gemstone"], []),
}

# Card binders by slot, the way players sort them. Cards are among the most
# traded things on a real server (about one shop in eight in the iRO sample
# is mostly cards), so besides the two staple card stalls there are these.
def monster_card(*slots):
    def rule(e):
        if e.get("Type") != "Card" or e["Id"] not in COMMON_CARDS | RARE_CARDS:
            return False
        return not slots or bool(locs(e) & set(slots))
    return rule


for _key, _titles, _rule in [
    ("cards_weapon", ["weapon cards", "S> weapon cards", "cards for weapons", "dmg cards fs"], monster_card("Right_Hand")),
    ("cards_armor", ["armor cards", "S> armor cards", "body cards"], monster_card("Armor")),
    ("cards_headgear", ["headgear cards", "S> hat cards", "head cards fs"], monster_card("Head_Top", "Head_Mid", "Head_Low")),
    ("cards_garment_shoes", ["garment n shoe cards", "S> garment cards", "S> shoe cards"], monster_card("Garment", "Shoes")),
    ("cards_shield", ["shield cards", "S> shield cards", "cards for shields"], monster_card("Left_Hand")),
    ("cards_accessory", ["accessory cards", "S> acc cards", "ring cards"],
     monster_card("Both_Accessory", "Left_Accessory", "Right_Accessory")),
    ("cards_cheap", ["cheap cards", "cards under 50k", "S> cards cheap", "card dump"],
     lambda e: monster_card()(e) and (price(e) or 0) <= 50_000),
]:
    THEMES.append(dict(key=_key, job=random.Random(_key).choice(["Merchant", "HighMerchant", "Blacksmith", "Alchemist"]),
                       pick=[4, 8], weight=1, rule=_rule, titles=_titles + [f"{{name}}'s {_titles[0].capitalize()}"]))

# Buy shops: players' buying stores, which ask for items instead of selling
# them. rAthena lets a buying store take only items flagged BuyingStore, and
# at most 5 kinds at once. Anyone can open one, so buyers wear any job's
# sprite. Most of them buy what a player brings home from hunting: common
# loot, quest turn-ins, the loot of a dungeon or a leveling field. Those pay
# 75-95 % of the low end of the sell range, so selling to them beats an NPC;
# the rest (cards, boxes, ygg, gems...) pay 60-85 %. Either way a buyer pays
# less than any stall asks, so nothing can be bought and sold back for profit.
BUY_PREFIX = "prontera-vendors/buy/"
BUY_MARKET = BUY_PREFIX + "sidewalks"
# Filled in the same order as the sell lanes: top first, then the left.
BUY_AREAS = [
    {"X1": 140, "Y1": 136, "X2": 140, "Y2": 172},  # top, west (outer sidewalk)
    {"X1": 171, "Y1": 136, "X2": 171, "Y2": 172},  # top, east (outer sidewalk)
    {"X1": 104, "Y1": 125, "X2": 135, "Y2": 125},  # left, upper row
    {"X1": 104, "Y1": 110, "X2": 135, "Y2": 110},  # left, lower row
]
BUY_JOBS = {  # sprite -> a gear set that fits it
    "Knight": "para_knight_base", "LordKnight": "para_knight_base", "RuneKnight": "para_knight_base",
    "Crusader": "para_crusader", "Paladin": "para_crusader", "RoyalGuard": "para_crusader",
    "Wizard": "para_mage", "HighWizard": "para_mage", "Sage": "para_mage", "Professor": "para_mage",
    "Warlock": "para_mage", "Sorcerer": "para_mage", "Priest": "low_blunt", "HighPriest": "low_blunt",
    "ArchBishop": "low_blunt", "Hunter": "para_bow", "Sniper": "para_bow", "Ranger": "para_bow",
    "Monk": "para_monk", "Champion": "para_monk", "Sura": "para_monk", "Assassin": "para_thief",
    "AssassinCross": "para_thief", "Rogue": "para_thief", "Stalker": "para_thief", "GuillotineCross": "para_thief",
    "Blacksmith": "para_merchant", "Alchemist": "para_merchant", "Merchant": "para_merchant",
}


def era_jobs():
    """The jobs this era's job database has, by name without spaces or
    underscores ("RuneKnight" = "Rune_Knight"): pre-renewal has no third
    jobs, and a profile with one is skipped by the server."""
    body = yaml.load(open(os.path.join(RA, "db", ERA, "job_stats.yml"), encoding="utf-8"), Loader=Loader)["Body"]
    return {k.replace("_", "").replace(" ", "").lower() for e in body for k in (e.get("Jobs") or {})}


ERA_JOBS = era_jobs()
BUY_JOBS = {k: v for k, v in BUY_JOBS.items() if k.lower() in ERA_JOBS}
PAY_COMMON = (0.75, 0.95)
PAY_OTHER = (0.60, 0.85)


def buyable(e):
    return bool((e.get("Flags") or {}).get("BuyingStore")) and tradeable(e)


def named(*names):
    """Aegis names of items by their display names, those this era has."""
    out = set()
    for n in names:
        e = ITEMS_BY_NAME.get(n.lower())
        if e:
            out.add(e["AegisName"])
    return out


ITEMS_BY_NAME = {e["Name"].lower(): e for e in ITEMS_BY_ID.values() if e.get("Name")}

UPGRADE = {"Oridecon", "Elunium", "Oridecon_Stone", "Elunium_Stone", "Emveretarcon"}
CRAFTING = {"Steel", "Iron", "Iron_Ore", "Coal", "Star_Crumb"}
ELEMENTAL = {"Flame_Heart", "Mistic_Frozen", "Rough_Wind", "Great_Nature", "Boody_Red", "Crystal_Blue",
             "Wind_Of_Verdure", "Yellow_Live", "Elemental_Fire", "Elemental_Water", "Elemental_Earth",
             "Elemental_Wind"}
HERBS = {"Green_Herb", "Red_Herb", "Yellow_Herb", "White_Herb", "Blue_Herb"}
# Alchemist and Genetic brewing: Witched Starsand above all ("always a buy
# shop for Witch Starsand and brewing materials").
ALCHEMY = {"Empty_Bottle", "Poison_Spore", "Medicine_Bowl", "Detrimindexta", "Karvodailnirol", "Poison_Bottle",
           "Acid_Bottle", "Fire_Bottle", "Stem", "Blossom_Of_Maneater", "Aloe_Leaflet", "Starsand_Of_Witch",
           "Mushroom_Spore", "Root_Of_Maneater", "Heart_Of_Mermaid", "Fluorescent_Liquid"}
# SP food nobody can buy from an NPC: many players keep a buying store open
# for Strawberries alone.
BERRIES = named("Strawberry", "Grape", "Honey", "Lemon", "Apple", "Banana", "Carrot", "Orange")
# Repeatable EXP quests (Langry, Halgus, Laertes, Yullo, Private Jeremy, Shone,
# Lemly, Li, Lella, Cuir, the Einbroch villager, Lilla, the vegetable farmer)
# and the Eden Group's collecting missions: what they ask for, in bulk.
TURN_INS = named("Fluff", "Chrysalis", "Powder of Butterfly", "Porcupine Quill", "Stone Heart", "Earthworm Peeling",
                 "Frill", "Dokebi Horn", "Huge Leaf", "Anolian Skin", "Bacillus", "Sharp Leaf", "Antelope Horn",
                 "Skel-Bone", "Animal Skin", "Bear's Footskin", "Insect Feeler", "Garlet", "Yoyo Tail", "Acorn",
                 "Raccoon Leaf", "Mole Whiskers", "Mole Claw", "Fine Sand", "Grit", "Sticky Webfoot",
                 "Maneater Blossom", "Bloody Page", "Mystic Horn", "Fragment", "Rusty Screw")
# Items with buyers of their own, kept out of the general potion and
# consumable buyers.
BUY_SPECIALS = {"Old_Card_Album", "Magic_Card_Album", "Old_Blue_Box", "Old_Violet_Box", "Bloody_Dead_Branch",
                "Branch_Of_Dead_Tree", "Old_Gift_Box", "Yggdrasilberry", "Seed_Of_Yggdrasil", "Leaf_Of_Yggdrasil",
                "Royal_Jelly", "Fruit_Of_Mastela"} | BERRIES
# What a dedicated buyer already takes; the junk buyer leaves it to them.
OWN_BUYER = UPGRADE | CRAFTING | ELEMENTAL | HERBS | ALCHEMY | BERRIES


def quest_asks():
    """Item id -> how many NPC scripts of this era ask a player for it
    (countitem), the measure of what quests want."""
    asks = {}
    npc = os.path.join(RA, "npc")
    for root, _, files in os.walk(npc):
        # Folders under npc/ only: the checkout's own path may say anything.
        parts = os.path.relpath(root, npc).split(os.sep)
        if OTHER_ERA in parts or "custom" in parts or "test" in parts:
            continue
        for f in files:
            if not f.endswith(".txt"):
                continue
            seen = set()
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                if line.lstrip().startswith("//"):
                    continue
                for m in re.finditer(r"countitem\(\s*(\w+)\s*\)", line):
                    t = m.group(1)
                    e = ITEMS_BY_ID.get(int(t)) if t.isdigit() else item(t)
                    if e:
                        seen.add(e["Id"])
            for i in seen:
                asks[i] = asks.get(i, 0) + 1
    return asks


QUEST_ASKS = quest_asks()

BUY_THEMES = [
    # The buyers a real server always has, so each has a Min in the market:
    # upgrade ores above all, crafting materials, elemental stones, herbs,
    # alchemy materials, berries and the junk every hunter carries.
    dict(key="upgrade", titles=["B> ori elu", "buying ores", "B> Oridecon / Elunium", "WTB elu ori rough",
                                "B> rough ori / rough elu", "{name} buys ores"],
         rule=lambda e: buyable(e) and e["AegisName"] in UPGRADE, weight=3, min=2, max=3),
    dict(key="crafting", titles=["B> steel iron coal", "buying crafting mats", "B> star crumbs", "WTB smith mats"],
         rule=lambda e: buyable(e) and e["AegisName"] in CRAFTING, weight=2, min=1),
    dict(key="elemental", titles=["B> ele stones", "buying flame hearts etc", "B> converters"],
         rule=lambda e: buyable(e) and e["AegisName"] in ELEMENTAL, weight=2, min=1),
    dict(key="herbs", titles=["B> herbs", "buying green herbs", "B> red/yellow herbs", "WTB herbs"],
         rule=lambda e: buyable(e) and e["AegisName"] in HERBS, weight=2, min=1, pay=PAY_COMMON),
    dict(key="alchemy", titles=["B> alche mats", "buying bottles n bowls", "WTB alchemy stuff", "B> witched starsand",
                                "B> brewing mats"],
         rule=lambda e: buyable(e) and e["AegisName"] in ALCHEMY, weight=2, min=1, pay=PAY_COMMON),
    dict(key="berries", titles=["B> straws", "buying strawberries", "B> strawberry grape honey", "WTB SP food",
                                "B> straws, good price"],
         rule=lambda e: buyable(e) and e["AegisName"] in BERRIES, weight=2, min=1, pay=PAY_COMMON),
    dict(key="junk", titles=["B> jellopy n fluff", "buying junk loot", "B> your loot, > npc", "WTB common drops",
                             "B> shells feathers etc", "dump ur loot here"],
         rule=lambda e: buyable(e) and e.get("Type") == "Etc" and e["AegisName"] not in OWN_BUYER
         and not ("Gemstone" in e["AegisName"] or "Jewel" in e["AegisName"] or e["AegisName"].endswith("_Ore"))
         and DROPPERS.get(e["Id"], 0) >= 15 and 0 < (price(e) or 0) < 2_000,
         rank=lambda e: DROPPERS.get(e["Id"], 0), limit=40, weight=2, min=1, pay=PAY_COMMON),
    # The rest rotate.
    dict(key="turn_ins", titles=["B> turn-in items", "buying quest turn-ins", "B> fluff/grit/huge leaf",
                                 "WTB Eden mission items", "B> exp quest items"],
         rule=lambda e: buyable(e) and e["AegisName"] in TURN_INS, weight=2, pay=PAY_COMMON),
    dict(key="quest_mats", titles=["B> quest items", "buying hat quest mats", "WTB loot for quests"],
         rule=lambda e: buyable(e) and e.get("Type") == "Etc" and QUEST_ASKS.get(e["Id"], 0) >= 2,
         rank=lambda e: QUEST_ASKS.get(e["Id"], 0), limit=80, weight=2, pay=PAY_COMMON),
    dict(key="dyestuffs", titles=["B> Dyestuffs", "buying dyestuffs", "WTB scarlet/white dyestuffs"],
         rule=lambda e: buyable(e) and is_dyestuff(e)),
    dict(key="cards_rare", titles=["B> good cards", "buying rare cards", "WTB cards, fair price"],
         rule=lambda e: buyable(e) and e["Id"] in RARE_CARDS),
    dict(key="boxes", titles=["B> OCA", "B> OBB OPB", "buying boxes", "B> BB / DB", "WTB albums"],
         rule=lambda e: buyable(e) and e["AegisName"] in {"Old_Card_Album", "Magic_Card_Album", "Old_Blue_Box",
              "Old_Violet_Box", "Bloody_Dead_Branch", "Branch_Of_Dead_Tree", "Old_Gift_Box"}),
    dict(key="ygg", titles=["B> yggs", "buying ygg berries", "WTB ygg seed"],
         rule=lambda e: buyable(e) and e["AegisName"] in {"Yggdrasilberry", "Seed_Of_Yggdrasil", "Leaf_Of_Yggdrasil",
              "Royal_Jelly", "Fruit_Of_Mastela"}),
    dict(key="potions", titles=["B> pots", "buying potions", "B> whites", "WTB herbs n pots"],
         rule=lambda e: buyable(e) and e.get("Type") == "Healing" and e["AegisName"] not in BUY_SPECIALS),
    dict(key="consumables", titles=["B> useables", "buying consumables", "WTB awakening/berserk"],
         rule=lambda e: buyable(e) and e.get("Type") in ("Usable", "DelayConsume") and e["AegisName"] not in BUY_SPECIALS),
    dict(key="gems", titles=["B> gems", "buying jewels", "B> blue gems"],
         rule=lambda e: buyable(e) and ("Gemstone" in e["AegisName"] or "Jewel" in e["AegisName"])),
    dict(key="random", titles=["Buying", "B> stuff", "buying random loot", "B>"],
         rule=lambda e: buyable(e) and e.get("Type") in ("Etc", "Card", "Healing", "Usable") and popularity(e) >= 200
         and e["Id"] not in COMMON_CARDS,
         sample="random", limit=60),
]
# Loot by monster level, the same bands as the sell stalls (and one past 99
# where the era has such monsters). Unlike a sell stall, a buyer keeps the
# drops many monsters share: those are exactly what a hunter carries home.
for _lo, _hi in [(1, 20), (21, 40), (41, 60), (61, 80), (81, 99), (100, 175)]:
    BUY_THEMES.append(dict(key=f"loot_lv{_lo}_{_hi}" if _hi < 175 else f"loot_lv{_lo}_up",
                           titles=[f"B> lv {_lo}-{_hi} loot" if _hi < 175 else f"B> lv {_lo}+ loot",
                                   f"buying loot from lv {_lo}-{_hi} mobs" if _hi < 175 else f"buying lv {_lo}+ mob loot",
                                   "B> mob loot", "B> drops"],
                           levels=(_lo, _hi), buyfilter=True, limit=80, pay=PAY_COMMON))


def buy_amount(p, rng):
    """How many a buyer asks for: lots of cheap loot, a few of anything dear."""
    if p < 1_000:
        return rng.choice([100, 200, 300, 500])
    if p < 20_000:
        return rng.choice([20, 30, 50, 100])
    if p < 200_000:
        return rng.choice([5, 10, 20])
    return rng.choice([1, 2, 3])


# Pets: eggs (bought from a stall, the server creates a real, hatchable egg
# for the buyer; engine patch 0021) with incubators and food, and the
# accessories pets wear.
THEMES += [
    dict(key="pet_eggs", job="Merchant", pick=[4, 8], weight=1,
         titles=["pet eggs", "S> eggs + incubator", "pets for sale", "adopt a pet", "{name}'s Pet Shop"],
         rule=lambda e: e.get("Type") in PET_EGG_TYPES and e["AegisName"].lower() in PET_EGGS,
         extra=["Pet_Incubator", "Pet_Food"]),
    dict(key="pet_gear", job="Alchemist", pick=[3, 6], weight=1,
         titles=["pet equipment", "S> pet accessories", "pet gear", "dress up your pet", "{name}'s Pet Boutique"],
         rule=lambda e: e.get("Type") in PET_GEAR_TYPES),
]

# Staples: a real market always has these. In the market each has Min 1 (a
# spot always holds one), weight 3 and Max 2; card themes weigh 2; the rest 1
# with Max 1, so the street keeps a mix.
STAPLES = {"general_gear", "potions", "forge_supplies", "healing", "common_cards", "rare_cards"}

# Dungeon loot stalls: what the monsters of a place drop (no cards; those
# have their own stalls). (key, title, spawn files)
AREAS_LOOT = [
    ("byalan", "Byalan Drops", ["iz_dun.txt"]),
    ("geffenia", "Geffenia Drops", ["gefenia.txt"]),
    ("kiel", "Kiel Drops", ["kh_dun.txt"]),
    ("payon_cave", "Payon Cave Loot", ["pay_dun.txt"]),
    ("orc_dungeon", "Orc Dungeon Loot", ["orcsdun.txt"]),
    ("ant_hell", "Ant Hell Drops", ["anthell.txt"]),
    ("sphinx", "Sphinx Loot", ["in_sphinx.txt"]),
    ("pyramids", "Pyramid Loot", ["moc_pryd.txt"]),
    ("sunken_ship", "Sunken Ship Loot", ["treasure.txt"]),
    ("clock_tower", "Clock Tower Drops", ["c_tower.txt", "alde_dun.txt"]),
    ("glast_heim", "Glast Heim Loot", ["glastheim.txt"]),
    ("turtle_island", "Turtle Island Drops", ["tur_dun.txt"]),
    ("toy_factory", "Toy Factory Drops", ["xmas_dun.txt"]),
    ("niflheim", "Niflheim Loot", ["nif_dun.txt", "fields/niflheim.txt"]),
    ("magma", "Magma Dungeon Drops", ["mag_dun.txt"]),
    ("ice_cave", "Ice Cave Drops", ["ice_dun.txt"]),
    ("abyss_lake", "Abyss Lake Loot", ["abyss.txt"]),
    ("thanatos", "Thanatos Tower Loot", ["tha_t.txt"]),
    ("odin", "Odin Shrine Drops", ["odin.txt"]),
    ("juperos", "Juperos Loot", ["juperos.txt"]),
    ("bio_lab", "Bio Lab Loot", ["lhz_dun.txt"]),
    ("comodo_caves", "Comodo Cave Drops", ["beach_dun.txt"]),
    ("amatsu", "Amatsu Dungeon Drops", ["ama_dun.txt"]),
    ("sewers", "Culvert Drops", ["prt_sew.txt"]),
    ("guild_dungeon", "Guild Dungeon Loot", ["gld_dunSE.txt", "gld_re.txt"]),
]
for _key, _title, _files in AREAS_LOOT:
    _short = _title.split(" ")[0]
    THEMES.append(dict(key=_key, job=random.Random(_key).choice(["Merchant", "Blacksmith", "Alchemist", "Whitesmith", "Creator"]),
                       pick=[5, 9], weight=1, area=_files,
                       titles=[_title, f"S> {_short} loot", f"{_short.lower()} drops fs", f"fresh from {_short}",
                               f"{{name}}'s {_title}"]))

# Every item some monster drops, and how many kinds of monster drop it.
ANY_DROP = set()
DROPPERS = {}
# What only MVPs drop: nobody brings those to a buying store.
MVP_ONLY = set()
for _m in MOBS.values():
    for _d in _m.get("Drops") or []:
        _e = item(_d["Item"])
        if _e:
            ANY_DROP.add(_e["Id"])
            DROPPERS[_e["Id"]] = DROPPERS.get(_e["Id"], 0) + 1
_by_normal = set()
# How much of an item ordinary monsters drop: the sum of their drop chances
# (1.0 = one per kill of one kind of monster). Jellopy runs to dozens, a card
# to a few ten-thousandths.
DROP_ABUNDANCE = {}
for _mid, _m in MOBS.items():
    for _d in _m.get("Drops") or []:
        _e = item(_d["Item"])
        if _e and _mid not in MVP_IDS:
            _by_normal.add(_e["Id"])
            DROP_ABUNDANCE[_e["Id"]] = DROP_ABUNDANCE.get(_e["Id"], 0) + _d.get("Rate", 0) / 10000
MVP_ONLY = ANY_DROP - _by_normal
# A loot stall skips what more kinds of monster than this drop (Elunium,
# Yggdrasil Berry...), so each dungeon's stall shows its own loot.
LOOT_MAX_DROPPERS = 12
# Buyers are looser: a place's own loot is often shared (Skel-Bone, Huge Leaf),
# and that is what its hunters carry. Only the drops of nearly everything
# (Jellopy, Garlet, fruit) are left to the junk buyer.
PLACE_MAX_DROPPERS = 40


def spawn_lines():
    """(file under npc/<era>/mobs, map, mob id, count) for every normal spawn line."""
    out = []
    base = os.path.join(RA, "npc", ERA, "mobs")
    for root, _, files in os.walk(base):
        for f in files:
            if not f.endswith(".txt"):
                continue
            rel = os.path.relpath(os.path.join(root, f), base).replace(os.sep, "/")
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                if line.lstrip().startswith("//"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 4 or not parts[1].startswith("monster"):
                    continue
                mid = mob_ref(parts[3])
                fields = parts[3].split(",")
                n = int(fields[1]) if len(fields) > 1 and fields[1].strip().isdigit() else 1
                if mid in MOBS and mid not in MVP_IDS:
                    out.append((rel, parts[0].split(",")[0], mid, n))
    return out


SPAWN_LINES = spawn_lines()


def place_counts(files=(), maps=()):
    """Mob id -> how many spawn in these spawn files (a bare name means
    dungeons/) or on these maps."""
    files = {f if "/" in f else "dungeons/" + f for f in files}
    out = {}
    for rel, mp, mid, n in SPAWN_LINES:
        if rel in files or mp in maps:
            out[mid] = out.get(mid, 0) + n
    return out


def place_loot(counts, keep=()):
    """Item id -> how much of it a place yields (spawn count x drop rate): the
    buyable loot of its monsters, its most common first."""
    w = {}
    for mid, n in counts.items():
        for d in MOBS[mid].get("Drops") or []:
            e = item(d["Item"])
            if not e or not buyable(e):
                continue
            if e["AegisName"] not in keep and (e.get("Type") != "Etc" or DROPPERS.get(e["Id"], 0) > PLACE_MAX_DROPPERS):
                continue
            w[e["Id"]] = w.get(e["Id"], 0) + n * d.get("Rate", 1)
    return w


def top_monster(counts):
    """The monster a place is known for: the one that spawns most, leaving out
    plants and eggs, which nobody hunts."""
    best = sorted((-n, mid) for mid, n in counts.items()
                  if MOBS[mid].get("Race") != "Plant" and not MOBS[mid]["Name"].endswith("Egg"))
    return MOBS[best[0][1]]["Name"] if best else None


# Leveling fields players farm, from iRO's leveling-spot lists, where the loot
# has buyers on real servers: quest turn-ins (Grit and Fine Sand for Eden,
# Antelope Horn and Bacillus for the EXP quests), Strawberries and spores,
# Dragon Scales for Abyss Lake. The monsters come from this era's spawns, so
# the same field reads differently in each era. (key, sign name, maps, keep:
# items kept even when they are not loot proper)
FIELD_SPOTS = [
    ("spore_fields", "Spore field", ["pay_fild08", "mjolnir_06", "cmd_fild01"],
     {"Strawberry", "Poison_Spore", "Mushroom_Spore", "Stem"}),
    ("payon_forest", "Payon Forest", ["pay_fild09", "pay_fild10"], {"Branch_Of_Dead_Tree"}),
    ("sograt", "Sograt Desert", ["moc_fild11", "moc_fild16", "moc_fild17", "moc_fild18"], set()),
    ("orc_fields", "Orc field", ["gef_fild10", "gef_fild14"], set()),
    ("kokomo", "Kokomo Beach", ["cmd_fild02", "cmd_fild03", "cmd_fild04"], set()),
    ("geffen_fields", "Geffen field", ["gef_fild08"], set()),
    ("juno_fields", "Juno field", ["yuno_fild06", "yuno_fild07", "yuno_fild11"], set()),
    ("einbroch_fields", "Einbroch field", ["ein_fild01", "ein_fild04", "ein_fild06", "lhz_fild01"], set()),
    ("rachel_fields", "Rachel field", ["ra_fild05", "ra_fild12"], set()),
    ("quest_fields", "Ayothaya/Umbala", ["ayo_fild01", "um_fild01", "mjolnir_01"], set()),
]
# Dungeons with a buyer but no sell stall of their own.
BUY_ONLY_DUNGEONS = [
    ("thor_volcano", "Thor's Volcano", ["thor_v.txt"]),
    ("labyrinth", "Labyrinth Forest", ["prt_maze.txt"]),
    ("geffen_dungeon", "Geffen Dungeon", ["gef_dun.txt"]),
    ("mjolnir_mine", "Mjolnir Mine", ["mjo_dun.txt"]),
    ("gonryun", "Gonryun", ["gon_dun.txt"]),
    ("louyang", "Louyang", ["lou_dun.txt"]),
    ("ayothaya", "Ayothaya", ["ayo_dun.txt"]),
    ("einbroch_mine", "Einbroch Mine", ["ein_dun.txt"]),
    ("moscovia", "Moscovia", ["mosk_dun.txt"]),
    ("brasilis", "Brasilis", ["bra_dun.txt"]),
    ("nidhoggur", "Nidhoggur's Nest", ["nyd_dun.txt"]),
    ("abbey", "Cursed Abbey", ["abbey.txt"]),
    ("rachel_sanctuary", "Rachel Sanctuary", ["ra_san.txt"]),
    ("umbala", "Umbala", ["um_dun.txt"]),
]
# A place whose monsters leave fewer kinds than this has no buyer in that era.
PLACE_MIN_ITEMS = 5


def place_buyer(key, place, counts, keep=()):
    loot = place_loot(counts, keep)
    if len(loot) < PLACE_MIN_ITEMS:
        return None
    mon = top_monster(counts)
    titles = [f"Buying {place} loot", f"WTB> {place} loot", f"B> {place} drops", f"{{name}} buys {place} loot"]
    needs = {}
    if mon:
        # Only over a stall that wants something that monster drops.
        drops = [item(d["Item"])["AegisName"] for m in counts if MOBS[m]["Name"] == mon
                 for d in MOBS[m].get("Drops") or [] if item(d["Item"])]
        titles += [f"B> {mon} loot", f"WTB {mon} drops"]
        needs = {f"B> {mon} loot": ([], drops), f"WTB {mon} drops": ([], drops)}
    return dict(key=key, titles=titles, needs=needs, place=[ITEMS_BY_ID[i] for i in loot],
                rank=lambda e, w=loot: w[e["Id"]], limit=40, weight=1, max=1, pay=PAY_COMMON, location=True)


for _key, _title, _files in AREAS_LOOT:
    _t = place_buyer("dungeon_" + _key, re.sub(r" (Drops|Loot)$", "", _title), place_counts(files=_files))
    if _t:
        BUY_THEMES.append(_t)
for _key, _place, _files in BUY_ONLY_DUNGEONS:
    _t = place_buyer("dungeon_" + _key, _place, place_counts(files=_files))
    if _t:
        BUY_THEMES.append(_t)
for _key, _place, _maps, _keep in FIELD_SPOTS:
    _t = place_buyer("field_" + _key, _place, place_counts(maps=_maps), _keep)
    if _t:
        BUY_THEMES.append(_t)

for _t in BUY_THEMES:
    _t.update(buy=True, pick=[2, 5], job=random.Random(_t["key"]).choice(sorted(BUY_JOBS)))
    _t.setdefault("weight", 1)
    _t["titles"] = _t["titles"] + [f"{{name}} is buying"]

# Card tiers by the monster that drops them: level and boss class, since
# nearly every card drops at the same 0.01%.
COMMON_CARDS, RARE_CARDS = set(), set()
for _mid, _m in MOBS.items():
    if _mid in MVP_IDS:
        continue
    for _d in _m.get("Drops") or []:
        _e = item(_d["Item"])
        if not _e or _e.get("Type") != "Card" or _e["Id"] in MVP_CARDS:
            continue
        boss = (_m.get("Class") == "Boss")
        if _m.get("Level", 1) <= 60 and not boss:
            COMMON_CARDS.add(_e["Id"])
        else:
            RARE_CARDS.add(_e["Id"])
RARE_CARDS -= COMMON_CARDS

# ---------------------------------------------------------------------------
# Carded gear
# ---------------------------------------------------------------------------
#
# Carded equipment is one of the commonest sights on a real market street.
# What is sold comes from two places:
#
#   carded.json   what iRO players really listed (scrape_carded.py, from
#                 ragnastats): base item, refine, cards, how often. Weighs
#                 the popular builds in by how often they were listed.
#   CLASS_BUILDS  the builds the iRO wiki's class guides recommend, so each
#                 class stall carries its classics even where the market
#                 data is thin.
#
# Plus a share of "messed-up" cardings: cards that fit the slot but make an
# odd mix, the kind players sell off cheap. MVP cards are never in anything.
# A carded piece costs what its parts do (the item, its refines, its cards)
# and a little for the work; a messed-up one half its cards.

CARDED_PATH = os.path.join(HERE, "carded.json")
try:
    CARDED = json.load(open(CARDED_PATH))
except FileNotFoundError:
    CARDED = {}

ITEMS_BY_NAME_SLOTS = {}
for _e in ITEMS_BY_ID.values():
    if _e.get("Name"):
        ITEMS_BY_NAME_SLOTS.setdefault((_e["Name"].lower(), _e.get("Slots", 0)), _e)


def by_name(name, slots=None):
    """An item by display name ("Chain Mail", 1) or a card ("Hydra Card")."""
    if slots is not None:
        return ITEMS_BY_NAME_SLOTS.get((name.lower(), slots))
    return ITEMS_BY_NAME.get(name.lower())


# From the iRO wiki's class pages (Equipment): (item, slots, [cards], refine).
# A card list shorter than the slots leaves the rest empty, as players do.
CLASS_BUILDS = {
    "class_assassin": [
        ("Jur", 3, ["Soldier Skeleton Card"] * 3, 7), ("Jur", 3, ["Hydra Card"] * 3, 4),
        ("Gladius", 3, ["Hydra Card"] * 3, 7), ("Main Gauche", 4, ["Andre Card"] * 4, 4),
        ("Main Gauche", 4, ["Hydra Card"] * 4, 4), ("Chain Mail", 1, ["Peco Peco Card"], 4),
        ("Hood", 1, ["Condor Card"], 4), ("Manteau", 1, ["Raydric Card"], 4),
        ("Boots", 1, ["Matyr Card"], 4), ("Brooch", 1, ["Kobold Card"], 0), ("Clip", 1, ["Zerom Card"], 0),
    ],
    "class_rogue": [
        ("Gladius", 3, ["Hydra Card"] * 3, 7), ("Composite Bow", 4, ["Hydra Card"] * 4, 7),
        ("Manteau", 1, ["Raydric Card"], 4), ("Boots", 1, ["Matyr Card"], 4),
    ],
    "class_knight": [
        ("Pike", 4, ["Hydra Card", "Hydra Card", "Skeleton Worker Card", "Vadon Card"], 7),
        ("Full Plate", 1, ["Peco Peco Card"], 4), ("Chain Mail", 1, ["Pasana Card"], 4),
        ("Manteau", 1, ["Raydric Card"], 4), ("Shield", 1, ["Thara Frog Card"], 4),
        ("Boots", 1, ["Verit Card"], 4), ("Rosary", 1, ["Yoyo Card"], 0), ("Ring", 1, ["Mantis Card"], 0),
        ("Helm", 1, ["Elder Willow Card"], 4),
    ],
    "class_crusader": [
        ("Shield", 1, ["Thara Frog Card"], 4), ("Glittering Jacket", 1, ["Angeling Card"], 4),
        ("Helm", 1, ["Cramp Card"], 4), ("Manteau", 1, ["Raydric Card"], 4), ("Clip", 1, ["Zerom Card"], 0),
    ],
    "class_wizard": [
        ("Clip", 1, ["Vitata Card"], 0), ("Clip", 1, ["Phen Card"], 0), ("Clip", 1, ["Creamy Card"], 0),
        ("Muffler", 1, ["Raydric Card"], 4), ("Muffler", 1, ["Noxious Card"], 4), ("Guard", 1, ["Thara Frog Card"], 4),
        ("Shoes", 1, ["Eggyra Card"], 4), ("Shoes", 1, ["Verit Card"], 4),
    ],
    "class_sage": [
        ("Clip", 1, ["Phen Card"], 0), ("Clip", 1, ["Vitata Card"], 0), ("Muffler", 1, ["Whisper Card"], 4),
        ("Guard", 1, ["Thara Frog Card"], 4), ("Shoes", 1, ["Eggyra Card"], 4), ("Formal Suit", 1, ["Pupa Card"], 4),
    ],
    "class_hunter": [
        ("Composite Bow", 4, ["Hydra Card", "Hydra Card", "Vadon Card", "Vadon Card"], 7),
        ("Boots", 1, ["Matyr Card"], 4), ("Boots", 1, ["Male Thief Bug Card"], 4),
        ("Muffler", 1, ["Whisper Card"], 4), ("Muffler", 1, ["Raydric Card"], 4), ("Tights", 1, ["Ghostring Card"], 4),
        ("Brooch", 1, ["Zerom Card"], 0),
    ],
    "class_bard_dancer": [
        ("Cap", 1, ["Willow Card"], 4), ("Sunglasses", 1, ["Nightmare Card"], 0),
        ("Boots", 1, ["Matyr Card"], 4), ("Muffler", 1, ["Raydric Card"], 4),
    ],
    "class_priest": [
        ("Saint's Robe", 1, ["Pupa Card"], 7), ("Silk Robe", 1, ["Baby Desert Wolf Card"], 4),
        ("Buckler", 1, ["Thara Frog Card"], 4), ("Buckler", 1, ["Thief Bug Egg Card"], 4),
        ("Muffler", 1, ["Raydric Card"], 4), ("Shoes", 1, ["Eggyra Card"], 7), ("Shoes", 1, ["Verit Card"], 7),
        ("Clip", 1, ["Alligator Card"], 0), ("Biretta", 1, ["Willow Card"], 4),
    ],
    "class_monk": [
        ("Chain", 3, ["Minorous Card"] * 3, 7), ("Mace", 4, ["Minorous Card"] * 4, 4),
        ("Ring", 1, ["Mantis Card"], 0), ("Glove", 1, ["Zerom Card"], 0), ("Shoes", 1, ["Sohee Card"], 4),
        ("Shoes", 1, ["Verit Card"], 4),
    ],
    "class_blacksmith": [
        ("Battle Axe", 4, ["Minorous Card"] * 4, 4), ("Battle Axe", 4, ["Hydra Card"] * 4, 4),
        ("Chain Mail", 1, ["Marc Card"], 4), ("Chain Mail", 1, ["Peco Peco Card"], 4),
        ("Boots", 1, ["Matyr Card"], 4), ("Buckler", 1, ["Thara Frog Card"], 4),
        ("Ring", 1, ["Mantis Card"], 0), ("Manteau", 1, ["Raydric Card"], 4),
    ],
    "class_alchemist": [
        ("Chain Mail", 1, ["Marc Card"], 4), ("Buckler", 1, ["Thara Frog Card"], 4),
        ("Boots", 1, ["Matyr Card"], 4), ("Manteau", 1, ["Raydric Card"], 4), ("Clip", 1, ["Vitata Card"], 0),
    ],
}

ACCESSORY = {"Right_Accessory", "Left_Accessory", "Both_Accessory"}
HEADGEAR = {"Head_Top", "Head_Mid", "Head_Low"}


def card_fits(card, e):
    """Whether a card goes into a piece of equipment's slots."""
    cl, el = locs(card), locs(e)
    if e.get("Type") == "Weapon":
        return bool(cl & {"Right_Hand", "Both_Hand"})
    if el & ACCESSORY:
        return bool(cl & ACCESSORY)
    if el & HEADGEAR:
        return bool(cl & HEADGEAR)
    return bool(cl & el)


def carded_slot(e):
    if e.get("Type") == "Weapon":
        return "weapon"
    return "accessory" if locs(e) & ACCESSORY else "armor"


def carded_price(e, refine, cards, messed_up=False):
    """What it cost to make: the item and its refines, its cards, a little
    for the work; a messed-up one sells its cards at half."""
    base = price(e)
    if base is None:
        return None
    if refine:
        base = refined_price(e, base, refine, False)
    cp = [price(c) for c in cards]
    if any(p is None for p in cp):
        return None
    total = base + sum(cp) * (0.5 if messed_up else 1.0)
    return int(total * (0.95 if messed_up else 1.03))


def carded_spec(e, refine, cards, weight, messed_up=False):
    if not e.get("Refineable"):
        refine = 0  # accessories and the like cannot be refined
    p = carded_price(e, refine, cards, messed_up)
    if p is None or p > POOL_MAX:
        return None
    return dict(item=e["AegisName"], refine=refine, cards=[c["AegisName"] for c in cards], price=p, weight=weight)


def carded_ok(e, cards):
    return (e is not None and tradeable(e) and cards and all(cards) and len(cards) <= e.get("Slots", 0)
            and not any(c["Id"] in MVP_CARDS for c in cards))


def carded_market():
    """The carded pieces iRO players listed, as specs, most listed first."""
    out = []
    for bid, rec in CARDED.items():
        e = ITEMS_BY_ID.get(int(bid))
        for v in rec.get("variants", []):
            cards = [ITEMS_BY_ID.get(c) for c in v["cards"]]
            if not carded_ok(e, cards) or v["refine"] > 10:
                continue
            spec = carded_spec(e, v["refine"], cards, max(1, v.get("listings") or 1))
            if spec:
                out.append((e, spec))
    # ragnastats shows at most six pages, so every popular build reads "150
    # listings": among those, the base item more players traded comes first.
    out.sort(key=lambda t: (-min(t[1]["weight"], 150), -popularity(t[0])))
    return out


def varied(pairs, limit, per_base=3):
    """The first `limit` of pairs, at most per_base builds of any one item,
    so a stall is not all Clips."""
    out, seen = [], {}
    for e, spec in pairs:
        if seen.get(e["Id"], 0) >= per_base:
            continue
        seen[e["Id"]] = seen.get(e["Id"], 0) + 1
        out.append((e, spec))
        if len(out) >= limit:
            break
    return out


def carded_builds(key):
    out = []
    for name, slots, cards, refine in CLASS_BUILDS.get(key, []):
        e = by_name(name, slots)
        cs = [by_name(c) for c in cards]
        missing = ([f"{name} [{slots}]"] if e is None else []) + [c for c, ce in zip(cards, cs) if ce is None]
        if missing:
            print(f"  {key}: guide build skipped, no {', '.join(sorted(set(missing)))} in this era", file=sys.stderr)
            continue
        if carded_ok(e, cs):
            spec = carded_spec(e, refine, cs, 50)
            if spec:
                out.append((e, spec))
    return out


def carded_messed_up(bases, n, rng):
    """n odd cardings of these bases: fitting cards, an unlikely mix."""
    cards = [ITEMS_BY_ID[c] for c in sorted(COMMON_CARDS) if c in ITEMS_BY_ID and tradeable(ITEMS_BY_ID[c])]
    out = []
    for _ in range(n * 4):
        if len(out) >= n or not bases:
            break
        e = rng.choice(bases)
        fit = [c for c in cards if card_fits(c, e)]
        if not fit:
            continue
        k = rng.randint(1, e.get("Slots", 1))
        cs = [rng.choice(fit) for _ in range(k)]
        if len({c["Id"] for c in cs}) < min(k, 2):
            continue  # an odd mix, not a deliberate triple
        spec = carded_spec(e, rng.choice([0, 0, 0, 4, 5]), cs, 1, messed_up=True)
        if spec:
            out.append((e, spec))
    return out


def add_carded():
    """The carded stalls, and carded lines in the class, refined and slotted
    stalls. Run once prices are known."""
    rng = random.Random("carded")
    market = carded_market()
    by_slot = {"weapon": [], "armor": [], "accessory": []}
    for e, spec in market:
        by_slot[carded_slot(e)].append((e, spec))
    print(f"  carded: {len(market)} market builds ({', '.join(f'{k} {len(v)}' for k, v in by_slot.items())})", file=sys.stderr)

    def pick(pairs, limit):
        return [spec for _, spec in varied(pairs, limit)]

    for slot, key, titles in [
        ("weapon", "carded_weapons", ["carded weapons", "S> carded weps", "triple carded stuff", "{name}'s Carded Arsenal",
                                      "weapons w/ cards", "S> hydra/skel weps"]),
        ("armor", "carded_armory", ["carded armor", "S> carded armory", "armor w/ cards", "{name}'s Carded Armory",
                                    "S> thara/raydric gear", "carded gear fs"]),
        ("accessory", "carded_accessories", ["carded accs", "S> clips n rings", "carded accessories",
                                             "{name}'s Jewelry Box", "S> zerom/mantis accs"]),
    ]:
        pairs = varied(by_slot[slot], 60)
        bases = [e for e, _ in pairs]
        extra = [s for _, s in pairs] + [s for _, s in carded_messed_up(bases, max(3, len(pairs) // 6), rng)]
        if not extra:
            continue
        THEMES.append(dict(key=key, job=random.Random(key).choice(["Merchant", "Blacksmith", "Whitesmith", "Creator"]),
                           pick=[3, 6], weight=1, titles=titles, extra=extra))

    for t in THEMES:
        k = t["key"]
        if k.startswith("class_"):
            # Its guide builds, and what players listed that this class wears.
            rule = t.get("rule")
            worn = varied([(e, s) for e, s in market if rule and rule(e)], 8, per_base=2)
            t.setdefault("extra", [])
            t["extra"] += [s for _, s in carded_builds(k)] + [s for _, s in worn]
        elif k == "refined_weapons":
            t.setdefault("extra", [])
            t["extra"] += [s for _, s in varied([(e, s) for e, s in by_slot["weapon"] if s["refine"] >= 5], 12, per_base=1)]
        elif k == "slotted_gear":
            t.setdefault("extra", [])
            t["extra"] += pick(by_slot["armor"], 8) + [s for _, s in carded_messed_up(
                [e for e, _ in by_slot["armor"]], 3, rng)]


# ---------------------------------------------------------------------------
# Resolve
# ---------------------------------------------------------------------------

def area_items(files):
    seen = {}
    for mid, _ in spawns(files):
        if mid in MVP_IDS or mid not in MOBS:
            continue
        for d in MOBS[mid].get("Drops") or []:
            e = item(d["Item"])
            if e and e.get("Type") != "Card" and DROPPERS.get(e["Id"], 0) <= LOOT_MAX_DROPPERS:
                seen[e["Id"]] = e
    return list(seen.values())


def spawned_mobs():
    out = set()
    for root, _, files in os.walk(os.path.join(RA, "npc", ERA, "mobs")):
        for f in files:
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 4 and parts[1].startswith("monster"):
                    mid = mob_ref(parts[3])
                    if mid:
                        out.add(mid)
    return out


def level_items(lo, hi, max_droppers=LOOT_MAX_DROPPERS):
    spawned = spawned_mobs()
    out = {}
    for mid, m in MOBS.items():
        if mid in MVP_IDS or m.get("Class") == "Boss" or mid not in spawned or not lo <= m.get("Level", 1) <= hi:
            continue
        for d in m.get("Drops") or []:
            e = item(d["Item"])
            if e and e.get("Type") != "Card" and DROPPERS.get(e["Id"], 0) <= max_droppers:
                out[e["Id"]] = e
    return list(out.values())


def mvp_items():
    """What MVPs drop or reward, other than their cards."""
    out = {}
    for mid in MVP_IDS:
        m = MOBS[mid]
        for d in (m.get("Drops") or []) + (m.get("MvpDrops") or []):
            e = item(d["Item"])
            if e and e.get("Type") != "Card":
                out[e["Id"]] = e
    return list(out.values())


def boss_items():
    normal = set()
    for mid, m in MOBS.items():
        if mid not in MVP_IDS and m.get("Class") != "Boss":
            for d in m.get("Drops") or []:
                normal.add(d["Item"].lower())
    out = {}
    for mid, m in MOBS.items():
        if mid not in MVP_IDS and m.get("Class") == "Boss":
            for d in m.get("Drops") or []:
                e = item(d["Item"])
                if e and e.get("Type") != "Card" and d["Item"].lower() not in normal:
                    out[e["Id"]] = e
    return list(out.values())


def theme_candidates(theme):
    """The items a rule, area or loot theme considers. A rule can match
    thousands, so this is a bounded set: everything already priced, plus the
    lowest ids (the classic items a Prontera sidewalk would carry) up to
    CANDIDATE_CAP."""
    candidates = []
    if "rule" in theme:
        candidates = [e for e in ITEMS_BY_ID.values() if theme["rule"](e)]
    elif "area" in theme:
        candidates = area_items(theme["area"])
    elif theme.get("boss"):
        candidates = boss_items()
    elif theme.get("mvp"):
        candidates = mvp_items()
    elif "place" in theme:
        # A place buyer's loot, already chosen and weighted: all of it.
        return [e for e in theme["place"] if tradeable(e) and obtainable(e)]
    elif "levels" in theme:
        candidates = level_items(*theme["levels"],
                                 max_droppers=PLACE_MAX_DROPPERS if theme.get("buyfilter") else LOOT_MAX_DROPPERS)
        if theme.get("buyfilter"):
            candidates = [e for e in candidates if buyable(e)]
    candidates = [e for e in candidates if tradeable(e) and obtainable(e)]
    cached = [e for e in candidates if str(e["Id"]) in CACHE]
    rest = sorted((e for e in candidates if str(e["Id"]) not in CACHE), key=lambda e: e["Id"])
    return cached + rest[:max(0, CANDIDATE_CAP - len(cached))]


def prefetch(themes, workers=4, everything=False):
    """Fetch every price the themes will ask for (or, with everything, every
    tradeable item's), a few at a time."""
    from concurrent.futures import ThreadPoolExecutor
    want = {e["Id"] for e in ITEMS_BY_ID.values() if tradeable(e)} if everything else set()
    for t in themes:
        for spec in t.get("items", []) + t.get("extra", []):
            e = item(spec["item"] if isinstance(spec, dict) else spec)
            if e:
                want.add(e["Id"])
        want.update(e["Id"] for e in theme_candidates(t))
    want.update(item(n)["Id"] for n in REFINE_ORE.values())
    missing = sorted(i for i in want if str(i) not in CACHE)
    print(f"  fetching {len(missing)} prices ({len(want)} wanted)", file=sys.stderr)
    done = 0
    with ThreadPoolExecutor(workers) as pool:
        for iid, res in zip(missing, pool.map(lambda i: (time.sleep(0.2), fetch(i))[1], missing)):
            CACHE[str(iid)] = res
            done += 1
            if done % 50 == 0:
                json.dump(CACHE, open(PRICES, "w"), indent=0, sort_keys=True)
                print(f"    {done}/{len(missing)}", file=sys.stderr)
    json.dump(CACHE, open(PRICES, "w"), indent=0, sort_keys=True)


def resolve(theme, refresh, rng):
    lines = []
    if "items" in theme or "extra" in theme:
        for spec in theme.get("items", []) + theme.get("extra", []):
            spec = spec if isinstance(spec, dict) else dict(item=spec)
            e = item(spec["item"])
            if not e:
                print(f"  {theme['key']}: no item {spec['item']}", file=sys.stderr)
                continue
            if not tradeable(e):
                continue
            if not obtainable(e) or not all(item(c) and obtainable(item(c)) for c in spec.get("cards") or []):
                continue  # nothing in this era hands it out
            p = spec.get("price")
            if p is None:
                p = price(e, refresh)
                if p is None:
                    # Hand-picked, so trust the market even above the caps
                    # (an Ice Pick really does go for tens of millions).
                    avg, seen = market(e["Id"], False)
                    p = avg if avg and seen >= 20 else None
                if p is None:
                    continue
                if spec.get("refine"):
                    p = refined_price(e, p, spec["refine"], refresh)
            lines.append((e, spec, p))
    candidates = theme_candidates(theme)
    if candidates:
        ranked = []
        for e in candidates:
            if not tradeable(e):
                continue
            p = price(e, refresh)
            if p is None or p > POOL_MAX:
                continue
            ranked.append((theme.get("rank", popularity)(e), e, p))
        limit = theme.get("limit", 30)
        if theme.get("sample") == "random":
            random.Random(theme["key"]).shuffle(ranked)
        else:
            # The ones players actually trade most, so a stall reads familiar.
            ranked.sort(key=lambda t: -t[0])
        for _, e, p in ranked[:limit]:
            lines.append((e, dict(item=e["AegisName"]), p))
    return lines


def flow(d):
    parts = []
    for k, v in d.items():
        if isinstance(v, list):
            v = "[" + ", ".join(str(x) for x in v) + "]"
        parts.append(f"{k}: {v}")
    return "{ " + ", ".join(parts) + " }"


def q(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def read_table():
    import csv
    out = {}
    if not os.path.exists(TABLE_CSV):
        return out
    # Excel may save it in the local code page; only Id and the numbers matter.
    with open(TABLE_CSV, encoding="utf-8", errors="replace", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        rows = csv.reader((l for l in f if not l.lstrip().startswith("#")),
                          delimiter=";" if sample.count(";") > sample.count(",") else ",")
        for row in rows:
            if not row or row[0].strip().lower() == "id" or len(row) < 3:
                continue
            try:
                iid = int(row[0]) if row[0].strip() else item(row[1].strip())["Id"]
                lo = int(row[2])
                hi = int(row[3]) if len(row) > 3 and row[3].strip() else lo
            except (ValueError, TypeError):
                continue
            src = row[4].strip() if len(row) > 4 else ""
            lo, hi = (lo, max(lo, hi)) if lo > 0 else (0, 0)
            # A row that differs from what the generator last wrote was changed
            # by hand: it is kept, and says so.
            gen = GENERATED.get(str(iid))
            if src != "manual" and gen is not None and [lo, hi] != gen:
                src = "manual"
            out[iid] = (lo, hi, src)
    return out


def band(p):
    b = 0.08 if p >= 1000 else 0.15
    return tidy(max(1, int(p * (1 - b)))), tidy(int(p * (1 + b)) + 1)


def fill_table():
    """Every tradeable item gets a row: its range and where the price came
    from, or 0,0 ("not priced yet") so it is there to fill in. Rows changed
    by hand are kept; every other row follows the data."""
    for e in ITEMS_BY_ID.values():
        if not tradeable(e) or not e.get("Name"):
            continue
        fixed = PRICE_SET.get(e["AegisName"])
        if fixed:
            TABLE[e["Id"]] = (*fixed, "set")
            continue
        row = TABLE.get(e["Id"])
        if row and row[2] == "manual":
            continue
        p, src = priced(e)
        TABLE[e["Id"]] = (*band(p), src) if p is not None else (0, 0, "")


# How busy the customers of players' stalls are: every BuyersPerDay and
# SellersPerDay below times this. 3 puts a customer every 20-40 minutes on an
# item fake buyers want, at a fair price; the mod's pace settings scale it
# further for a server.
DEMAND_SCALE = 3

# Items some fake buying store wants, filled in as the buy themes resolve: a
# customer for a player's stall is likelier to want those.
BUY_WANTED = set()


def demand(e, lo, hi, busy_cut):
    """(BuyersPerDay, SellersPerDay) for the customers who visit players'
    stalls: how many come a day, at a fair price, to buy the item from a
    player's vending stall and to sell it into a player's buying store.

    Buyers: what fake buyers want and quests ask for sells best, heavily
    traded items better still; equipment and cards slower; dear items slower.
    Sellers: as much as monsters drop of it (the sum of their drop chances),
    for items a buying store may take, fewer for dear ones; none for what
    only MVPs drop.
    About 24 a day is one an hour; each takes a batch (cheap loot by the
    stack, dear things one at a time)."""
    p = (lo + hi) // 2 if lo else 0
    if e["Id"] in BUY_WANTED:
        buyers = 12
    elif e.get("Type") == "Card":
        buyers = 2
    elif is_equip(e):
        buyers = 2.5
    else:
        buyers = 4
    if QUEST_ASKS.get(e["Id"], 0) >= 2:
        buyers += 5
    if popularity(e) >= busy_cut:
        buyers *= 1.5
    if p >= 1_000_000:
        buyers *= 0.3
    elif p >= 100_000:
        buyers *= 0.6
    sellers = 0
    if buyable(e) and e["Id"] not in MVP_ONLY:
        a = DROP_ABUNDANCE.get(e["Id"], 0)
        if a >= 5:
            sellers = 24
        elif a >= 1:
            sellers = 12
        elif a >= 0.2:
            sellers = 6
        elif a >= 0.05:
            sellers = 2
        else:
            sellers = 1  # rare drops, crafted goods, quest rewards: someone still has a few
        if p >= 1_000_000:
            sellers *= 0.2
        elif p >= 100_000:
            sellers *= 0.5
        sellers = max(1, round(sellers))
    return max(1, round(buyers * DEMAND_SCALE)), round(sellers * DEMAND_SCALE)


# ---------------------------------------------------------------------------
# Dynamic market: its data, as an NPC script (npc/prontera-vendors-market-data.txt)
# ---------------------------------------------------------------------------
#
# The market itself is the mod's own NPC script (npc/prontera-vendors-market.txt).
# This writes what it needs to know and cannot work out at runtime: how much of
# each item changes hands on a normal day (how far one trade moves its price),
# which items move together (a group shares a move, Share percent of it), and
# the news events that push a group for some days. Items are the ones this
# era has; an event with nothing left is left out. Like waypoint-system's
# data, it is generated here and shipped, and nothing reads a file at runtime.

MARKET_GROUPS = [
    ("forge", 30, ["Elunium", "Oridecon", "Elunium_Stone", "Oridecon_Stone", "Emveretarcon"]),
    ("crafting", 30, ["Steel", "Iron", "Iron_Ore", "Coal"]),
    ("herbs", 30, sorted(HERBS)),
    ("potions", 30, ["Red_Potion", "Orange_Potion", "Yellow_Potion", "White_Potion", "Blue_Potion"]),
    ("slims", 30, ["Red_Slim_Potion", "Yellow_Slim_Potion", "White_Slim_Potion"]),
    ("gemstones", 30, ["Blue_Gemstone", "Yellow_Gemstone", "Red_Gemstone"]),
    ("elemental", 25, ["Flame_Heart", "Mistic_Frozen", "Rough_Wind", "Great_Nature",
                       "Boody_Red", "Crystal_Blue", "Wind_Of_Verdure", "Yellow_Live"]),
    ("boxes", 25, ["Old_Blue_Box", "Old_Violet_Box", "Old_Card_Album", "Magic_Card_Album",
                   "Bloody_Dead_Branch", "Branch_Of_Dead_Tree"]),
    ("ygg", 30, ["Yggdrasilberry", "Seed_Of_Yggdrasil", "Leaf_Of_Yggdrasil"]),
    ("berries", 25, sorted(BERRIES)),
    ("dragon", 30, ["Dragon_Scale", "Dragon_Canine", "Dragon_Train", "Burning_Heart"]),
]


def market_items(names):
    """The aegis names of those this era has, tradeable, once each."""
    out = []
    for n in names:
        e = item(n)
        if e and tradeable(e) and e["AegisName"] not in out:
            out.append(e["AegisName"])
    return out


def place_items(key, n=15):
    """A dungeon's (AREAS_LOOT) or field's (FIELD_SPOTS) loot, the commonest first."""
    for k, _, files in AREAS_LOOT:
        if k == key:
            counts = place_counts(files=files)
            break
    else:
        for k, _, maps, keep in FIELD_SPOTS:
            if k == key:
                counts = place_counts(maps=maps)
                break
        else:
            return []
    loot = place_loot(counts)
    return [ITEMS_BY_ID[i]["AegisName"] for i in sorted(loot, key=lambda i: (-loot[i], i))[:n]]


def market_events():
    """(key, text, days, [(change_min, change_max, [aegis...])]) for this era.
    Each key has its end text in NEWS_ENDS (a migration's is made below)."""
    rng = random.Random("market-news")
    quest = [e["AegisName"] for e in sorted((ITEMS_BY_ID[i] for i in QUEST_ASKS if i in ITEMS_BY_ID),
                                            key=lambda e: (-QUEST_ASKS[e["Id"]], e["Id"]))
             if buyable(e) and e.get("Type") == "Etc"][:12]
    cards = [ITEMS_BY_ID[i]["AegisName"] for i in sorted(COMMON_CARDS | RARE_CARDS, key=lambda i: (-popularity(ITEMS_BY_ID[i]), i))
             if i in ITEMS_BY_ID and tradeable(ITEMS_BY_ID[i])][:40]
    # Everyday goods: cheap consumables an NPC sells and the stalls carry, not
    # WoE-only (Siege, TE) items or boxes that open into something else.
    everyday = sorted(e["AegisName"] for e in ITEMS_BY_ID.values()
                      if e.get("Type") in ("Healing", "Usable") and tradeable(e) and e["Id"] in MARKET_ITEMS
                      and e["Id"] in NPC_SOLD
                      and 0 < (price(e) or 0) < 5_000
                      and not e["Name"].startswith(("Siege", "TE ")) and "Box" not in e["Name"]
                      and "Quiver" not in e["Name"])
    # Junk: cheap loot nearly every monster drops. Not ores, crafting or
    # alchemy materials, nor what an NPC sells (gemstones, bottles), which many
    # monsters drop too but nobody calls junk.
    junk = [e["AegisName"] for e in sorted((e for e in ITEMS_BY_ID.values()
                                            if e.get("Type") == "Etc" and buyable(e)
                                            and e["AegisName"] not in UPGRADE | CRAFTING | ELEMENTAL | ALCHEMY | HERBS
                                            and e["Id"] not in NPC_SOLD and "Ore" not in e["Name"].split()
                                            and 0 < (price(e) or 0) <= 2_000),
                                           key=lambda e: (-DROPPERS.get(e["Id"], 0), e["Id"]))][:12]
    food = ["Apple", "Banana", "Grape", "Carrot", "Meat", "Honey", "Royal_Jelly", "Strawberry", "Orange", "Lemon",
            "Red_Potion", "Orange_Potion", "Yellow_Potion", "White_Potion"]
    pets = [spec if isinstance(spec, str) else spec["item"] for t in THEMES if t["key"] == "pets" for spec in t["items"]]
    events = [
        ("woe_season", "War of Emperium season: guilds stock up on potions and gems.", 5,
         [(20, 40, ["White_Potion", "Blue_Potion", "Red_Slim_Potion", "Yellow_Slim_Potion", "White_Slim_Potion",
                    "Blue_Gemstone", "Yellow_Gemstone", "Red_Gemstone", "Acid_Bottle", "Fire_Bottle"])]),
        ("refining_fever", "The Prontera smith has a lucky week, everyone wants to refine.", 4,
         [(20, 35, ["Elunium", "Oridecon", "Elunium_Stone", "Oridecon_Stone", "Steel"])]),
        ("hat_craze", "A new hat is in fashion: quest materials sought.", 5, [(25, 50, quest)]),
        ("card_craze", "Collectors are buying up cards.", 4, [(15, 30, cards)]),
        ("alchemist_order", "The Alchemist Guild places a big order.", 4,
         [(25, 45, sorted(HERBS) + ["Empty_Bottle", "Medicine_Bowl", "Starsand_Of_Witch", "Stem"])]),
        ("gambling_night", "Gamblers flock to Prontera: boxes and albums in demand.", 3,
         [(20, 40, ["Old_Blue_Box", "Old_Violet_Box", "Old_Card_Album", "Magic_Card_Album",
                    "Bloody_Dead_Branch", "Branch_Of_Dead_Tree"])]),
        ("pet_fair", "A pet fair in Prontera: taming items and pet food sought.", 3, [(30, 60, pets)]),
        ("orc_rampage", "Adventurers flood the orc fields: orc loot everywhere.", 4,
         [(-40, -25, place_items("orc_fields"))]),
        ("spore_harvest", "A bumper spore season in Payon.", 4,
         [(-35, -20, ["Strawberry", "Poison_Spore", "Mushroom_Spore", "Stem"])]),
        ("glast_heim_purge", "A guild cleared Glast Heim, its loot is everywhere.", 4,
         [(-40, -25, place_items("glast_heim"))]),
        ("dragon_hunt", "Dragon hunters return from Magma and Abyss Lake.", 4,
         [(-40, -25, ["Dragon_Scale", "Dragon_Canine", "Dragon_Train", "Burning_Heart"])]),
        ("merchant_clearance", "A big merchant is closing shop: everyday goods cheap.", 3,
         [(-25, -15, rng.sample(everyday, min(10, len(everyday))))]),
        ("smith_overstock", "Forges are overstocked: ores at a discount.", 3,
         [(-30, -15, ["Elunium", "Oridecon", "Elunium_Stone", "Oridecon_Stone", "Iron", "Coal"])]),
        ("festival", "Festival! Food and potions sought, junk loot ignored.", 3,
         [(20, 20, food), (-15, -15, junk)]),
        ("monster_raid", "Monsters raid Prontera's gates: potions and wings in demand.", 3,
         [(20, 40, ["Red_Potion", "Orange_Potion", "Yellow_Potion", "White_Potion", "Wing_Of_Fly",
                    "Wing_Of_Butterfly", "Yggdrasilberry", "Green_Potion"])]),
        ("ygg_blight", "A blight on the World Tree: Yggdrasil berries and seeds are scarce.", 5,
         [(25, 45, ["Yggdrasilberry", "Seed_Of_Yggdrasil", "Leaf_Of_Yggdrasil"])]),
        ("dye_craze", "A fashion contest in Prontera: everyone wants dyestuffs.", 4,
         [(30, 50, sorted(e["AegisName"] for e in ITEMS_BY_ID.values()
                          if e.get("Type") == "Etc" and is_dyestuff(e) and tradeable(e)))]),
        ("arrow_shortage", "The Hunters' Guild runs dry: arrows sought.", 3,
         [(20, 35, ["Arrow", "Silver_Arrow", "Fire_Arrow", "Steel_Arrow", "Crystal_Arrow", "Arrow_Of_Wind",
                    "Stone_Arrow", "Immatrial_Arrow"])]),
        ("elemental_research", "The Sages of Juno study the elements: stones and converters sought.", 4,
         [(20, 40, ["Flame_Heart", "Mistic_Frozen", "Rough_Wind", "Great_Nature", "Elemental_Fire",
                    "Elemental_Water", "Elemental_Earth", "Elemental_Wind"])]),
        ("bounty_week", "Bounty week: the Prontera board pays for monster parts.", 4, [(20, 30, junk)]),
        ("card_dump", "An old collector sells off his albums: cards are cheap.", 3, [(-30, -15, cards)]),
        ("ore_strike", "Miners strike it rich in Mjolnir: ores at a discount.", 4,
         [(-40, -25, ["Iron_Ore", "Iron", "Coal", "Steel", "Elunium_Stone", "Oridecon_Stone"])]),
        ("herb_bloom", "Herbs bloom across the fields.", 4, [(-40, -25, sorted(HERBS))]),
    ]
    places = dict((k, re.sub(r" (Drops|Loot)$", "", t)) for k, t, _ in AREAS_LOOT)
    for flood, scarce in [("byalan", "payon_cave"), ("glast_heim", "sphinx"), ("clock_tower", "turtle_island"),
                          ("magma", "abyss_lake"), ("orc_dungeon", "geffenia"), ("pyramids", "toy_factory"),
                          ("sunken_ship", "niflheim"), ("ant_hell", "comodo_caves")]:
        key = f"migration_{flood}_{scarce}"
        # Loot both places share would move both ways at once: leave it out.
        out_, in_ = place_items(flood), place_items(scarce)
        both = set(out_) & set(in_)
        events.append((key,
                       f"Monsters are on the move: {places[flood]} loot floods in, {places[scarce]} loot grows scarce.", 4,
                       [(-30, -30, [n for n in out_ if n not in both]), (30, 30, [n for n in in_ if n not in both])]))
        NEWS_ENDS[key] = f"The monsters have settled again: {places[flood]} and {places[scarce]} loot back to normal."
    return events


# What the market announces when a piece of news is over.
NEWS_ENDS = {
    "woe_season": "The War of Emperium season is over; potions and gems are back to normal.",
    "refining_fever": "The refining fever has passed.",
    "hat_craze": "The hat craze is over; quest materials are back to normal.",
    "card_craze": "The collectors have their cards; card prices settle.",
    "alchemist_order": "The Alchemist Guild's order is filled.",
    "gambling_night": "The gamblers have left Prontera.",
    "pet_fair": "The pet fair is over.",
    "orc_rampage": "The orc fields are quiet again.",
    "spore_harvest": "The spore season in Payon is over.",
    "glast_heim_purge": "Glast Heim's loot has been sold off.",
    "dragon_hunt": "The dragon hunters' haul has been sold.",
    "merchant_clearance": "The clearance sale is over.",
    "smith_overstock": "The forges have used up their stock.",
    "festival": "The festival is over.",
    "monster_raid": "The raid on Prontera has been repelled.",
    "ygg_blight": "The World Tree has recovered.",
    "dye_craze": "The fashion contest is over; dyestuffs are back to normal.",
    "arrow_shortage": "The Hunters' Guild has arrows again.",
    "elemental_research": "The Sages have finished their research.",
    "bounty_week": "Bounty week is over.",
    "card_dump": "The collector's albums are sold out.",
    "ore_strike": "The Mjolnir ore glut has been bought up.",
    "herb_bloom": "The herb bloom is over.",
}



# Every item the stalls and buyers deal in, filled in as the themes resolve.
MARKET_ITEMS = set()


def market_volume(e):
    """How many change hands on a normal day: its customers and sellers a day
    (the price list), times what each deals in (cheap loot by the hundred,
    dear things one at a time)."""
    lo, hi, _ = TABLE.get(e["Id"], (0, 0, ""))
    p = (lo + hi) // 2 if lo else (price(e) or 0)
    buyers, sellers = demand(e, lo, hi, 0)
    deals = max(1.0, (buyers + max(sellers, 1)) / 2.0)
    each = 100 if p < 1000 else 3 if p < 20000 else 1.5 if p < 200000 else 1
    return max(1, round(deals * each))


def write_market_script():
    """npc/prontera-vendors-market-data.txt: the market's data, filled into
    temporary server variables at start ($@pv_*), read by the market script."""
    groups = [(key, share, market_items(names)) for key, share, names in MARKET_GROUPS]
    groups = [(key, share, items) for key, share, items in groups if len(items) >= 2]
    events = []
    for key, text, days, effects in market_events():
        fx = [(lo, hi, market_items(names)) for lo, hi, names in effects]
        fx = [(lo, hi, items) for lo, hi, items in fx if items][:2]
        if fx:
            events.append((key, text, days, fx))
    missing = [key for key, _, _, _ in events if key not in NEWS_ENDS]
    assert not missing, f"news without an end text in NEWS_ENDS: {missing}"
    ids = set(MARKET_ITEMS)
    for _, _, items in groups:
        ids.update(item(n)["Id"] for n in items)
    for _, _, _, fx in events:
        for _, _, items in fx:
            ids.update(item(n)["Id"] for n in items)
    out = ["//===== Ragnarok Offline: prontera-vendors =================================",
           "//= The dynamic market's data, for npc/prontera-vendors-market.txt.",
           "//= GENERATED by registry/tools/prontera-vendors/build_vendors.py",
           "//= (MARKET_GROUPS, market_events, market_volume); a re-run overwrites it.",
           "//===========================================================================",
           "-\tscript\tProntVendorsMarketData\t-1,{",
           "\tend;",
           "OnInit:",
           "\t// How many of each item change hands on a normal day.",
           "\tdeletearray $@pv_vol;"]
    vol = sorted((i, market_volume(ITEMS_BY_ID[i])) for i in ids if i in ITEMS_BY_ID)
    for k in range(0, len(vol), 8):
        out.append("\t" + " ".join(f"$@pv_vol[{i}] = {v};" for i, v in vol[k:k + 8]))
    out += ["\t// Groups: their items in a row, where each starts, how many, and the share of a move.",
            "\tdeletearray $@pv_gitem; deletearray $@pv_gstart; deletearray $@pv_glen; deletearray $@pv_gshare; deletearray $@pv_ig;"]
    flat, seen = [], set()
    for g, (key, share, items) in enumerate(groups):
        mine = [item(n)["Id"] for n in items]
        out.append(f"\t$@pv_gstart[{g}] = {len(flat)}; $@pv_glen[{g}] = {len(mine)}; $@pv_gshare[{g}] = {share}; // {key}")
        for i in mine:
            if i not in seen:  # an item's first group is its group
                out.append(f"\t$@pv_ig[{i}] = {g + 1};")
                seen.add(i)
        flat += mine
    for k in range(0, len(flat), 16):
        out.append(f"\tsetarray $@pv_gitem[{k}], " + ", ".join(map(str, flat[k:k + 16])) + ";")
    out.append(f"\t$@pv_gcount = {len(groups)};")
    out += ["\t// News: key, board text, days; up to two effects each (percent range, items).",
            "\tdeletearray $@pv_evkey$; deletearray $@pv_evtext$; deletearray $@pv_evend$; deletearray $@pv_evdays; deletearray $@pv_fxev;",
            "\tdeletearray $@pv_fxmin; deletearray $@pv_fxmax; deletearray $@pv_fxstart; deletearray $@pv_fxlen; deletearray $@pv_fxitem;"]
    flat, f = [], 0
    for e, (key, text, days, fx) in enumerate(events):
        out.append(f'\t$@pv_evkey$[{e}] = "{key}"; $@pv_evtext$[{e}] = {q(text)}; $@pv_evdays[{e}] = {days};')
        out.append(f'\t$@pv_evend$[{e}] = {q(NEWS_ENDS[key])};')
        for lo, hi, items in fx:
            mine = [item(n)["Id"] for n in items]
            out.append(f"\t$@pv_fxev[{f}] = {e}; $@pv_fxmin[{f}] = {lo}; $@pv_fxmax[{f}] = {hi}; "
                       f"$@pv_fxstart[{f}] = {len(flat)}; $@pv_fxlen[{f}] = {len(mine)};")
            flat += mine
            f += 1
    for k in range(0, len(flat), 16):
        out.append(f"\tsetarray $@pv_fxitem[{k}], " + ", ".join(map(str, flat[k:k + 16])) + ";")
    out += [f"\t$@pv_evcount = {len(events)};", f"\t$@pv_fxcount = {f};", "\tend;", "}"]
    npc = os.path.join(os.path.dirname(OUT_DB), "npc")
    os.makedirs(npc, exist_ok=True)
    open(os.path.join(npc, "prontera-vendors-market-data.txt"), "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
    print(f"  market: {len(vol)} item volumes, {len(groups)} groups, {len(events)} news events", file=sys.stderr)


# ---------------------------------------------------------------------------
# Supply: what the world's hunters find
# ---------------------------------------------------------------------------
#
# npc/prontera-vendors-supply.txt simulates parties hunting the world's
# fields and dungeons, an hour at a time, and keeps a supply of each item
# that only monsters drop. The engine lists no more of one than the supply
# holds ($@pop_item_supply). This writes what that script needs: each map's
# yield per party-hour, the MvPs, and per item its decay class and cap.

# Kills one party makes in an hour on a map with monsters to spare (one
# every 12 s), and the seconds a monster takes to find and kill on top of its
# respawn: a map's spawns cap its kills, however many parties hunt it.
SUPPLY_PARTY_KILLS = 300
SUPPLY_HUNT_SECONDS = 30
# A map needs this many monsters worth hunting to draw a party.
SUPPLY_MIN_MOBS = 8
# How much likelier a party picks a known hunting ground (FIELD_SPOTS and the
# dungeons with a loot stall or buyer).
SUPPLY_KNOWN_SPOT = 3
# Each item's stock never goes past this many times the most a stall line
# lists, and at least SUPPLY_CAP_MIN: drops nobody lists don't pile up.
SUPPLY_CAP_TIMES = 4
SUPPLY_CAP_MIN = 5
# Half-life class, in percent of the "How long loot stays" setting. What
# players use up (ores, stones, herbs, potions...) leaves fastest; cards and
# MvP loot are held longest, equipment longer than loot.
SUPPLY_HL_USED = 50
SUPPLY_HL_LOOT = 100
SUPPLY_HL_EQUIP = 300
SUPPLY_HL_RARE = 500
SUPPLY_USED_TYPES = ("healing", "usable", "delayconsume", "cash")
# rAthena's drop-rate classes (mob.cpp, the item_rate_* battle flags), in the
# order the supply script reads them with getbattleflag.
RATE_CLASSES = ["common", "common_boss", "common_mvp", "heal", "heal_boss", "heal_mvp",
                "use", "use_boss", "use_mvp", "equip", "equip_boss", "equip_mvp",
                "card", "card_boss", "card_mvp", "treasure", "mvp"]
# Spawn files the hunters go to: the world's fields and dungeons, not towns,
# castles, the academy or event spawns.
SUPPLY_SPAWN_DIRS = ("fields/", "dungeons/")
SUPPLY_SPAWN_FILES = ("tra_fild.txt", "verus.txt")
# Filled in by main() as the sell themes resolve: item id -> the most any
# plain line of a sell stall lists.
SELL_PLAIN = {}


def produced_items():
    """What a player can make (forge, brew, cook...): produce_db's results."""
    out = set()
    path = os.path.join(RA, "db", ERA, "produce_db.txt")
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="utf-8", errors="replace"):
        parts = line.split("//")[0].strip().split(",")
        if len(parts) > 1 and parts[1].strip().isdigit():
            out.add(int(parts[1]))
    return out


def mob_bosstype(m):
    """rAthena's boss type: "mvp", "boss" (a mini-boss) or ""."""
    if (m.get("Modes") or {}).get("Mvp") or m.get("MvpExp", 0) > 0:
        return "mvp"
    return "boss" if m.get("Class") == "Boss" else ""


def rate_class(e, m, mvp_reward=False):
    """The index in RATE_CLASSES of the drop-rate setting rAthena scales this
    drop by (mob.cpp, the mob_db load)."""
    if mvp_reward:
        return RATE_CLASSES.index("mvp")
    if "Treasure" in (m.get("RaceGroups") or {}):
        return RATE_CLASSES.index("treasure")
    t = (e.get("Type") or "Etc").lower()
    kind = {"healing": "heal", "usable": "use", "cash": "use", "weapon": "equip", "armor": "equip",
            "petarmor": "equip", "card": "card"}.get(t, "common")
    bt = mob_bosstype(m)
    return RATE_CLASSES.index(kind + ("_" + bt if bt else ""))


def supply_spawns():
    """(map, mob id, count, average respawn in seconds, boss_monster?) for
    every spawn line in the hunters' fields and dungeons."""
    out = []
    base = os.path.join(RA, "npc", ERA, "mobs")
    for root, _, files in os.walk(base):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), base).replace(os.sep, "/")
            if not f.endswith(".txt") or not (rel.startswith(SUPPLY_SPAWN_DIRS) or rel in SUPPLY_SPAWN_FILES):
                continue
            for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
                if line.lstrip().startswith("//"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 4 or not parts[1].startswith(("monster", "boss_monster")):
                    continue
                mid = mob_ref(parts[3])
                if mid not in MOBS:
                    continue
                fields = [x.strip() for x in parts[3].split(",")]
                n = int(fields[1]) if len(fields) > 1 and fields[1].isdigit() else 1
                d1 = int(fields[2]) if len(fields) > 2 and fields[2].isdigit() else 0
                d2 = int(fields[3]) if len(fields) > 3 and fields[3].isdigit() else 0
                mp = parts[0].split(",")[0].strip()
                if n > 0 and re.fullmatch(r"[A-Za-z0-9_]+", mp):
                    out.append((mp, mid, n, (d1 + d2 / 2) / 1000, parts[1].startswith("boss_monster")))
    return out


# An NPC selling an item for up to this many times its market price is where
# players get it, so hunting doesn't limit it. Dearer NPCs (a special shop
# with Elunium at 200,000z) don't count.
SUPPLY_NPC_TIMES = 1.5


def supply_gated(spawn_rows):
    """Items the supply limits: those a sell stall lists plain that only
    monsters on the hunters' maps give (no NPC sells them near the market
    price, nobody makes them). What the hunters can't find stays as it is,
    or it would never show."""
    found = set()
    for _, mid, _, _, _ in spawn_rows:
        m = MOBS[mid]
        for d in (m.get("Drops") or []) + (m.get("MvpDrops") or []):
            e = item(d["Item"])
            if e:
                found.add(e["Id"])
    made = produced_items()

    def npc_source(i):
        if i not in NPC_PRICE:
            return False
        hi = TABLE.get(i, (0, 0, ""))[1]
        return not hi or NPC_PRICE[i] <= SUPPLY_NPC_TIMES * hi

    return {i for i in SELL_PLAIN if i in found and not npc_source(i) and i not in made}


def write_supply_script():
    """npc/prontera-vendors-supply-data.txt: the hunting simulation's data,
    filled into temporary server variables at start ($@pvs_*)."""
    rows = supply_spawns()
    gated = supply_gated(rows)
    known = {mp for _, _, maps, _ in FIELD_SPOTS for mp in maps}
    known_files = {f for _, _, files in AREAS_LOOT + BUY_ONLY_DUNGEONS for f in files}
    # Maps of the known dungeons: their spawn files name them.
    for rel, mp, _, _ in SPAWN_LINES:
        if rel.split("/")[-1] in known_files:
            known.add(mp)

    by_map, mvps = {}, {}
    for mp, mid, n, respawn, boss in rows:
        if mob_bosstype(MOBS[mid]) == "mvp":
            mv = mvps.setdefault(mid, {"copies": 0, "respawn": respawn, "maps": set()})
            mv["copies"] += n
            mv["respawn"] = min(mv["respawn"], respawn)
            mv["maps"].add(mp)
            continue
        by_map.setdefault(mp, []).append((mid, n, respawn))

    maps = []
    for mp in sorted(by_map):
        lines = by_map[mp]
        # Plants and eggs are hit now and then, not hunted.
        def weight(mid, n):
            m = MOBS[mid]
            return n * (0.3 if m.get("Race") == "Plant" or m["Name"].endswith("Egg") else 1.0)
        hunted = sum(weight(mid, n) for mid, n, _ in lines)
        if hunted < SUPPLY_MIN_MOBS:
            continue
        lv = round(sum(MOBS[mid].get("Level", 1) * weight(mid, n) for mid, n, _ in lines) / hunted)
        cap = 0
        yields = {}
        for mid, n, respawn in lines:
            # Each line gets its share of a party's kills, no more than its
            # monsters can respawn in an hour.
            line_cap = n * 3600 / (respawn + SUPPLY_HUNT_SECONDS)
            cap += line_cap
            kills = min(SUPPLY_PARTY_KILLS * weight(mid, n) / hunted, line_cap)
            m = MOBS[mid]
            for d in m.get("Drops") or []:
                e = item(d["Item"])
                if not e or e["Id"] not in gated:
                    continue
                k = (e["Id"], rate_class(e, m))
                yields[k] = yields.get(k, 0) + kills * d.get("Rate", 0) / 10000
        yields = {k: round(v * 1_000_000) for k, v in yields.items() if round(v * 1_000_000) > 0}
        maps.append((mp, lv, min(round(cap), 1_000_000), SUPPLY_KNOWN_SPOT if mp in known else 1, yields))

    # Each item's yield per party-hour, over where parties go (by map weight):
    # the long-run inflow, for a market started filled and for long downtime.
    total_w = sum(w for _, _, _, w, _ in maps) or 1
    avg = {}
    for _, _, _, w, yields in maps:
        for (iid, cls), v in yields.items():
            a = avg.setdefault(iid, {})
            a[cls] = a.get(cls, 0) + v * w / total_w

    out = ["//===== Ragnarok Offline: prontera-vendors =================================",
           "//= The hunted supply's data, for npc/prontera-vendors-supply.txt.",
           "//= GENERATED by registry/tools/prontera-vendors/build_vendors.py",
           "//= (write_supply_script); a re-run overwrites it.",
           "//===========================================================================",
           "-\tscript\tProntVendorsSupplyData\t-1,{",
           "\tend;",
           "OnInit:",
           "\t$@pvs_ready = 0;",
           f"\t$@pvs_party_kills = {SUPPLY_PARTY_KILLS};",
           "\t// rAthena's drop-rate settings, in the order each yield's class counts them.",
           "\tdeletearray $@pvs_rateflag$;",
           "\tsetarray $@pvs_rateflag$[0], " + ", ".join(q("item_rate_" + c) for c in RATE_CLASSES) + ";",
           "\t// The items the supply limits: id, half-life class (% of the setting),",
           "\t// cap, and the long-run yield per party-hour (millionths, by rate class).",
           "\tdeletearray $@pvs_gid; deletearray $@pvs_ghl; deletearray $@pvs_gcap; deletearray $@pvs_gk;",
           "\tdeletearray $@pvs_aitem; deletearray $@pvs_acls; deletearray $@pvs_arate;"]
    gids = sorted(gated)
    for k in range(0, len(gids), 16):
        out.append(f"\tsetarray $@pvs_gid[{k}], " + ", ".join(map(str, gids[k:k + 16])) + ";")
    hl, caps = [], []
    for i in gids:
        e = ITEMS_BY_ID[i]
        used = ((e.get("Type") or "").lower() in SUPPLY_USED_TYPES
                or e["AegisName"] in UPGRADE | CRAFTING | ELEMENTAL | HERBS | ALCHEMY)
        hl.append(SUPPLY_HL_RARE if e.get("Type") == "Card" or i in MVP_ONLY
                  else SUPPLY_HL_EQUIP if is_equip(e)
                  else SUPPLY_HL_USED if used else SUPPLY_HL_LOOT)
        caps.append(max(SUPPLY_CAP_MIN, SUPPLY_CAP_TIMES * SELL_PLAIN[i]))
    for k in range(0, len(gids), 16):
        out.append(f"\tsetarray $@pvs_ghl[{k}], " + ", ".join(map(str, hl[k:k + 16])) + ";")
    for k in range(0, len(gids), 16):
        out.append(f"\tsetarray $@pvs_gcap[{k}], " + ", ".join(map(str, caps[k:k + 16])) + ";")
    for k in range(0, len(gids), 8):
        out.append("\t" + " ".join(f"$@pvs_gk[{i}] = {k + j + 1};" for j, i in enumerate(gids[k:k + 8])))
    flat = [(i, cls, round(v)) for i in gids for cls, v in sorted(avg.get(i, {}).items()) if round(v) > 0]
    for name, col in (("aitem", 0), ("acls", 1), ("arate", 2)):
        for k in range(0, len(flat), 16):
            out.append(f"\tsetarray $@pvs_{name}[{k}], " + ", ".join(str(r[col]) for r in flat[k:k + 16]) + ";")
    out.append(f"\t$@pvs_gcount = {len(gids)}; $@pvs_acount = {len(flat)};")

    out += ["\t// Maps: name, monster level, kills an hour its spawns allow, weight, and",
            "\t// where its yields start and how many (item, rate class, millionths of",
            "\t// one per party-hour at $@pvs_party_kills kills).",
            "\tdeletearray $@pvs_map$; deletearray $@pvs_mlv; deletearray $@pvs_mcap; deletearray $@pvs_mw;",
            "\tdeletearray $@pvs_mstart; deletearray $@pvs_mlen; deletearray $@pvs_yitem; deletearray $@pvs_ycls; deletearray $@pvs_yrate;"]
    flat = []
    for m_i, (mp, lv, cap, w, yields) in enumerate(maps):
        out.append(f'\t$@pvs_map$[{m_i}] = "{mp}"; $@pvs_mlv[{m_i}] = {lv}; $@pvs_mcap[{m_i}] = {cap}; '
                   f"$@pvs_mw[{m_i}] = {w}; $@pvs_mstart[{m_i}] = {len(flat)}; $@pvs_mlen[{m_i}] = {len(yields)};")
        flat += [(i, cls, v) for (i, cls), v in sorted(yields.items())]
    for name, col in (("yitem", 0), ("ycls", 1), ("yrate", 2)):
        for k in range(0, len(flat), 16):
            out.append(f"\tsetarray $@pvs_{name}[{k}], " + ", ".join(str(r[col]) for r in flat[k:k + 16]) + ";")
    out.append(f"\t$@pvs_mcount = {len(maps)};")

    out += ["\t// MvPs: monster, level, how many spawn, respawn (s), a map, and their drops",
            "\t// the supply limits (item, rate class, chance in 10000).",
            "\tdeletearray $@pvs_mvp; deletearray $@pvs_mvplv; deletearray $@pvs_mvpn; deletearray $@pvs_mvpre;",
            "\tdeletearray $@pvs_mvpmap$; deletearray $@pvs_mvpstart; deletearray $@pvs_mvplen;",
            "\tdeletearray $@pvs_vitem; deletearray $@pvs_vcls; deletearray $@pvs_vrate;"]
    flat = []
    for v_i, mid in enumerate(sorted(mvps)):
        m, mv = MOBS[mid], mvps[mid]
        drops = []
        for d, reward in [(d, False) for d in m.get("Drops") or []] + [(d, True) for d in m.get("MvpDrops") or []]:
            e = item(d["Item"])
            if e and e["Id"] in gated and d.get("Rate", 0) > 0:
                drops.append((e["Id"], rate_class(e, m, reward), d["Rate"]))
        out.append(f"\t$@pvs_mvp[{v_i}] = {mid}; $@pvs_mvplv[{v_i}] = {m.get('Level', 1)}; "
                   f"$@pvs_mvpn[{v_i}] = {mv['copies']}; $@pvs_mvpre[{v_i}] = {max(60, round(mv['respawn']))}; "
                   f'$@pvs_mvpmap$[{v_i}] = "{sorted(mv["maps"])[0]}"; $@pvs_mvpstart[{v_i}] = {len(flat)}; '
                   f"$@pvs_mvplen[{v_i}] = {len(drops)}; // {m['Name']}")
        flat += drops
    for name, col in (("vitem", 0), ("vcls", 1), ("vrate", 2)):
        for k in range(0, len(flat), 16):
            out.append(f"\tsetarray $@pvs_{name}[{k}], " + ", ".join(str(r[col]) for r in flat[k:k + 16]) + ";")
    out += [f"\t$@pvs_mvpcount = {len(mvps)};",
            "\t// Filled: the supply script can start (before the first stalls open).",
            "\t$@pvs_ready = 1;",
            '\tif (getnpcid(0, "ProntVendorsSupply"))',
            '\t\tdonpcevent "ProntVendorsSupply::OnDataReady";',
            "\tend;", "}"]
    npc = os.path.join(os.path.dirname(OUT_DB), "npc")
    os.makedirs(npc, exist_ok=True)
    open(os.path.join(npc, "prontera-vendors-supply-data.txt"), "w", encoding="utf-8", newline="\n").write(
        "\n".join(out) + "\n")
    print(f"  supply: {len(gids)} items limited, {len(maps)} maps, {len(mvps)} MvPs", file=sys.stderr)
    return maps, avg, gids


def write_table():
    import csv
    priced = sorted(popularity(ITEMS_BY_ID[i]) for i, (lo, _, _) in TABLE.items() if lo)
    busy_cut = priced[int(len(priced) * 0.9)] if priced else 0
    os.makedirs(os.path.dirname(TABLE_CSV), exist_ok=True)
    with open(TABLE_CSV, "w", encoding="utf-8", newline="") as f:
        f.write("# prontera-vendors price table: what each item sells for, as a range each\n"
                "# stall rolls inside. Edit freely; the server reads it at startup, and\n"
                "# registry/tools/prontera-vendors/build_vendors.py keeps existing rows; Id decides.\n"
                "# 0,0 = no price yet: fill one in and re-run the generator, and the item\n"
                "# can then show up in the themes it fits.\n"
                "# Source: kro (RagMAYA, kRO vending), ragnastats (iRO, converted),\n"
                "# npc (from the NPC price), sibling (a same-named item's price),\n"
                "# estimate (a model's guess from drops, levels and stats: a ballpark,\n"
                "# worth checking), manual (changed by hand; kept on re-runs),\n"
                "# set (fixed in build_vendors.py's PRICE_SET; wins over this file).\n"
                "# Refined, forged and carded lines are priced in population_vendors.yml.\n"
                "# BuyersPerDay / SellersPerDay: how many customers a day, at a fair\n"
                "# price, buy the item from a player's stall / sell it into a player's\n"
                "# buying store (the mod's customer settings). Whole numbers; the generator\n"
                "# rewrites them from its rules on every run, so tune those, or the pace\n"
                "# settings, rather than these columns.\n")
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["Id", "Name", "Min", "Max", "Source", "BuyersPerDay", "SellersPerDay"])
        gen = {}
        for iid, (lo, hi, src) in sorted(TABLE.items(), key=lambda kv: (ITEMS_BY_ID[kv[0]]["Name"].lower(), kv[0])):
            w.writerow([iid, ITEMS_BY_ID[iid]["Name"], lo, hi, src, *demand(ITEMS_BY_ID[iid], lo, hi, busy_cut)])
            gen[str(iid)] = [lo, hi]
    json.dump(gen, open(GENERATED_PATH, "w"), separators=(",", ":"), sort_keys=True)


TABLE = {}
# What the generator wrote last time, to tell hand edits from data changes.
GENERATED_PATH = os.path.join(HERE, "table_generated.json" if ERA == "re" else "table_generated_pre-re.json")
try:
    GENERATED = json.load(open(GENERATED_PATH))
except FileNotFoundError:
    GENERATED = {}


def main():
    # --reprice starts the table over from market data (hand edits are lost).
    if "--reprice" not in sys.argv:
        TABLE.update(read_table())
    if "--all-prices" in sys.argv:
        prefetch(THEMES, everything=True)
    elif "--refresh-prices" in sys.argv:
        prefetch(THEMES)
    refresh = False
    calibrate()
    train_fallbacks()
    fill_table()
    add_carded()
    rng = random.Random(1)
    vendors, profiles, market = [], [], []
    buy_market = []
    for t in THEMES + BUY_THEMES:
        lines = resolve(t, refresh, rng)
        if not lines:
            print(f"  {t['key']}: nothing to sell, skipped", file=sys.stderr)
            continue
        buying = t.get("buy", False)
        key = (BUY_PREFIX if buying else PREFIX) + t["key"]
        # Generic signs that fit the stall: never a "SALE" over a buyer.
        generic = [x for x in (BUY_TITLES if buying else SELL_TITLES) + GENERIC_TITLES if x not in t["titles"]]
        titles = list(t["titles"]) + random.Random(t["key"]).sample(generic, t.get("generic", 3))
        if not buying and t["key"] in CHEEKY_SELL_THEMES:
            titles += random.Random(t["key"] + "#cheeky").sample(SELL_CHEEKY, 3)
        # Signs that name items go to StockTitles, with what they need; one whose
        # items this pool lacks is dropped. Every stall also gets two {item} signs.
        have = {e["AegisName"] for e, _, _ in lines}
        needs_of = {**TITLE_NEEDS, **t.get("needs", {})}
        plain, stock_titles = [], []
        for x in titles:
            if x not in needs_of:
                plain.append(x)
                continue
            need_all, need_any = needs_of[x]
            need_any = [n for n in need_any if n in have]
            if all(n in have for n in need_all) and (need_any or not needs_of[x][1]):
                stock_titles.append((x, need_all, need_any))
        for x in random.Random(t["key"] + "#stock").sample(BUY_STOCK_SIGNS if buying else SELL_STOCK_SIGNS, 2):
            stock_titles.append((x, [], []))
        out = [f"  - VendorKey: {key}", "    Type: Pool", f"    Title: {q(plain[0])}", "    TitleFromPool:"]
        out += [f"      - {q(x)}" for x in plain]
        out.append("    StockTitles:")
        for x, need_all, need_any in stock_titles:
            d = {"Title": q(x)}
            if need_all:
                d["Needs"] = need_all
            if need_any:
                d["Any"] = sorted(set(need_any))
            out.append(f"      - {flow(d)}")
        lo, hi = t["pick"]
        max_slots = min(12, max(hi, 1))
        if buying:
            out += ["    Buying: true", f"    PickCount: [{lo}, {min(hi, 5)}]", "    MaxSlots: 5",
                    "    RotationHours: 4", "    RotationJitterMinutes: 30",
                    "    Callouts: { EverySeconds: [90, 270], MapGapSeconds: 6 }",
                    "    Pool:"]
        else:
            out += [f"    PickCount: [{lo}, {hi}]", f"    MaxSlots: {max_slots}",
                    "    RotationHours: 4", "    RotationJitterMinutes: 30",
                    "    PriceMistakeOneIn: 5000",
                    "    Undercut: { Chance: 50, StepPct: [1, 5] }",
                    "    Callouts: { EverySeconds: [90, 270], MapGapSeconds: 6 }",
                    "    Pool:"]
        for e, spec, p in lines:
            MARKET_ITEMS.add(e["Id"])
            if buying:
                BUY_WANTED.add(e["Id"])
                lo_p = TABLE.get(e["Id"], (0, 0, ""))[0] or band(p)[0]
                pay_lo, pay_hi = t.get("pay", PAY_OTHER)
                d = {"Item": e["AegisName"], "Amount": buy_amount(p, rng),
                     "Price": [tidy(max(1, int(lo_p * pay_lo))), tidy(max(1, int(lo_p * pay_hi)))]}
                out.append(f"      - {flow(d)}")
                continue
            d = {"Item": e["AegisName"], "Amount": amount_for(e, p, rng)}
            plain = not (spec.get("refine") or spec.get("element") or spec.get("stars") or spec.get("cards"))
            if plain:
                SELL_PLAIN[e["Id"]] = max(SELL_PLAIN.get(e["Id"], 0), d["Amount"])
            if plain and TABLE.get(e["Id"], (0, 0, ""))[0] > 0:
                d["Price"] = list(TABLE[e["Id"]][:2])
            else:
                d["Price"] = list(band(p))
            if spec.get("refine"):
                d["Refine"] = spec["refine"]
            if spec.get("element"):
                d["Element"] = spec["element"]
            if spec.get("stars"):
                d["Stars"] = spec["stars"]
            if spec.get("cards"):
                d["Cards"] = spec["cards"]
            out.append(f"      - {flow(d)}")
        vendors.append("\n".join(out))
        (buy_market if buying else market).append(key)
        profiles.append("\n".join([
            f"  - Profile: {key}_vendor",
            "    PlacementBound: true",
            "    Jobs:",
            f"      {t['job']}: {BUY_JOBS.get(t['job'], 'para_merchant') if buying else 'para_merchant'}",
            "    NameProfile: default",
            "    Hair: [0, 42]",
            "    HairColor: [0, 131]",
            "    ClothesColor: [0, 699]",
            "    Flags:",
            "      - mortal",
            "    TownBehavior: vendor",
            f"    VendorKey: {key}",
            "    Script: |",
            "      setcart;",
        ]))
        print(f"  {t['key']}: {len(lines)} items", file=sys.stderr)
    write_table()
    write_market_script()
    write_supply_script()

    # The market: every sidewalk spot rolls one of the themes whenever a stall
    # is put there, so the street changes as stalls rotate. Its Count is what
    # the "Sell stalls" setting replaces.
    m = [f"  - Market: {MARKET}", "    Spawns:", "      - Map: prontera", f"        Count: {STALLS}",
         "        Fill: Lanes", f"        LaneFillPct: {LANE_FILL}", "        Areas:"]
    m += [f"          - {flow(a)}" for a in AREAS]
    m.append("    Themes:")
    for key in market:
        short = key[len(PREFIX):]
        if short in STAPLES:
            w = {"Theme": key, "Weight": 3, "Min": 1, "Max": 2}
        elif short.startswith("cards_"):
            w = {"Theme": key, "Weight": 2, "Max": 1}
        else:
            w = {"Theme": key, "Weight": 1, "Max": 1}
        m.append(f"      - {flow(w)}")
    vendors.insert(0, "\n".join(m))

    # The buy market: the same, on its own sidewalks, replaced by "Buy stalls".
    if buy_market:
        bm = [f"  - Market: {BUY_MARKET}", "    Spawns:", "      - Map: prontera", f"        Count: {STALLS}",
              "        Fill: Lanes", f"        LaneFillPct: {LANE_FILL}", "        Areas:"]
        bm += [f"          - {flow(a)}" for a in BUY_AREAS]
        bm.append("    Themes:")
        spec = {BUY_PREFIX + t["key"]: t for t in BUY_THEMES}
        for key in buy_market:
            t = spec.get(key, {})
            w = {"Theme": key, "Weight": t.get("weight", 1)}
            if t.get("min"):
                w["Min"] = t["min"]
            w["Max"] = t.get("max", 3)
            bm.append(f"      - {flow(w)}")
        vendors.insert(1, "\n".join(bm))
        room = sum(t.get("max", 3) for t in BUY_THEMES if BUY_PREFIX + t["key"] in buy_market)
        if room < STALLS_MAX:
            print(f"  WARNING: buy themes allow only {room} stalls at once, below the {STALLS_MAX} the setting allows",
                  file=sys.stderr)
        loc = sum(t["weight"] for t in BUY_THEMES if t.get("location") and BUY_PREFIX + t["key"] in buy_market)
        allw = sum(t["weight"] for t in BUY_THEMES if BUY_PREFIX + t["key"] in buy_market)
        print(f"  buy market: {len(buy_market)} themes, room for {room}; places carry {loc}/{allw} of the weight",
              file=sys.stderr)

    head = (
        "###########################################################################\n"
        "# prontera-vendors — {what}\n"
        "# GENERATED by registry/tools/prontera-vendors/build_vendors.py from rAthena's item, monster and\n"
        "# spawn databases and iRO market prices. Edit by hand if you like, but a\n"
        "# re-run overwrites this file; lasting changes belong in the script.\n"
        "###########################################################################\n"
    )
    vend_doc = head.format(what="vendor definitions") + (
        "#\n"
        "# One Pool vendor per theme. Each stall draws PickCount items from its Pool\n"
        "# with prices rolled inside each item's [min, max] (sometimes just under the\n"
        "# cheapest rival stall, never below the NPC sell price), and on a rare\n"
        "# 1-in-5000 per item lists one with a digit missing.\n"
        "#\n"
        "# The first entry is the market: its spots on both Prontera sidewalks, and\n"
        "# the themes a spot may roll (Weight, Min, Max) each time a stall is put\n"
        "# there. Its Count is replaced by the mod's \"Sell stalls\" setting; rotation\n"
        "# and callouts come from the settings too, and the values here are what\n"
        "# applies without them. The themes after it sell; they have no Spawns.\n"
        "###########################################################################\n\n"
        "Header:\n  Type: POPULATION_VENDORS_DB\n  Version: 1\n\nBody:\n"
    )
    pop_doc = head.format(what="vendor shell profiles") + (
        "#\n"
        "# One PlacementBound profile per theme: the engine finds it by VendorKey, not\n"
        "# by job, so the job is only the sprite (a job that can vend on a real\n"
        "# server) and it never displaces the engine's own vendors.\n"
        "###########################################################################\n\n"
        "Header:\n  Type: POPULATION_ENGINE_DB\n  Version: 2\n\nBody:\n"
    )
    os.makedirs(OUT_DB, exist_ok=True)
    open(os.path.join(OUT_DB, "population_vendors.yml"), "w", encoding="utf-8", newline="\n").write(
        vend_doc + "\n\n".join(vendors) + "\n")
    open(os.path.join(OUT_DB, "population_vendor_pop.yml"), "w", encoding="utf-8", newline="\n").write(
        pop_doc + "\n\n".join(profiles) + "\n")


if __name__ == "__main__":
    main()
