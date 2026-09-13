'use strict';
const scopes = new Set(['local', 'lan', 'friends', 'public']);
function effective(client, settings) {
  if (!Object.hasOwn(settings, 'hosting_scope') && client.lan !== undefined && typeof client.lan !== 'boolean') {
    throw new Error('Invalid LAN setting. Repair the saved hosting setting before starting.');
  }
  const scope = Object.hasOwn(settings, 'hosting_scope') ? settings.hosting_scope : (client.lan ? 'lan' : 'local');
  if (!scopes.has(scope)) throw new Error('Invalid hosting scope. Repair the saved hosting setting before starting.');
  return { ...client, hosting_scope: scope, lan: scope === 'lan' };
}
module.exports = { effective };
