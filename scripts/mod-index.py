#!/usr/bin/env python3
"""Rebuild registry/index.json from the mod folders beside it.

The index is generated, never hand-written: every entry's digests have to be
the bytes actually in the repository, or the app refuses the download and
nobody can tell whether the mod or the index is wrong.

    python3 scripts/mod-index.py [--check]

`--check` rebuilds into memory and fails if the committed index differs, which
is what CI runs so a mod cannot be merged without its digests.
"""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "registry"
MODS = REGISTRY / "mods"
# Anything a mod legitimately ships. Deliberately a list rather than a
# denylist: a new kind of file should be a deliberate decision, made here.
ALLOWED = {".json", ".yml", ".yaml", ".txt", ".lua", ".lub", ".js", ".mjs",
           ".css", ".html", ".png", ".bmp", ".jpg", ".gif", ".spr", ".act",
           ".gat", ".gnd", ".rsw", ".rsm", ".wav", ".mp3", ".ttf", ".md"}
# What an icon or a screenshot may be. The app decodes these itself, so the
# list is what it can render rather than what a browser might guess at.
PICTURES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_SCREENSHOTS = 4
TAG = __import__("re").compile(r"^[a-z0-9][a-z0-9-]{0,23}$")


def build():
    mods = []
    for directory in sorted(p for p in MODS.iterdir() if p.is_dir()):
        manifest_path = directory / "mod.json"
        if not manifest_path.is_file():
            raise SystemExit(f"{directory.name}: every mod needs a mod.json")
        manifest = json.loads(manifest_path.read_text())
        files = []
        for path in sorted(p for p in directory.rglob("*") if p.is_file()):
            relative = path.relative_to(directory).as_posix()
            if path.suffix.lower() not in ALLOWED:
                raise SystemExit(f"{directory.name}: {relative} has an extension the index does not carry")
            files.append({"path": relative,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        if not files:
            raise SystemExit(f"{directory.name}: no files")
        carried = {relative["path"] for relative in files}

        def picture(value, field):
            """A picture the mod actually ships, named relative to its folder."""
            if not isinstance(value, str) or not value:
                raise SystemExit(f"{directory.name}: {field} must be a path inside the mod")
            if value not in carried:
                raise SystemExit(f"{directory.name}: {field} names {value}, which the mod does not contain")
            if Path(value).suffix.lower() not in PICTURES:
                raise SystemExit(f"{directory.name}: {field} names {value}, which is not a picture")
            return value

        tags = manifest.get("tags", [])
        if not isinstance(tags, list) or len(tags) > 8:
            raise SystemExit(f"{directory.name}: \"tags\" is a list of up to 8 short labels")
        for tag in tags:
            if not isinstance(tag, str) or not TAG.match(tag):
                raise SystemExit(f"{directory.name}: tag {tag!r} must be lowercase letters, digits and -, up to 24")

        screenshots = manifest.get("screenshots", [])
        if not isinstance(screenshots, list) or len(screenshots) > MAX_SCREENSHOTS:
            raise SystemExit(f"{directory.name}: up to {MAX_SCREENSHOTS} screenshots")

        requires = manifest.get("requires", {})
        requires = requires if isinstance(requires, dict) else {}
        needs = [name for name in requires.get("mods", []) if isinstance(name, str)]

        mods.append({
            "name": directory.name,
            "version": manifest.get("version", ""),
            "author": manifest.get("author", ""),
            "description": manifest.get("description", ""),
            "homepage": manifest.get("homepage", ""),
            "tags": sorted(dict.fromkeys(tags)),
            "icon": picture(manifest["icon"], "icon") if manifest.get("icon") else "",
            "screenshots": [picture(shot, "screenshots") for shot in screenshots],
            "requires": {"mods": needs, "era": requires.get("era", ""), "app": requires.get("app", "")},
            "files": files,
        })
    return {"version": 1, "mods": mods}


def main(argv):
    index = json.dumps(build(), indent=2) + "\n"
    target = REGISTRY / "index.json"
    if "--check" in argv:
        current = target.read_text() if target.exists() else ""
        if current != index:
            raise SystemExit("registry/index.json is out of date; run python3 scripts/mod-index.py")
        print("registry/index.json matches the mod folders")
        return
    target.write_text(index)
    print(f"wrote {target.relative_to(ROOT)} with {len(json.loads(index)['mods'])} mod(s)")


if __name__ == "__main__":
    main(sys.argv[1:])
