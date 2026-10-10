#!/usr/bin/env python3
"""Check the bounded Lua snapshot against stock Renewal data (stdlib only).

Run after scripts/vendor-fetch.sh rathena vendor/rathena. This entry point
always requires the configured pin and never skips, including outside CI.
The readers deliberately accept only the snapshot's simple data shapes;
new syntax or reward properties require an explicit review, not omission.
"""
from collections import Counter
from pathlib import Path
import re
import subprocess
import unittest

APP = Path(__file__).resolve().parents[2]
SUPPLEMENT = APP / 'client-assets/data/luafiles514/lua files/selectpackage/selectpackageitem_supplement.lua'
BOXES = {101454: 'Metal_W_Box', 101458: 'Booster_Hat_Box', 101459: 'Booster_Back_Box'}
FIELDS = ('box', 'group', 'reward', 'amount', 'rental hours', 'refine')


def lua_rows(text):
    text = re.sub(r'--[^\n]*', '', text)
    match = re.fullmatch(r'\s*packageitemsetbox\s*=\s*\{(.*)\}\s*', text, re.S)
    if not match:
        raise ValueError('supplement: expected a literal packageitemsetbox table')
    body = match[1]
    rows = []
    while body.strip():
        match = re.match(r'\s*\{\s*(\d+(?:\s*,\s*\d+){5})\s*\}\s*(,|$)', body)
        if not match:
            raise ValueError(f'supplement: expected six integer columns near {body[:100]!r}')
        rows.append(tuple(map(int, match[1].split(','))))
        body = body[match.end():]
    if not rows:
        raise ValueError('supplement: empty table')
    return rows


def item_names(texts):
    names = {}
    for text in texts:
        # Only top-level item records, never Id/AegisName inside a script.
        for block in re.split(r'^  - Id: ', text, flags=re.M)[1:]:
            item_id = int(block.splitlines()[0].split('#', 1)[0])
            match = re.search(r'^    AegisName: ([^\n]+)$', block, re.M)
            if not match:
                raise ValueError(f'item {item_id}: missing/unsupported AegisName')
            name = match[1].strip().strip('\"')
            if name in names:
                raise ValueError(f'duplicate AegisName {name}')
            names[name] = item_id
    return names


def server_rows(text, names):
    rows, seen = [], set()
    selected = set(BOXES.values())
    for block in re.split(r'^  - Item: ', text, flags=re.M)[1:]:
        lines = block.splitlines()
        name = lines.pop(0).strip()
        if name not in selected:
            continue
        if name in seen:
            raise ValueError(f'{name}: duplicate package definition')
        seen.add(name)
        box = names[name]  # Server identity, not a copied numeric reward map.
        group, reward, properties, groups = None, None, {}, set()

        def finish():
            if reward is not None:
                rows.append((box, group, names[reward], properties.get('Amount', 1),
                             properties.get('RentalHours', 0), properties.get('Refine', 0)))

        for line in lines:
            line = line.split('#', 1)[0].rstrip()
            if not line.strip():
                continue
            if line in ('    Groups:', '        Items:'):
                continue
            match = re.fullmatch(r'      - Group: (\d+)', line)
            if match:
                finish()
                group, reward, properties = int(match[1]), None, {}
                if group in groups:
                    raise ValueError(f'{name}: duplicate group {group}')
                groups.add(group)
                continue
            match = re.fullmatch(r'          - Item: ([A-Za-z0-9_]+)', line)
            if match and group is not None:
                finish()
                reward, properties = match[1], {}
                continue
            match = re.fullmatch(r'            (Amount|RentalHours|Refine): (\d+)', line)
            if match and reward is not None and match[1] not in properties:
                properties[match[1]] = int(match[2])
                continue
            raise ValueError(f'{name}, group {group}: unsupported/duplicate field {line!r}; review snapshot')
        finish()
        if not groups or any(not any(row[:2] == (box, g) for row in rows) for g in groups):
            raise ValueError(f'{name}: missing or empty reward group')
    if seen != selected:
        raise ValueError(f'item_packages.yml: missing packages {sorted(selected - seen)}')
    return rows


def compare(actual, expected):
    if set(row[0] for row in actual) != set(BOXES):
        raise ValueError(f'supplement box IDs: expected {sorted(BOXES)}, got {sorted(set(row[0] for row in actual))}')
    missing = Counter(expected) - Counter(actual)
    extra = Counter(actual) - Counter(expected)
    if missing or extra:
        def describe(rows):
            return '\n'.join(f'  {dict(zip(FIELDS, row))} (x{count})' for row, count in sorted(rows.items())) or '  none'
        raise ValueError('selection-package snapshot drift; review selectpackageitem_supplement.lua '
                         'against pinned db/re/item_packages.yml and item_db_*.yml\n'
                         f'missing server rewards:\n{describe(missing)}\nunexpected Lua rewards:\n{describe(extra)}')


class SelectionPackages(unittest.TestCase):
    def test_supplement_matches_the_pinned_server(self):
        rathena = APP / 'vendor/rathena'
        pins = [line.split()[2] for line in (APP / 'config/VENDOR_PINS').read_text().splitlines()
                if line.split() and line.split()[0] == 'rathena']
        self.assertEqual(len(pins), 1, 'config/VENDOR_PINS must contain exactly one rathena pin')
        head = subprocess.run(['git', '-C', str(rathena), 'rev-parse', 'HEAD'],
                              capture_output=True, text=True)
        self.assertTrue(head.returncode == 0 and head.stdout.strip() == pins[0],
                        f'vendor/rathena must be at {pins[0]}, got {head.stdout.strip() or head.stderr.strip()}; '
                        'run bash scripts/vendor-fetch.sh rathena vendor/rathena')
        names = item_names((rathena / f'db/re/item_db_{kind}.yml').read_text()
                           for kind in ('equip', 'usable', 'etc'))
        expected = server_rows((rathena / 'db/re/item_packages.yml').read_text(), names)
        compare(lua_rows(SUPPLEMENT.read_text()), expected)

    def test_every_column_and_row_multiplicity_detect_drift(self):
        # Mutate real snapshot rows: each required column must affect the check.
        rows = lua_rows(SUPPLEMENT.read_text())
        for column, field in enumerate(FIELDS):
            with self.subTest(field=field):
                changed = list(rows[0])
                changed[column] += 1
                with self.assertRaises(ValueError):
                    compare([tuple(changed)] + rows[1:], rows)
        for changed in (rows[1:], rows + [rows[0]]):
            with self.assertRaises(ValueError):
                compare(changed, rows)

    def test_symbolic_names_defaults_and_explicit_properties(self):
        names = item_names(['  - Id: 501\n    AegisName: Reward\n' + ''.join(
            f'  - Id: {box}\n    AegisName: {name}\n' for box, name in BOXES.items())])
        packages = ''.join(f'''  - Item: {name}
    Groups:
      - Group: 4
        Items:
          - Item: Reward
      - Group: 9
        Items:
          - Item: Reward
            Amount: 3
            RentalHours: 24
            Refine: 7
''' for name in BOXES.values())
        expected = [row for box in BOXES for row in
                    ((box, 4, 501, 1, 0, 0), (box, 9, 501, 3, 24, 7))]
        self.assertEqual(server_rows(packages, names), expected)
        for before, after in (('RentalHours: 24', 'RentalHours: 25'),
                              ('Amount: 3', 'Amount: 4'), ('Refine: 7', 'Refine: 8'),
                              ('Group: 9', 'Group: 10')):
            with self.subTest(change=after), self.assertRaises(ValueError):
                compare(expected, server_rows(packages.replace(before, after), names))
        with self.assertRaisesRegex(ValueError, 'unsupported/duplicate field'):
            server_rows(packages.replace('Refine: 7', 'Grade: D'), names)
        with self.assertRaisesRegex(ValueError, 'duplicate group'):
            server_rows(packages.replace('Group: 9', 'Group: 4'), names)
        with self.assertRaisesRegex(ValueError, 'missing packages'):
            server_rows(packages.replace('Metal_W_Box', 'Other_Box'), names)


if __name__ == '__main__':
    unittest.main()
