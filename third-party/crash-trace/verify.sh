#!/bin/sh
# Runs in each native Alpine image build; no VM, SQL or player data involved.
set -eux
cd /rathena/ragnarok-crash-tests
g++ -g -O1 -fno-omit-frame-pointer -fno-optimize-sibling-calls -DRAGNAROK_CRASH_TRACE -Wl,--build-id=sha1 -rdynamic fixture.cpp -lunwind -o fixture
objcopy --only-keep-debug fixture fixture.debug
strip --strip-debug fixture
objcopy --add-gnu-debuglink=fixture.debug fixture
for mode in segv fpe; do
    status=0
    ./fixture "$mode" > "$mode.log" 2>&1 || status=$?
    cat "$mode.log"
    if [ "$mode" = segv ]; then expected=139; else expected=136; fi
    test "$status" = "$expected"
    grep -q 'RAGNAROK_CRASH_TRACE v1 signal=' "$mode.log"
    grep -q 'function=original_fault+' "$mode.log"
    grep -q 'function=fault_caller+' "$mode.log"
    grep -q 'RAGNAROK_CRASH_TRACE_END' "$mode.log"
    offset=$(sed -n 's/.*main_offset=\(0x[0-9a-f]*\).*function=original_fault+.*/\1/p' "$mode.log" | head -1)
    test -n "$offset"
    addr2line -f -e fixture.debug "$offset" > "$mode.symbolized"
    grep -q 'original_fault' "$mode.symbolized"
    grep -q 'fixture.cpp:' "$mode.symbolized"
done
mkdir -p /symbols/trace-tests
cp segv.log fpe.log segv.symbolized fpe.symbolized /symbols/trace-tests/
echo 'Original-context segfault/FPE trace and separate symbol lookup passed'
