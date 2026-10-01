// "Sign in with Google / Apple" on the login window, for a friend playing
// through the host's invitation link (docs/FRIENDS_SHARING.md).
//
// Only the friend gateway answers /_friend/sign-in/status, and only with
// `enabled` when the host has set sign-in up. Anywhere else -- the host's own
// window on 127.0.0.1:3338, a LAN join, a host without keys -- the request
// fails or says no, and the login window is left exactly as it was.
//
// Signing in happens on the gateway's pages. What comes back here is an
// account name and a one-time token (60 seconds, one use), which this puts in
// the login window's own fields and submits the way the Connect button does:
// the login server accepts the token in place of a password.
//
// Later: when the replaceable pre-game screens land (task 30, the fork's
// `pregame-hooks`), this becomes that hook's default login screen's provider
// buttons, and `continueSignedIn` its submit path. Nothing here depends on the
// window's layout beyond the three fields every WinLogin version shares
// (.user, .pass, .connect in WinLoginCommon.js).
import Runtime from './ExtensionRuntime.mjs';

// Every version of the window: WinLogin, WinLoginV2, WinLoginV3.
const LOGIN = /^WinLogin(V\d+)?$/;
const NAMES = { google: 'Sign in with Google', apple: 'Sign in with Apple' };
let state = null;

async function status() {
    if (state) return state;
    try {
        const response = await fetch('/_friend/sign-in/status', { credentials: 'same-origin', cache: 'no-store' });
        state = response.ok ? await response.json() : { enabled: false };
    } catch { state = { enabled: false }; }
    return state;
}

async function continueSignedIn(root, button) {
    button.disabled = true;
    try {
        const response = await fetch('/_friend/sign-in/token', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' }, body: '{}' });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.username || !result.token) throw Error(result.error || 'Sign-in failed. Try again.');
        const user = root.querySelector('.user'), pass = root.querySelector('.pass'), connect = root.querySelector('.connect');
        user.value = result.username; pass.value = result.token;
        connect.click();
        // The window is removed on connect; if not, do not leave the token in it.
        pass.value = '';
    } catch (error) {
        button.disabled = false;
        button.title = error.message;
        button.textContent = error.message;
    }
}

function decorate(item, current) {
    if (!LOGIN.test(item.name) || !item.root) return;
    // The window is reused; what it should offer may have changed since.
    item.root.querySelector('.ro-sign-in')?.remove();
    if (!current.enabled) return;
    const panel = document.createElement('div');
    panel.className = 'ro-sign-in';
    panel.style.cssText = 'position:absolute;left:0;right:0;top:100%;margin-top:6px;display:flex;flex-direction:column;gap:4px;font:12px/1.4 sans-serif;';
    const button = (text, onClick) => {
        const element = document.createElement('button');
        element.type = 'button'; element.textContent = text;
        element.style.cssText = 'padding:6px 10px;border:1px solid #7b8fb6;border-radius:4px;background:#f4f6fb;color:#1c2333;cursor:pointer;';
        // The login window treats any mousedown as its own; keep ours ours.
        element.addEventListener('mousedown', event => event.stopImmediatePropagation());
        element.addEventListener('click', event => { event.stopImmediatePropagation(); onClick(element); });
        return element;
    };
    if (current.signedIn && !current.needsAccount) {
        panel.append(button(`Continue as ${current.email}`, element => continueSignedIn(item.root, element)));
    } else if (current.signedIn) {
        panel.append(button(`Finish setting up ${current.email}`, () => { location.href = '/_friend/'; }));
    } else {
        for (const provider of current.providers || []) {
            panel.append(button(NAMES[provider] || provider, () => { location.href = '/_friend/sign-in/start?provider=' + encodeURIComponent(provider); }));
        }
    }
    const host = item.root.querySelector('#WinLogin') || item.root.firstElementChild || item.root;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(panel);
}

export function install() {
    const { api } = Runtime.scope('ragnarok:sign-in');
    api.on('ui:append', item => {
        if (!LOGIN.test(item.name)) return;
        // Asked again each time the window opens: a sign-in may have finished
        // in between (the window comes back after a disconnect).
        state = null;
        status().then(current => decorate(item, current));
    });
}
