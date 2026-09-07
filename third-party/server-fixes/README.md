# Pinned rAthena corrections

These small patches apply to the pinned rAthena sources through
`scripts/apply-server-mods.sh`, in both normal and diagnostic builds. They retain
rAthena's GPL license; changes are marked `RAGNAROKMAC` where applicable.

`0001-language-mask.patch` validates the language index before shifting. The
English index is zero, so the previous operation shifted by -1 before reaching
its English early return. Large indices could also shift out of range or wrap
the 16-bit mask. Valid languages and the enabled-language policy are unchanged.
This was caught during real diagnostic map-server startup, not during logout.
