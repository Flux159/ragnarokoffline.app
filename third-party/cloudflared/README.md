# Cloudflare connector

The app downloads the official cloudflared **2026.8.3** release when the owner
starts sharing or connects Cloudflare. The platform archive and executable checksums are pinned in
`electron/sharing/helper.js`; an unverified download is never executed. The
helper is not bundled into a release by this change and never auto-updates.
The official project uses Apache-2.0; its license is retained here.

An installation record beside the helper stores its version, platform, release
date, source, checksums, download time and latest helper verification time.
Copy diagnostics rechecks the executable checksum and includes these non-secret
details. Legacy caches have an unknown download time. Helper updates ship by
updating the app's pin; maintainers must keep it within Cloudflare's supported
window (one year of their latest release).

Source and release: https://github.com/cloudflare/cloudflared/tree/2026.8.3

The app provisions a **locally managed** named tunnel with a dedicated secret,
then writes an exact-host ingress to its protected loopback gateway plus a 404
fallback. It does not run a dashboard-managed tunnel with arbitrary remote
origins. The setup API token is ephemeral; only the dedicated tunnel credential
is saved through Electron's OS-backed safeStorage. `TUNNEL_CRED_CONTENTS` passes
that credential directly to the owned child; it is absent from argv, logs and
plaintext credential files. Logs use error level and are not forwarded into
application diagnostics.

The routing JSON contains no secret. It lives outside the asset root. DNS and
the stopped tunnel remain in the user's Cloudflare account when the local
credential is forgotten; the UI states this explicitly.
