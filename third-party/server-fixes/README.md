# Pinned rAthena corrections

These small patches apply to the pinned rAthena sources through
`scripts/apply-server-mods.sh`, in both normal and diagnostic builds. They retain
rAthena's GPL license; changes are marked `RAGNAROKMAC` where applicable.

`0001-language-mask.patch` validates the language index before shifting. The
English index is zero, so the previous operation shifted by -1 before reaching
its English early return. Large indices could also shift out of range or wrap
the 16-bit mask. Valid languages and the enabled-language policy are unchanged.
This was caught during real diagnostic map-server startup, not during logout.

`0002-base-sp-range.patch` clamps calculated base SP before converting the
floating-point result to unsigned. Default coefficients for a Ninja-mapped job
produce -2 at level 10; converting that to `uint32` is undefined. Normal
nonnegative values are unchanged, and overflow saturates at the return type's
maximum. The actual function has a separate UBSan reduction covering both bounds.

`0003-unlearned-skill-level.patch` returns zero for an unlearned skill before the
shared accessor indexes a level table. Native character login asks for SP at
level zero while constructing the skill list; the previous macro read index -1.
Stored and extrapolated learned levels retain their existing behavior.

`0004-weapon-bonus-bounds.patch` sizes both weapon bonus arrays from the existing
weapon enum (moved before the player structure) and checks item-script indices.
The fixed diagnostic image reached a real Pre-Renewal population spawn, where
equipping a Katar read index 16 from the old 16-element array. Later weapon types
also exceeded that array, including the damage bonus used by combat.
`verify-weapon-bounds.py` reproduces the actual declaration/setter/status-read
fault and checks every weapon type plus invalid script indices after patching.

`0005-persist-loot-preferences.patch` keeps `@autoloot`, `@autoloottype` and
`@showexp` across a logout. All three lived only in the session, so every login
began by retyping them, and players were writing login scripts to do it for
them. The values are stored as ordinary per-character variables, which needs no
schema change and no migration, written by the commands that set them so a
crash loses nothing, and read back in `pc_reg_received` because that is the
first point at which character variables have arrived. A stored rate is clamped
to rAthena's own range on the way in, so a hand-edited variable cannot put the
session into a state the command itself could not produce.
