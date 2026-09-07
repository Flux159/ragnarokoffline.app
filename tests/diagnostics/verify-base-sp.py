#!/usr/bin/env python3
"""UBSan reduction of the actual pinned base-SP function and boundary inputs."""
import os, pathlib, subprocess, sys, tempfile
source = (pathlib.Path(sys.argv[1]) / 'src/map/pc.cpp').read_text()
start = source.index('uint32 JobDatabase::calc_basesp(')
end = source.index('\n}\n', start) + 3
function = source[start:end]
with tempfile.TemporaryDirectory(prefix='ro-base-sp-') as directory:
    root = pathlib.Path(directory)
    (root / 'check.cpp').write_text('''#include <cstdint>
#include <climits>
#include <cmath>
#include <memory>
#include <cassert>
using uint16=uint16_t; using uint32=uint32_t; using uint64=uint64_t;
constexpr uint64 MAPID_FIRSTMASK=255, MAPID_NINJA=1, MAPID_GUNSLINGER=2, MAPID_SUMMONER=3;
uint64 pc_jobid2mapid(uint32 job) { return job; }
struct s_job_info { uint32 job_id=MAPID_NINJA, sp_factor=0, sp_increase=100; };
struct JobDatabase { uint32 calc_basesp(uint16 level, const std::shared_ptr<s_job_info>& job); };
''' + function + '''
int main() {
    JobDatabase database; auto job=std::make_shared<s_job_info>();
    assert(database.calc_basesp(10, job) == 0); // 10 + 10 - 22 = -2 before clamping
    assert(database.calc_basesp(9, job) == 38);
    job->job_id=0; assert(database.calc_basesp(10, job) == 20);
    job->job_id=MAPID_SUMMONER; assert(database.calc_basesp(10, job) == 30);
    job->sp_factor=UINT_MAX; job->sp_increase=UINT_MAX;
    assert(database.calc_basesp(250, job) == UINT_MAX);
}
''')
    subprocess.run([os.environ.get('CXX', 'clang++'), '-std=c++11', '-O1', '-fsanitize=undefined', '-fno-sanitize-recover=all', str(root/'check.cpp'), '-o', str(root/'check')], check=True)
    result = subprocess.run([str(root/'check')], capture_output=True, text=True)
    if '--expect-fault' in sys.argv:
        assert result.returncode != 0 and 'outside the range of representable values' in result.stderr, result.stderr
    else:
        assert result.returncode == 0, result.stderr
print('Expected negative base-SP conversion reproduced' if '--expect-fault' in sys.argv else 'Base SP normal values and unsigned bounds passed UBSan')
