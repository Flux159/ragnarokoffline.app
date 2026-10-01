'use strict';
(async () => {
  const status = document.getElementById('status');
  const fragment = new URLSearchParams(location.hash.slice(1));
  const invite = fragment.get('invite');
  // The invitation travels only in a fragment and the exchange POST body.
  // Remove it before navigating to game files or external browser UI.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const response = invite ? await fetch('/_friend/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite }) }) : await fetch('/_friend/session');
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Ask the host for a new invitation link.');
    status.textContent = 'You’re invited. Use a game account on this server, or create one below.';
    document.getElementById('ready').hidden = false;
    await signIn();
  } catch (error) { status.textContent = error.message || 'The host is offline. Try again when they start sharing.'; }
  // Sign in with Google or Apple, when the host has set it up. Nothing shows
  // otherwise, and password accounts work exactly as before.
  async function signIn() {
    const state = await (await fetch('/_friend/sign-in/status')).json().catch(() => ({}));
    if (!state.enabled) return;
    const names = { google: 'Sign in with Google', apple: 'Sign in with Apple' };
    const providers = document.getElementById('providers');
    providers.replaceChildren(...state.providers.map(provider => {
      const link = document.createElement('a');
      link.className = 'play'; link.textContent = names[provider] || provider;
      link.href = '/_friend/sign-in/start?provider=' + encodeURIComponent(provider);
      return link;
    }));
    document.getElementById('sign-in').hidden = state.signedIn;
    document.getElementById('signed-in').hidden = !state.signedIn;
    document.getElementById('choose').hidden = !state.needsAccount;
    document.getElementById('signup').hidden = state.signedIn;
    document.getElementById('play').hidden = state.needsAccount;
    document.getElementById('identity').textContent = !state.signedIn ? ''
      : state.needsAccount ? `Signed in as ${state.email}.`
      : `Signed in as ${state.email}, playing as ${state.username}. Choose Play, then “Continue” on the game’s login screen.`;
    if (state.needsAccount && !document.getElementById('new-username').value)
      document.getElementById('new-username').value = state.email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '_').slice(0, 23);
  }
  const post = async (route, body) => {
    const response = await fetch('/_friend/sign-in/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.error || 'That did not work. Try again.');
    return result;
  };
  for (const [form, route, fields] of [['create-account', 'create', () => ({ username: document.getElementById('new-username').value })],
    ['link-account', 'link', () => ({ username: document.getElementById('link-username').value, password: document.getElementById('link-password').value })]]) {
    document.getElementById(form).addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.target.querySelector('button'); button.disabled = true;
      try { const result = await post(route, fields()); status.textContent = `Your sign-in now plays as ${result.username}.`; await signIn(); }
      catch (error) { status.textContent = error.message; }
      finally { document.getElementById('link-password').value = ''; button.disabled = false; }
    });
  }
  document.getElementById('sign-out').addEventListener('click', async () => {
    try { await post('out', {}); status.textContent = 'Signed out.'; await signIn(); } catch (error) { status.textContent = error.message; }
  });
  document.getElementById('register').addEventListener('submit', async event => {
    event.preventDefault();
    const button = document.getElementById('create'); button.disabled = true;
    const password = document.getElementById('password');
    const confirmation = document.getElementById('confirmation');
    try {
      if (password.value !== confirmation.value) throw Error('The passwords do not match.');
      const response = await fetch('/_friend/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('username').value, password: password.value, confirmation: confirmation.value }) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Could not create the account.');
      document.getElementById('signup').hidden = true;
      status.textContent = 'Account created. Choose Play, then enter that account name and password on the game login screen.';
    } catch (error) { status.textContent = error.message; }
    finally { password.value = ''; confirmation.value = ''; button.disabled = false; }
  });
})();
