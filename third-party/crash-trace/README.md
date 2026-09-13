# Original-context Linux crash tracing

Ragnarok Offline's GPL-3.0-or-later hook runs before rAthena's existing emergency
save handler for SIGSEGV and SIGFPE. It captures the kernel-provided signal
context with libunwind1.8.1 local unwinding, up to32 frames, using fixed buffers
and `write`. It does not allocate, demangle, invoke stdio or dump memory/locals.
The main thread has an alternate signal stack. Other threads retain their own
normal stack unless they install an alternate one. Recursive faults take the
default signal action. Upstream's character-save attempt and re-raise remain.

libunwind is an MIT-licensed server-image dependency, pinned through Alpine3.23
packages1.8.1-r0 for both supported guest architectures. It provides the unwinder
that musl lacks; no Rust supervisor dependency is added. Local cursor operations
used here are documented as signal-safe by the library. This is best-effort:
a damaged stack/unwind table, another fault, or blocked log transport can still
prevent a complete trace. Keep raw core capture and sanitizer testing separate.

Sources: [local signal-frame initialization](https://www.nongnu.org/libunwind/man/unw_init_local%283%29.html),
[local name lookup safety](https://www.nongnu.org/libunwind/man/unw_get_proc_name%283%29.html),
[libunwind package](https://pkgs.alpinelinux.org/packages?branch=v3.23&name=libunwind-dev).

The image keeps function symbols while splitting DWARF into matching debug
artifacts. `main_offset` is relative to the main executable's recorded ELF load
bias, so `addr2line -f -C -e map-server.debug OFFSET` can resolve those frames
for PIE builds. Shared-library frames have absolute PCs and best-effort names;
they need that library's symbols/mappings for further offline analysis. Return
addresses can identify the instruction after a call. Always match image identity,
era and ELF build ID; do not symbolize with the newest unrelated binary.

`fixture.cpp` and `verify.sh` compile the exact hook, cause real SIGSEGV/SIGFPE,
check the original fault/caller names and separately resolve the captured main
ELF offset to source. Both native image builds run them before compiling rAthena.
This proves the tracing mechanism, not the reported intermittent map-server bug.
