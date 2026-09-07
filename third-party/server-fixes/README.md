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
