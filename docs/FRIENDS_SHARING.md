# Share one world through a browser link

The host runs Ragnarok Offline. Friends open an HTTPS invitation in a browser,
create an ordinary game account if needed, and play in **that same server and
database**. They do not install the app or download a separate game server.
The host must keep the app running and the computer awake.

## One-time Cloudflare setup

Use **Settings → Multiplayer → Set up sharing over the internet**.

1. Change or disable this era's default GM password under Accounts. Use
   **Prepare server for friends** to secure its internal credentials and save a
   backup. Existing characters and account IDs are preserved.
2. Choose an unused hostname on a domain active in your Cloudflare account.
   Create an API token with Zone Read and DNS Edit scoped to that domain and
   Cloudflare Tunnel Edit scoped to its account. Enter it in the app's password
   field, not chat or a diagnostic report. A tunnel run token is different.
3. Click **Connect Cloudflare**. The app downloads and checks the pinned helper,
   creates a dedicated locally managed tunnel, and adds a proxied CNAME. It
   refuses to overwrite an existing DNS record. The setup API token is not saved;
   the dedicated tunnel credential uses the operating system's secure storage.
4. Click **Share with friends**, then **Copy invitation link**. Paste that link
   into your conversation with friends. Starting sharing applies protected
   account policy and restarts game services; do this before everyone logs in.

Invitations last eight hours. Each invited browser may create one ordinary
account, with a maximum of 32 authenticated browser sessions per invitation.
Account creation does not restart the host. The account and its characters stay
in the host's current era when the invitation expires. Renewal and Pre-Renewal
are separate databases.

**Stop sharing** closes remote sessions and the connector while local play keeps
running. Replacing the invitation disconnects existing friends and invalidates
the old link. Changing server settings, switching era/mode, repairing, quitting
or suspending the host also stops sharing. Start sharing again when ready.
A failed/reconnecting link is shown as such; Copy is enabled only after the
public HTTPS endpoint and a game WebSocket have verified against this host.

Forgetting a connection removes its saved local credential. The stopped tunnel
and DNS record remain in Cloudflare for the account owner to remove there.
No Quick Tunnel, public registration portal, SMTP/reset service or ngrok adapter
is provided by this implementation.

## Access boundary

The connector targets the app's loopback gateway on 3339. The Rust RemoteClient
on 3338 and all game TCP ports remain loopback-only. The gateway covers the
entire tunnel origin: files, search, batch and every WebSocket upgrade. It does
not trust loopback peers or forwarded headers as owner authentication. It never
proxies management, diagnostics, logs or raw GRF downloads.

An invitation is exchanged from a URL fragment through a same-origin POST for a
Secure, HttpOnly, SameSite cookie. The fragment is removed before game navigation.
Expiry/revocation also closes live game sockets. HTTP bodies, sessions, account
attempts, socket counts and WebSocket frames/messages are bounded; proxy pipes
preserve backpressure. Authenticated content is private/no-store at the HTTP/CDN
layer. The client's existing local file cache still applies.

The Rust supervisor checks the actual running era, managed credentials, GM
password policy, suffix signup policy, container port bindings and the pinned
base command/permission files. Mods replacing command/permission imports are
refused for friends mode. The app checks current LAN listeners as well. A
separate owner page retains privileged Electron IPC; public pages have none.

The access boundary is implemented in the shell's gateway rather than changing
the sibling Rust server's protocol. This keeps the whole connector and its
revocation lifecycle in one app change. The Rust server still performs asset
resolution and the allowlisted WS-to-TCP forwarding.

## Validation and limits

`tests/e2e/friends-sharing.cjs` owns a stopped marked disposable world. It uses a
local TLS connector fixture with the real gateway, Rust RemoteClient and rAthena.
It creates an invited group-0 account without restarting the host, logs in and
creates a character through the phone browser, verifies all three WSS stages,
shares a map and chat with the owner, and stops remote access while local play
continues. It preserves settings, backs up the test DB, restores the clipboard,
and stops the owned world. It never provisions Cloudflare resources.

With the packaged app and other development hosts fully stopped, run:

```sh
RO_E2E_WORLD=/absolute/path/to/marked/disposable/world \
RO_E2E_CLIENT_JSON=/absolute/path/to/client-file-selection.json \
node tests/e2e/friends-sharing.cjs
```

The selection JSON supplies only installed game-asset paths. The test world
must already have its own prepared runtime and private test accounts from the
account acceptance fixture. Never point `RO_E2E_WORLD` at a player's save.

Unit tests cover unauthorized paths, forged headers/origins, private files,
account limits, revoked/expired sessions and active sockets, frame limits,
Cloudflare provisioning rollback, secure-storage refusal, and connector
cancellation/failure. Actual provider, separate-network/cellular, sleep/wake and
packaged platform acceptance must be recorded separately from the TLS fixture.

Provider references: [Cloudflare setup](https://developers.cloudflare.com/tunnel/setup/),
[API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
[cloudflared source and license](../third-party/cloudflared/README.md).
