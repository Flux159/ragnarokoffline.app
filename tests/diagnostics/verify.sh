#!/bin/sh
# Only synthetic faults are safe to emit into hosted CI logs.
set -eu
out=${1:?provide a private evidence directory}
fixture=${FIXTURE_BIN:-/diagnostics/sanitizer-fixture}
umask 077
mkdir -p "$out"
for mode in uaf overflow segv; do
    status=0
    "$fixture" "$mode" > "$out/$mode.log" 2>&1 || status=$?
    cat "$out/$mode.log"
    test "$status" -ne 0
    test "$status" -ne 2
    test "$status" -ne 91
    ! grep -q UNEXPECTED_LEGACY_HANDLER "$out/$mode.log"
    grep -q 'fixture.cpp:' "$out/$mode.log"
    case "$mode" in
        uaf) grep -q 'AddressSanitizer: heap-use-after-free' "$out/$mode.log"; grep -q fault_uaf "$out/$mode.log" ;;
        overflow) grep -q 'runtime error: signed integer overflow' "$out/$mode.log"; grep -q fault_overflow "$out/$mode.log" ;;
        segv) grep -q 'AddressSanitizer: SEGV' "$out/$mode.log"; grep -q fault_segv "$out/$mode.log" ;;
    esac
    printf '%s %s\n' "$mode" "$status" >> "$out/exits.txt"
done
echo 'ASan use-after-free, UBSan overflow and original SIGSEGV source lookup passed'
