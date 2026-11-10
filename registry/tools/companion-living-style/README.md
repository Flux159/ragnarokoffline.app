# Companion Living Style catalog tools

These files are maintainer inputs and do not ship inside the installed mod.

- `observed-outfits.json`: anonymized export supplied by the author, November 10, 2026. Only four integer View fields per outfit.
- `costume-reference.json`: matching rAthena costume definitions (GPL-3.0-or-later), limited to observed views with entries in app 1.8.3 bundled HatTable/RobeTable. This is a conservative allowlist, not a complete client asset scan.
- `living-style.template.txt`: runtime source template with a single generated catalog marker.
- `build.cjs`: validates and deduplicates complete tuples, emits runtime arrays and the installed catalog. Rejects malformed or extra outfit fields. Unknown occupied slots exclude the entire combination.
- `check.cjs`: catalog provenance, strict input validation, generated output, actual registration-block replay and settings-bridge checks.
- `check-refresh.cjs`: unchanged client timing/cancellation and bounded server-scan regressions.

Run from any directory:
```
node registry/tools/companion-living-style/build.cjs
node registry/tools/companion-living-style/check.cjs
node registry/tools/companion-living-style/check-refresh.cjs
python3 scripts/mod-index.py
python3 scripts/mod-index.py --check
```

The v1.7.0 catalog (unchanged in v1.7.1) deliberately retains only 431 of 1,487 collected combinations. A missing bundled table entry is not proof that the user's GRFs lack it; expand the allowlist only after verifying mappings and sprites. Preserve zero slots and the observed tuple. Do not replace missing pieces with guesses.

For future releases, update the versioned output paths and test counts deliberately. Record collection date/counts and validation limits. Never publish raw authenticated HTML or session data. No network access occurs in the generator or installed mod.
