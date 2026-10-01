'use strict';
// One-time login tokens, and checking a game password with the login server.
//
// After a friend signs in with Google or Apple, the game client still has to
// send the login server *something* in its password field. It sends one of
// these: issued by the gateway, valid for 60 seconds, for one account, once.
// The login server (Flux159/rathena, src/login/login_token.cpp) checks it
// against the SHA-256 kept in `login_tokens`; the token itself is never stored
// or logged anywhere, and the password field cannot tell anyone a password.
const crypto = require('node:crypto');
const net = require('node:net');

// `~` and 22 base64url characters: 132 random bits in exactly 23 characters,
// which is what CA_LOGIN's 24-byte password field holds with its NUL. The
// login server only treats a password of this exact shape as a token.
const SHAPE = /^~[A-Za-z0-9_-]{22}$/;

function issueLoginToken() {
  const token = '~' + crypto.randomBytes(17).toString('base64url').slice(0, 22);
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex') };
}

// Does this username/password log in? Asked of the login server itself, with
// the packet the game client sends (CA_LOGIN), so whatever it checks -- a
// hashed password, a ban, a disabled account -- is what decides. Used once,
// to link a sign-in to an existing account, and closed on the first answer.
function checkGameLogin({ username, password, host = '127.0.0.1', port = 6900, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const field = value => { const bytes = Buffer.alloc(24); Buffer.from(String(value), 'latin1').copy(bytes, 0, 0, 23); return bytes; };
    if (!/^[\x20-\x7e]{1,23}$/.test(username) || !/^[\x20-\x7e]{1,23}$/.test(password)) return resolve(false);
    const packet = Buffer.concat([Buffer.from([0x64, 0x00]), Buffer.alloc(4), field(username), field(password), Buffer.from([0])]);
    const socket = net.connect({ host, port });
    let received = Buffer.alloc(0), settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeout, () => finish(Error('The game server did not answer. Try again shortly.')));
    socket.on('connect', () => socket.write(packet));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 2) return;
      // AC_ACCEPT_LOGIN, in either of its forms, is the only yes. Everything
      // else -- refusals, a ban notice -- is a no.
      finish(null, [0x69, 0xac4].includes(received.readUInt16LE(0)));
    });
    socket.on('error', () => finish(Error('The game server is not reachable. Try again shortly.')));
    socket.on('close', () => finish(null, false));
  });
}

module.exports = { SHAPE, issueLoginToken, checkGameLogin };
