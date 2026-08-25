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

RO client assets are copyrighted by Gravity Co., Ltd. and are **never** committed,
bundled, or redistributed with this app. `.gitignore` blocks `*.grf` deliberately. The
app points at a client folder you supply, with a first-run screen that explains what
is needed.

The layout RemoteClient-JS expects:

```
resources/
├── DATA.INI        # required — lists the GRFs, in load order
├── data.grf
├── rdata.grf
└── *.grf
```

`DATA.INI` is the standard RO ini; entry `0` wins over `1`:

```ini
[Data]
0=rdata.grf
1=data.grf
```

Load order matters: **lower index wins**. Overlay GRFs (costume/effect packs) go
above the base client GRFs:

```ini
[Data]
0=kro_data.grf          ; overlay: costumes, effects, modern UI
1=official_data.grf     ; overlay
2=rdata.grf             ; kRO base
3=data.grf              ; kRO base — maps, models, palettes, lua
```

`scripts/grfls.py` inspects a GRF and reports what it does and does not contain. Run
it on your files before wiring anything up — a GRF with no `.rsw`/`.gnd`/`.gat`
entries is a sprite overlay, not a playable client, and it will fail at map load
rather than at startup. The same check runs on first launch so the app can say
"this GRF has no maps" instead of hanging on a black screen.

Requirements worth knowing before you start:

- GRF version **0x200** or **0x300**, **without DES encryption**. Encrypted GRFs must
  be repacked with [GRF Editor](https://github.com/Tokeiburu/GRFEditor) using
  *Options → Repack type → Decrypt*, then *Tools → Repack*.
- Loose files that live outside the GRF (`System/itemInfo.lua`, `msgstringtable.txt`,
  BGM, `AI/`) go in a folder pointed at by `DATA_OVERRIDE_PATH`, or in
  `data/` / `System/` / `BGM/` next to `resources/`.

---

## Status

Pre-implementation. This README is the plan; nothing is built yet.

## License

The RagnarokMac source is MIT. rAthena, roBrowserLegacy, RemoteClient-JS, and Nebula
each carry their own licenses. Game assets are not covered by any of them.
