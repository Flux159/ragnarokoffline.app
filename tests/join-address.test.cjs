const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJoinAddress, gameUrl } = require('../electron/join-address');
const { JoinSession } = require('../electron/join-session');

test('full URLs retain HTTPS/default ports while legacy LAN addresses retain :3338', () => {
  const cases = [
    ['https://game.example/', 'https://game.example'],
    ['https://game.example:443/api.html?app=ONLINE', 'https://game.example'],
    ['https://game.example:8443/', 'https://game.example:8443'],
    ['http://game.example/', 'http://game.example'],
    ['http://game.example:80/', 'http://game.example'],
    ['192.168.1.20', 'http://192.168.1.20:3338'],
    ['host.local:8080/api.html?app=ONLINE', 'http://host.local:8080'],
    ['host.local:80#invite=test', 'http://host.local'],
    ['[::1]', 'http://[::1]:3338'],
    ['[::1]:3338/', 'http://[::1]:3338'],
    ['http://[::1]/', 'http://[::1]'],
    ['https://[2001:db8::1]:8443/', 'https://[2001:db8::1]:8443'],
  ];
  for (const [input, origin] of cases) assert.equal(parseJoinAddress(input).origin, origin, input);
});

test('session handoff saves only origins and redacts invites even after exchange', () => {
  const session = new JoinSession();
  const origin = session.remember('https://game.example/#invite=unique-private-test-token');
  assert.equal(origin, 'https://game.example');
  assert.equal(session.url(origin), 'https://game.example/api.html?app=ONLINE#invite=unique-private-test-token');
  assert.ok(!session.redact('Failed https://game.example/#invite=unique-private-test-token').includes('unique-private-test-token'));
  session.exchanged('https://other.example/');
  assert.match(session.url(origin), /#invite=/);
  session.exchanged('https://game.example/api.html?app=ONLINE');
  assert.equal(session.url(origin), 'https://game.example/api.html?app=ONLINE');
  assert.ok(!session.redact('old unique-private-test-token').includes('unique-private-test-token'));
  assert.equal(new JoinSession().url(origin), 'https://game.example/api.html?app=ONLINE');
});

test('invite fragments survive game navigation without entering probe/saved origins', () => {
  const input = 'https://game.example/api.html?app=ONLINE#invite=a_test-token';
  assert.deepEqual(parseJoinAddress(input), { origin: 'https://game.example', invite: '#invite=a_test-token' });
  assert.equal(gameUrl(input), input);
  assert.equal(gameUrl('https://game.example', '#invite=next'), 'https://game.example/api.html?app=ONLINE#invite=next');
});

test('unsupported schemes, userinfo, ambiguous IPv6 and control characters are rejected without echoing input', () => {
  for (const input of ['', 'ftp://host/', 'file:///tmp/private', 'javascript:alert(1)',
    'https://user:secret@host/', 'user@host', '::1', 'host:bad',
    'https://host/\nsecret', 'https://host\\@other/', 'x'.repeat(4097)]) {
    assert.throws(() => parseJoinAddress(input), error => {
      assert.ok(!error.message.includes('secret'));
      return /HTTP or HTTPS/.test(error.message);
    }, input);
  }
});
