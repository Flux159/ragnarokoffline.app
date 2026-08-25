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
| `official_data.grf` | 747 MB | 163,421 | *Overlay* from [llchrisll's ROenglishRE](https://github.com/llchrisll/ROenglishRE) docs. Costume/garment/effect sprites and other-region art (jRO/iRO/twRO event effects); 163,407 files absent from `data.grf`, colliding on only 14 — almost purely additive |
| `kro_data.grf` | 104 MB | 22,220 | Same source. **Skip it** — 22,147 of its 22,220 paths are already in `official_data.grf`, leaving 73 unique files |
| `BGM/` | 312 MB | 180 mp3 | Music, referenced by `data/mp3nametable.txt` |
| `System/` | — | — | `itemInfo*.lub`, `mapInfo*.lub`, quest lists, fonts |
| `AI/` | — | — | Homunculus/mercenary scripts |

### DATA.INI

**kRO does not ship one** — `Ragnarok.ini` and `RagnarokKR.ini` are encrypted launcher
config, not this. You write `resources/DATA.INI` yourself. **Lower index wins**, so
overlays go above the base:

```ini
[Data]
0=official_data.grf     ; overlay: costume/effect art (ROenglishRE docs)
1=rdata.grf             ; renewal overrides
2=data.grf              ; base: maps, models, palettes, lua
```

English text is *not* layered here — it comes in through `DATA_OVERRIDE_PATH`, which
outranks every GRF. See [English translation](#english-translation).

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

### English translation

kRO is Korean: `data/idnum2itemdisplaynametable.txt` and friends are CP949 Korean, and
there is **no `data/msgstringtable.txt`** at all — kRO ships
`data/luafiles514/lua files/msgstring_kr.lub`, which is not the file roBrowser reads.

The translation comes from [**ROenglishRE**](https://github.com/llchrisll/ROenglishRE).
Note that `official_data.grf` and `kro_data.grf` come from that project's docs site but
are **not** the translation — they contain zero text files, only `data/sprite` and
`data/texture`. They are the supplementary *art* packs. The translated text lives in
the repository's `Translation/` tree.

**We load the translation as loose files, not as a GRF.** `DATA_OVERRIDE_PATH` is
checked before any GRF (see the precedence chain below), so pointing it at
ROenglishRE's data folder overrides every Korean table without repacking a 2.4 GB
archive — and it can be re-pulled and diffed like the text it is:

```ini
DATA_OVERRIDE_PATH=../assets/roenglish/data
```

### Lookup precedence (verified in `clientController.js`)

For any asset request, RemoteClient-JS resolves in this order:

1. LRU memory cache
2. Loose files on disk next to the server root
3. `DATA_OVERRIDE_PATH` — **where the translation goes**
4. The GRF index — and within it, **the first GRF listed in `DATA.INI` wins**
   (`buildFileIndex()`: *"Only store first occurrence (first GRF has priority)"*)

So index `0` is the highest priority, not the lowest. An overlay placed *last* would be
shadowed by kRO's originals and do nothing. If you ever do ship the translation as a
GRF instead of loose files, it goes at index `0`.

### Other gaps

- **`System/itemInfo.lub`.** The live table is `System/itemInfo_true.lub`
  (2020-06-03); the `itemInfo.lub` at the client root is a 2012 leftover. Copy or
  symlink the right one into place — ROenglishRE ships a translated replacement, which
  is the one we actually want. Note it is compiled Lua 5.1 bytecode (`LuaQ` header),
  not source; confirm roBrowser's reader handles the compiled form before assuming
  item descriptions work.
- **Korean filenames.** Every asset path inside these GRFs is CP949-encoded
  (`data\texture\유저인터페이스\...`), and roBrowser requests them as Latin-1
  mojibake. RemoteClient-JS indexes both spellings and has an explicit mojibake
  fallback, which is a large part of why it was chosen over rolling our own asset
  server.

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

## Running it

```bash
scripts/bootstrap.sh ~/Downloads     # clone + build upstreams, link GRFs, build rAthena
scripts/stack.sh up                  # MariaDB + login/char/map in the microVM
cd src-tauri && cargo tauri build     # produces RagnarokMac.app + a DMG
```

Then open `RagnarokMac.app`, press **Start server**, then **Play**.

`scripts/stack.sh status|down|logs <service>` covers the rest. The app drives
the same script, so anything you can do in the launcher you can do in a terminal.

## Status

Working end to end on Apple Silicon (macOS 26.5, M-series):

| Piece | State |
|---|---|
| rAthena arm64 image | built, 224 MB runtime image, packetver 20200401 |
| MariaDB + schema | 63 tables imported on first boot |
| login / char / map | all three up, map connected to char, char to login |
| GRF asset serving | **1,012,440 files** indexed across 3 GRFs in 2.2 s |
| WebSocket proxy | browser-shaped `CA_LOGIN` returns `AC_ACCEPT_LOGIN` |
| login → char handshake | verified over the advertised address |
| Tauri shell | `RagnarokMac.app` + DMG bundle |

### Known issue: Nebula's published-port forwarder

Host→guest port publishing **cannot carry the game socket**. Nebula's forwarder
reconciles on a 2-second poll, and `list_containers(...).unwrap_or_default()` in
`crates/nebulad/src/net.rs` treats a *failed* Docker query the same as "no
containers running" — so every forward is torn down and rebuilt whenever the
query hiccups. Short HTTP requests survive; a long-lived game connection dies:

```
01:06:37  port forward removed (gone or IP moved) port=5121
01:06:37  port forward removed (gone or IP moved) port=3201   <- unrelated container
01:06:37  port forward removed (gone or IP moved) port=6900
01:06:37  port forward removed (gone or IP moved) port=6121
01:06:39  port forward added (127.0.0.1:5121 -> 192.168.64.2:5121)
```

All four went at once, including a container that had been stable for months —
the signature of an empty list, not four independent stops. Reproducible with a
bare `nc` echo container: the connection resets at ~1.0 s every time.

**Workaround in use:** skip the forwarder. On macOS the VZ NAT subnet is
host-routable, so containers publish on `0.0.0.0` inside the guest and
`scripts/stack.sh` discovers the guest address, writes it into
`conf/import/char_conf.txt` / `map_conf.txt` so the servers advertise a
reachable address, and regenerates both `endpoint.json` (read by the game page)
and the proxy's `WS_ALLOWED_TARGETS`. Nothing is hardcoded — the guest takes a
fresh DHCP lease on every boot.

Note also that the daemon's `/v1alpha1/status` reported a stale `agent.ip`
(`192.168.64.8`) while the live address was `192.168.64.2`, so discovery probes
before trusting it.

### Still to do

- English translation via `DATA_OVERRIDE_PATH` (see above) — the client is
  Korean until then.
- Containerise the asset server so the `.app` no longer needs Node on the host.
- Code signing and notarization.
- Auto-create the local account instead of seeding it by hand.

## License

The RagnarokMac source is MIT. rAthena, roBrowserLegacy, RemoteClient-JS, and Nebula
each carry their own licenses. Game assets are not covered by any of them.
