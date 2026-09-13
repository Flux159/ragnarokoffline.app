#!/usr/bin/env python3
"""Install our small, independently idempotent core signal hook on pinned rAthena."""
from pathlib import Path
import shutil
import sys
root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1])
core = target / 'src/common/core.cpp'
source = core.read_text()
include = '#include "ragnarok_crash_trace.hpp" // RAGNAROKMAC original-fault traces'
hook = '''#if defined(__linux__) && defined(RAGNAROK_CRASH_TRACE)
	if (!ragnarok_crash_trace::install(sig_proc)) {
		ShowWarning("Could not install native crash tracing; upstream signal handling remains available.\\n");
	}
#endif'''
if include not in source:
    anchor = '#include "core.hpp"'
    if source.count(anchor) != 1:
        raise SystemExit('Core include anchor changed; crash hook not applied')
    source = source.replace(anchor, include + '\n' + anchor)
# Migrate the early development include order idempotently. rAthena redefines
# UINT64_MAX with a cast, incompatible with libunwind's preprocessor checks.
source = source.replace('#include "core.hpp"\n' + include, include + '\n#include "core.hpp"')
if hook not in source:
    anchor = '\tcompat_signal(SIGFPE, sig_proc);'
    if source.count(anchor) != 1:
        raise SystemExit('Core signal anchor changed; crash hook not applied')
    source = source.replace(anchor, anchor + '\n' + hook)
core.write_text(source)
shutil.copyfile(root / 'third-party/crash-trace/ragnarok_crash_trace.hpp', target / 'src/common/ragnarok_crash_trace.hpp')
for name in ['fixture.cpp', 'ragnarok_crash_trace.hpp', 'verify.sh', 'libunwind-COPYING']:
    folder = target / 'ragnarok-crash-tests'
    folder.mkdir(exist_ok=True)
    shutil.copyfile(root / 'third-party/crash-trace' / name, folder / name)
