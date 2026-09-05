# Working in this repository

Read [README.md](README.md) first — its **Architecture** section is the real
reference and this file does not replace it. What follows is the part that is
easy to get wrong from inside the tree.

## The one that will bite you: there are two RemoteClients, and we use the Rust one

The asset server is
[**roBrowserLegacy-RemoteClient-Rust**](https://github.com/Flux159/roBrowserLegacy-RemoteClient-Rust)
— ours, a Rust rewrite. It ships as the `robrowser-remoteclient` binary and
serves `:3338`.

`vendor/roBrowserLegacy-RemoteClient-JS/` is the **upstream Node reference we
ported from**. It is kept for comparison. It does not run, and reading it to
answer "what does the server do?" gives answers that are plausible, detailed
and wrong — the two have diverged. Its `path-mapping.json`, for instance, is a
generated file with zero entries, and the Rust port implements no path mapping
at all.

If the checkout is not beside this one, ask rather than reading the JS copy.

**What the Rust server does, in order** (`src/client.rs`, `resolve`):

1. in-memory cache
2. loose files under the server root — `state/assets/`, which is where the
   translation layer and every mod's `data/` land
3. `DATA_OVERRIDE_PATH`
4. the GRFs, under the requested spelling, then under the Korean reading of it

A miss returns 404 and is appended to `state/assets/logs/missing-files.log`.
It never falls back to a different file, so it cannot serve *wrong* content —
only the right file or nothing. When a client renders the wrong sprite, the
asset server is not the suspect; when it renders nothing, that log names the
file.

## The three projects, and where each one's problems show up

| Piece | Ours? | Where it runs | Symptoms it owns |
|---|---|---|---|
| [nebula](https://github.com/Flux159/nebula) | ours | host | the microVM will not boot; guest images; `NEBULA_MIN_VERSION` |
| [rAthena](https://github.com/rathena/rathena) | upstream, vendored at `vendor/rathena` | in containers, in the VM | anything about rules: drops, refine, quests, NPCs, what a feature flag switches on |
| [roBrowserLegacy](https://github.com/MrAntares/roBrowserLegacy) | upstream + `patches/` | Chromium, in Electron | anything you can see: UI windows, sprites, packet parsing |
| RemoteClient (Rust) | ours | host, `:3338` | file resolution, GRF decoding, the WS→TCP proxy |

Everything Linux-side runs in containers inside a microVM the app carries. The
server is never ported; we bring the platform it is tested on.

### The seam where bugs actually live

rAthena and roBrowserLegacy are developed by different people against different
assumptions, and **the app is the only thing that makes them agree**. Both are
compiled/configured to packet version **20221005** (`scripts/bootstrap.sh` sets
the server's, `config/Config.local.js` the client's — they must move together).

That still leaves a gap: rAthena will happily use a feature the client has never
implemented. `conf/battle/feature.conf` ships with `feature.refineui: on` and
`feature.stylist: on`; roBrowser implements the refine UI but gates it behind a
config flag, and does not implement the stylist window at all. The result is an
NPC that closes its dialogue and opens nothing.

**So when a UI "does not open", check three things in this order:**

1. Does roBrowser register and hook the packet? Search `Online.js` for the
   packet name, not the hex id — and use *its* names (`OPEN_REFINING_UI`, not
   `ZC_REFINE_OPEN_WINDOW`; `UI_OPEN`, not `ZC_OPEN_UI`).
2. Is it behind a `Configs.get("enable…")` flag? Several are, and
   `Config.js` does not define them all.
3. Does rAthena's script have a non-UI fallback? `getbattleflag("feature.x")`
   in an NPC script usually means it does.

`onUIOpen` handles exactly three `ui_type` values (7 attendance, 8 enchant
grade, 10 enchant). rAthena's enum is in `src/map/clif.hpp` — `OUT_UI_STYLIST`
is 1, and nothing handles it.

## Layout

| Path | What it is |
|---|---|
| `stack/` | `ragnarok-stack`, the Rust supervisor. **No dependencies** — see below |
| `electron/` | the shell: `main.js` (privileged), `preload.js`, IPC |
| `config/Config.local.js` | the roBrowser config **template**; `write_client_config` in `stack/src/assets.rs` rewrites it per era and per mod |
| `mods/` | bundled mods, shipped in the app |
| `examples/mods/` | worked examples, not shipped enabled |
| `vendor/rathena` | read it to answer "what does the server do?" |
| `third-party/population-engine` | our modified copy, GPL-3.0, changes marked `RAGNAROKMAC` |

`stack/` and the randomizer have **no crate dependencies**, on purpose: this
ships in a signed bundle, CI has to stay quick, and there is no dependency tree
to audit. Hand-rolled JSON, YAML-shape reading and zlib live there for that
reason. Match it — do not add a crate without saying why.

## Runtime state

`~/Library/Application Support/Ragnarok Offline/` on macOS.

| Path | Notes |
|---|---|
| `state/assets/` | the served root. **Rebuilt from scratch on every `link-assets`** |
| `state/mods/` | installed mods. Deliberately *outside* the asset root so a rebuild cannot destroy them |
| `state/assets/overlay.id` | fingerprint of the mod overlay; the shell clears the client's cache when it changes |
| `state/logs/`, `state/crashes/` | supervisor logs; preserved map-server crashes |
| `File System/` | Chromium's sandboxed FS — **roBrowser's own file cache** |

That last one is worth knowing about: roBrowser saves what it downloads and
looks there before asking the server again, keyed by filename. It survives
restarts, so a mod that replaces a stock file can appear to do nothing while
every status says it worked.

## Testing

- `cd stack && cargo test` — the supervisor's suite.
- `node --check electron/main.js` after touching the shell.
- `npm start` runs the app from source against the *same* state directory as
  the packaged build, which is the quickest way to test a shell change.
- Killing things: `pgrep -x` and kill by PID. `pkill -f <pattern>` has matched
  the agent's own shell in this repo and killed the session.

The build workflow triggers on `v*` tags and manual dispatch only — **there are
no PR checks**, so local verification is all there is.
