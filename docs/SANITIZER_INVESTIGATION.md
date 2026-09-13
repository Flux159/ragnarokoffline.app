# Disposable map-server investigation

The normal image and diagnostic image use the same rAthena pin, population
patches and packet version. `containers/rathena/Dockerfile.sanitizers` is a
separate development build: Clang 21.1.2, ASan/UBSan, debug information and frame
pointers. It compiles both eras and keeps symbols inside the diagnostic image.
The compiler and package versions, ELF build IDs, app source and image identity
are retained with the review artifact. It is never a release image or a shipped
app dependency, and there is no new Rust crate.

The diagnostic build uses `--enable-manager=no`. rAthena's normal pooled
allocator keeps freed blocks in an arena, hiding allocation/free boundaries
from AddressSanitizer. This changes allocation behavior and timing, so a clean
sanitizer run cannot prove the production allocator has no fault. Findings need
a reduced reproducer and validation against the normal build as well.

Sanitizer errors stop the process at the first fault. Their signal handlers take
precedence over rAthena's emergency-save handler; the normal crash-trace hook is
not enabled in this image. Exit-time leak detection and raw cores are disabled.
This build is only for marked disposable worlds. It is not appropriate for a
player save and cannot promise emergency saving after an error.

## Build and validation

Dispatch the existing `images` workflow with `diagnostics=true` on the review
branch. This calls the diagnostic workflow on native Linux ARM64 and x64 and
skips the normal image jobs. Only `ragnarokmac/rathena-diagnostics:SOURCE_SHA` is
tagged; nothing is published to releases. Review artifacts expire after 14 days.
Preserve the downloaded archive and checksum locally while investigating.

The exact diagnostic runtime must first pass three intentional faults: a
heap-use-after-free, signed integer overflow and SIGSEGV. Each must stop with a
symbolized source location. A deliberately installed legacy signal handler must
not replace the sanitizer's report. The build runs this fixture before compiling
rAthena and repeats it in the final runtime image. Before gameplay, repeat it
inside the actual nebula guest too; a hosted runner does not prove guest support.

`sh /diagnostics/verify.sh /tmp/fixture-evidence` only runs synthetic faults.
Never feed player data to this fixture or upload live server sanitizer reports
automatically. Those reports can contain private addresses, names or memory
contents and need private retention and review before sharing.

## Investigation matrix

Use the stopped, marked disposable world with a preserved normal image and
database backup. Retain original settings and credentials. Record the exact
image, era, population/mod configuration, start/end time and completed cycle
count for every row:

| Axis | Cases |
| --- | --- |
| Era | Renewal, Pre-Renewal |
| Population | Off; on with recorded density and active shell count |
| Mods | Disabled baseline; enabled recorded set |
| Events | Login/logout; disconnect/reconnect; map changes; combat; spawn/despawn; `@reloadscript` |

Stop and retain the first sanitizer report or unexpected exit before replacing
the container. Distinguish a test-injected fault, a sanitizer finding, and a
reproduction of the reported intermittent crash. No underlying cause of #16 is
claimed until a real failing scenario is recorded. Keep #16 open if the matrix
does not reproduce it, with actual exposure duration and remaining hypotheses.

References: [Clang ASan build and symbolization](https://clang.llvm.org/docs/AddressSanitizer.html),
[sanitizer signal-handler controls](https://github.com/google/sanitizers/wiki/SanitizerCommonFlags).

## September 7 continuation

The original image passed the synthetic fixture inside the actual ARM64 guest,
but real game startup failed UBSan at `char_logif.cpp:827`: `WFIFOL(fd,50)`
casts a byte-offset FIFO pointer to `uint32*`. Similar unaligned accesses are
pervasive in the pinned packet macros. This is real C++ alignment UB, not a
reproduction of the intermittent logout crash. The gameplay diagnostic image
excludes only `alignment`; ASan and the other UBSan checks remain fatal. It
cannot be used to claim the absence of alignment defects. See the
[Clang per-check controls](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html#usage).

`tests/e2e/sanitizer-guest.cjs` verifies the archive checksum and deliberately
faulting runtime inside a stopped, marked disposable world, then waits for
owned shutdown to release its ports. `tests/e2e/map-crash-stress.cjs` backs up
each era before repeated real client login, warp, script reload, native
character-select logout and abrupt navigation disconnect. It records completed
counts and image identity, and preserves the first detected game fault.

Normal ARM64 image `ec813673406bdfa995723535f926697f1167467ab105a0e5f938d96236d61660`
completed 20 reload/logout cycles: five per era/population-off-or-on combination.
Bundled mobile and keyboard mods were enabled. No crash was reproduced; this
short exposure is not closure of #16 or the full acceptance matrix.

The corrected diagnostic image from build `34153441798` (source
`7cd027d67218ee40e6829579da3d82d32d37ca87`, ARM64 image
`5b4dc29e9dce57b3969af9e84e92c1acf40c2f87048c1f02a62030d60203a8cd`)
passed the synthetic guest fixture, then found another real startup defect:
`msg_checklangtype(0)` shifts by -1 before its English early return. The retained
stack starts at `msg_conf.cpp:133`, called by `map_do_init_msg`. The small
`third-party/server-fixes/0001-language-mask.patch` moves the early return and
range checks before the shift. It applies to both normal and diagnostic builds.
`tests/diagnostics/verify-language.py` compiles that actual source function with
UBSan: the pinned original fails on English; the patched checker passes English,
all nine other languages, three enable masks and invalid integer bounds.
This is a startup UB finding, not evidence of the intermittent logout fault.

The real injected-map-fault recovery test passed with the normal image:
`RO_E2E_RECOVERY_SMOKE=1` detected the stopped map, showed its private-report
screen and returned to native login through Retry. The stress fixture also
supports `RO_E2E_STRESS_MODS=off`, preserving/restoring mod selection files, and
records the actual mod list. Population rows explicitly stop and respawn 100
shells between map transitions before reloading scripts.

After that fix, build `34155293027` passed both architecture jobs and the actual
guest fixture. Real startup then found a negative-to-unsigned conversion in
`JobDatabase::calc_basesp` (`pc.cpp:13822`, via `loadingFinished`). A Ninja-mapped
job with default coefficients computes -2 at level 10. The second small server
patch clamps the floating-point value to the unsigned return range before the
cast. `verify-base-sp.py` reproduces the original UBSan failure and verifies the
fix, ordinary values and overflow. Again this is a separate startup finding.

Build `34156678115` (source `eedaaf2fd466eb6c96730dc2904d6f6e5e4fcbc9`)
passed both architectures and the guest fixture, then reached actual character
login. The Pre-Renewal/population-off row stopped at `skill_get_sp` with index -1
while `clif_skillinfoblock` built the unlearned skill list after `LoadEndAck`.
`0003-unlearned-skill-level.patch` returns zero before indexing a level-zero
skill; the source-macro UBSan reduction fails before and passes after, including
stored and extrapolated learned levels. The original private game report is
retained. This is a reproduced login defect, not proof of the intermittent
logout crash's cause.

Both architectures passed diagnostic build `34158378360` and normal build
`34158843298` at source `fdaf7b8ef7df95f431a1af3b39466931c0739873`. The patched
normal ARM64 image completed all 20 extended cycles with mods disabled. The
diagnostic image passed the guest fixture and five Pre-Renewal/population-off
cycles, then failed during real population activation: `status.cpp:4353` read
index 16 from `indexed_bonus.weapon_atk[16]` while a shell equipped a Katar.
The stack includes `pc_equipitem`, `population_engine_spawn_shell` and the
autosummon timer. The failed population assertion did not mean population was
merely slow; the retained server log contains the fatal sanitizer report.

The fourth server patch sizes `weapon_atk` and `weapon_damage_rate` from the
complete weapon enum and guards item-script writes. Its source-derived
reduction reproduces index 16 on the original and checks all weapon types and
invalid indices after patching. This is a real population-path bounds defect;
the intermittent logout scenario still needs its own reproduction evidence.

Source `dd39509a16e57666834f404a532403a13a47063d`, containing all four fixes,
passed both architectures in diagnostic build `34160404547` and normal build
`34160406889`. The diagnostic ARM64 image
`202bc00ca59d311214f8d7116d1ca3b684e0855d897ba84dab457a50dd0434e3`
passed the actual guest synthetic fixture, then completed all 20 extended
gameplay cycles with mods disabled: five for each era/population combination.
The recorded exposure was 22:51:01–22:58:24 UTC, with no sanitizer fault,
browser error or cleanup failure. Positive population counts were required;
population rows issued stop/100-shell spawn requests as well as map changes,
script reloads and both native logout and abrupt disconnects.

An earlier run with this same image completed five population-off cycles but
checked population before the next demand-driven timer tick. It retained zero
stats and healthy server logs, not a sanitizer finding. The fixture now polls
for a positive count, checking server health on each attempt. That timing
failure and the original fourth-fault evidence remain retained separately.
