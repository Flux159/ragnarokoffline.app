#!/usr/bin/env python3
"""Exercise actual weapon declarations, bonus setters and Pre-Renewal status read."""
import os, pathlib, re, subprocess, sys, tempfile
root=pathlib.Path(sys.argv[1])/'src/map'
hpp=(root/'pc.hpp').read_text(); pc=(root/'pc.cpp').read_text(); status=(root/'status.cpp').read_text()
enum=re.search(r'enum weapon_type : uint8 \{.*?\n\};',hpp,re.S).group()
arrays='\n'.join(re.findall(r'int32 weapon_(?:atk|damage_rate)\[[^\]]+\];',hpp))
start=pc.index('\tcase SP_WEAPON_ATK:'); end=pc.index('\tcase SP_CRITICAL_ADDRACE:',start)
setter=pc[start:end]
start=status.index('\tif (sd->status.weapon < MAX_WEAPON_TYPE && sd->indexed_bonus.weapon_atk')
end=status.index('\n',status.index('base_status->batk +=',start))
reader=status[start:end]
program='''#include <cstdint>
#include <cassert>
#include <climits>
using uint8=uint8_t; using int32=int32_t;
'''+enum+'''
struct Player { struct { int weapon=0; } status; struct { int lr_flag=0; } state; struct {'''+arrays+'''} indexed_bonus{}; };
struct Status { int batk=0; };
int read(Player* sd) { Status value; auto base_status=&value;
'''+reader+'''
return value.batk; }
enum {SP_WEAPON_ATK, SP_WEAPON_DAMAGE_RATE, LR_FLAG_ARROW};
void bonus(Player* sd, int type, int type2, int val) { switch(type) {
'''+setter+'''
} }
int main() {
 Player player; player.status.weapon=W_KATAR; assert(read(&player)==0);
 for(int weapon=0; weapon<MAX_WEAPON_TYPE; weapon++) {
  player.status.weapon=weapon; bonus(&player,SP_WEAPON_ATK,weapon,3); bonus(&player,SP_WEAPON_DAMAGE_RATE,weapon,4);
  assert(read(&player)==3); assert(player.indexed_bonus.weapon_damage_rate[weapon]==4);
 }
 for(int invalid : {-1, MAX_WEAPON_TYPE, INT_MAX}) {
  bonus(&player,SP_WEAPON_ATK,invalid,90); bonus(&player,SP_WEAPON_DAMAGE_RATE,invalid,90);
 }
 player.status.weapon=W_KATAR; assert(read(&player)==3);
}
'''
program='#include <initializer_list>\n'+program.replace('{-1, MAX_WEAPON_TYPE, INT_MAX}', '{-1, static_cast<int>(MAX_WEAPON_TYPE), INT_MAX}')
with tempfile.TemporaryDirectory(prefix='ro-weapon-bounds-') as temporary:
 folder=pathlib.Path(temporary); (folder/'check.cpp').write_text(program)
 subprocess.run([os.environ.get('CXX','clang++'),'-std=c++11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all',str(folder/'check.cpp'),'-o',str(folder/'check')],check=True)
 result=subprocess.run([str(folder/'check')],capture_output=True,text=True)
 if '--expect-fault' in sys.argv:
  assert result.returncode and 'index 16 out of bounds' in result.stderr,result.stderr
 else: assert result.returncode==0,result.stderr
print('Original weapon index 16 fault reproduced' if '--expect-fault' in sys.argv else 'All weapon types and invalid bonus indices passed UBSan')
