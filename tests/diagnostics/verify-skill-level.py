#!/usr/bin/env python3
"""UBSan reduction of the actual skill-level macro used at character login."""
import os, pathlib, subprocess, sys, tempfile
source = (pathlib.Path(sys.argv[1]) / 'src/map/skill.cpp').read_text()
start = source.index('#define skill_get_lv(')
end = source.index('} while(0)', start) + len('} while(0)')
macro = source[start:end]
with tempfile.TemporaryDirectory(prefix='ro-skill-level-') as directory:
    root = pathlib.Path(directory)
    (root/'check.cpp').write_text('''#include <cstdint>
#include <algorithm>
#include <cassert>
using int32=int32_t; using uint16=uint16_t;
#define MAX_SKILL_LEVEL 13
#define min(a,b) std::min<int32>(a,b)
bool skill_check(uint16 id) { return id == 1; }
''' + macro + '''
int32 get(uint16 id, uint16 level) {
    int32 table[MAX_SKILL_LEVEL] = {1,2,3,4,5,6,7,8,9,10,11,12,13};
    skill_get_lv(id, level, table);
}
int main() {
    assert(get(1,0) == 0);
    assert(get(0,0) == 0); assert(get(0,1) == 0);
    for (uint16 level=1; level<=MAX_SKILL_LEVEL; ++level) assert(get(1,level) == level);
    assert(get(1,14) == 14); assert(get(1,15) == 15);
}
''')
    subprocess.run([os.environ.get('CXX', 'clang++'), '-std=c++11', '-O1', '-fsanitize=undefined', '-fno-sanitize-recover=all', str(root/'check.cpp'), '-o', str(root/'check')], check=True)
    result = subprocess.run([str(root/'check')], capture_output=True, text=True)
    if '--expect-fault' in sys.argv:
        assert result.returncode != 0 and 'index -1 out of bounds' in result.stderr, result.stderr
    else:
        assert result.returncode == 0, result.stderr
print('Expected unlearned skill index fault reproduced' if '--expect-fault' in sys.argv else 'Unlearned, invalid, stored and extrapolated skill levels passed UBSan')
