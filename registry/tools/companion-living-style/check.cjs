'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const dir=__dirname,mod=path.resolve(dir,'../../mods/companion-living-style');
const {validate,generate}=require('./build.cjs');
const input=JSON.parse(fs.readFileSync(path.join(dir,'observed-outfits.json')));
const ref=JSON.parse(fs.readFileSync(path.join(dir,'costume-reference.json')));
const catalog=JSON.parse(fs.readFileSync(path.join(mod,'ROPD-OUTFITS-v1.7.0.json')));
const npc=fs.readFileSync(path.join(mod,'npc/living-style-v1.7.0.txt'),'utf8');
const manifest=JSON.parse(fs.readFileSync(path.join(mod,'mod.json')));
const checks=[];function check(name,fn){fn();checks.push(name);}
check('Reproducible catalog: exact observed tuples, unique and complete',()=>{
 const {accepted,rejected}=validate(input,ref);
 assert.equal(catalog.included,431);assert.equal(catalog.excluded,1056);
 assert.deepEqual(catalog.outfits,accepted);assert.equal(rejected.length,1056);
 assert.equal(npc,fs.readFileSync(path.join(dir,'living-style.template.txt'),'utf8').replace('// GENERATED_ROPD_CATALOG',generate(accepted)));
 for(const o of accepted)assert(input.outfits.some(x=>JSON.stringify(x)===JSON.stringify(o.views)));
 assert.equal(new Set(accepted.map(o=>JSON.stringify(o.views))).size,accepted.length);
});
check('Bad schema, malformed IDs and extra personal fields are rejected',()=>{
 for(const o of [{upper:-1,middle:0,lower:0,garment:0},{upper:1,middle:0,lower:0,garment:0,name:'private'}, {upper:'1',middle:0,lower:0,garment:0}])
 assert.throws(()=>validate({schemaVersion:1,outfits:[o]},ref));
 assert.throws(()=>validate({schemaVersion:9,outfits:[]},ref));
});
check('Unknown slot rejects the entire combination; zero slots remain zero',()=>{
 const good=catalog.outfits.find(o=>Object.values(o.views).some(v=>v===0)).views;
 const {accepted,rejected}=validate({schemaVersion:1,outfits:[good,good,{...good,garment:65535}]},ref);
 assert.equal(accepted.length,1);assert.deepEqual(accepted[0].views,good);assert.equal(rejected.length,1);
});
check('Runtime checks all four item mappings before appending any complete outfit',()=>{
 const block=npc.slice(npc.indexOf('    .ropd_count = 0;'),npc.indexOf('    // Curated, single-slot candidates'));
 assert.equal((block.match(/else if \(checkre\(0\)\) \.@ok = 0;/g)||[]).length,4);
 assert.equal((block.match(/ITEMINFO_VIEW\) != \.@v_/g)||[]).length,4);
 for(const k of ['upper','middle','lower','garment'])assert(block.indexOf('if (!.@ok) continue;')<block.indexOf('.ropd_'+k+'[.ropd_count] ='));
});
check('Actual registration block: one shuffle on first login, none on map refresh/join, fresh after logout',()=>{
 const source=npc.slice(npc.indexOf('L_RegisterPlayer:\n')+18,npc.indexOf('\nL_Style:\n')).replace(/\/\/[^\n]*/g,'')
 .replace(/@dls_session_seen/g,'connection.seen').replace(/\.(players|auto_shuffle|session_seed|session_epoch)\b/g,'state.$1');
 const state={players:[],auto_shuffle:1,session_seed:5,session_epoch:0};let id=10,connection={seen:0};
 const run=()=>vm.runInNewContext('(function(){'+source+'})()',{
 state,connection,getcharid:()=>id,getarraysize:a=>a.length,inarray:(a,v)=>a.indexOf(v),rand:()=>17
 });
 run();assert.equal(state.session_epoch,1);const seed=state.session_seed;
 run();assert.equal(state.session_seed,seed);assert.deepEqual(state.players,[10]);
 id=11;connection={seen:0};run();assert.equal(state.session_epoch,1);assert.deepEqual(state.players,[10,11]);
 state.players=[];id=10;connection={seen:0};run();assert.equal(state.session_epoch,2);assert.notEqual(state.session_seed,seed);
 state.players=[];state.auto_shuffle=0;connection={seen:0};const fixed=state.session_seed;run();assert.equal(state.session_seed,fixed);
 assert(npc.includes('OnPCLogoutEvent:'));assert(npc.includes('deletearray .players[.@p], 1;'));
});
check('Session invalidates cached appearances, while colour/body picks retain manual seed',()=>{
 assert(npc.includes('+ ":" + .session_epoch'));
 assert(npc.includes('.@pick = (.@cid % 100000) + .session_seed * 97;'));
 assert(npc.includes('    .@pick = (.@cid % 100000) + .seed * 97;\n    if (.colours)'));
});
check('Observed branch uses one row across four slots and respects real companion costumes',()=>{
 const block=npc.slice(npc.indexOf('    if (.@use_ropd) {'),npc.indexOf('    } else {',npc.indexOf('    if (.@use_ropd) {')));
 assert.equal((block.match(/\[\.@outfit\]/g)||[]).length,4);
 assert.equal((block.match(/\.@kind != 3 \|\| getequipid/g)||[]).length,4);
 assert(!block.includes('theme_'));assert(!block.includes('rand('));
 assert(npc.includes('if (.@theme && ((.@pick * 41) + 7) % 100 < .theme_blend) .@use_ropd = 0;'));
 assert(npc.includes('.@use_ropd = .ropd && .ropd_count > 0;'));
});
check('All 13 bounded scans yield; balanced braces; no inventory or stat mutations',()=>{
 const loops=[...npc.matchAll(/for \([^\n]+\) \{\n((?:\s*\/\/[^\n]*\n)*\s*[^\n]+)/g)];
 assert.equal(loops.length,13);for(const m of loops)assert(m[1].includes('if (.@i % 4 == 0) sleep 1;'));
 const code=npc.replace(/\/\/[^\n]*/g,'').replace(/"(?:[^"\\]|\\.)*"/g,'""');let depth=0;
 for(const ch of code){if(ch==='{')depth++;if(ch==='}')depth--;assert(depth>=0);}assert.equal(depth,0);
 assert(!/\b(?:getitem|equip|setlook|jobchange|freeloop)\s*\(/.test(code));
});
check('Defaults enable observed outfits and automatic sessions; legacy settings remain',()=>{
 for(const k of ['style_ropd_outfits','style_login_shuffle','style_town_themes'])assert.equal(manifest.settings.find(s=>s.key===k).default,true);
 assert.equal(manifest.version,'1.7.0');assert.equal(manifest.requires.app,'>=1.8.3');assert.equal(manifest.requires.era,'any');
});
(async()=>{
 const elements=new Map();class Element{constructor(){this.children=[];this.value='';this.checked=false;}append(...n){this.children.push(...n);}}
 for(const k of ['fields','status','save'])elements.set(k,new Element());
 let saved;const context=vm.createContext({document:{getElementById:k=>elements.get(k),createElement:()=>new Element()},window:{modSettings:{get:async()=>({settings:manifest.settings.map(s=>({...s,value:s.default}))}),set:async v=>{saved=v;}}}});
 const html=fs.readFileSync(path.join(mod,manifest.settingsPage),'utf8');vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);
 await new Promise(resolve=>setImmediate(resolve));await elements.get('save').onclick();
 assert.equal(saved.style_login_shuffle,true);assert.equal(saved.style_ropd_outfits,true);assert.equal(saved.style_seed,1);
 checks.push('Settings page loads and saves automatic/observed options through the supported bridge');
 console.log(checks.map(x=>'PASS '+x).join('\n')+'\n'+checks.length+' checks passed. Live NPC parsing and sprites remain unverified.');
})().catch(e=>{console.error(e);process.exitCode=1;});
