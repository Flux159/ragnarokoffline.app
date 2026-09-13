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
  } catch (error) { status.textContent = error.message || 'The host is offline. Try again when they start sharing.'; }
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
