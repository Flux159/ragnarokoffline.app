# Playing together: one host, several clients

*Plan only — nothing here is implemented yet.*

Today RagnarokMac is one process tree bound to `127.0.0.1`, and every design
choice reflects that: the account is seeded by hand, registration exists only
because roBrowser's `Name_M` fallback is cheap, and the WebSocket proxy has a
three-entry allowlist. Letting a friend connect breaks all three at once, plus a
fourth thing that is easy to miss — **they need the game assets too**, and we
cannot ship those.

This is deliberately staged. Stage 1 is a weekend's work and covers "my friend
is on the couch". Stage 3 is a different product and should not be started
casually.

---

## What actually has to change

| Concern | Single player today | Needed for guests |
|---|---|---|
| Bind address | `127.0.0.1` only | LAN interface, chosen deliberately |
| Advertised address | `char_ip`/`map_ip` = `127.0.0.1` | an address the *guest* can reach |
| Proxy allowlist | three fixed loopback entries | must follow the bind address |
| Accounts | one seeded admin | real registration, per-person |
| Assets | host's own GRFs | each guest needs their own copy |
| Trust | nobody else can connect | anyone who can reach the port can try |

The address problem is the one that bites first and is the least obvious: the
char and map servers *hand the client an address to reconnect to*. Get it wrong
and the guest authenticates against the login server, then silently fails to
reach the char server, because it was told to connect to `127.0.0.1` — which,
on their machine, is them.

---

## Stage 1 — LAN

The host flips a switch in Settings; guests join from a browser.

**Host side**

1. A `Host a game` toggle in Settings, off by default, with the LAN address and
   port shown next to it.
2. `scripts/stack.sh` publishes on the LAN interface instead of loopback, and
   writes the chosen address into `char_ip` / `map_ip` and the proxy allowlist.
   This is exactly the plumbing that already exists for `127.0.0.1` — one
   variable, three consumers, and `endpoint.json` already exists so the client
   page reads whatever it is told.
3. `WS_ALLOWED_TARGETS` is regenerated from the same value rather than
   hand-maintained, as it is now.

**Guest side**

Guests do not install RagnarokMac. They open `http://<host>:3338/play.html` in a
browser — the whole point of a browser-based client. But **they must supply
their own GRFs**, and that is a real obstacle:

- The host's asset server *can* serve GRF-extracted assets to guests. That is
  what a Remote Client is for, and it is how public roBrowser servers operate.
- It also means the host is distributing Gravity's copyrighted assets over the
  network. Fine among people who each own a client; not fine as a public
  service. Worth an explicit, honest note in the UI rather than a silent
  default.

**Accounts.** `new_account: yes` is already on, so `Name_M` / `Name_F`
registration works. For a handful of friends that is genuinely enough. What is
missing is a way for the host to *see* and *manage* accounts — a list in
Settings, with the ability to remove one and to promote someone to admin.

**Estimated work:** the address plumbing is small because it is already
parameterised. The account list is a new Settings pane over `mysql` queries. The
honest cost is in testing the failure modes: guest on a different subnet, host
sleeping mid-session, two people picking the same character name.

---

## Stage 2 — over the internet, for people you know

Everything in Stage 1, plus:

1. **Transport.** Do not port-forward. Prefer a mesh VPN (Tailscale) where each
   participant is an identity, not an IP — it sidesteps NAT, gives TLS-grade
   transport, and keeps the server off the public internet. A tunnel
   (Cloudflare Tunnel, `ngrok`) is the fallback when the guest cannot install
   anything, and it is strictly worse: the endpoint is public the moment it
   exists.
2. **TLS.** A browser on a public origin will refuse `ws://`. The asset server
   needs `wss://`, which means a certificate, which means a hostname. Tailscale
   provides both; a raw tunnel needs its own answer.
3. **`forceUseAddress: true`** in the client config. Without it the client uses
   the internal IP the char/map server sends and dies outside the host's LAN.
   This is the single most common roBrowser deployment failure.
4. **Rate limiting on registration.** `allowed_regs` / `time_allowed` already
   exist in rAthena and are currently at defaults nobody has thought about.

**Do not do this until Stage 1 is solid**, and be clear-eyed that an exposed
rAthena is a real service with a real attack surface.

---

## Stage 3 — a client that can point anywhere

The largest change, and the one that turns RagnarokMac from an appliance into a
client. Only worth it if people actually want to join *other* people's servers.

- **Server list.** Multiple entries in Settings, each with address, port,
  packetver, renewal flag and a display name — roBrowser's `servers` array is
  already shaped exactly like this, so the work is UI and persistence, not
  protocol.
- **Per-server identity.** Credentials stored per server in the macOS Keychain,
  never in `client.json`.
- **Packetver is per server, not global.** This is the sharp edge. Our rAthena
  is *compiled* with `--enable-packetver=20200401`; a different server may speak
  a different version, and the client must match it per connection. roBrowser
  supports this per server entry. It also means "join a friend's server" and
  "host your own" are independent features that happen to share a window.
- **Asset compatibility.** A server from a different client era may need GRFs we
  do not have. The first-run check (`scripts/grfls.py`) should grow a
  per-server "your client data does not cover this server" warning rather than
  failing at map load.
- **Separate the roles.** At this point *host* and *play* are two products
  sharing a shell: Settings should say so, and the stack should not start at all
  when the user is only joining someone else.

---

## Open questions

- Does the host serve assets to guests by default, or must each guest point at
  their own local GRFs? The former is far better UX and the more legally
  exposed; this should be a deliberate, documented choice, not a default.
- Do we want guest accounts to persist across sessions, or be ephemeral per
  game night? Ephemeral is friendlier and avoids account management entirely.
- Is a "host" mode even the right shape, or should the server be a separate
  headless artifact that RagnarokMac merely launches? The latter is cleaner for
  Stage 2 and more work now.
- Character data lives in the `ragnarokmac-db` volume on the host. If the host
  stops hosting, everyone's characters go with it. Should guests be told that
  plainly up front?
