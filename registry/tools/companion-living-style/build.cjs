'use strict';
const fs=require('node:fs'),path=require('node:path');
const here=__dirname, mod=path.resolve(here,'../../mods/companion-living-style');
const input=JSON.parse(fs.readFileSync(path.join(here,'observed-outfits.json'),'utf8'));
const reference=JSON.parse(fs.readFileSync(path.join(here,'costume-reference.json'),'utf8'));
const slots={upper:'Costume_Head_Top',middle:'Costume_Head_Mid',lower:'Costume_Head_Low',garment:'Costume_Garment'};
const masks={upper:'EQP_COSTUME_HEAD_TOP',middle:'EQP_COSTUME_HEAD_MID',lower:'EQP_COSTUME_HEAD_LOW',garment:'EQP_COSTUME_GARMENT'};
function validate(input,reference){
 if(input.schemaVersion!==1||!Array.isArray(input.outfits))throw Error('Invalid catalog schema');
 const seen=new Set(), accepted=[], rejected=[];
 for(const o of input.outfits){
  if(!o||Object.keys(o).sort().join(',')!=='garment,lower,middle,upper'||!Object.values(o).every(v=>Number.isInteger(v)&&v>=0&&v<=65535))throw Error('Invalid outfit fields');
  const key=Object.keys(slots).map(k=>o[k]).join(':');
  if(seen.has(key))continue;seen.add(key);
  if(!Object.values(o).some(Boolean))continue;
  const ids={};const missing=[];
  for(const [k,slot] of Object.entries(slots)){
   if(o[k]===0){ids[k]=0;continue;}
   const match=reference.items.find(c=>c.slot===slot&&c.view===o[k]);
   if(!match)missing.push(k+':'+o[k]);else ids[k]=match.id;
  }
  if(missing.length)rejected.push({views:o,missing});
  else accepted.push({views:o,items:ids});
 }
 if(!accepted.length)throw Error('No complete supported outfits; refusing empty release');
 return {accepted,rejected};
}
function arrays(name,values){
 let text='';
 for(let i=0;i<values.length;i+=32)text+='    setarray '+name+(i?'['+i+']':'')+', '+values.slice(i,i+32).join(', ')+';\n';
 return text;
}
function generate(accepted){
 let text='    // Generated complete observed outfits. Zero is an intentionally empty slot.\n';
 for(const k of Object.keys(slots)){
  text+=arrays('.@ropd_'+k+'_ids',accepted.map(o=>o.items[k]));
  text+=arrays('.@ropd_'+k+'_refs',accepted.map(o=>o.views[k]));
 }
 text+='    .ropd_count = 0;\n    for (.@i = 0; .@i < '+accepted.length+'; .@i++) {\n        if (.@i % 4 == 0) sleep 1;\n        .@ok = 1;\n';
 for(const k of Object.keys(slots)){
  text+='        .@id = .@ropd_'+k+'_ids[.@i];\n        .@v_'+k+' = .@ropd_'+k+'_refs[.@i];\n';
  text+='        if (.@id > 0) {\n            if (getitemname(.@id) != "null" && getiteminfo(.@id, ITEMINFO_LOCATIONS) == '+masks[k]+') {\n                if (getiteminfo(.@id, ITEMINFO_VIEW) != .@v_'+k+') .@ok = 0;\n            } else if (checkre(0)) .@ok = 0;\n        }\n';
 }
 text+='        if (!.@ok) continue;\n';
 for(const k of Object.keys(slots))text+='        .ropd_'+k+'[.ropd_count] = .@v_'+k+';\n';
 text+='        .ropd_count++;\n    }\n';
 return text;
}
function compactRows(o,key){var head={...o};delete head[key];return JSON.stringify(head,null,2).slice(0,-2)+',\n  '+JSON.stringify(key)+': [\n'+o[key].map(v=>'    '+JSON.stringify(v)).join(',\n')+'\n  ]\n}\n';}
if(require.main===module){
 const result=validate(input,reference);
 const template=fs.readFileSync(path.join(here,'living-style.template.txt'),'utf8');
 if(template.split('// GENERATED_ROPD_CATALOG').length!==2)throw Error('Missing/duplicate generation marker');
 fs.writeFileSync(path.join(mod,'npc/living-style-v1.7.1.txt'),template.replace('// GENERATED_ROPD_CATALOG',generate(result.accepted)));
 const catalog={schemaVersion:1,source:input.source,collectedAt:input.collectedAt,pagesCollected:input.pagesCollected,recordsCollected:input.recordsCollected,observedUnique:input.outfits.length,included:result.accepted.length,excluded:result.rejected.length,validation:'Complete combinations matching reference costume slots and bundled client view tables; sprite rendering requires live testing.',outfits:result.accepted};
 fs.writeFileSync(path.join(mod,'ROPD-OUTFITS-v1.7.1.json'),compactRows(catalog,'outfits'));
 console.log(JSON.stringify({included:result.accepted.length,excluded:result.rejected.length}));
}
module.exports={validate,generate};
