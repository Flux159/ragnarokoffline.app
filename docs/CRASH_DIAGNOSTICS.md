# Map-server crash evidence

An unexpected map-server exit now creates a private incident report in
`state/crashes/reports/`. The app checks every 15 seconds while its owned asset
server runs. Capture also runs before game container replacement, orderly game
stops/account changes, and Repair, so these operations preserve an existing
failure before discarding the container. A stopped engine is never started for
collection. The monitor queues behind owner operations and does not restart games.

The report records the container/image identity, start/finish times, running
database era, exit code and OOM indicator when available, supervisor/app version,
compiled rAthena source pin and host architecture. It includes bounded map,
login and char log tails. These companion tails describe capture time; they are
not asserted to be synchronized with the original fault. The image identity is
the authority for what ran; a compiled source pin alone cannot identify a custom
or previously cached image.

Logs are private by default and managed service credentials are redacted before
writing. Review reports before sharing: they can contain player names or messages.
No raw container configuration, environment, SQL data or core dump is exported.
Invalid/unreadable credential journals cause capture to fail rather than writing
an unredacted report. Collection failure is recorded locally; the normal stop or
recovery operation is still allowed to proceed.

New reports are immutable and deduplicated by container/start/finish identity.
Each report is limited to 1 MiB; the newest ten reports are retained, with a
10 MiB aggregate cap. Old legacy crash logs and unrelated files are not pruned.
Filesystem failures leave an actionable local diagnostic rather than repeatedly
creating partial reports. The CLI `ragnarok-stack capture-crashes` uses the same
collector and reports any newly saved incident paths.

## What this does not establish

`Received a crash signal` describes rAthena's emergency handler, not the faulty
call or a successful save. Exit code 139 by itself does not prove SIGSEGV; the
report labels it as a nonzero exit. Missing metadata remains unknown. Collection
can miss a container removed externally between polls or a VM destroyed before
its logs can be read; it cannot recover evidence the engine no longer retains.

New server images include bounded original-context SIGSEGV/SIGFPE traces before
rAthena's emergency-save handler. Old images still produce reports without a
trace; `backtraceAvailable` describes the retained log evidence. Matching debug
artifacts are exported for each image build and era. See
[the trace hook](../third-party/crash-trace/README.md) for symbol lookup, signal
safety and limitations. Issue #16 stays open: disposable sanitizer/reload/logout
stress tests and the actual root-cause investigation remain outstanding. Population cleanup contains
possible lifetime hazards worth auditing, but no underlying intermittent fault
has been reproduced or fixed by this logging change.

## Validation

`cargo test` covers classification, terminal escape removal and retention.
With `STACK_BIN` set to the freshly built supervisor, Node tests compile a small
portable fake engine and exercise actual CLI capture, credential redaction,
metadata filtering, restarted-container deduplication, large stdout/stderr tails
and clean exits. Monitor tests cover inactive ownership, overlapping polls,
retry and sanitized error reporting. Native CI runs these on macOS, Linux and
Windows.

A separate actual-guest fixture deliberately terminates an Alpine shell with
SIGSEGV in the marked disposable world. It verifies the engine's real exit
metadata, retained logs, duplicate suppression and preservation through
supervisor shutdown. It tests the capture mechanism only; it is not an rAthena
crash reproducer. Never inject faults into a player's save or report an injected
signal as a reproduced instance of #16.

Run the opt-in guest fixture with `RO_E2E_WORLD` set to a stopped disposable
world and `STACK_BIN` set to the newly compiled collector:

```sh
node tests/e2e/crash-capture.cjs
```

It verifies free ports, starts only that world's VM, refuses existing world
containers, runs the faulting shell in the existing server image, and stops the
VM after preserving its report. It never starts MariaDB or real game servers.

To exercise the native handler inside both real rAthena eras, the Settings/game
acceptance fixture also accepts `RO_E2E_NATIVE_CRASH_TRACE=1`, alongside its
required `RO_E2E_WORLD` and `RO_E2E_CLIENT_JSON`. Use a stopped, marked disposable
world with the new server image and matching supervisor. After logging into each
era, it injects Linux signal 11 into its own map container, checks that native
frames precede the emergency-save message in the incident report, and restarts
the world before continuing. The final cleanup stops the owned world and
restores its original selection. Existing account credentials are preserved.

The numeric signal is intentional: the pinned slim runtime does not recognize
the name `SEGV` and falls back to SIGTERM. A clean shutdown from that named
signal does not test the crash handler. The fixture records image/container
identity and observed exit status even if incident capture fails. This remains
an injected-signal acceptance test, not a reproduction of issue #16.


When the owning app captures a new game-server incident during play, it returns
the game window to a recovery screen. **Open crash reports** opens the private
reports folder; review files before sharing them. **Retry** starts the server
and reopens the login screen. Recovery waits for that action and does not loop.
An old collector result cannot replace a newer asset launch's window.

A restarted container retains its old logs. Classification now discards log
records older than its current `StartedAt`, so an earlier crash message cannot
turn a later clean stop into a new incident. Reports also include the packet
version, capture-time population settings and asset overlay fingerprint; these
are explicitly capture-time observations, not proof of the fault-time state.
