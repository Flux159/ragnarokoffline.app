'use strict';
const net = require('node:net');
const os = require('node:os');

// Ports the app publishes: the asset server, then rAthena's login, char and
// map. All four are bound to 127.0.0.1 when hosting is anything but `lan`.
const GAME_PORTS = [3338, 6900, 6121, 5121];

// What a single connection attempt proved, worst first. `open` is the only
// outcome that says a port is exposed; every other one says it is not, and
// they differ only in how much we are entitled to claim about why.
//
// The distinction that matters is `closed` versus `filtered`. A refused
// connection is the stack telling us nothing is listening. A dropped one is a
// packet filter telling us nothing, and Windows drops by default: its inbound
// policy discards unsolicited SYNs without a reset, so a probe to this
// machine's own LAN address times out on a healthy install rather than being
// refused. Treating that silence as a failure made sharing impossible there.
const OUTCOMES = {
  open: 'reachable',
  closed: 'refused, so nothing is listening',
  unreachable: 'no route to that address',
  filtered: 'no answer, so a packet filter dropped it',
  error: 'the probe itself failed',
};

function classify(error) {
  switch (error.code) {
    case 'ECONNREFUSED': case 'ECONNRESET': return 'closed';
    case 'EHOSTUNREACH': case 'ENETUNREACH': case 'ENETDOWN': case 'EHOSTDOWN':
    case 'EADDRNOTAVAIL': case 'EACCES': case 'EPERM': return 'unreachable';
    case 'ETIMEDOUT': return 'filtered';
    default: return 'error';
  }
}

// Every IPv4 address this machine answers on, minus loopback. Virtual adapters
// are deliberately included: a Hyper-V or WSL bridge is still an address a
// listener could bind, and excluding them by name would be a guess that ages
// badly as the platform adds more of them.
function localAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(info => info && !info.internal && info.family === 'IPv4')
    .map(info => info.address);
}

function probeOne(address, port, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const socket = new net.Socket();
    const finish = outcome => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ address, port, outcome });
    };
    socket.setTimeout(timeoutMs, () => finish('filtered'));
    socket.once('connect', () => finish('open'));
    socket.once('error', error => finish(classify(error)));
    // connect() throws rather than emitting for a malformed port or address.
    // Left uncaught it rejects this promise, takes Promise.all with it and
    // surfaces as exactly the unexplained sharing failure this module exists
    // to replace. An unprobeable address is a result, not an exception.
    try {
      socket.connect({ host: address, port });
    } catch {
      finish('error');
    }
  });
}

// Every address against every port, at once. Serially this was one timeout per
// probe, and a machine with several virtual adapters spent half a minute in a
// check that is meant to be instant.
async function probeListeners({ timeoutMs = 1000, ports = GAME_PORTS, addresses = localAddresses() } = {}) {
  const results = await Promise.all(addresses.flatMap(address => ports.map(port => probeOne(address, port, timeoutMs))));
  const exposed = results.filter(result => result.outcome === 'open');
  const filtered = results.filter(result => result.outcome === 'filtered');
  return { results, exposed, filtered, addresses };
}

// A machine with several virtual adapters produces one result per adapter per
// port, and naming all two dozen turns the sentence into a wall. Name a few and
// count the rest; the diagnostics section carries the full list.
function where(results, limit = 4) {
  const named = results.slice(0, limit).map(result => `${result.address}:${result.port}`).join(', ');
  const rest = results.length - limit;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

// Which addresses were affected, regardless of port -- the useful unit when a
// whole interface was dropped, which is the usual shape of a firewall result.
function whichAddresses(results, limit = 4) {
  const unique = [...new Set(results.map(result => result.address))];
  const rest = unique.length - limit;
  return rest > 0 ? `${unique.slice(0, limit).join(', ')} and ${rest} more` : unique.join(', ');
}

// One line per probe, for the log and for a bug report. Without this the only
// evidence of a failure was the word "listeners" and no address.
function describe({ results }) {
  if (!results.length) return 'no non-loopback IPv4 address on this machine';
  return results.map(result => `${result.address}:${result.port} ${result.outcome} (${OUTCOMES[result.outcome]})`).join('\n');
}

// The sentence a player sees. Only an actually reachable port is a refusal:
// the authoritative checks already ran in the supervisor, which reads the
// container port bindings and the engine's publication flag rather than
// guessing from outside. This probe is the second opinion, so it may say "I
// could not tell" without stopping anything.
function verdict(report) {
  if (report.exposed.length) {
    return {
      shareable: false,
      message: `A game port is reachable on your network at ${where(report.exposed)}. `
        + 'Turn off "Allow LAN connections" in Settings → Multiplayer, restart the server, then share again.',
    };
  }
  if (report.filtered.length) {
    return {
      shareable: true,
      message: `Your firewall dropped the check on ${whichAddresses(report.filtered)} instead of refusing it, `
        + 'so those ports could not be confirmed closed from outside. The server’s own settings were '
        + 'verified separately and are private, so sharing continued. This is normal on Windows.',
    };
  }
  return { shareable: true, message: '' };
}

module.exports = { probeListeners, describe, verdict, localAddresses, GAME_PORTS };
