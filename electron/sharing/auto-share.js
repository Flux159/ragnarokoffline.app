'use strict';

// Whether the app should put sharing back on by itself.
//
// Sharing does not survive the server restarting. Every verb that cycles the
// stack stops it first -- applying settings, switching era, Repair, a backup,
// an account change -- and a map-server crash stops it too. Coming back was a
// button the host had to notice and press, and until they did, the link their
// friends were holding answered nothing. That is the whole of issue #100.
//
// A connected domain is what makes the answer obvious enough not to ask. Its
// hostname does not change, so resuming restores the very link the friends
// already have: there is no new address to send and nothing for anyone to
// decide, which is why this is the behaviour rather than a setting. A temporary
// link is never resumed -- Cloudflare hands out a new trycloudflare.com address
// every time, so the most it could do is open a tunnel nobody can reach and
// leave the host to notice and send a new link anyway.
//
// The conditions live here rather than inline at the call site because "should
// this machine open a tunnel to the internet without being asked" deserves to
// be readable in one place, and testable without an Electron window. Refusing
// is the default: every reason to share has to be present at once.
//
// `state` is the sharing controller's own state; `configured` is whether a
// named tunnel is saved; `scope` is the effective hosting scope.
//
// `quiet` marks the refusals that mean "this was never going to share": not
// hosting, never shared, no domain. The caller runs after every server
// operation, and those three would otherwise fill the log of every install that
// has only ever played alone. A refusal that would have shared but for
// something passing is never quiet; that one is worth a line.
function decide({ mode, scope, state, configured, stoppedByHand, quitting } = {}) {
  const no = reason => ({ share: false, useDomain: false, reason });
  const nothingToSay = reason => ({ ...no(reason), quiet: true });
  if (quitting) return nothingToSay('the app is quitting');
  if (mode !== 'host') return nothingToSay('this copy is joining someone else’s server');
  // Whether sharing was ever turned on at all. Nothing but a successful share
  // leaves the scope on `friends`, which makes it the only durable record of
  // that -- and the reason a server whose owner has only ever played alone is
  // never put on the internet by this. It is also what keeps an automatic start
  // from changing the server it found: friends mode is already in force, so
  // resuming alters nothing about how the game ports bind.
  if (scope !== 'friends') return nothingToSay('this server is not set up for friends');
  if (!configured) return nothingToSay('no connected domain; a temporary link changes address and is not resumed');
  // Stopping sharing is an instruction, and an Apply two minutes later is not
  // permission to undo it. It holds until sharing is started by hand again or
  // the app is relaunched -- a relaunch being the point at which "bring the
  // server up" plainly includes the address it is normally reachable at.
  if (stoppedByHand) return no('sharing was stopped by hand');
  if (!['stopped', 'failed'].includes(state)) return no(`sharing is already ${state}`);
  return { share: true, useDomain: true, reason: 'the connected domain keeps its address' };
}

module.exports = { decide };
