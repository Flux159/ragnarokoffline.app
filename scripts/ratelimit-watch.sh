#!/usr/bin/env bash
# Log GitHub API quota consumption over time, to find what is spending it.
#
#   scripts/ratelimit-watch.sh [interval_seconds] [logfile]
#
# The /rate_limit endpoint is itself exempt from the limit, so this can poll
# as often as you like without being part of the problem it measures.
#
# Each line records the delta since the previous sample, so a burst shows up
# as one large number next to a timestamp you can correlate with whatever was
# running -- an agent, a CI run, a script.
set -euo pipefail
INTERVAL="${1:-60}"
LOG="${2:-$HOME/ratelimit.log}"
prev=""
printf 'time                 remaining  used_since_last  reset_in  processes\n' | tee -a "$LOG"
while true; do
    json=$(gh api rate_limit 2>/dev/null) || { sleep "$INTERVAL"; continue; }
    rem=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["resources"]["core"]["remaining"])')
    rst=$(printf '%s' "$json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["resources"]["core"]["reset"])')
    delta=""
    if [ -n "$prev" ]; then
        d=$(( prev - rem ))
        # A reset makes remaining jump up; report that rather than a negative.
        [ "$d" -lt 0 ] && delta="(reset)" || delta="$d"
    fi
    # Who was alive for this interval. A burst is only actionable if you can
    # see what was running when it happened; the API will not tell you which
    # token or process spent the quota, so correlate locally instead.
    ghp=$(pgrep -f '^gh ' 2>/dev/null | wc -l | tr -d ' ')
    cld=$(pgrep -fl 'claude' 2>/dev/null | grep -c . | tr -d ' ')
    printf '%s  %9s  %15s  %7sm  gh=%s claude=%s\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$rem" "${delta:-—}" \
        "$(( (rst - $(date +%s)) / 60 ))" "$ghp" "$cld" | tee -a "$LOG"
    prev="$rem"
    sleep "$INTERVAL"
done
