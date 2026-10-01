# autologin

Opens the game on the character you played last. No login screen, no
character select: press Play and you are standing where you logged out.

Ships with the app, **off**. Turn it on in **Settings → Mods → autologin**.

## Using it

1. Turn the mod on, start the game and log in as usual. Pick a character.
2. Once you are on the map, the login is remembered.
3. From then on every launch logs you in and plays that character. For a
   moment you see "Logging in as …" over the login background, and then the
   game.

| You want | Do this |
|---|---|
| Pick a different character next time | **Escape → Character select.** The next launch logs you in and stops at character select. Whoever you play next is remembered. |
| Log out properly | **Escape → Exit** (or **Cancel** on character select). The remembered login is revoked, and the next launch shows the login screen. Log in again to be remembered again. |
| The login screen just this once | Hold **Shift** while the game starts, or press **Show the login screen** on the "Logging in…" card. Nothing is forgotten. |
| Be logged in, but always choose a character | Untick **Also play my last character** under the mod in Settings. |
| Stop it entirely | Turn the mod off. |

If something has changed since last time, you get the normal screen and a
short note at the top saying why, once:

- the remembered login was revoked, expired (30 days unused), or the account's
  password was changed or the account was disabled in Settings → Accounts:
  the login screen;
- the character was deleted or is waiting to be deleted: character select;
- the server could not be reached: the login screen, and it tries again next
  time.

## What is remembered, and where

**Never your password.** Nothing in the game page holds it, and nothing this
mod stores could be used as it.

- **The app keeps a remembered-login credential**: 256 random bits, made by the
  app when you first reach the map. In your own game window it is kept in a file
  of the app's (`state/remembered-login.json`, one per era), outside the page's
  storage. Everyone else's browser keeps it in an HttpOnly cookie that the
  world's host sets (see the next section). No script in the page, this mod's
  included, can read it.
- **The server keeps only its SHA-256**, in `app_remembered_logins`, with the
  account it belongs to.
- **The mod keeps** (in the page's own storage) whether a login is remembered,
  the account name for the "Logging in as" card, and the id and name of your
  last character.

At launch the app trades the credential for a **one-time login token**: 60
seconds, one use, only its hash stored, in `login_tokens` -- the same tokens
Google/Apple sign-in uses. The client sends the token where a password would
go, and the login server accepts it once.

To remember a login, the page has to prove it is logged in to that account
right now. It does that with the session token the login server gave the client
at login, which the server already uses to prove an account to its own web
services. So a mod cannot get a credential for an account it is not playing.

## Where it works, and how the credential is kept there

Every player of a world, on their own device:

| How you reach the world | Where the credential is kept |
|---|---|
| **Your own world, in the app** | a file of the app's, asked for over the app's IPC |
| **Through the host's sharing link over HTTPS**: a quick `trycloudflare.com` tunnel, or the host's own domain (a named tunnel) | `__Host-ro-remember`: **Secure**, HttpOnly, SameSite=Strict, Path=/. Set by the friend gateway, the only HTTPS the app serves, so every HTTPS player gets this cookie. |
| **A LAN join** (`http://<host's LAN address>:<port>`), only while the host has LAN turned on | `ro-remember-<port>`: HttpOnly, SameSite=Strict, Path=/_friend/remember/. The host's asset server hands that path to the app (`APP_PROXY_PREFIX`), which answers with the same routes the gateway uses. |

The split is decided by **which of the app's own listeners the request came
in on**, never by anything the request says about itself. The gateway always
sets the Secure cookie. The LAN endpoint is reached only through the asset
server's plain-HTTP listener and never sets or reads the gateway's cookie.

**Over plain HTTP the cookie cannot be Secure.** Scripts still cannot read it,
but anyone who can watch that network can see it, just as they can see the
game's own login packets. The mod says so once when it first remembers you
over plain HTTP. If that matters to you, ask the host for their HTTPS sharing
link. The same goes for a custom DNS name pointed straight at the host's port
without TLS: it is plain HTTP and is treated as LAN. A TLS proxy of your own
in front of the LAN port is refused rather than given the weaker cookie. Use
the app's tunnel or your own domain through it instead.

Anywhere else, such as a LAN join while the host has LAN off, or another
server, the mod does nothing.

Needs a login server that accepts one-time tokens (our rAthena fork,
`login-tokens`). One that does not refuses the token; after two refusals in a
row the mod forgets the login and stops trying.

## How it is built

Everything is the client API, so the mod is one file, `client/index.js`:

- `api.screens.replace('login' | 'charSelect', …)` takes the two screens
  while it drives them, and `view.login(username, token)` / `view.play(slot)`
  press their buttons. It hands both screens back as soon as it is done, or
  as soon as anything goes wrong.
- `api.account.remember()` / `.resume()` / `.forget()` keep the login.
- The `exit` event says the player chose Character select or Exit. It comes
  from `UI/ExitHooks.js` in our roBrowser fork, raised by the Escape window and
  by character select's Cancel; a disconnect is never reported, so losing the
  connection does not log you out.

See [docs/MODDING.md](../../docs/MODDING.md#leaving-the-game-and-remembered-logins--exit-and-apiaccount).
