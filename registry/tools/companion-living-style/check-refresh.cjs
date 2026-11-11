'use strict';
const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'), path=require('node:path');
const mod=path.resolve(__dirname,'../../mods/companion-living-style');
const source=fs.readFileSync(path.join(mod,'client/index.js'),'utf8');
const npc=fs.readFileSync(path.join(mod,'npc/living-style-v1.7.2.txt'),'utf8').replace(/\r\n/g,'\n');
const manifest=JSON.parse(fs.readFileSync(path.join(mod,'mod.json'),'utf8'));
const checks=[];
function harness(params={},map=null){
  let now=0,nextId=0;
  const tasks=new Map(),events=new Map(),requests=[],cleanups=[];
  const api={version:1,snapshot:()=>({map}),cleanup:fn=>cleanups.push(fn),
    on:(event,fn)=>{events.set(event,fn);return()=>events.delete(event);},
    server:{request:(...args)=>{requests.push({now,args});return Promise.resolve('ok');}}};
  const init=vm.runInNewContext(source.replace('export default function init','function init')+'\ninit;',{
    setTimeout:(fn,delay)=>{const id=++nextId;tasks.set(id,{at:now+delay,fn});return id;},
    clearTimeout:id=>tasks.delete(id),Promise,Error,
  });
  const dispose=init(params,api);
  function advance(target){
    while(true){const pending=[...tasks].sort((a,b)=>a[1].at-b[1].at).find(([,t])=>t.at<=target);if(!pending)break;tasks.delete(pending[0]);now=pending[1].at;pending[1].fn();}
    now=target;
  }
  return {api,tasks,events,requests,dispose,advance,cleanups};
}
let h=harness();
assert.equal(h.tasks.size,0);
h.events.get('map:enter')({name:'prontera'});
assert.equal(h.tasks.size,4);
h.advance(0);assert.equal(h.requests.length,1);
assert.equal(h.requests[0].args[0],'dlsrefresh');
assert.equal(h.requests[0].args[1],'');
assert.equal(h.requests[0].args[2].timeout,2000);
h.advance(149);assert.equal(h.requests.length,1);
h.advance(150);assert.equal(h.requests.length,2);
h.advance(500);assert.equal(h.requests.length,3);
h.advance(1200);assert.equal(h.requests.length,4);
checks.push('Map arrival requests refresh immediately and only retries at the four bounded times');
h=harness();h.events.get('map:enter')({name:'prontera'});h.advance(0);
h.events.get('map:leave')();assert.equal(h.tasks.size,0);
h.events.get('map:enter')({name:'payon'});h.advance(0);h.advance(1200);
assert.equal(h.requests.length,5);
checks.push('Teleport/map leave cancels stale requests; the next map receives its own refresh sequence');
h.events.get('map:enter')({name:'geffen'});h.events.get('exit')();h.advance(5000);assert.equal(h.requests.length,5);
checks.push('Exiting cancels queued requests');
h.events.get('map:enter')({name:'izlude'});h.dispose();h.cleanups[0]();h.advance(8000);
assert.equal(h.requests.length,5);assert.equal(h.events.size,0);
checks.push('Disposal is idempotent and removes timers and event subscriptions');
for(const seed of [1,5,9999]){
  h=harness({style_seed:seed},{name:'prontera'});h.advance(1200);
  assert.equal(h.requests.length,4);
  assert.equal(h.requests.map(r=>r.now).join(','),'0,150,500,1200');
  h.dispose();
}
checks.push('Shuffle values 1, 5 and 9999 use identical map-arrival timing, including late initialization');
const seed=manifest.settings.find(s=>s.key==='style_seed');
assert.equal(seed.min,1);assert.equal(seed.max,9999);assert(seed.description.includes('automatic'));
checks.push('Manual shuffle limits remain 1–9999 and its description explains automatic mode');
// Every finite traversal, including startup, cleanup and map refresh, yields
// before its body. This targets the reported runaway script execution regression.
const loops=[...npc.matchAll(/for \([^\n]+\) \{\n((?:\s*\/\/[^\n]*\n)*\s*[^\n]+)/g)];
assert.equal(loops.length,14);
for(const match of loops)assert(/if \(\.@[a-z]+ % 4 == 0\) sleep 1;/.test(match[1]));
assert(!npc.includes('freeloop('));
checks.push('All fourteen finite scans (including the complete outfit catalog and the in-view pass) yield in groups of four without disabling the server loop guard');
assert(npc.includes('stopnpctimer;'));
assert(npc.includes('if (.ready && !.busy'));
assert(npc.includes('if (!.ready || .busy)'));
assert(!npc.includes('OnTimer10000'));
checks.push('Timer work is serialized and the old ten-second-only refresh is removed');
assert(npc.includes('getmapunits(BL_PC, .@map$, .@gids)'));
assert(npc.includes('getmapxy .@map$, .@x, .@y;'));
assert(!npc.includes('.@atcmd_parameters$[1]'));
assert(npc.includes('gettickcount(')===false);
assert(npc.includes('isloggedin(.@requester_aid, .@requester_cid)'));
assert(npc.includes('0xFFFFFF, .@requester_cid'));
checks.push('Server refresh uses the real requester map, ignores client targets and explicitly replies after RID-releasing yields');
for(const eq of ['TOP','MID','LOW'])assert(npc.includes(`.@kind != 3 || getequipid(EQI_COSTUME_HEAD_${eq}, .@cid) <= 0`));
assert(npc.includes('.@kind != 3 || getequipid(EQI_COSTUME_GARMENT, .@cid) <= 0'));
checks.push('Companions keep actual equipped costumes while ambient/vendor AI can override default costume looks visually');
// AI entering a player's client view (AREA_SIZE 14) are restyled at once.
assert(npc.includes('getareaunits(BL_PC, .@pmap$, .@px - 14, .@py - 14, .@px + 14, .@py + 14, .@near)'));
assert(npc.includes('if (inarray(.@seen, .@near[.@j]) < 0)\n                    callsub L_Style, .@near[.@j], 1;'));
assert(npc.indexOf('getareaunits(')<npc.indexOf('.@n = getunits(BL_PC, .@gids);'));
checks.push('AI coming into a real player\'s view are restyled on the next pass, before the world-wide scan, without waiting for the five-second refresh');
// Review of PR 777: tracking is one array per player, replaced each pass and dropped at logout.
assert(!npc.includes('".near_" + .@aid + "_"'));
assert(npc.includes('copyarray .@seen, getd(".near_" + .@aid), .@k;'));
assert(npc.includes('deletearray getd(".near_" + .@aid);\n            if (.@m > 0) copyarray getd(".near_" + .@aid), .@near, .@m;'));
assert(npc.includes('deletearray getd(".near_" + .@aid);\n                deletearray .players[.@i], 1;'));
assert(npc.includes('OnPCLogoutEvent:')&&npc.indexOf('deletearray getd(".near_" + getcharid(3));')>npc.indexOf('OnPCLogoutEvent:'));
checks.push('In-view tracking keeps one bounded list per real player, replaced every pass and removed when that player logs out');
const report=`Companion Living Style v1.7.2 refresh checks\n${checks.length} checks passed.\n\n`+checks.map(c=>'PASS '+c).join('\n')+'\n\nLive rendering and server execution after restart remain to be confirmed.\n';

console.log(report);
