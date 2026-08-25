# Linux and Windows builds, and CI for all three

*Plan only — nothing here is implemented yet.*

The macOS build is self-contained: 339 MB installed, 196 MB compressed, no
Docker and no Node required on the target machine. Most of what makes that work
is already cross-platform. Nebula is tested on macOS
(Virtualization.framework), Linux (KVM) and Windows (Hyper-V/WHP, **no WSL2**),
Tauri targets all three, and rAthena is more at home on Linux than on macOS.

So this is mostly a packaging exercise. The parts that genuinely differ are
listed first, because they are the ones that will eat the time.

---

## The four things that actually change

### 1. The container image is arm64-only

`containers/rathena/Dockerfile` is built for the host's architecture, and every
build so far has been Apple Silicon. A Linux or Windows x86_64 build needs an
**amd64 rAthena image**, which means:

- `scripts/package.sh` grows a target architecture rather than assuming the
  build host's.
- The image is built per-arch in CI (`--platform linux/amd64`), not on a
  developer laptop.
- `dist/images.tar.gz` becomes per-arch, so the download differs by platform.
  Do not ship a multi-arch bundle: it would double the 135 MB for no benefit.

This is the single biggest item and the one most likely to surface surprises,
because it is the first time rAthena is compiled anywhere but arm64 Alpine here.

### 2. Bundled binaries are per-platform

`payload/bin/` currently holds four macOS arm64 binaries:

| Binary | Where it comes from | Notes |
|---|---|---|
| `nebula`, `nebulad` | nebula's own release build | already built for all three in `release.yml` |
| `docker-slim` | nebula-slim | pure Rust, cross-compiles to Windows without WSL2 |
| `node` | nodejs.org official tarball | **must** be the official build — Homebrew's links Homebrew dylibs and is not portable |

Each needs its platform equivalent, and `node.exe` on Windows brings a
different directory layout. Worth a small manifest rather than hardcoded paths.

### 3. Guest images

On first run nebula downloads a kernel and rootfs (~147 MB compressed) from its
GitHub releases. Those are per-architecture too. Either accept the download —
it is nebula's own bootstrap and keeps us from duplicating their artifacts — or
bundle them and grow the installer by that much. **Decide this before release**,
because it is the difference between "works offline" and "needs the internet
once".

### 4. Paths and the spaces bug

State already goes through Tauri's `app_data_dir`, so `~/.local/share/ragnarokmac`
and `%APPDATA%\com.ragnarokmac.app` come for free. Two things to carry over:

- **Single-file bind mounts break when the host path contains a space.** This
  was found on macOS (`~/Library/Application Support/…`) and reproduces with the
  real docker CLI, so it is not ours and not the shim's. Windows is worse:
  `C:\Users\<name>\…` frequently contains spaces, and usernames can too. The fix
  already in place — mount `conf/import` as one directory instead of five files —
  is what makes this portable. Do not reintroduce file mounts.
- Windows path separators reach the container runtime as bind sources. Anything
  built by string concatenation needs checking.

---

## What ports cleanly

- **Tauri shell** — no macOS-specific APIs. The menu already uses
  `PredefinedMenuItem`, which maps to the platform convention; Settings lands
  under File rather than the app menu, which is correct elsewhere.
- **`scripts/*.sh`** — bash, and all four scripts avoid macOS-isms except
  `sed -i ''`, which needs `sed -i` on GNU. Windows needs Git Bash or a rewrite;
  a small Rust supervisor would remove the shell dependency entirely and is
  worth considering if Windows proves painful.
- **The client and translation** — pure JS and data, identical everywhere.
- **The asset flow** — users supply their own GRFs on every platform. The
  first-run picker is already Tauri's native dialog.

---

## CI

Nothing is automated today; every build so far has been local. Three workflows,
smallest first:

### `ci.yml`
On every push: `cargo fmt --check`, `cargo clippy`, `bash -n` over `scripts/`,
and a client build. Cheap, and it catches the class of mistake that has actually
bitten — a shell script that only fails at runtime.

### `release.yml`
Tag-triggered matrix over `macos-14` (arm64), `ubuntu-latest`, `windows-latest`:
build the rAthena image for the target arch, run `scripts/package.sh`, build the
Tauri bundle, upload the artifact. Nebula's `release.yml` is the reference — it
already does a three-platform matrix with the libkrun fork.

### macOS signing — already solved, next door

`~/Projects/nebula/scripts/sign-release.sh` does Developer ID sign → notarize →
staple → DMG, and is parameterised entirely by environment. Adapting it is
changing the app path and the entitlements file. It expects:

| Secret | Purpose |
|---|---|
| `APPLE_TEAM_ID` | Developer team |
| `APPLE_CERT_P12_BASE64` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERT_PASSWORD` | `.p12` export password |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8` | `notarytool` App Store Connect key |

Details worth copying rather than rediscovering: it imports into a **throwaway
keychain** (never the default), signs with `--options runtime --timestamp`, and
trims whitespace from the pasted IDs — stray whitespace is the classic
notarytool failure.

These secrets exist on the nebula repo. If they are repo-scoped they must be
re-added to ragnarokmac; promoting them to **organisation secrets** avoids
maintaining two copies.

Today's build is **ad-hoc signed**, so Gatekeeper will refuse it on anyone
else's Mac. That is a hard blocker for handing a DMG to a friend, and it is the
one release task with an external dependency (Apple), so start it first.

### Windows and Linux signing

- **Windows**: unsigned installers trip SmartScreen. An OV/EV code-signing
  certificate is a purchase with a lead time — decide now whether v1 ships
  unsigned with instructions, or waits.
- **Linux**: no signing expectation. `.AppImage` is the least-friction format
  given we already bundle everything; a `.deb` implies dependency declarations
  we do not need.

---

## Suggested order

1. macOS signing + notarization in CI. External dependency, longest lead time.
2. `ci.yml`. Cheap, and stops regressions while the rest lands.
3. Linux build — closest to the current one, and rAthena's native platform.
4. amd64 rAthena image. Needed by both Linux and Windows; do it once.
5. Windows build. Most likely to need real work, mostly around bash and paths.

## Open questions

- Ship the guest kernel/rootfs, or let nebula fetch them on first run?
- Is a Windows code-signing certificate worth buying for v1?
- Do we keep bash, or move the supervisor logic into Rust to make Windows a
  first-class target rather than one needing Git Bash?
- Does an x86_64 Mac build matter, or is Apple Silicon only acceptable?
