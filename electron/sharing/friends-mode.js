'use strict';

// Whether "Share with friends" has to rebuild the server before it can share.
//
// The button writes `hosting_scope: friends` through the same path as Apply in
// Settings: stop the asset server, run the whole supervisor, re-link the
// client, start the asset server again. For a server not yet in friends mode
// that is the point -- the game ports have to be rebound to loopback and the
// login server restarted with friends-mode protection -- so it cannot be
// skipped. For a server already in friends mode it is thirty-odd seconds of
// downtime that ends with an asset server configured exactly as before, which
// is issue #120.
//
// Not "is the saved scope already friends". A start narrows friends to Local
// for an era that was never prepared for internet hosting, and the saved
// setting is left alone when it does, so the file can say friends about a
// server that is not. The last word goes to the supervisor's `sharing-check`,
// which looks at the running containers and the engine rather than at
// settings. The other conditions only decide whether it is worth asking.
//
// Nor is this the place to skip a no-op Apply in general: an Apply that changes
// nothing is how a half-finished era switch or mod change gets retried.
//
// Rebuilding is the default, as it was before this existed. Every reason not to
// has to be present at once, and a check that could not be run counts as a
// failed one.
function rebuildNeeded({ scope, lan, assetsRunning, assetsReady, phase, backendReady } = {}) {
  const rebuild = reason => ({ rebuild: true, reason });
  if (scope !== 'friends') return rebuild('this server is not in friends mode yet');
  if (lan) return rebuild('LAN hosting is on, and friends mode needs private game ports');
  if (!assetsRunning || !assetsReady) return rebuild('the server is not running');
  // Only a supervisor run that finished writes Ready. Anything else -- a start
  // or an Apply that failed part-way, a Repair, a Stop -- is a server whose
  // configuration nobody has confirmed since.
  if (phase !== 'Ready') return rebuild('the last server start did not finish');
  if (backendReady !== true) return rebuild('the running server is not configured for friends');
  return { rebuild: false, reason: 'the running server is already in friends mode' };
}

module.exports = { rebuildNeeded };
