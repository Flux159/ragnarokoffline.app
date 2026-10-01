// api.account: a remembered login, for the autologin mod (mods/autologin).
//
// The page never holds the remembered credential. It asks whoever serves it
// to keep one, and later to exchange it for a one-time login token:
//
//   - the host's own window -- the app's game window, on loopback, on
//     whatever port the asset server has -- asks the app over its one
//     game-page IPC handler, `remember_login`, which keeps the credential in a
//     file of its own (electron/remember-login.js). The app checks for itself
//     that the page is the one it loaded.
//   - everyone else posts to /_friend/remember/ on the origin they loaded the
//     game from, which keeps the credential in an HttpOnly cookie: a friend's
//     browser reaches the friend gateway (electron/sharing/gateway.js), a LAN
//     player's reaches the host's asset server, which hands the path to the
//     app (electron/sharing/lan-remember.js).
//
// Where neither answers -- a host without LAN remembering, a plain static
// server -- `status()` reports the feature unavailable.
//
// Remembering needs proof that this page is logged in to the account: the
// account id and the web auth token the login server gave the client at
// login (Session.AID, Session.WebToken). Those are passed in by the bridge
// and go only to the app or the gateway, never to a plugin.
//
// No roBrowser imports, so tests can run it under plain node.

// Local means this machine's own loopback, whatever the port; and only the
// app's window has `invoke` at all.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const failure = (code, message) => Object.assign(new Error(message), { code });

export function createAccount({ session = () => null, invoke = null, fetch: fetchImpl = globalThis.fetch, origin = () => globalThis.location?.origin } = {}) {
    const local = () => {
        if (typeof invoke !== 'function') return false;
        try { return LOOPBACK.has(new URL(origin()).hostname); } catch { return false; }
    };

    async function request(action, body = {}) {
        if (local()) {
            const answer = await invoke('remember_login', { action, ...body });
            return answer && typeof answer === 'object' ? answer : { ok: false, code: 'unavailable', error: 'No answer from the app.' };
        }
        if (typeof fetchImpl !== 'function') return { ok: false, code: 'unavailable', error: 'Remembered logins are not offered here.' };
        const response = await fetchImpl('/_friend/remember/' + action, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        // Not the gateway, or no invitation session: nothing to remember with.
        if (response.status === 404 || response.status === 401 || response.status === 403 || response.status === 405)
            return { ok: false, code: 'unavailable', error: 'Remembered logins are not offered here.' };
        return await response.json().catch(() => ({ ok: false, code: 'unavailable', error: 'The server gave an answer that could not be read.' }));
    }

    async function call(action, body) {
        let answer;
        try { answer = await request(action, body); }
        catch { throw failure('unavailable', 'The app or the server could not be reached.'); }
        if (!answer.ok) throw failure(answer.code || 'unavailable', String(answer.error || 'That did not work.'));
        return answer;
    }

    return Object.freeze({
        // { available, remembered }. Never rejects.
        async status() {
            try {
                const answer = await request('status');
                return { available: Boolean(answer.ok && answer.available !== false), remembered: Boolean(answer.ok && answer.remembered) };
            } catch { return { available: false, remembered: false }; }
        },
        // Remember the account this page is logged in to now, replacing
        // whatever was remembered before. Resolves { username }.
        async remember() {
            const current = session();
            if (!current?.accountId) throw failure('not-logged-in', 'Not logged in.');
            if (!current.webToken) throw failure('unsupported', 'This game server did not give the client a session token, so the login cannot be remembered.');
            const answer = await call('issue', { accountId: String(current.accountId), webToken: String(current.webToken) });
            // secure: whether the credential travels only over this machine
            // or HTTPS. False on a plain-HTTP LAN origin, where anyone on that
            // network can read the cookie.
            let secure = local();
            try { secure ||= new URL(origin()).protocol === 'https:'; } catch { /* not a URL */ }
            return { username: String(answer.username || ''), secure };
        },
        // A one-time login token for the remembered account: { username,
        // token }, to hand straight to the login screen's login(). Rejects
        // with .code 'none' (nothing remembered), 'revoked' (it was, and is
        // no longer valid -- already forgotten) or 'unavailable' (try later).
        async resume() {
            const answer = await call('resume');
            return { username: String(answer.username || ''), token: String(answer.token || '') };
        },
        // Revoke it, here and on the server. Resolves whether it was asked.
        async forget() {
            try { await call('forget'); return true; } catch { return false; }
        },
    });
}
