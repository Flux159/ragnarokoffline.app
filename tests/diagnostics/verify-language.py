#!/usr/bin/env python3
"""Compile the actual pinned language checker as a UBSan reduction.
Usage: verify-language.py /path/to/rathena [--expect-fault]
"""
import os
import pathlib
import subprocess
import sys
import tempfile

root = pathlib.Path(sys.argv[1])
source = (root / 'src/common/msg_conf.cpp').read_text()
function = source[source.index('int32 msg_checklangtype('):].strip()
assert function.endswith('}') and function.count('int32 msg_checklangtype(') == 1
header = (root / 'src/common/msg_conf.hpp').read_text()
enum = header[header.index('enum lang_types {'):header.index('};') + 2]
with tempfile.TemporaryDirectory(prefix='ro-language-') as temp:
    path = pathlib.Path(temp)
    (path / 'check.cpp').write_text('''#include <cstdint>
#include <climits>
#include <cassert>
using int32 = int32_t; using uint16 = uint16_t;
#define ShowDebug(...) ((void)0)
''' + enum + '\n' + function + '''
int main() {
    assert(msg_checklangtype(0, false) == 1);
    for (int lang = 1; lang <= 9; ++lang)
        assert(msg_checklangtype(lang, false) == ((LANG_ENABLE & (1u << (lang-1))) ? 1 : -2));
    for (int lang : {INT_MIN, -1, 10, 16, 17, 31, 32, INT_MAX})
        assert(msg_checklangtype(lang, false) == -1);
}
'''.replace('int main()', '#include <initializer_list>\nint main()'))
    for mask in ['0', '0x1ff', '0x101']:
        subprocess.run([os.environ.get('CXX', 'clang++'), '-std=c++11', '-O1',
            '-fsanitize=undefined', '-fno-sanitize-recover=all', '-DLANG_ENABLE=' + mask,
            str(path / 'check.cpp'), '-o', str(path / 'check')], check=True)
        result = subprocess.run([str(path / 'check')], capture_output=True, text=True)
        if '--expect-fault' in sys.argv:
            assert result.returncode != 0 and 'shift exponent -1 is negative' in result.stderr, result.stderr
        else:
            assert result.returncode == 0, result.stderr
print('Expected English shift fault reproduced' if '--expect-fault' in sys.argv else 'English, all languages, masks and invalid bounds passed UBSan')
