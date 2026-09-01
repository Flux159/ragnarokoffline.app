# Other clients, other servers

*Plan only — nothing here is implemented yet.*

Ragnarok Offline is a packaging layer that happens to package one client and one
server. rAthena and roBrowserLegacy run unmodified in containers; nothing about
the microVM, the setup flow, the config generation or the LAN plumbing knows what
is running inside. That is the whole argument for this document: the interesting
asset is the packaging, and it is not tied to either choice.

There is a wave of open clients right now, several of them good, and at least one
alternative server emulator. Being able to run any of them without the setup tax
is a better product than being a nice wrapper around one stack.

| Project | Language | What it is | Notes |
|---|---|---|---|
| [goro](https://github.com/kivutar/goro) | Go, wgpu | native client | MIT, statically linked, aims to be a drop-in replacement for the original exe |
| [korangar](https://github.com/vE5li/korangar) | Rust | native client | |
| [nostalro-client](https://github.com/nmeylan/nostalro-client) | Rust | native client | targets ≤ EP13, packetver ≤ 20120307, Windows and Linux |
| [rust-ro](https://github.com/nmeylan/rust-ro) | Rust | **server** emulator | the alternative-to-rAthena case |
| [roBrowserLegacy](https://github.com/MrAntares/roBrowserLegacy) | JS/WebGL | browser client | what we ship today |

---

## The thing that actually couples, and it is not the client

The instinct is that swapping clients is the hard part. It is not. **A client and
a server have to agree on a packet version and an asset era**, and that agreement
is the only real constraint in the system.

Our rAthena is compiled `--enable-packetver=20221005`
(`containers/rathena/Dockerfile:17`). goro targets pre-renewal, roughly the 2008
experience. nostalro-client explicitly supports packetver up to 20120307 and
resources up to EP13. Neither will talk to the server we ship today, and no amount
of client-side work changes that — it is a server build-time decision.

**The good news is that this is already parameterised**, which was not obvious
until I looked:

- `PACKETVER` is a Dockerfile `ARG`, set once in `scripts/bootstrap.sh:13`, and
  `images.yml` reads it from there rather than keeping a second copy.
- The built image is tagged with it: `ragnarokmac/rathena:20221005`.
- The stack picks the image from `RAGNAROKMAC_IMAGE`
  (`stack/src/config.rs:97`), defaulting to that tag.

So a second era is a second image tag built with a different build-arg, selected
by an env var that already exists. No code change, no fork, no second Dockerfile.
That is a much smaller lever than expected, and it is the one to pull first.

---

## Native clients remove architecture rather than adding it

roBrowserLegacy is a *browser* client, so we serve it. A native client is a
process, so we launch it. That deletes most of what sits between the shell and
the server:

| Today | With a native client |
|---|---|
| Electron `BrowserWindow` renders the client | native process; we own no window |
| RemoteClient serves the client bundle over HTTP | not needed — it is a binary |
| RemoteClient extracts GRF assets on demand | not needed — it reads GRFs off disk |
| RemoteClient proxies WebSocket → raw TCP | not needed — it speaks TCP directly |

**RemoteClient disappears entirely** in that configuration, and the Electron shell
becomes what it already half is: a supervisor that brings the stack up and then
starts something. `electron/main.js` currently ends that sequence with
`win.loadURL('http://127.0.0.1:3338')`; the native path ends it with a spawned
child process pointed at `127.0.0.1:6900`.

Everything below the client is untouched — nebula, the microVM, rAthena, MariaDB,
first-run setup, the GRF folder picker, rate settings, backups.

**Joining a friend gets simpler, not harder.** Today "join" means pointing a
browser at the host's asset server, because the client itself is served from
there. A native client connects straight to the host's rAthena, which is how every
other RO client in the world works. The `char_ip`/`map_ip` rewriting we already do
for LAN hosting is exactly what that needs.

The cost is on the other side: we would be shipping and code-signing a
third-party binary per platform, and inheriting its crash reporting, its update
cadence and its asset expectations. roBrowser's real advantage is that one
Chromium renders it identically everywhere and there is one renderer to test.

---

## Stage 1 — make the era a choice

The smallest change that unlocks everything else, and worth doing even if no
second client is ever added.

1. Build and publish a second rAthena image at an older packetver. `images.yml`
   currently reads a single `PACKETVER`; it needs to loop, and the release needs
   to carry both tarballs.
2. Surface the choice. `RAGNAROKMAC_IMAGE` already exists as the seam — the work
   is a Settings control and persisting it in `client.json` alongside the mode.
3. Warn on mismatch. `scripts/grfls.py` already inspects the user's GRFs on first
   run; it should say "your client data does not cover this era" rather than
   failing at map load.

The database is the thing to be careful with: characters created against one era
are not obviously portable to another, and the existing `backup`/`restore` path is
the only safety net. Switching era should be a deliberate action with a warning,
not a dropdown that silently reinitialises a world.

## Stage 2 — one native client, end to end

Pick **one** and take it all the way rather than building an abstraction for three
clients we have not shipped any of. goro is the natural first candidate: MIT,
statically linked by design, and its author explicitly wants it to be a drop-in
replacement, which is the same shape as what we need.

1. A `client` field in `client.json` beside `mode`, with `robrowser` as the
   default and no behaviour change when unset.
2. `start_stack` branches: serve-and-load-URL, or spawn-and-supervise. The stack
   startup and health-checking above it does not change.
3. Ship the binary in `payload/bin/` per platform, signed with the rest of the
   sidecars. `scripts/package.sh` already stages per-platform binaries and knows
   about `.exe` suffixes; this is one more entry.
4. Decide what the app window *is* when the game runs in another process — most
   likely settings and boot progress only, with the game window belonging to the
   client.

The honest risk is that a native client makes the app a launcher, and a launcher
that adds a microVM is competing with "just run the exe" on Windows. The value is
clearest exactly where it is now: macOS, where there is no exe to just run.

## Stage 3 — a different server

rust-ro is a server emulator, so it slots in where rAthena does: a different
container image behind the same supervisor. The interface it has to satisfy is
narrow — listen on the three ports, read a config we generate, use the MariaDB we
start — and `stack/src/cmds.rs` currently hard-codes rAthena's container names and
the shape of its config.

Not worth doing speculatively. Worth knowing that the seam is an image tag and a
config generator, and worth not making that harder in the meantime.

---

## What is out of scope

The [3rd-person camera / WASD project](https://www.reddit.com/r/RagnarokOnline/comments/1vv9p99/)
from the Gearfinder group is a different kind of thing: modifications to the
original client plus server-side movement handling. There is no redistributable
client to package, so it is a collaboration rather than an integration. Same for
the Unity reimplementations — interesting, not packageable.

---

## Open questions

- Is a second packetver image worth the release weight — another ~135 MB per arch
  in the images tarball — before any client needs it?
- Do we ship third-party client binaries inside our bundle, or fetch them on first
  run? Shipping means signing and notarising someone else's code and owning its
  crashes; fetching means a download step we currently do not have.
- If the game runs in a native process, what is the Electron window for? A
  settings pane and a boot log may not justify Chromium at all — and if it does
  not, the shell could be something much smaller.
- Does era selection belong per-install or per-server-entry? It is a property of
  the *server*, so the moment someone joins a friend it has to come from the host,
  not from local settings.
- Who owns the compatibility matrix? "Which client works with which server at
  which packetver with which GRFs" is real documentation, and getting it wrong
  produces exactly the silent failure this project exists to avoid.
