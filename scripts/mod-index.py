#!/usr/bin/env python3
"""Rebuild registry/index.json from the mod folders beside it.

The index is generated, never hand-written: every entry's digests have to be
the bytes actually in the repository, or the app refuses the download and
nobody can tell whether the mod or the index is wrong.

    python3 scripts/mod-index.py [--check]

`--check` rebuilds into memory and fails if the committed index differs, which
is what CI runs so a mod cannot be merged without its digests.

A folder whose mod.json has a `source` is an entry for a mod that lives in its
author's GitHub repository; it carries only that mod.json and pictures, and is
checked for shape without contacting GitHub. docs/MOD_REGISTRY.md has both.
"""
import hashlib
import json
import re
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
TAG = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
# A source entry: the mod lives in its author's GitHub repository and the app
# installs its latest release (docs/MOD_REGISTRY.md). The same shapes the app
# accepts in electron/mod-source.js; nothing here talks to GitHub, so this
# check runs offline and CI never depends on somebody else's repository.
REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$")
ASSET = re.compile(r"^[A-Za-z0-9._*?-]{1,100}\.zip$", re.IGNORECASE)


def read_source(name, source):
    """The `source` object of a registry mod.json, checked."""
    if not isinstance(source, dict):
        raise SystemExit(f"{name}: \"source\" must be an object like {{\"github\": \"owner/repo\"}}")
    unknown = set(source) - {"github", "asset"}
    if unknown:
        raise SystemExit(f"{name}: \"source\" has no field called {sorted(unknown)[0]!r} (this index understands \"github\" and \"asset\")")
    github = source.get("github")
    if not isinstance(github, str) or not REPO.match(github):
        raise SystemExit(f"{name}: source.github must be \"owner/repo\", the GitHub repository the releases come from")
    out = {"github": github}
    if "asset" in source:
        asset = source["asset"]
        if not isinstance(asset, str) or not ASSET.match(asset):
            raise SystemExit(f"{name}: source.asset must be a .zip file name, with * or ? for the parts that change, e.g. \"my-mod-*.zip\"")
        out["asset"] = asset
    return out


def build():
    mods = []
    for directory in sorted(p for p in MODS.iterdir() if p.is_dir()):
        manifest_path = directory / "mod.json"
        if not manifest_path.is_file():
            raise SystemExit(f"{directory.name}: every mod needs a mod.json")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        source = read_source(directory.name, manifest["source"]) if "source" in manifest else None
        files = []
        for path in sorted(p for p in directory.rglob("*") if p.is_file()):
            relative = path.relative_to(directory).as_posix()
            if path.suffix.lower() not in ALLOWED:
                raise SystemExit(f"{directory.name}: {relative} has an extension the index does not carry")
            if source and relative != "mod.json" and path.suffix.lower() not in PICTURES:
                raise SystemExit(f"{directory.name}: a source entry carries only its mod.json and pictures; "
                                 f"{relative} belongs in {source['github']}")
            files.append({"path": relative,
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        if not files:
            raise SystemExit(f"{directory.name}: no files")
        if source:
            # The registry's own mod.json is not the mod's, and must not look
            # like one: an app that predates source entries drops an entry
            # with no mod.json in its files rather than installing this one.
            files = [f for f in files if f["path"] != "mod.json"]
            if "version" in manifest:
                raise SystemExit(f"{directory.name}: a source entry has no \"version\"; it comes from each release's own mod.json")
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

        entry = {
            "name": directory.name,
            "version": manifest.get("version", ""),
            "author": manifest.get("author", ""),
            "description": manifest.get("description", ""),
            "homepage": manifest.get("homepage", "") or (f"https://github.com/{source['github']}" if source else ""),
            "tags": sorted(dict.fromkeys(tags)),
            "icon": picture(manifest["icon"], "icon") if manifest.get("icon") else "",
            "screenshots": [picture(shot, "screenshots") for shot in screenshots],
            "requires": {"mods": needs, "era": requires.get("era", ""), "app": requires.get("app", "")},
        }
        if source:
            entry["source"] = source
        entry["files"] = files
        mods.append(entry)
    return {"version": 1, "mods": mods}


def main(argv):
    index = json.dumps(build(), indent=2) + "\n"
    target = REGISTRY / "index.json"
    if "--check" in argv:
        current = target.read_text(encoding="utf-8") if target.exists() else ""
        if current != index:
            raise SystemExit("registry/index.json is out of date; run python3 scripts/mod-index.py")
        print("registry/index.json matches the mod folders")
        return
    target.write_text(index, encoding="utf-8")
    print(f"wrote {target.relative_to(ROOT)} with {len(json.loads(index)['mods'])} mod(s)")


if __name__ == "__main__":
    main(sys.argv[1:])
