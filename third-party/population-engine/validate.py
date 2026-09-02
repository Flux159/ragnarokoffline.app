#!/usr/bin/env python3
"""Check the population YAML for the two mistakes the server will not report.

population_config.cpp keys the job database by job id (`this->put(job_id, ...)`),
so a job belongs to exactly one profile and the last block parsed silently wins.
A profile that loses all of its jobs is then skipped by fill_category without a
word: the maps it owns simply stay empty. That is invisible in the server log,
which is how it shipped once already.

The second check is slots: a gear item in the wrong slot is rejected at load,
and the shell spawns wearing nothing.

    python3 third-party/population-engine/validate.py [path-to-rathena]
"""
import re, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = os.path.join(ROOT, 'population-engine', 'files', 'db')
RA = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), 'vendor', 'rathena')

fail = 0

# --- one job, one profile --------------------------------------------------
prof_src = open(os.path.join(FILES, 'population_engine.yml')).read()
claims, owner = {}, {}
for blk in re.split(r'^  - Profile: ', prof_src, flags=re.M)[1:]:
    prof = blk.split()[0]
    m = re.search(r'^(\s*)Jobs:\s*\n((?:\1\s+\w+\s*:\s*\S+\n)+)', blk, re.M)
    if not m:
        continue
    for job in re.findall(r'^\s+(\w+)\s*:', m.group(2), re.M):
        claims.setdefault(job, []).append(prof)
        owner[job] = prof

for job, profs in claims.items():
    if len(profs) > 1:
        print(f"FAIL job {job} is claimed by {profs}; only {owner[job]} keeps it")
        fail += 1

live = set(owner.values())
for prof in re.findall(r'^  - Profile: (\S+)', prof_src, re.M):
    if prof not in live:
        print(f"FAIL profile {prof} ends up with no jobs, so every map it owns stays empty")
        fail += 1

# --- every spawn entry names a profile that exists and has jobs ------------
spawn = open(os.path.join(FILES, 'population_spawn.yml')).read()
for prof in re.findall(r'^  - Profile: (\S+)', spawn, re.M):
    if prof not in live:
        print(f"FAIL spawn table references {prof}, which has no jobs")
        fail += 1

# --- gear sits in a slot the item can actually occupy ----------------------
db = os.path.join(RA, 'db', 're', 'item_db_equip.yml')
if os.path.exists(db):
    loc = {}
    for m in re.finditer(r'AegisName:\s*(\S+)\s*\n(.*?)(?=\n  - Id:|\Z)',
                         open(db, encoding='utf-8', errors='replace').read(), re.S):
        loc[m.group(1).strip()] = set(re.findall(r'^\s+(\w+):\s*true\s*$', m.group(2), re.M))
    SLOT = {'HeadTop': {'Head_Top'}, 'HeadMid': {'Head_Mid'}, 'HeadBottom': {'Head_Low'},
            'Armor': {'Armor'}, 'Weapon': {'Right_Hand', 'Both_Hand', 'Left_Hand'},
            'Shield': {'Left_Hand'}, 'Garment': {'Garment'}, 'Shoes': {'Shoes'},
            'AccL': {'Left_Accessory', 'Both_Accessory'},
            'AccR': {'Right_Accessory', 'Both_Accessory'}}
    gs = open(os.path.join(FILES, 'population_gear_sets.yml')).read()
    for blk in re.split(r'^  - GearSetName: ', gs, flags=re.M)[1:]:
        name = blk.split()[0]
        for slot, allowed in SLOT.items():
            m = re.search(rf'^    {slot}:\s*\n((?:\s+-\s+\S+\n)+)', blk, re.M)
            if not m:
                continue
            for item in re.findall(r'-\s+(\S+)', m.group(1)):
                if item.isdigit():
                    continue
                if item not in loc:
                    print(f"FAIL {name}/{slot}: {item} is not in the item database")
                    fail += 1
                elif not (loc[item] & allowed):
                    upstream = item.startswith('C_')  # costume items, upstream's
                    print(f"{'warn' if upstream else 'FAIL'} {name}/{slot}: "
                          f"{item} is {sorted(loc[item])}")
                    fail += 0 if upstream else 1
else:
    print(f"note: no item database at {db}, skipping the gear slot check")

# --- vendor placements are shaped the way the parser expects ---------------
vend = open(os.path.join(FILES, 'population_vendors.yml')).read()
areas = re.findall(r'^\s+Area:\s*\n((?:\s+[A-Za-z0-9]+\s*:\s*-?\d+\s*\n)+)', vend, re.M)
for body in areas:
    keys = re.findall(r'^\s+([A-Za-z0-9]+)\s*:', body, re.M)
    if sorted(keys) != ['X1', 'X2', 'Y1', 'Y2']:
        print(f"FAIL vendor Area block has keys {keys}, expected X1/Y1/X2/Y2")
        fail += 1
# Count real keys, not the word: the file's comment header mentions Area: too.
real = len(re.findall(r'^\s+Area:\s*$', vend, re.M))
if real != len(areas):
    print(f"FAIL {real - len(areas)} vendor Area block(s) are malformed")
    fail += 1

print("population data OK" if not fail else f"{fail} problem(s)")
sys.exit(1 if fail else 0)
