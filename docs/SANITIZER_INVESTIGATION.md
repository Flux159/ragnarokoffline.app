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
