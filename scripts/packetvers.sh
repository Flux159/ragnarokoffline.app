#!/usr/bin/env bash
# Print the packet versions in config/PACKETVERS, so every script and workflow
# reads the one list the same way.
#
#   scripts/packetvers.sh default   # the first: image tag, fresh installs
#   scripts/packetvers.sh extra     # the rest, space-separated (may be empty)
#   scripts/packetvers.sh all       # all of them, one per line
set -euo pipefail

FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/config/PACKETVERS"
vers=$(sed -e 's/#.*//' "$FILE" | awk 'NF { print $1 }')
for v in $vers; do
    case "$v" in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
        *) echo "config/PACKETVERS: not a packet version: $v" >&2; exit 1 ;;
    esac
done
[ -n "$vers" ] || { echo "config/PACKETVERS lists no packet versions" >&2; exit 1; }

case "${1:-all}" in
    default) echo "$vers" | head -1 ;;
    extra)   echo "$vers" | tail -n +2 | paste -sd' ' - ;;
    all)     echo "$vers" ;;
    *) echo "usage: $0 default|extra|all" >&2; exit 2 ;;
esac
