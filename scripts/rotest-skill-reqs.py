#!/usr/bin/env python3
"""Skill requirements for scripts/rotest-skill-sweep.cjs, from the pinned rAthena.

For every skill id >= 2000 (3rd and 4th jobs): the weapon types and ammo it
requires, the items it consumes, and the state it needs (Ridingdragon, Mado,
Cart, Shield, ...), read from db/re/skill_db.yml. For every weapon and ammo type, one item of that type
(the lowest id) from db/re/item_db_equip.yml and item_db_etc.yml, for the sweep
to hand the character before casting.

    python3 scripts/rotest-skill-reqs.py [vendor/rathena] > artifacts/sweep/skill-reqs.json
    REQS_MIN_ID=0 python3 ...   # every skill, not only 3rd/4th-job ids (>= 2000)

The files are regular enough to read line by line, which keeps this free of a
YAML dependency.
"""
import json
import os
import re
import sys
from pathlib import Path

db = Path(sys.argv[1] if len(sys.argv) > 1 else 'vendor/rathena') / 'db/re'

skills = {}
cur = section = None
for line in open(db / 'skill_db.yml', encoding='utf-8'):
    m = re.match(r'^  - Id: (\d+)', line)
    if m:
        cur = {'weapons': [], 'ammo': [], 'state': None, 'name': None, 'items': []}
        skills[int(m.group(1))] = cur
        section = None
        continue
    if cur is None:
        continue
    m = re.match(r'^    Name: (\S+)', line)
    if m:
        cur['name'] = m.group(1)
        continue
    if re.match(r'^    \S', line):
        section = 'requires' if line.strip() == 'Requires:' else None
        continue
    if section is None:
        continue
    m = re.match(r'^      (\w+):\s*(.*)$', line)
    if m:
        key, value = m.groups()
        if key == 'State':
            cur['state'] = value
        section = ('requires', key if value == '' else None)
        continue
    m = re.match(r'^        - Item: (\S+)', line)
    if m and isinstance(section, tuple) and section[1] == 'ItemCost':
        if m.group(1) not in cur['items']:
            cur['items'].append(m.group(1))
        continue
    m = re.match(r'^        (\w+): true', line)
    if m and isinstance(section, tuple):
        if section[1] == 'Weapon':
            cur['weapons'].append(m.group(1))
        elif section[1] == 'Ammo':
            cur['ammo'].append(m.group(1))


def first_of_each(name, kind):
    """Lowest item id of each SubType among items of Type `kind`."""
    best, cur = {}, {}

    def flush():
        if cur.get('Type') == kind and cur.get('SubType') and cur['SubType'] not in best:
            best[cur['SubType']] = cur['Id']

    for line in open(db / name, encoding='utf-8'):
        m = re.match(r'^  - Id: (\d+)', line)
        if m:
            flush()
            cur = {'Id': int(m.group(1))}
            continue
        m = re.match(r'^    (Type|SubType): (\S+)', line)
        if m:
            cur[m.group(1)] = m.group(2)
    flush()
    return best


json.dump({
    'skills': {k: v for k, v in skills.items() if k >= int(os.environ.get('REQS_MIN_ID', 2000))},
    'weaponItem': first_of_each('item_db_equip.yml', 'Weapon'),
    'ammoItem': first_of_each('item_db_etc.yml', 'Ammo'),
}, sys.stdout, indent=1)
