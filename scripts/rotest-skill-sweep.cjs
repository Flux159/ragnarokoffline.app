#!/usr/bin/env node
// Cast every 3rd/4th-job skill of one or more jobs and record what happened,
// through a running `rotest` daemon logged in on a non-GM-looking account
// (docs/AGENT_TESTING.md).
//
// For each skill the character is first given what rAthena's skill_db says it
// needs -- a weapon of the right type, ammo, a shield, a mount, a cart -- so a
// refusal is the game's rule, not a naked character. Then it casts on a
// target, the ground or itself, takes a burst of cropped frames from the
// moment of the cast, and tiles them into one sheet per skill.
//
//   node scripts/rotest-skill-sweep.cjs <reqs.json> <jobId> ...
//   SWEEP_SKILLS=5201,5208 node scripts/rotest-skill-sweep.cjs <reqs.json> 4252   # just those
//
// reqs.json maps skill id to { weapons, ammo, state } and weapon/ammo type to
// an item id; artifacts/sweep/skill-reqs.json is built from
// vendor/rathena/db/re/{skill_db,item_db_equip,item_db_etc}.yml.
// One JSON line per skill on stdout, a summary per job on stderr.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const WORLD = path.resolve(process.env.RO_E2E_WORLD || path.join(repo, 'artifacts/agent-world'));
const MISSING = path.join(WORLD, 'state/assets/logs/missing-files.log');
const PORT = Number(process.env.ROTEST_PORT || 7480);
const SHEETS = path.resolve(process.env.ROTEST_SHEETS || path.join(process.env.ROTEST_OUT || path.join(repo, 'artifacts/rotest'), 'sheets'));

function call(cmd, args = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ cmd, args: args.map(String) });
        const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
        });
        req.on('error', reject);
        req.end(body);
    });
}
const evaluate = async js => (await call('eval', [js])).result;
// A GM command that did not go through means everything after it is noise.
async function gm(text) {
    const r = await call('gm', [text]);
    if (r.error) throw new Error(`gm ${text}: ${r.error}`);
    return r.chat || [];
}
const missingSize = () => { try { return fs.statSync(MISSING).size; } catch { return 0; } };
const missingSince = offset => {
    try {
        const all = fs.readFileSync(MISSING);
        return all.subarray(offset).toString('latin1').split(/\r?\n|(?<=\})(?=\{)/).filter(Boolean)
            .map(l => { try { return JSON.parse(l).requestedPath; } catch { return l.slice(0, 160); } });
    } catch { return []; }
};
// Chat lines that arrived after `before` was read.
function newLines(before, after) {
    for (let k = Math.min(before.length, after.length); k > 0; k--) {
        if (before.slice(-k).join('\n') === after.slice(0, k).join('\n')) return after.slice(k);
    }
    return after;
}

// SkillTargetSelection.TYPE: 1 enemy, 2 place, 4 self, 16 friend, 32 trap.
const kind = type => (type & 4) ? 'self' : (type & 2) ? 'ground' : (type & 1) ? 'enemy' : (type & 16) ? 'friend' : (type ? 'other' : 'passive');

let reqs;
const state = { weaponType: null, ammoType: null, mounted: false, cart: false, falcon: false, shield: false, items: new Set() };
const isAmmo = id => (id >= 1750 && id < 1800) || (id >= 13200 && id < 13300) || id >= 18000;

async function equipItem(id) {
    await gm(`@item ${id} ${isAmmo(id) ? 100 : 1}`);
    const r = await call('equip', [id]);
    return Boolean(r.ok && (r.chat || []).some(l => /put on|equip/i.test(l)));
}

// Give the character what skill_db says the skill needs. Returns notes on
// what was set up, or why it could not be.
async function prepare(skill) {
    const need = reqs.skills[skill.id] || { weapons: [], ammo: [], state: null };
    const notes = [];
    if (need.weapons.length && !need.weapons.includes(state.weaponType)) {
        let done = false;
        for (const type of need.weapons.filter(t => t !== 'Fist')) {
            const item = reqs.weaponItem[type];
            if (item && await equipItem(item)) { state.weaponType = type; state.shield = false; done = true; notes.push(`weapon ${type} (${item})`); break; }
        }
        if (!done) notes.push(need.weapons.includes('Fist') ? 'weapon: fist' : `weapon: none of ${need.weapons.join('/')} would equip`);
    }
    if (need.ammo.length && !need.ammo.includes(state.ammoType)) {
        const type = need.ammo.find(t => reqs.ammoItem[t]);
        if (type && await equipItem(reqs.ammoItem[type])) { state.ammoType = type; notes.push(`ammo ${type}`); }
        else notes.push(`ammo: none of ${need.ammo.join('/')} would equip`);
    }
    // What the cast consumes (gemstones, cannonballs, crystals...): a stack,
    // by AegisName, which @item accepts.
    for (const item of need.items || []) {
        if (!state.items.has(item)) { await gm(`@item ${item} 50`); state.items.add(item); notes.push(`items ${item}`); }
    }
    const s = need.state;
    if (/^(Ridingdragon|Mado|Riding)$/i.test(s || '')) {
        if (!state.mounted) { await gm('@mount'); state.mounted = true; notes.push(`@mount for ${s}`); }
    } else if (s === 'Cart') {
        if (!state.cart) { await gm('@cart 1'); state.cart = true; notes.push('@cart 1'); }
    } else if (s === 'Falcon') {
        if (!state.falcon) { await gm('@option 0 0 16'); state.falcon = true; notes.push('@option falcon'); }
    } else if (s === 'Shield') {
        if (!state.shield) { if (await equipItem(2101)) { state.shield = true; notes.push('shield (2101)'); } else notes.push('shield would not equip'); }
    } else if (s) {
        notes.push(`state ${s} not set up`);
    }
    return notes;
}

async function target() {
    let mob = ((await call('state', ['9'])).entities || []).find(e => e.type === 'MOB' && !e.dead);
    if (!mob) {
        await gm('@monster 1002 1');
        await call('wait', ['1200']);
        mob = ((await call('state', ['9'])).entities || []).find(e => e.type === 'MOB' && !e.dead);
    }
    return mob;
}

function sheet(job, skill, frames, label) {
    if (!frames?.length) return null;
    fs.mkdirSync(SHEETS, { recursive: true });
    const out = path.join(SHEETS, `${job}-${skill.id}-${skill.name.replace(/[^\w]+/g, '_')}.png`);
    const py = `
import sys, json
from PIL import Image, ImageDraw
files, out, label, every = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
ims = [Image.open(f) for f in files]
w, h = ims[0].size
cols = 3 if len(ims) <= 6 else 4; rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (w * cols, h * rows + 28), 'black')
d = ImageDraw.Draw(sheet)
d.text((8, 7), label, fill='white')
for i, im in enumerate(ims):
    sheet.paste(im, ((i % cols) * w, 28 + (i // cols) * h))
    d.text(((i % cols) * w + 6, 28 + (i // cols) * h + 4), f'+{i * every} ms', fill='yellow')
sheet.save(out)
`;
    const r = spawnSync('python3', ['-c', py, JSON.stringify(frames), out, label, String(process.env.SWEEP_EVERY || 150)]);
    if (r.status === 0) for (const f of frames) fs.rmSync(f, { force: true });
    return r.status === 0 ? out : null;
}

async function sweepJob(job) {
    Object.assign(state, { weaponType: null, ammoType: null, mounted: false, cart: false, falcon: false, shield: false, items: new Set() });
    await gm(`@jobchange ${job}`);
    await gm('@blvl 250');
    await gm('@jlvl 70');
    await gm('@allstats');
    await gm('@allskill');
    await gm('@heal');
    await call('wait', ['1500']);
    const me = await evaluate('window.roAgent.player()');
    const only = process.env.SWEEP_SKILLS ? new Set(process.env.SWEEP_SKILLS.split(',').map(Number)) : null;
    const skills = (await call('skills')).filter(s => s.type && s.level && s.id >= Number(process.env.SWEEP_MIN_ID ?? 2000) && (!only || only.has(s.id)));
    let bad = 0;
    for (const skill of skills) {
        if (!(await evaluate('Boolean(window.roClientDiagnostics.snapshot().map)'))) throw new Error('left the game; see `rotest shot`');
        const setup = await prepare(skill);
        const p0 = await evaluate('window.roAgent.player()');
        if (p0?.sp && p0.sp.sp < p0.sp.max * 0.5) await gm('@heal');
        await call('wait', ['700']);                   // after-cast delay of the previous skill
        await call('errors');                           // drain
        const chatBefore = await evaluate('window.roAgent.chat(30)');
        const before = await evaluate('window.roAgent.player()');
        const k = kind(skill.type);
        const mob = k === 'enemy' || k === 'ground' ? await target() : null;
        const offset = missingSize();
        // Long casts (Arch Mage and the like) land after a short burst ends:
        // SWEEP_BURST frames, SWEEP_EVERY ms apart.
        const burst = Number(process.env.SWEEP_BURST || 6), every = Number(process.env.SWEEP_EVERY || 150);
        const args = [skill.id, skill.level, '--burst', burst, '--every', every];
        if (k === 'enemy' && mob) args.push('--target', mob.gid);
        if (k === 'ground' && mob) args.push('--cell', Math.round(mob.position[0]), Math.round(mob.position[1]));
        if (k === 'friend') args.push('--target', 'self');
        const t0 = await evaluate('Date.now()');
        const r = await call('skill', args);
        const net = await evaluate(`window.roAgent.net(${t0})`);
        const started = await evaluate(`window.roAgent.effects ? window.roAgent.effects(${t0}) : null`);
        const after = await evaluate('window.roAgent.player()');
        const mobAfter = mob ? ((await call('state', ['12'])).entities || []).find(e => e.gid === mob.gid) : null;
        const chat = newLines(chatBefore, await evaluate('window.roAgent.chat(30)'));
        const problems = (r.errors || []).filter(e => !/userconfig/.test(e.text)).map(e => `${e.kind}: ${e.text.slice(0, 240)}`);
        const missing = missingSince(offset);
        const need = reqs.skills[skill.id] || {};
        const sp = before?.sp && after?.sp ? before.sp.sp - after.sp.sp : null;
        const line = {
            job, skill: skill.id, name: skill.name, aegis: need.name, kind: k, level: skill.level,
            requires: { weapons: need.weapons || [], ammo: need.ammo || [], state: need.state || null }, setup,
            picked: r.clicked?.pickedByClient ?? null, spSpent: sp,
            targetDamaged: mob ? (mobAfter ? mobAfter.hp?.hp < mob.hp?.hp || mobAfter.dead : true) : null,
            chat, problems, missing,
            sent: net?.sent || [], recv: net?.recv || [],
            unhandled: (net?.recv || []).filter(n => n.endsWith('(no handler)')),
            effects: started ? [...new Set(started.map(e => String(e.id) + (e.known ? '' : ' (not in EffectTable)')))] : null,
            sheet: sheet(job, skill, r.frames, `${job} ${skill.id} ${skill.name} (${k}) sp:${sp ?? '?'} ${chat.slice(-1)[0] || ''}`),
        };
        if (problems.length || missing.length || line.unhandled.length) bad++;
        console.log(JSON.stringify(line));
    }
    console.error(`job ${job} (${me?.name}): ${skills.length} skills, ${bad} with client errors/warnings, missing files or unhandled packets`);
}

(async () => {
    const [reqFile, ...jobArgs] = process.argv.slice(2);
    const jobs = jobArgs.map(Number).filter(Boolean);
    if (!reqFile || !jobs.length) { console.error('usage: rotest-skill-sweep.cjs <reqs.json> <jobId> ...'); process.exit(2); }
    reqs = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
    for (const job of jobs) await sweepJob(job);
})().catch(e => { console.error(e); process.exit(1); });
