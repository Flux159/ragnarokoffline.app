'use strict';
// Settings → Mods: what is waiting for Apply, and what Apply leaves to do.
//
// Kept apart from settings.html so the rules can be tested under node, and so
// the warning in the Mods header and the Apply button's emphasis are both
// worked out here, from one place, and cannot disagree.
//
// No DOM in this file. Loaded by settings.html as a plain script (it becomes
// window.ModsState) and by tests/mods-state.test.cjs through require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ModsState = api;
})(typeof self !== 'undefined' ? self : this, () => {
  /**
   * What the server was last started with, as `{ name: enabled }`.
   *
   * The first listing is taken as applied: nothing the page can see says
   * otherwise, and a warning on every open would be a warning nobody reads.
   * After that, a mod that appears (installed since) counts as off in the
   * running server -- installs do not restart it, so an install that is on
   * is a change waiting for Apply -- except a UI skin or cursor pack, whose
   * installer switches it on and rebuilds the client files itself.
   */
  function adopt(baseline, mods) {
    const next = { ...(baseline || {}) };
    for (const m of mods) {
      if (m.refused || Object.hasOwn(next, m.name)) continue;
      next[m.name] = baseline && !m.kind ? false : !!m.enabled;
    }
    return next;
  }

  /** The baseline once everything listed now is what the server runs. */
  function applied(mods, checked) {
    const next = {};
    for (const m of mods) {
      if (m.refused) continue;
      next[m.name] = Object.hasOwn(checked, m.name) ? !!checked[m.name] : !!m.enabled;
    }
    return next;
  }

  /**
   * The changes Apply would carry, as a list of `{ name, change }`, where
   * change is `on`, `off`, `removed` or `settings`.
   *
   * `checked` is the checkboxes as they stand; `present` every mod name in
   * the list, refused ones included, so a mod that is merely refused now is
   * not mistaken for one that was removed.
   */
  function pending({ baseline, checked, present, settings = {}, settingsBaseline = {} }) {
    const out = [];
    if (!baseline) return out;
    for (const [name, on] of Object.entries(checked)) {
      const was = Object.hasOwn(baseline, name) ? baseline[name] : false;
      if (!!on !== !!was) out.push({ name, change: on ? 'on' : 'off' });
    }
    for (const [name, was] of Object.entries(baseline)) {
      if (was && !present.includes(name)) out.push({ name, change: 'removed' });
    }
    for (const [name, values] of Object.entries(settings)) {
      if (JSON.stringify(values) !== settingsBaseline[name]) {
        // Switching a mod off and changing its options is still one mod.
        if (!out.some(p => p.name === name)) out.push({ name, change: 'settings' });
      }
    }
    return out;
  }

  /** The header's warning for a list from pending(), or '' for none. */
  function pendingText(changes) {
    if (!changes.length) return '';
    return 'You have changes to mods that aren’t applied yet — press Apply.';
  }

  /**
   * The header's line after a successful Apply, until the game has loaded
   * again. `after` is the game's launch count when Apply finished; `game` is
   * `{ open, launches }` as the app reports it now. Null once there is
   * nothing left to say.
   */
  function appliedNotice(after, game) {
    if (after === null || after === undefined) return null;
    if (game && game.launches > after) return null;
    return game && game.open
      ? { text: 'Mods applied. Reopen the game to load them.', button: 'Reopen game' }
      : { text: 'Mods applied. They load the next time you open the game.', button: 'Open game' };
  }

  return { adopt, applied, pending, pendingText, appliedNotice };
});
