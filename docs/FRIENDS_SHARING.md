# Share one world through a browser link

The host runs Ragnarok Offline. Friends open an HTTPS invitation in a browser,
create an ordinary game account if needed, and play in **that same server and
database**. They do not install the app or download a separate game server.
The host must keep the app running and the computer awake.

## Simplest setup: a temporary session link

Use **Settings → Multiplayer → Set up sharing over the internet**.

1. Change or disable this era's default GM password under Accounts. Use
   **Prepare server for friends** to secure its internal credentials and save a
   backup. Existing characters and account IDs are preserved.
2. Click **Share with friends**. The app downloads/checks the pinned Cloudflare
   helper, creates a temporary hostname, and verifies public HTTPS and WSS.
   No Cloudflare account, domain, API token or password store is needed.
3. Click **Copy invitation link** and send it to your friends.

Temporary links use Cloudflare Quick Tunnels, a development/test service with
no uptime guarantee and a 200-in-flight-request limit. They are convenient for
casual test sessions; use the optional named tunnel for regular hosting. A new
sharing session gets a new temporary hostname. See [Cloudflare's limits](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Optional: your own fixed hostname

Open **Use a named tunnel for regular hosting** in the same section.

1. Choose an unused hostname on a domain active in your Cloudflare account.
   Create an API token with Zone Read and DNS Edit scoped to that domain and
   Cloudflare Tunnel Edit scoped to its account. Enter it in the app's password
   field, not chat or a diagnostic report. A tunnel run token is different.
2. Click **Connect Cloudflare**. The app creates a dedicated locally managed
   tunnel and proxied CNAME. It refuses to overwrite an existing DNS record.
   The setup API token is not saved; the dedicated tunnel credential uses the
   operating system's secure storage.
3. Select **Use this fixed hostname**, then **Share with friends**.

The Quick Tunnel limit counts simultaneous requests across the tunnel, not total
requests or players. Asset loading can reach it. Named tunnels do not have that
Quick Tunnel limit and work behind NAT without port forwarding. A separately
hosted server with DNS and HTTPS/WebSocket routing is also possible, but requires
manual setup; DNS alone does not bypass NAT.

Starting sharing applies protected account policy and restarts game services;
do this before everyone logs in.

Invitations last as long as **Invitation lasts** in Settings says, 1-30 days
and 7 by default. That is this app's own expiry, not Cloudflare's: the tunnel
runs for as long as you are sharing, and using your own domain instead of a
temporary link does not change it. **Replace invitation** revokes every
existing link immediately. Each invited browser may create one ordinary
account, with a maximum of 32 authenticated browser sessions per invitation.
Account creation does not restart the host. The account and its characters stay
in the host's current era when the invitation expires. Renewal and Pre-Renewal
are separate databases.

**Stop sharing** closes remote sessions and the connector while local play keeps
running. Replacing the invitation disconnects existing friends and invalidates
the old link. Changing server settings, switching era/mode, backing up, repairing, quitting
or suspending the host also stops sharing. Start sharing again when ready.
A failed/reconnecting link is shown as such; Copy is enabled only after the
public HTTPS endpoint and a game WebSocket have verified against this host.

**With your own domain connected, that last step happens by itself.** A named
tunnel keeps its hostname, so once the server is up again — after applying a
setting, a Repair, a crash you recovered from, or the next time you start the
server — sharing comes back at the same address and the link your friends
already have starts working again with nothing sent to anyone. There is nothing
to turn on.

Three things it will not do. It never acts on a server that has not been shared
before: the saved hosting scope is the record of that, so a local or LAN server
is never put on the internet by it, and an automatic start never changes how the
game ports bind. It never resumes a temporary link, whose `trycloudflare.com`
address changes every time — resuming one would open a tunnel at an address
nobody holds, which is what connecting a domain is for. And it never overrides
**Stop sharing**, which holds until you share again yourself or relaunch the
app, so applying a setting a minute later does not undo it. To stop sharing for
good, use **Forget saved Cloudflare connection**, or take the server off friends
mode. An automatic start runs the same checks and reports in the same place as
the button, and a failure leaves the panel saying why.

Forgetting a connection removes its saved local credential. The stopped tunnel
and DNS record remain in Cloudflare for the account owner to remove there.
Open public registration, SMTP/reset services and ngrok are not provided.

## Sign in with Google or Apple

Optional. If you bring your own OAuth client from Google, Apple or both,
invited friends can sign in with that account instead of typing a game password.
**Without one, nothing changes.** Password accounts keep working either way, and
your own window on this computer always uses a password.

It needs your own hostname (above). Google and Apple only send people back to a
redirect URI registered in advance, and a temporary `trycloudflare.com` address
changes every time you share. The redirect URI the app uses is:

```
https://<your hostname>/_friend/sign-in/callback
```

for example `https://play.example.com/_friend/sign-in/callback`. Settings shows
it under **Multiplayer → Let friends sign in with Google or Apple**, once a
hostname is connected.

### Making a Google client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project, or choose one.
2. Go to **APIs & Services → OAuth consent screen**. Choose **External**, and
   give it an app name and a support email. The app asks only for `openid` and
   `email`, which Google treats as non-sensitive, so there is nothing to review.
   While the screen is in *Testing*, only the test users you list can sign in.
   **Publish** it to let anyone with the invitation in.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client
   ID**. Choose **Web application**. Under **Authorized redirect URIs**, add the
   redirect URI above, exactly. No JavaScript origins are needed.
4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) and the
   **Client secret** into Settings, then choose **Save Google sign-in**.

### Making an Apple client

Sign in with Apple on the web needs a paid Apple Developer Program membership.
In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/):

1. **Identifiers → App IDs**: have an App ID with the **Sign in with Apple**
   capability turned on. Any of yours will do; it is the "primary App ID" the
   next steps group under.
2. **Identifiers → Services IDs**: register one, for example
   `com.example.play`. Turn on **Sign in with Apple**, choose **Configure**,
   pick the primary App ID, and enter your hostname under **Domains and
   Subdomains** (`play.example.com`) and the redirect URI under **Return URLs**.
3. **Keys**: create a key with **Sign in with Apple** turned on, configured
   for the same primary App ID. Download the `.p8` file. Apple lets you
   download it once. Note the **Key ID**.
4. Your **Team ID** is in the top right of the developer site, and under
   Membership details.
5. In Settings, enter the Services ID, the Team ID and the Key ID, paste the
   whole `.p8` file, including its `BEGIN` and `END` lines, and choose **Save
   Apple sign-in**.

Changes apply the next time you start sharing on your hostname.

### What friends see

The invitation page and the game's login window show **Sign in with Google**
and **Sign in with Apple**. The first time, a friend chooses either a new game
account name, with no password, or an account they already have here. Linking
an existing account asks for its password once. The app checks it with the game
server itself, and after that they sign in without it. From then on, the login
window offers **Continue as you@example.com**, and that logs them straight in.

Accounts are matched by the provider's own id for the person and by the email
address the provider has **verified**. Someone who signs in with Google and
later with Apple under the same address gets the same game account. Apple's
*Hide My Email* addresses are different addresses, so they are a different
account unless linked. The email a player can type into the game, `login.email`,
is never used for matching, and an email is never linked automatically to a
password account: only that account's password does that.

### How it works, and what is kept where

- The sign-in is the OpenID Connect authorization-code flow, run by the app's
  friend gateway. It uses PKCE for Google; Apple returns with a form POST and
  does not support PKCE, so its client secret is a short-lived ES256 token the
  app signs with your `.p8` key. Each sign-in has its own `state`, tied to the
  browser that started it by a ten-minute cookie, and a `nonce` the ID token
  must carry back. The ID token is fetched from the provider directly, and the
  app checks its signature against the provider's published keys, its issuer,
  audience, expiry and issue time, and that the email is verified.
- After a sign-in, the game client asks the gateway for a **one-time login
  token**: `~` and 22 random characters, sent in place of a password. Only its
  SHA-256 is stored, in `login_tokens`. The login server accepts it once, for
  that account only, within 60 seconds, and compares hashes in constant time.
  This is a change on our rAthena fork (`src/login/login_token.cpp`), which is
  why the server must be a build that includes it.
- New accounts get a random password nobody is shown, so they can only be
  entered by signing in.
- The Google client secret and the Apple `.p8` key are kept like the Cloudflare
  credential: encrypted by your operating system's password store, in the app's
  `sharing` folder. They are never written under `state/assets`, never sent to a
  friend's browser, and never logged. Neither are tokens.
- **Remove** in Settings forgets a provider. Accounts made with it keep their
  characters. Without the sign-in they cannot be entered until you set a
  password for them under Accounts.

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

Friends mode replaces automatic failed-password bans of the shared proxy IP
with five login attempts per minute per browser and per account. Other friends
can still log in after one browser makes mistakes. The gateway parses the
shipped client's ordinary login protocol across split/batched frames, retains
only hashed account keys for these limits, and leaves explicit IP bans intact.
Custom SSO/Han login modes and non-ASCII account names are not supported here.

The Rust supervisor checks the actual running era, managed credentials, GM
password policy, suffix signup policy, container port bindings and the pinned
base command/permission files. Mods replacing command/permission imports are
refused for friends mode. The app probes the current LAN listeners as a second
opinion: a port that answers refuses sharing outright, while a probe a firewall
drops is reported to the player rather than treated as a failure, since the
supervisor has already verified the bindings from the inside. A
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
and stops the owned world. The default fixture never provisions Cloudflare resources.

With the packaged app and other development hosts fully stopped, run:

```sh
RO_E2E_WORLD=/absolute/path/to/marked/disposable/world \
RO_E2E_CLIENT_JSON=/absolute/path/to/client-file-selection.json \
node tests/e2e/friends-sharing.cjs
```

The selection JSON supplies only installed game-asset paths. The test world
must already have its own prepared runtime and private test accounts from the
account acceptance fixture. Never point `RO_E2E_WORLD` at a player's save.

Set `RO_E2E_REAL_CLOUDFLARE=1` to explicitly run the same test through the
production controller and a real temporary Cloudflare tunnel. This mode uses
normal certificate verification, creates no account/DNS resources, and closes
the app-owned connector during cleanup. It exercises the actual no-token Share
button. A separate physical/cellular client is still a different acceptance row.

On September 7, the production no-token Share button passed this real Cloudflare
test on macOS ARM64: eight rejected native logins left another friend able to
join, invited account creation preserved running services, both clients shared
a map and live chat, and Stop removed remote access while local services stayed
up. Browser errors were empty and the owned connector/world stopped during
cleanup. The readiness check uses a fresh DNS resolver for each attempt and
Cloudflare's public DNS for temporary names; this avoids stale negative answers
observed during Electron startup while retaining normal TLS verification.

Unit tests cover unauthorized paths, forged headers/origins, private files,
account limits, revoked/expired sessions and active sockets, frame limits,
Cloudflare provisioning rollback, secure-storage refusal, and connector
cancellation/failure. Named-tunnel provisioning, separate-network/cellular, sleep/wake and packaged
platform acceptance must be recorded separately from either automated fixture.

Provider references: [Cloudflare setup](https://developers.cloudflare.com/tunnel/setup/),
[API setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/),
[cloudflared source and license](../third-party/cloudflared/README.md).

## Helper versions and diagnostics

The helper downloads on demand from the official GitHub release for the current
platform. The app pins its version and archive/executable SHA-256 checksums.
**Copy diagnostics** (also Save diagnostics and issue reports) includes the pin,
verified installed version, release date, platform/asset, official download URL,
checksums and current integrity status. It records the download and latest
helper verification times in `sharing/helpers/<version>/installation.json`.
Older cached helpers have an unknown download time; their version can still be
verified by checksum. Collecting diagnostics never downloads or executes the
helper and never includes tunnel credentials or raw connector logs.

Update the app to receive a newer helper pin; the helper does not auto-update.
Cloudflare [supports versions within one year of its most recent release](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
Maintainers must refresh the version, release date and all platform checksums
together when upgrading, and retest public HTTPS/WSS sharing. The release date
in diagnostics helps identify stale app/helper installations; it is not an
online check of Cloudflare's latest release or support status.
