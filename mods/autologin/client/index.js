// autologin: open the game on your own character again, without the login
// and character-select screens. README.md has the whole story; in short:
//
//   - The first time you play a character, the app (or, for a friend, the
//     friend gateway) is asked to remember this login. What it keeps is a
//     random credential the page never sees -- never your password.
//   - On every later launch the credential is traded for a one-time login
//     token, which logs you in, and the character you played last is
//     selected and played. Neither screen is drawn.
//   - Escape -> Character select: the next launch stops at character select
//     (still logged in for you). Escape -> Exit, or Cancel on character
//     select: the remembered login is revoked and you see the login screen.
//   - Hold Shift while the game starts to skip it once.
//
// Everything here goes through the client API: api.screens drives the two
// screens, api.account keeps the login, the 'exit' event says what the
// player chose. Nothing here can read a password or the credential.

const STATE_KEY = 'state';
// How long character select may take to list the remembered character.
const LIST_WAIT_MS = 6000;
// How long after Play before the screen is handed back if nothing happened.
const PLAY_WAIT_MS = 20000;
// Refusals in a row before a remembered login is given up on. One can be the
// server restarting; two is a login server that will not take it.
const MAX_REFUSALS = 2;

const CARD_CSS = `
:host { all: initial; }
.veil { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 14vh; box-sizing: border-box;
  background: rgba(8, 10, 18, .55); font: 13px/1.45 system-ui, sans-serif; color: #eef1fa; }
.card { min-width: 260px; max-width: 360px; padding: 16px 18px; border-radius: 8px;
  background: rgba(22, 26, 40, .94); border: 1px solid #56618a; box-shadow: 0 8px 30px rgba(0,0,0,.45); text-align: center; }
.title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.hint { opacity: .75; font-size: 12px; margin-top: 8px; }
button { margin-top: 12px; padding: 5px 14px; border-radius: 4px; border: 1px solid #7b8fb6;
  background: #2b3350; color: #eef1fa; font: inherit; cursor: pointer; }
button:hover { background: #3a4570; }
`;

export function readState(value) {
    const state = value && typeof value === 'object' ? value : {};
    return {
        remembered: state.remembered === true,
        username: typeof state.username === 'string' ? state.username.slice(0, 32) : '',
        characterId: Number.isInteger(state.characterId) && state.characterId > 0 ? state.characterId : null,
        characterName: typeof state.characterName === 'string' ? state.characterName.slice(0, 32) : '',
        refusals: Number.isInteger(state.refusals) && state.refusals > 0 ? Math.min(state.refusals, 99) : 0,
        plainHttpNoted: state.plainHttpNoted === true,
    };
}

/**
 * The mod, with everything it touches passed in so a test can drive it.
 * env: { window, document, setTimeout, clearTimeout }.
 */
export function createAutologin(api, parameters = {}, env = globalThis) {
    const win = env.window || env;
    const doc = env.document;
    const later = env.setTimeout || setTimeout;
    const cancelLater = env.clearTimeout || clearTimeout;
    const rememberCharacter = parameters?.remember_character !== false;

    let state = readState(api.preferences.get(STATE_KEY, {}));
    const save = next => {
        state = readState({ ...state, ...next });
        try { api.preferences.set(STATE_KEY, state); } catch { /* storage off: this launch still works */ }
    };
    const clear = () => save({ remembered: false, username: '', characterId: null, characterName: '', refusals: 0 });

    // --- Saying why, once -------------------------------------------------
    let notice = null;
    function tell(message) {
        if (!doc?.createElement || !doc.body) return;
        notice?.remove();
        notice = doc.createElement('div');
        notice.className = 'ro-autologin-notice';
        notice.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483000;max-width:min(520px,90vw);'
            + 'padding:9px 14px;border-radius:6px;background:rgba(22,26,40,.95);border:1px solid #c79a4b;color:#f3e7cf;'
            + 'font:13px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;';
        notice.textContent = message;
        doc.body.appendChild(notice);
        const shown = notice;
        later(() => { if (notice === shown) { shown.remove(); notice = null; } }, 9000);
    }
    api.cleanup(() => notice?.remove());

    // --- Shift skips it once ----------------------------------------------
    let shift = false;
    const onKey = event => { if (event.key === 'Shift') shift = event.type === 'keydown'; };
    win.addEventListener?.('keydown', onKey, true);
    win.addEventListener?.('keyup', onKey, true);
    win.addEventListener?.('blur', () => { shift = false; });
    api.cleanup(() => { win.removeEventListener?.('keydown', onKey, true); win.removeEventListener?.('keyup', onKey, true); });

    // --- Driving the two screens -------------------------------------------
    // stage: 'idle' (nothing to do, or done), 'login' (signing in),
    // 'charSelect' (waiting to play), 'playing' (Play pressed).
    let stage = 'idle';
    let removeLogin = null, removeCharSelect = null;
    let listTimer = null, playTimer = null;
    let submitted = false;
    let card = null;

    function drawCard(root, title, cancelLabel) {
        if (!root || !doc?.createElement) return;
        const style = doc.createElement('style');
        style.textContent = CARD_CSS;
        const veil = doc.createElement('div'); veil.className = 'veil';
        const box = doc.createElement('div'); box.className = 'card';
        const heading = doc.createElement('div'); heading.className = 'title'; heading.textContent = title;
        const hint = doc.createElement('div'); hint.className = 'hint';
        hint.textContent = 'Hold Shift while the game starts to skip this.';
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = cancelLabel;
        button.addEventListener('click', () => stop('cancelled'));
        box.append(heading, hint, button); veil.append(box);
        root.replaceChildren?.(style, veil);
        card = { heading };
    }

    // Hand both screens back to the client. Deferred: this can be reached
    // from inside a screen's own show(), and the client's window should
    // come back after that call has returned.
    function release() {
        stage = 'idle';
        if (listTimer) { cancelLater(listTimer); listTimer = null; }
        if (playTimer) { cancelLater(playTimer); playTimer = null; }
        const login = removeLogin, charSelect = removeCharSelect;
        removeLogin = removeCharSelect = null;
        card = null;
        later(() => { login?.(); charSelect?.(); }, 0);
    }

    function stop(reason, message) {
        if (stage === 'idle') return;
        release();
        if (message) tell(message);
        else if (reason === 'cancelled') tell('Automatic login stopped for this launch.');
    }

    async function signIn(view) {
        let answer;
        try {
            answer = await api.account.resume();
        } catch (error) {
            if (stage !== 'login') return;
            if (error?.code === 'revoked' || error?.code === 'none') {
                clear();
                // Revoked (Exit elsewhere, a password change), lapsed after 30
                // days unused, or the account disabled -- or the app no longer
                // has it. Already forgotten on the server's side.
                return stop('stale', 'Your remembered login has ended (it was signed out, changed or unused for 30 days), so here is the login screen. Log in and play to be remembered again.');
            }
            return stop('unavailable', `Could not log you in automatically: ${error?.message || 'the server did not answer'}.`);
        }
        if (stage !== 'login') return;
        if (shift) return stop('cancelled');
        submitted = true;
        // Already remembered: this login does not need a new credential.
        rememberedThisLogin = true;
        save({ username: answer.username });
        try { view.login(answer.username, answer.token); }
        catch (error) { stop('failed', `Could not log you in automatically: ${error.message}`); }
    }

    // The login went through: the screen after it opened. The login hook
    // goes now, so a later visit to the login screen is the client's own.
    function accepted() {
        if (stage !== 'login' || !submitted) return;
        const login = removeLogin;
        removeLogin = null;
        later(() => login?.(), 0);
        if (state.refusals) save({ refusals: 0 });
        stage = removeCharSelect ? 'charSelect' : 'idle';
        if (!removeCharSelect) card = null;
    }

    function onLoginShow(view) {
        if (stage !== 'login') return;
        // Shown again after we sent the token: the server said no, and the
        // client's own message box has said why.
        if (submitted) {
            const refusals = state.refusals + 1;
            if (refusals >= MAX_REFUSALS) {
                api.account.forget();
                clear();
                return stop('refused', 'The server has not accepted the remembered login twice, so it has been forgotten. Log in and play to be remembered again.');
            }
            save({ refusals });
            return stop('refused', 'The server did not accept the automatic login. It will be tried again next time.');
        }
        if (shift) return stop('cancelled');
        drawCard(view.root, state.username ? `Logging in as ${state.username}…` : 'Logging in…', 'Show the login screen');
        signIn(view);
    }

    function onCharSelect(view) {
        accepted();
        if (stage === 'playing') return;
        if (stage !== 'charSelect') return;
        if (!card) drawCard(view.root, state.characterName ? `Entering as ${state.characterName}…` : 'Entering the game…', 'Choose a character');
        if (shift) return stop('cancelled');
        const character = view.characters.find(entry => entry.id === state.characterId);
        if (character && character.deletePending) {
            save({ characterId: null, characterName: '' });
            return stop('deleting', `${character.name} is waiting to be deleted, so it was not played. Choose a character.`);
        }
        if (character && view.enabled) {
            stage = 'playing';
            if (listTimer) { cancelLater(listTimer); listTimer = null; }
            // Nothing more from the client within the wait: give the screen back.
            playTimer = later(() => stop('timeout', 'The game did not open your character. Choose it again.'), PLAY_WAIT_MS);
            try { view.play(character.slot); }
            catch (error) { stop('failed', `Could not enter the game automatically: ${error.message}`); }
            return;
        }
        if (!listTimer) {
            listTimer = later(() => {
                listTimer = null;
                if (stage !== 'charSelect') return;
                const name = state.characterName || 'Your last character';
                save({ characterId: null, characterName: '' });
                stop('missing', `${name} is not on this account any more. Choose a character.`);
            }, LIST_WAIT_MS);
        }
    }

    function begin() {
        if (!state.remembered) return false;
        if (shift) { tell('Shift was held: automatic login skipped for this launch.'); return false; }
        stage = 'login';
        submitted = false;
        removeLogin = api.screens.replace('login', {
            show: onLoginShow,
            update() {},
            hide() {},
        });
        if (rememberCharacter && state.characterId) {
            removeCharSelect = api.screens.replace('charSelect', {
                show: onCharSelect,
                update: onCharSelect,
                // The window closes on Play (and on Cancel); once playing,
                // map:enter finishes the job.
                hide() { if (stage === 'charSelect') stop('closed'); },
            });
        }
        return true;
    }

    // --- Keeping the remembered login in step with the player --------------
    let rememberedThisLogin = false;

    api.on('map:enter', () => {
        const player = api.snapshot().player;
        if (stage !== 'idle') {
            // Arrived where we were taking the player.
            release();
        }
        if (rememberCharacter && player?.characterId && player.characterId !== state.characterId) {
            save({ characterId: player.characterId, characterName: player.name || '' });
        }
        if (state.refusals) save({ refusals: 0 });
        if (rememberedThisLogin) return;
        rememberedThisLogin = true;
        api.account.remember().then(
            result => {
                save({ remembered: true, username: result.username });
                // Once: a LAN address over plain HTTP. The cookie is HttpOnly,
                // but the network can see it.
                if (result.secure === false && !state.plainHttpNoted) {
                    save({ plainHttpNoted: true });
                    tell('Remembered over plain HTTP: anyone on this network could read it. For more safety, ask the host for their HTTPS sharing link.');
                }
            },
            error => {
                // Not offered here (a LAN join, an old client): say nothing.
                if (error?.code !== 'unavailable' && error?.code !== 'unsupported') tell(`This login could not be remembered: ${error.message}`);
            });
    }, { replay: false });

    api.on('exit', event => {
        if (event.to === 'charSelect') {
            // Next launch stops at character select, still logged in.
            save({ characterId: null, characterName: '' });
            return;
        }
        // Out to the login screen: forget the login, here and on the server.
        rememberedThisLogin = false;
        clear();
        api.account.forget();
    }, { replay: false });

    // A new login on this page (after Exit, or a disconnect) is remembered
    // afresh on its first map.
    api.on('ui:append', item => {
        if (/^WinLogin(V\d+)?$/.test(item.name)) rememberedThisLogin = false;
        // Past the login screen: character select, or a list of servers.
        if (/^(CharSelect(V\d+)?|WinList)$/.test(item.name)) accepted();
    }, { replay: false });

    return { begin, stop, get stage() { return stage; }, get state() { return state; } };
}

export default function init(parameters, api) {
    if (api?.version !== 1 || !api.screens?.supported?.() || !api.account) return;
    const autologin = createAutologin(api, parameters, globalThis);
    autologin.begin();
    return () => autologin.stop('disposed');
}
