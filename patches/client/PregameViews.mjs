// What a mod sees of the screens before the game (api.screens).
//
// The roBrowser fork's UI/ScreenHooks.js hands each hook the window's own
// live context: its fields read the window's state, its functions are the
// window's buttons. This module turns that into what a plugin gets -- a
// frozen copy of the data, so a mod cannot reach into the window's arrays,
// and actions that check their arguments before the window acts on them.
//
// No roBrowser imports, so tests can run it under plain node.

export const SCREENS = Object.freeze(['login', 'serverList', 'charSelect', 'charCreate']);

function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

// An integer, from a number or a numeric string; NaN for anything else.
const int = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isInteger(Number(value)) ? Number(value) : NaN;
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

// The parts of a character the sprite is drawn from. Names are the ones
// roBrowser's Entity.set reads, so a look goes straight to api.screens.stage.
export const LOOK_KEYS = Object.freeze(['job', 'sex', 'head', 'headpalette', 'bodypalette', 'weapon', 'shield',
    'accessory', 'accessory2', 'accessory3', 'robe', 'body', 'effectState']);

export function look(character) {
    return {
        job: number(character.job), sex: number(character.sex), head: number(character.head),
        headpalette: number(character.headpalette), bodypalette: number(character.bodypalette),
        weapon: number(character.weapon), shield: number(character.shield),
        accessory: number(character.accessory), accessory2: number(character.accessory2), accessory3: number(character.accessory3),
        robe: number(character.Robe ?? character.robe), body: number(character.body), effectState: number(character.effectState),
    };
}

/** A plain copy of one character-list entry. */
export function character(info, { jobName = () => '', mapName = () => '' } = {}) {
    return {
        id: number(info.GID), slot: number(info.CharNum), name: String(info.name ?? ''),
        job: number(info.job), jobName: String(jobName(info.job) || ''),
        level: number(info.level), jobLevel: number(info.joblevel), exp: number(info.exp), jobExp: number(info.jobexp),
        hp: number(info.hp), maxHp: number(info.maxhp), sp: number(info.sp), maxSp: number(info.maxsp),
        zeny: number(info.money),
        stats: { str: number(info.Str), agi: number(info.Agi), vit: number(info.Vit),
            int: number(info.Int), dex: number(info.Dex), luk: number(info.Luk) },
        map: String(info.lastMap ?? '').replace(/\.gat$/i, ''), mapName: String(mapName(info.lastMap) || ''),
        sex: number(info.sex),
        // Waiting out the deletion delay. The time itself is left out: the
        // client keeps it as a date on some packet versions and as a
        // countdown on others.
        deletePending: Boolean(info.DeleteDate),
        look: look(info),
    };
}

function slotChecker(ctx) {
    return slot => {
        const value = int(slot);
        if (!Number.isInteger(value) || value < 0 || value >= ctx.maxSlots) throw new RangeError(`slot must be 0..${ctx.maxSlots - 1}`);
        return value;
    };
}

function inRange(value, range, what) {
    const v = int(value);
    if (!Number.isInteger(v) || v < range.min || v > range.max) throw new RangeError(`${what} must be ${range.min}..${range.max}`);
    return v;
}

/**
 * The view handed to a mod's show() and update(): data plus actions.
 * `extras` adds what the bridge owns: root (the mod's layer) and lookups.
 */
export function buildView(screen, ctx, extras = {}) {
    const base = { screen, root: extras.root ?? null };
    switch (screen) {
        case 'login':
            return Object.freeze({ ...base,
                savedId: String(ctx.savedId ?? ''), saveId: Boolean(ctx.saveId),
                // The same path the Connect button takes. `password` is what
                // the login packet carries: a password, or a token a sign-in
                // service issued in place of one.
                login(user, password, options = {}) {
                    if (typeof user !== 'string' || !user.length || user.length > 64) throw new TypeError('login: user must be a non-empty string');
                    if (typeof password !== 'string' || password.length > 4096) throw new TypeError('login: password must be a string');
                    ctx.login(user, password, typeof options?.saveId === 'boolean' ? options.saveId : undefined);
                },
                signup: () => { ctx.signup(); },
                exit: () => { ctx.exit(); },
            });
        case 'serverList': {
            const servers = freeze((ctx.servers || []).map((label, index) => ({ index, label: String(label) })));
            return Object.freeze({ ...base, servers, index: int(ctx.index) || 0,
                select(index) {
                    const value = int(index);
                    if (!Number.isInteger(value) || value < 0 || value >= servers.length) throw new RangeError('select: no such server');
                    ctx.select(value);
                },
                exit: () => { ctx.exit(); },
            });
        }
        case 'charSelect': {
            const characters = freeze((ctx.characters || []).map(info => character(info, extras))
                .sort((a, b) => a.slot - b.slot));
            const checkSlot = slotChecker(ctx);
            const pick = slot => { if (slot !== undefined) ctx.select(checkSlot(slot)); };
            const index = int(ctx.index) || 0;
            return Object.freeze({ ...base, characters, maxSlots: int(ctx.maxSlots) || 0, index,
                selected: characters.find(entry => entry.slot === index) || null,
                sex: number(ctx.sex), enabled: Boolean(ctx.enabled), deleteReservation: Boolean(ctx.deleteReservation),
                select(slot) { ctx.select(checkSlot(slot)); },
                // Each acts on the selected slot, or selects `slot` first --
                // exactly what the window's own buttons do.
                play(slot) { pick(slot); ctx.play(); },
                create(slot) { pick(slot); ctx.create(); },
                requestDelete(slot) { pick(slot); ctx.requestDelete(); },
                cancelDelete(slot) { pick(slot); ctx.cancelDelete(); },
                confirmDelete(slot) { pick(slot); ctx.confirmDelete(); },
                exit: () => { ctx.exit(); },
            });
        }
        case 'charCreate': {
            const races = freeze((ctx.races || []).map(race => ({ job: number(race.job), name: String(extras.jobName?.(race.job) || ''),
                hair: { min: number(race.hair?.min), max: number(race.hair?.max) },
                hairColor: { min: number(race.hairColor?.min), max: number(race.hairColor?.max) } })));
            const sex = number(ctx.sex);
            const chooseSex = Boolean(ctx.chooseSex);
            return Object.freeze({ ...base, sex, chooseSex, races, hasStats: Boolean(ctx.hasStats),
                // { name, job, sex, hair, hairColor, stats? }. The server
                // has the last word: a refusal comes back as the client's
                // own message box.
                create(spec = {}) {
                    const race = races.find(entry => entry.job === number(spec.job, races[0]?.job));
                    if (!race) throw new RangeError('create: job must be one of races[].job');
                    if (typeof spec.name !== 'string') throw new TypeError('create: name must be a string');
                    const chosen = chooseSex && spec.sex !== undefined ? int(spec.sex) : sex;
                    if (chosen !== 0 && chosen !== 1) throw new RangeError('create: sex must be 0 or 1');
                    const stats = {};
                    for (const key of ['str', 'agi', 'vit', 'int', 'dex', 'luk']) stats[key] = int(spec.stats?.[key] ?? 5);
                    ctx.create({ name: spec.name, job: race.job, sex: chosen,
                        hair: inRange(spec.hair ?? race.hair.min, race.hair, 'hair'),
                        hairColor: inRange(spec.hairColor ?? race.hairColor.min, race.hairColor, 'hairColor'),
                        stats });
                },
                exit: () => { ctx.exit(); },
            });
        }
        default:
            throw new TypeError(`unknown screen ${screen}`);
    }
}
