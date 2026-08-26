#!/usr/bin/env bash
# Sign the built .app for distribution, and optionally notarise it.
#
#   scripts/sign.sh [path/to/RagnarokMac.app]
#
# Tauri does not seal the bundle: it leaves a linker-signed main binary and no
# Contents/_CodeSignature at all. That passes unnoticed locally, because nothing
# checks a signature you never transferred. Copy the app to another Mac and
# Gatekeeper rejects it as "damaged and can't be opened" — a dead end with no
# "Open Anyway", and one that looks nothing like a signing problem.
#
# Set RAGNAROKMAC_IDENTITY to override the certificate. Without one, this falls
# back to an ad-hoc signature: valid, sealed, still not notarisable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/RagnarokMac.app}"
[ -d "$APP" ] || { echo "no app bundle at $APP" >&2; exit 1; }

IDENTITY="${RAGNAROKMAC_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
    IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
        | grep "Developer ID Application" | head -1 \
        | sed 's/.*"\(.*\)"/\1/') || true
fi
if [ -z "$IDENTITY" ]; then
    echo "no Developer ID found; signing ad-hoc (not notarisable)" >&2
    IDENTITY="-"
fi
echo "==> identity: $IDENTITY"

# Hardened runtime is required for notarisation, and a Developer ID signature
# without it is refused by the service. Ad-hoc cannot use it.
RUNTIME=()
[ "$IDENTITY" != "-" ] && RUNTIME=(--options runtime --timestamp)

ENT="$ROOT/config/entitlements.plist"

sign() {
    local target="$1"; shift
    codesign --force --sign "$IDENTITY" ${RUNTIME[@]+"${RUNTIME[@]}"} "$@" "$target"
}

# Inner code first: sealing the bundle hashes what is inside it, so anything
# signed afterwards invalidates the seal.
echo "==> sidecars"
for b in nebula nebulad; do
    # Virtualization.framework refuses to start a VM without these, and the
    # entitlement has to be on the binary that makes the call, not on the app.
    sign "$APP/Contents/Resources/payload/bin/$b" --entitlements "$ENT"
done
for b in docker-slim robrowser-remoteclient; do
    sign "$APP/Contents/Resources/payload/bin/$b"
done

echo "==> bundle"
sign "$APP"

echo "==> verify"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2
codesign -d --entitlements - "$APP/Contents/Resources/payload/bin/nebulad" 2>&1 \
    | grep -qi virtualization \
    && echo "  virtualization entitlement present" \
    || { echo "  MISSING virtualization entitlement" >&2; exit 1; }

if [ "$IDENTITY" = "-" ]; then
    echo
    echo "Ad-hoc signed. Another Mac will need right-click > Open, or"
    echo "  xattr -dr com.apple.quarantine /Applications/RagnarokMac.app"
    exit 0
fi

# Notarisation needs credentials this script deliberately does not invent. Store
# them once with:
#   xcrun notarytool store-credentials ragnarokmac --apple-id … --team-id … --password …
PROFILE="${RAGNAROKMAC_NOTARY_PROFILE:-ragnarokmac}"
if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    echo
    echo "Signed with Developer ID, but not notarised: no '$PROFILE' credential."
    echo "Until it is notarised, a downloaded copy still shows"
    echo "\"Apple cannot check it for malicious software\"."
    exit 0
fi

echo "==> notarising (a few minutes)"
ZIP="${TMPDIR:-/tmp}/RagnarokMac-notarize.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
# Staple, so the app validates offline — the machine that runs it may never
# reach Apple, and this whole project is meant to work with no network.
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
rm -f "$ZIP"
echo "==> notarised and stapled"
