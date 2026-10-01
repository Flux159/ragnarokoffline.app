#!/usr/bin/env node
// rotest -- drive a disposable Ragnarok Offline world from the command line.
//
// One daemon owns the world's asset server and one Chromium page on
// http://127.0.0.1:3338/. Every other command is a short HTTP call to it that
// prints JSON, so an agent can play the game one step at a time: log in, run
// GM commands, walk, attack, cast, and look (screenshots, state). Clicks and
// keys go through real input, so they exercise the same client code a player's
// do. docs/AGENT_TESTING.md is the guide.
//
// The world is tests/e2e/world.cjs's: its own runtime, save and database under
// RO_E2E_WORLD, never the player's.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const home = process.env.HOME || process.env.USERPROFILE || '';
const appData = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Ragnarok Offline')
    : process.platform === 'win32' ? path.join(process.env.APPDATA || '', 'Ragnarok Offline')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Ragnarok Offline');
const WORLD = path.resolve(process.env.RO_E2E_WORLD || path.join(repo, 'artifacts/agent-world'));
const PORT = Number(process.env.ROTEST_PORT || 7480);
const OUT = path.resolve(process.env.ROTEST_OUT || path.join(repo, 'artifacts/rotest'));
const env = { ...process.env, RO_E2E_WORLD: WORLD,
    RO_E2E_RUNTIME: process.env.RO_E2E_RUNTIME || path.join(appData, 'runtime'),
    RO_E2E_CLIENT_JSON: process.env.RO_E2E_CLIENT_JSON || path.join(appData, 'client.json') };

const USAGE = `usage: rotest <command> [args]

world:   prepare | up | down | backup      the disposable world (tests/e2e/world.cjs); up also makes tester
         world tester                      make the tester account in an existing world
daemon:  start [--headed] | stop | status  asset server + browser, kept running
server:  server <args>                     the world's ragnarok-stack: logs map 100, sql "...", status

  login [user] [pass]        default tester / tester123 (made by world up); ragnarok / ragnarok is the GM-sprite account
  char <slot>                enter the game with the character in <slot> (0-based)
  create <slot> <name>       make a character in an empty slot, then enter with it
  gm <text> | say <text>     type into the chat box and send (e.g. gm "@jobchange 4252")
  state [radius]             player, nearby entities, chat, new errors
  equip <itemId>             equip an item already in the inventory
  skills [filter]            skills the character has: id, name, level, sp, range, type
  hover <x> <y> [--px]       put the cursor on a cell (or pixels); what the client sees there
  shot [name]                screenshot; prints the file
  walk <x> <y>               click that map cell, wait for the walk to end
  attack [gid|nearest]       click a monster (a real click on it)
  skill <id> [level] [--target <gid|nearest>] [--cell <x> <y>] [--burst N [--every ms]]
                             cast via the skill window's path, then click the target
  click <x> <y> [right]      raw mouse click at page pixels
  key <key>                  press a key (Playwright names: Enter, Escape, F1, Alt+E ...)
  eval <js>                  run JS in the page (window.roAgent is there); prints the result
  wait <ms>
  errors                     every console/page error since start

Environment: RO_E2E_WORLD (default artifacts/agent-world), RO_E2E_RUNTIME,
RO_E2E_CLIENT_JSON, ROTEST_PORT (7480), ROTEST_OUT (artifacts/rotest).`;

// ---------------------------------------------------------------- client side

// The world's own ragnarok-stack, with the environment world.cjs gives it.
const SUFFIX = process.platform === 'win32' ? '.exe' : '';
const STACK = path.join(WORLD, 'runtime', 'bin', 'ragnarok-stack' + SUFFIX);
function stackEnv() {
    const root = path.join(WORLD, 'runtime');
    return { ...env,
        RAGNAROK_OFFLINE_ROOT: root, RAGNAROK_OFFLINE_HOME: WORLD, RAGNAROKMAC_STATE: path.join(WORLD, 'state'),
        NEBULA_HOME: path.join(WORLD, 'nebula'), NEBULA_BIN: path.join(root, 'bin', 'nebula' + SUFFIX),
        RAGNAROKMAC_DOCKER: path.join(root, 'bin', 'docker-slim' + SUFFIX) };
}
function stack(args, stdio = 'pipe', input) {
    return spawnSync(STACK, args, { stdio, input, encoding: 'utf8', env: stackEnv() });
}

// The world's game page: on 3338, or wherever RAGNAROK_OFFLINE_ASSET_PORT
// moved it so the world can run beside the player's app. The world's own
// supervisor decides (electron/ports.js), as it does for world.cjs.
let gameUrl = null;
function game() {
    return gameUrl ||= `http://127.0.0.1:${require('../electron/ports').readPorts(STACK, stackEnv()).asset}/`;
}

// The play-testing account every world should have: `tester` / `tester123`,
// in the GM group so @commands work, and -- unlike the built-in `ragnarok`
// account -- not on the client's adminList, so the client draws its real
// class outfit instead of the GM sprite. Made once; a no-op after that.
const TESTER = { user: 'tester', pass: 'tester123' };
function ensureTester() {
    const has = stack(['sql', `SELECT group_id FROM login WHERE userid='${TESTER.user}'`]);
    const group = (has.stdout || '').trim().split('\n').slice(1).join('').trim();
    if (group === '99') { console.log(`test account ready: ${TESTER.user} / ${TESTER.pass}`); return true; }
    if (!group) {
        const made = stack(['accounts'], 'pipe', JSON.stringify({ era: fs.existsSync(path.join(WORLD, 'state/prerenewal')) ? 'prerenewal' : 'renewal',
            action: 'create', username: TESTER.user, password: TESTER.pass, confirmation: TESTER.pass }));
        if (made.status !== 0) { console.error('could not create the tester account:', made.stderr || made.stdout); return false; }
    }
    const gm = stack(['sql', '--write', `UPDATE login SET group_id=99 WHERE userid='${TESTER.user}'`]);
    if (gm.status !== 0) { console.error('could not give tester GM commands:', gm.stderr || gm.stdout); return false; }
    console.log(`test account ready: ${TESTER.user} / ${TESTER.pass} (GM commands, drawn as its class)`);
    return true;
}

function call(cmd, args) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ cmd, args });
        const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function running() {
    try { return (await call('ping', [])).status === 200; } catch { return false; }
}

async function client(argv) {
    const [cmd, ...args] = argv;
    if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
    if (cmd === 'world') {
        const sub = args[0];
        // For a world that was made before `up` created it.
        if (sub === 'tester') { process.exitCode = ensureTester() ? 0 : 1; return; }
        const r = spawnSync(process.execPath, [path.join(repo, 'tests/e2e/world.cjs'), sub], { env, stdio: 'inherit' });
        process.exitCode = r.status ?? 1;
        if (sub === 'up' && r.status === 0) process.exitCode = ensureTester() ? 0 : 1;
        return;
    }
    if (cmd === 'server') {
        // The world's own supervisor, with the environment world.cjs gives it:
        // `rotest server logs map 200`, `rotest server sql "SELECT ..."`.
        const r = stack(args, 'inherit');
        process.exitCode = r.status ?? 1;
        return;
    }
    if (cmd === 'start') {
        if (await running()) { console.log(JSON.stringify({ ok: true, already: true })); return; }
        fs.mkdirSync(OUT, { recursive: true });
        const log = fs.openSync(path.join(OUT, 'daemon.log'), 'a');
        const child = spawn(process.execPath, [__filename, '__daemon', ...args], { env, detached: true, stdio: ['ignore', log, log] });
        child.unref();
        for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (await running()) { console.log(JSON.stringify({ ok: true, pid: child.pid, log: path.join(OUT, 'daemon.log') })); return; }
            try { process.kill(child.pid, 0); } catch { break; }
        }
        console.error('daemon did not come up; see ' + path.join(OUT, 'daemon.log'));
        process.exitCode = 1;
        return;
    }
    if (!(await running())) {
        if (cmd === 'stop' || cmd === 'status') { console.log(JSON.stringify({ ok: true, running: false })); return; }
        console.error('rotest daemon is not running. Run `rotest world up` and `rotest start` first.');
        process.exitCode = 1;
        return;
    }
    const { status, body } = await call(cmd, args);
    console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    if (status !== 200) process.exitCode = 1;
}

// ---------------------------------------------------------------- daemon side

async function daemon(flags) {
    const { chromium } = require('@playwright/test');
    const headed = flags.includes('--headed');
    fs.mkdirSync(OUT, { recursive: true });
    const log = (...a) => console.log(new Date().toISOString(), ...a);

    // The world's asset server. world.cjs serve owns it and stops it on SIGTERM.
    const serve = spawn(process.execPath, [path.join(repo, 'tests/e2e/world.cjs'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    serve.stdout.on('data', d => log('[serve]', String(d).trim()));
    serve.stderr.on('data', d => log('[serve!]', String(d).trim()));
    for (let i = 0; ; i++) {
        try { await fetch(game()); break; } catch {
            if (i > 60 || serve.exitCode !== null) throw new Error('asset server did not start (is `rotest world up` done?)');
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    const browser = await chromium.launch({ headless: !headed, args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { try { localStorage.setItem('roAgent', '1'); } catch {} });
    const page = await context.newPage();
    const errors = [];
    let errorsSeen = 0;
    page.on('pageerror', e => errors.push({ at: Date.now(), kind: 'pageerror', text: String(e.stack || e.message).slice(0, 2000) }));
    // Warnings too: roBrowser reports an unhandled packet ("Packet 0x... not
    // registered") as a warning, and that is often the whole bug.
    page.on('console', m => {
        const kind = m.type() === 'error' ? 'console' : m.type() === 'warning' ? 'warning' : null;
        if (kind) errors.push({ at: Date.now(), kind, text: m.text().slice(0, 2000) });
    });
    page.on('response', r => { if (r.status() >= 400) errors.push({ at: Date.now(), kind: 'http', text: `${r.status()} ${new URL(r.url()).pathname}` }); });
    await page.goto(game(), { waitUntil: 'domcontentloaded' });
    log('browser ready', headed ? '(headed)' : '(headless)');

    const agent = (fn, arg) => page.evaluate(([f, a]) => {
        if (!window.roAgent) throw new Error('window.roAgent missing: client built without AgentHook, or not in game yet');
        return window.roAgent[f](...(a || []));
    }, [fn, arg]);
    // As the e2e suite does: on a map and able to move, not merely a player
    // entity (which exists before the map has loaded).
    const inGame = () => page.evaluate(() => {
        const s = window.roClientDiagnostics?.snapshot();
        return Boolean(s?.map && s.input?.canMove && window.roAgent?.player());
    }).catch(() => false);
    const until = async (test, ms = 15000, step = 200) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await test()) return true; await page.waitForTimeout(step); }
        return false;
    };
    // In game and the camera set up: the player's own cell projects on screen.
    const settled = () => until(async () => (await inGame()) && await page.evaluate(() => {
        const me = window.roAgent.player();
        return Boolean(me && window.roAgent.project(Math.round(me.position[0]), Math.round(me.position[1])).onScreen);
    }).catch(() => false), 60000, 300);
    const newErrors = () => { const e = errors.slice(errorsSeen); errorsSeen = errors.length; return e; };
    const shot = async (name, clip) => {
        const file = path.join(OUT, `${(name || 'shot').replace(/[^\w.-]+/g, '_')}-${Date.now()}.png`);
        await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
        return file;
    };
    const player = () => agent('player');
    // What a click at (x, y) lands on. The game canvas means the map; anything
    // else is a window in the way, and the client never sees the click.
    const blocker = (x, y) => page.evaluate(([x, y]) => {
        let el = document.elementFromPoint(x, y);
        while (el?.shadowRoot?.elementFromPoint(x, y) && el.shadowRoot.elementFromPoint(x, y) !== el) el = el.shadowRoot.elementFromPoint(x, y);
        if (!el || el.tagName === 'CANVAS') return null;
        const host = el.getRootNode()?.host;
        return (host?.id || el.closest('[id]')?.id || el.tagName) + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');
    }, [x, y]);
    const findTarget = async spec => {
        // `self` (or the player's own id) for skills cast on a friend.
        const me = await player();
        if (spec === 'self' || String(spec) === String(me?.gid)) return me;
        const list = await agent('entities', [{ radius: 30 }]);
        if (!spec || spec === 'nearest') return list.find(e => e.type === 'MOB' && !e.dead) || null;
        return list.find(e => String(e.gid) === String(spec)) || null;
    };
    const clickEntity = async (target, button = 'left') => {
        await page.mouse.move(target.click.x, target.click.y);
        await page.waitForTimeout(120); // let a frame run so the client picks what is under the cursor
        const over = await agent('mouse');
        await page.mouse.click(target.click.x, target.click.y, { button });
        return over.over?.gid === target.gid;
    };
    // Type into the chat box and send. Only ever the visible input: with the
    // game menu (Escape) or a dialog open, Enter would press *their* default
    // button -- which is how a stray Enter logs a character out.
    const chatSend = async text => {
        let input = page.locator('.input-chatbox:visible').first();
        if (!(await input.count())) {
            const blocked = await page.evaluate(() => {
                const s = window.roClientDiagnostics?.snapshot();
                return s?.input?.capturing || !s?.map;
            }).catch(() => true);
            if (blocked) throw new Error('chat is not reachable: a menu or dialog is open, or not in game (see `rotest shot`)');
            await page.keyboard.press('Enter');
            input = page.locator('.input-chatbox:visible').first();
        }
        await input.fill(text, { timeout: 3000 });
        await input.press('Enter', { timeout: 3000 });
        await page.waitForTimeout(700);
        return agent('chat', [8]).catch(() => []);
    };

    const commands = {
        ping: async () => ({ ok: true }),
        status: async () => ({ ok: true, running: true, url: page.url(), inGame: await inGame(), errors: errors.length }),
        login: async ([user = TESTER.user, pass = TESTER.pass]) => {
            if (!page.url().startsWith(game())) await page.goto(game());
            await page.locator('#user').waitFor({ timeout: 60000 });
            await page.locator('#user').fill(user);
            await page.locator('#pass').fill(pass);
            await page.locator('.connect').click();
            const ok = await until(() => page.locator('#slot0').isVisible().catch(() => false), 30000);
            return { ok, screen: ok ? 'character select' : 'still on login (wrong password?)', shot: await shot('login'), errors: newErrors() };
        },
        char: async ([slot = '0']) => {
            await page.locator(`#slot${slot}`).dblclick();
            const ok = await settled();
            if (ok) await page.waitForTimeout(1000);
            return { ok, player: ok ? await player() : null, shot: await shot('entered'), errors: newErrors() };
        },
        create: async ([slot = '0', name]) => {
            if (!name) throw new Error('create <slot> <name>');
            await page.locator(`#slot${slot}`).dblclick();
            await page.waitForTimeout(1500);
            // The creation window is a shadow root; Playwright's CSS locators
            // pierce open ones, a plain querySelector does not.
            const form = page.locator('#CharCreatev4');
            await form.locator('input[type=text]').first().fill(name);
            const before = await shot('create-form');
            await form.locator('ui-button.make').click();
            // Back on character select, the new character sits in its slot.
            const ok = await until(async () => !(await form.isVisible().catch(() => false)), 15000);
            await page.waitForTimeout(1000);
            return { ok, next: `rotest char ${slot}`, shots: [before, await shot('created')], errors: newErrors() };
        },
        gm: async args => {
            const text = args.join(' ');
            const chat = await chatSend(text);
            // A warp reloads the map; wait for it rather than hand back a
            // half-loaded scene.
            if (/^[@#](warp|rura|go|jump|jumpto|load|return|recall)\b/i.test(text)) { await page.waitForTimeout(800); await settled(); }
            return { chat, player: await player().catch(() => null), errors: newErrors() };
        },
        // The inventory's own equip path (what a double-click on the item runs).
        equip: async ([id]) => {
            const result = await page.evaluate(id => {
                const inv = window.roAgent.modules.UIManager.getComponent('Inventory');
                const item = inv?.getItemById(Number(id));
                if (!item) return { ok: false, reason: `item ${id} is not in the inventory (gm "@item ${id}")` };
                inv.onEquipItem(item.index, item.location);
                return { ok: true, index: item.index, location: item.location };
            }, id);
            await page.waitForTimeout(800);
            return { ...result, chat: await agent('chat', [3]), errors: newErrors() };
        },
        // The skill window's rows, once each (every tab renders its own).
        skills: async ([filter]) => {
            const seen = new Set();
            return (await agent('skills')).filter(sk => !seen.has(sk.id) && seen.add(sk.id))
                .filter(sk => !filter || String(sk.id) === filter || sk.name.toLowerCase().includes(filter.toLowerCase()));
        },
        say: async args => ({ chat: await chatSend(args.join(' ')), errors: newErrors() }),
        state: async ([radius = '15']) => ({
            player: await player().catch(e => ({ error: e.message })),
            entities: await agent('entities', [{ radius: Number(radius) }]).catch(e => ({ error: e.message })),
            chat: await agent('chat', [10]).catch(() => []),
            mouse: await agent('mouse').catch(() => null),
            errors: newErrors(),
        }),
        shot: async ([name]) => ({ file: await shot(name) }),
        click: async ([x, y, button]) => { await page.mouse.click(Number(x), Number(y), { button: button === 'right' ? 'right' : 'left' }); await page.waitForTimeout(300); return { ok: true, errors: newErrors() }; },
        // Where the client thinks the cursor is: move to a cell's projected
        // point (or raw pixels with --px) and read back Mouse.world.
        hover: async ([x, y, flag]) => {
            const point = flag === '--px' ? { x: Number(x), y: Number(y) } : await agent('project', [Number(x), Number(y)]);
            await page.mouse.move(point.x, point.y);
            await page.waitForTimeout(150);
            return { point, coveredBy: await blocker(point.x, point.y), mouse: await agent('mouse') };
        },
        key: async ([key]) => { await page.keyboard.press(key); await page.waitForTimeout(300); return { ok: true, errors: newErrors() }; },
        wait: async ([ms = '1000']) => { await page.waitForTimeout(Number(ms)); return { ok: true }; },
        eval: async args => ({ result: await page.evaluate(src => {
            // eslint-disable-next-line no-new-func
            const value = new Function('return (async () => (' + src + '))()')();
            return Promise.resolve(value).then(v => JSON.parse(JSON.stringify(v ?? null)));
        }, args.join(' ')), errors: newErrors() }),
        walk: async ([x, y]) => {
            const target = await agent('project', [Number(x), Number(y)]);
            if (!target?.onScreen) return { ok: false, reason: 'cell is off screen; walk closer first or @warp', target };
            const covered = await blocker(target.x, target.y);
            if (covered) return { ok: false, reason: `a window covers that cell (${covered}); close or move it, or pick another cell`, target };
            await page.mouse.move(target.x, target.y);
            await page.waitForTimeout(120);
            const aimed = (await agent('mouse')).world;
            await page.mouse.click(target.x, target.y);
            // Done when the player reaches the cell, or started and then
            // stood still for a second, or never moved within three seconds.
            const start = Date.now(), from = (await player()).position.join(',');
            let last = from, stillSince = Date.now(), moved = false;
            while (Date.now() - start < 30000) {
                await page.waitForTimeout(250);
                const pos = (await player()).position;
                const p = pos.join(',');
                if (Math.round(pos[0]) === Number(x) && Math.round(pos[1]) === Number(y)) break;
                if (p !== last) { moved = true; last = p; stillSince = Date.now(); }
                if (moved && Date.now() - stillSince > 1000) break;
                if (!moved && Date.now() - start > 3000) break;
            }
            const me = await player();
            return { ok: Math.abs(me.position[0] - x) <= 1 && Math.abs(me.position[1] - y) <= 1, position: me.position,
                clicked: target, clientAimedAt: [aimed.x, aimed.y], errors: newErrors() };
        },
        attack: async ([spec]) => {
            const target = await findTarget(spec);
            if (!target) return { ok: false, reason: 'no such monster in range', nearby: (await agent('entities', [{ radius: 30 }])).slice(0, 8) };
            const hovered = await clickEntity(target);
            await page.waitForTimeout(2500);
            const after = (await agent('entities', [{ radius: 30 }])).find(e => e.gid === target.gid) || null;
            return { ok: hovered, pickedByClient: hovered, target, after, player: await player(), chat: await agent('chat', [5]), shot: await shot('attack'), errors: newErrors() };
        },
        skill: async args => {
            const id = Number(args[0]);
            const level = args[1] && !args[1].startsWith('--') ? Number(args[1]) : undefined;
            const t = args.indexOf('--target'), c = args.indexOf('--cell'), b = args.indexOf('--burst');
            const burst = b >= 0 ? Number(args[b + 1]) || 6 : 0;
            const ev = args.indexOf('--every');
            const every = ev >= 0 ? Number(args[ev + 1]) || 150 : 150;
            // A previous cast still waiting for a target would take this one's
            // click. Right-click cancels target selection; Escape would open
            // the game menu instead.
            if ((await agent('mouse')).state === await page.evaluate(() => window.roAgent.modules.Mouse.MOUSE_STATE.USESKILL)) {
                const me = await player();
                await page.mouse.click(me.cell.x, me.cell.y, { button: 'right' });
                await page.waitForTimeout(200);
            }
            const started = await agent('useSkill', [id, level]);
            let clicked = null;
            if (started.targeting && t >= 0) {
                const target = await findTarget(args[t + 1]);
                if (!target) return { ok: false, reason: 'target not found', started };
                clicked = { target, pickedByClient: await clickEntity(target) };
            } else if (started.targeting && c >= 0) {
                const cell = await agent('project', [Number(args[c + 1]), Number(args[c + 2])]);
                await page.mouse.click(cell.x, cell.y);
                clicked = { cell };
            }
            // Effects are over in a second or two, so a burst from the moment
            // of the cast catches them where one later screenshot does not.
            const frames = [];
            // Cropped to the player and what is in front of them, so a frame is
            // the effect rather than the whole screen.
            // Centred between the caster and whatever was clicked, so an
            // effect on a target a few cells away is in frame too.
            const me = await player();
            const vp = page.viewportSize();
            const aim = clicked?.target?.cell || clicked?.cell || me.cell;
            const cx = (me.cell.x + aim.x) / 2, cy = (me.cell.y + aim.y) / 2 - 40;
            const clip = { x: Math.round(Math.max(0, Math.min(vp.width - 560, cx - 280))), y: Math.round(Math.max(0, Math.min(vp.height - 420, cy - 210))), width: 560, height: 420 };
            for (let i = 0; i < burst; i++) { frames.push(await shot(`skill-${id}-f${i}`, clip)); await page.waitForTimeout(every); }
            await page.waitForTimeout(burst ? 600 : 2000);
            return { started, clicked, player: await player(), chat: await agent('chat', [6]), frames, shot: await shot(`skill-${id}`), errors: newErrors() };
        },
        errors: async () => ({ errors }),
        stop: async () => { setTimeout(async () => { await browser.close().catch(() => {}); serve.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000); }, 50); return { ok: true, stopping: true }; },
    };

    http.createServer((req, res) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', async () => {
            let out, code = 200;
            try {
                const { cmd, args } = JSON.parse(data || '{}');
                if (!commands[cmd]) { code = 400; out = { error: `unknown command ${cmd}`, usage: USAGE }; }
                else { log('>', cmd, JSON.stringify(args)); out = await commands[cmd](args || []); }
            } catch (e) { code = 500; out = { error: e.message }; }
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out));
        });
    }).listen(PORT, '127.0.0.1', () => log('listening on', PORT));
    const quit = () => { browser.close().catch(() => {}); serve.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000); };
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    serve.on('exit', code => { log('asset server exited', code); process.exit(1); });
}

if (process.argv[2] === '__daemon') daemon(process.argv.slice(3)).catch(e => { console.error(e); process.exit(1); });
else client(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
