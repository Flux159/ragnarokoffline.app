# RagnarokMac

A single, self-contained macOS `.app` that runs **Ragnarok Online offline** — server,
client, and game window in one icon. Double-click it and you are in Prontera. No
Docker Desktop, no terminal, no MySQL install, no `.exe` under Wine.

Under the hood it stitches together three existing projects:

| Piece | Project | Role |
|---|---|---|
| microVM orchestrator | [**nebula**](https://github.com/Flux159/nebula) (`~/Projects/nebula`) | Runs the Linux side of the stack in a fast, embedded microVM on Virtualization.framework |
| game server | [**rAthena**](https://github.com/rathena/rathena) | The open-source RO server emulator (login / char / map / web) + MariaDB |
| game client | [**roBrowserLegacy**](https://github.com/MrAntares/roBrowserLegacy) + [**RemoteClient-JS**](https://github.com/FranciscoWallison/roBrowserLegacy-RemoteClient-JS) | WebGL RO client, GRF asset server, and TCP↔WebSocket proxy |

The app shell is **Tauri** (Rust + WKWebView), matching Nebula's own `ui/`, so the two
share a toolchain and a signing/notarization pipeline.

---

## Goals

### 1. One artifact, zero setup

`RagnarokMac.app` is the entire product. First launch does the bootstrap (pull guest
images, build the rAthena image, initialize the database, index the GRFs) behind a
progress screen, and every launch after that is a warm start into the character
select. Uninstall is dragging the app to the Trash plus deleting one state directory.

### 2. Offline-first, single player

The default mode binds every service to `127.0.0.1`. No account server on the
internet, no ports open to the LAN, no login you have to remember — the app creates
and auto-logs-in a local account.

### 3. Tuneable like a single-player game

Rates that normally require editing `conf/battle/*.conf` and restarting the server are
first-class app settings with sliders:

- **Base / Job / Quest EXP rate**
- **Zeny (drop + reward) rate**
- **Item / Equipment / Card drop rates**
- **Renewal vs Pre-Renewal** mechanics
- **Max level, stat/skill point pools**
- **Instant-cast / no-death-penalty / autoloot** style quality-of-life toggles
- **@commands** (`@warp`, `@item`, `@job`) on or off

These write to `conf/import/battle_conf.txt` — rAthena's designated override file, so
upstream config stays pristine — and are applied with `@reloadbattleconf` where the
setting supports a live reload, or a supervised map-server restart where it does not.

### 4. Honest, visible state

A status panel shows what is actually running: VM up/down and its real host memory
footprint (Nebula's balloon means an idle stack should cost ~1 GiB, not 8), each of
the five rAthena services, the asset cache hit rate, and the current character count.
Nothing about the stack should be a black box the user cannot inspect or restart.

### 5. Play, then get out of the way

The game itself renders in a dedicated Tauri window — fullscreen-capable, correct
retina scaling, no browser chrome, no address bar. It should feel like a native game,
not a web page in a frame.

### Later (explicitly not v1)

- **LAN mode.** Rebind services to `0.0.0.0`, flip `forceUseAddress` in the client
  config, and show a join URL + QR code. Friends on the same network open a browser
  and play — no client install on their side, which is the whole appeal of a
  browser-based client.
- **Invite a friend over the internet.** A tunnel (Tailscale / Cloudflare Tunnel /
  plain reverse proxy) in front of the same stack, with the client served over TLS.
  This needs a real look at authentication and abuse before it ships.
- **Content tooling.** In-app NPC/script editing, custom item and mob editors, world
  save/branch snapshots using Nebula's live memory snapshots (`vessels snapshot` +
  `branch`) so a server state can be forked and rolled back like a save file.
- **Nebula-slim.** If Nebula-slim's engine covers everything the stack needs, swap it
  in — it is ~32 MB versus ~140 MB+ for the full Go stack, and that is most of the
  difference between a 100 MB and a 300 MB download.

---

## Architecture

```
┌──────────────────────── RagnarokMac.app ───────────────────────────┐
│                                                                    │
│  Tauri shell (Rust)                                                │
│   ├── Launcher window   — start/stop, progress, status, logs       │
│   ├── Settings window   — rates, renewal, QoL toggles (⌘,)         │
│   └── Game window       — WKWebView → http://127.0.0.1:3338/…      │
│                                                                    │
│  Supervisor (Rust)                                                 │
│   └── drives the Nebula REST API (127.0.0.1:7440, v1alpha1)        │
│       via sdk/typescript's Rust equivalent / plain HTTP            │
│                                                                    │
│  Embedded Nebula engine ──► Linux microVM (Virtualization.framework)│
│      ┌──────────────────────────────────────────────────────┐      │
│      │  mariadb          :3306   accounts, chars, storage   │      │
│      │  rathena-login    :6900                              │      │
│      │  rathena-char     :6121                              │      │
│      │  rathena-map      :5121                              │      │
│      │  rathena-web      :8888   (emblems, party icons)     │      │
│      │  remoteclient-js  :3338   static client + GRF assets │      │
│      │                           + WebSocket proxy          │      │
│      └──────────────────────────────────────────────────────┘      │
│                    ports published to localhost by Nebula          │
└────────────────────────────────────────────────────────────────────┘

Browser/WKWebView ──HTTP──► :3338 (client JS + sprites/maps out of the GRF)
                  ──WS────► :3338/ws/127.0.0.1:6900 ──TCP──► login/char/map
```

**Why a microVM instead of building rAthena natively?** rAthena officially supports
Linux and Windows only; macOS is not a supported target, and Apple Silicon even less
so. Compiling it against Homebrew MariaDB works for some people some of the time and
is exactly the kind of "works on my machine" fragility a shipped `.app` cannot have.
Nebula gives a known-good Linux userland at a ~0.6 s boot and ~1 GiB idle cost, so the
server runs on the platform it is actually tested on. The containers are built
**arm64-native** — no Rosetta in the hot path.

**Why RemoteClient-JS specifically?** Its *unified server mode* collapses three
processes into one Node process on one port — the embedded static server replaces
`live-server`/Vite for the client bundle, the GRF controller replaces the PHP remote
client, and the built-in proxy replaces standalone `wsproxy.js`:

```ini
PORT=3338
ENABLE_STATIC_SERVE=true                 # serves the built roBrowserLegacy client
ENABLE_WSPROXY=true                      # /ws/{host}:{port} -> raw TCP
ROBROWSER_PATH=../roBrowserLegacy        # points at the client build
WS_ALLOWED_TARGETS=127.0.0.1:6900,127.0.0.1:6121,127.0.0.1:5121
DATA_OVERRIDE_PATH=                      # loose files not inside any GRF
CACHE_MAX_FILES=5000
CACHE_MAX_MEMORY_MB=1024
```

That means **one supervised process, one port, one healthcheck** for the entire client
side — the Tauri game window just opens `http://127.0.0.1:3338/…` and everything
(client JS, sprites decoded out of the GRF, and the game socket) comes from that
single origin. No CORS, no second server to babysit, no port juggling when we later
rebind for LAN mode. It also brings an LRU asset cache, GRF indexing for O(1) lookups,
and the CP949/Korean-filename handling RO assets require.

`WS_ALLOWED_TARGETS` is a genuine allowlist, which is the right primitive for the
later "expose to friends" mode — the proxy will only ever dial our own rAthena.

---

## Repository layout (planned)

```
ragnarokmac/
├── src-tauri/            Rust: app shell, supervisor, Nebula client, config writer
├── src/                  Launcher + Settings UI
├── containers/
│   ├── rathena/          arm64 Dockerfile + build script for rAthena
│   └── remoteclient/     Dockerfile for RemoteClient-JS + roBrowserLegacy build
├── config/
│   ├── battle_conf.tmpl  Template rendered from the Settings values
│   └── Config.local.js.tmpl  roBrowser client config (address, port, packetver)
├── scripts/
│   ├── bootstrap.sh      Clone/pin upstream sources into vendor/
│   └── package.sh        Build, sign, notarize, staple, DMG
└── docs/
```

Upstreams are **pinned by commit** in `scripts/bootstrap.sh` and fetched at build
time. They are not vendored into git — rAthena alone is a large, fast-moving tree, and
tracking a pin is easier to reason about than a subtree merge.

---

## Game assets (the part that is on you)

RO client assets are copyrighted by Gravity Co., Ltd. They are **never** committed,
bundled, or redistributed with this app — `.gitignore` blocks GRFs, `BGM/`, `System/`,
and the client folder deliberately. The app points at a client directory you supply,
with a first-run screen that explains what is needed.

A working set is a full kRO client. The kRO full-client and patch mirrors linked from
[**ratemyserver.net's kRO download page**](https://ratemyserver.net/index.php?page=download_kROLinks)
are the usual source; the reference set this project is developed against is the
**2020-06-03 kRO renewal client** from there.

### What a complete set looks like

Verified with `scripts/grfls.py` against the reference client:

| File | Size | Entries | Role |
|---|---|---|---|
| `data.grf` | 2.4 GB | 103,498 | **Base.** 854 maps, 7,269 models, 1,752 palettes, `luafiles514`, item/map name tables |
| `rdata.grf` | 931 MB | 55,012 | **Renewal overrides.** 605 files absent from `data.grf` + 135 that differ — the rest is duplicated |
| `official_data.grf` | 747 MB | 163,421 | *Optional overlay.* Costume/garment/effect sprites; 163,407 files not in `data.grf`, and it collides on only 14 — almost purely additive |
| `BGM/` | 312 MB | 180 mp3 | Music, referenced by `data/mp3nametable.txt` |
| `System/` | — | — | `itemInfo*.lub`, `mapInfo*.lub`, quest lists, fonts |
| `AI/` | — | — | Homunculus/mercenary scripts |

### DATA.INI

**kRO does not ship one** — `Ragnarok.ini` and `RagnarokKR.ini` are encrypted launcher
config, not this. You write `resources/DATA.INI` yourself. **Lower index wins**, so
overlays go above the base:

```ini
[Data]
0=official_data.grf     ; optional overlay: costumes, effects
1=rdata.grf             ; renewal overrides
2=data.grf              ; base: maps, models, palettes, lua
```

Run `scripts/grfls.py` on your files before wiring anything up:

```
$ scripts/grfls.py ~/Downloads/data.grf ~/Downloads/rdata.grf
```

It reads only the compressed file table (fast even on multi-GB archives) and reports
whether each archive is a playable base or a sprite overlay, plus a pairwise breakdown
of identical / overriding / unique paths so the load order can be chosen on real
numbers. A GRF with no `.rsw` entries fails at *map load*, not at startup, so this
check also runs on first launch — the app should say "this GRF has no maps" rather
than show a black screen.

### Known gaps in a stock kRO set

Two things the reference client does **not** provide, both of which need a community
overlay GRF placed above `data.grf`:

- **English text.** kRO is Korean. `data/idnum2itemdisplaynametable.txt` and friends
  are CP949 Korean, and there is **no `data/msgstringtable.txt`** at all — kRO ships
  `data/luafiles514/lua files/msgstring_kr.lub` instead, which is not the file
  roBrowser reads. Without a translation GRF the game is playable but entirely in
  Korean, with blank UI strings where `msgstringtable.txt` was expected.
- **`System/itemInfo.lub`.** The live table is `System/itemInfo_true.lub`
  (2020-06-03); the `itemInfo.lub` at the client root is a 2012 leftover. Copy or
  symlink the right one into place. Note it is compiled Lua 5.1 bytecode (`LuaQ`
  header), not source — confirm roBrowser's reader handles the compiled form before
  assuming item descriptions work.

### Loose files

Anything not inside a GRF — `System/`, `BGM/`, `AI/` — is served from disk. Point
`DATA_OVERRIDE_PATH` at it, or place the folders next to `resources/`. The override
path is checked *after* local `data/` and *before* GRF lookup, which makes it the
right place for per-server tweaks that should not require repacking a 2.4 GB archive.

### Packet version

The reference client is `Ragexe.exe` 2020-06-03 / `RagexeRE.exe` 2020-04-10. Pin
rAthena's `--enable-packetver` and roBrowser's `packetver:` to a value in that era
(**20200401** is the value roBrowser's own docs use and is well-trodden in rAthena).
Upstream's AIO compose defaults to `20250618`, which is far newer than these assets —
do not inherit it blindly.

## Status

Pre-implementation. This README is the plan; nothing is built yet.

## License

The RagnarokMac source is MIT. rAthena, roBrowserLegacy, RemoteClient-JS, and Nebula
each carry their own licenses. Game assets are not covered by any of them.
