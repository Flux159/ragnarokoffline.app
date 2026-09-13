# Internet account safeguards

Settings → Accounts → **Check internet account safeguards** checks the selected
running era. It reports owner-only signup, enabled GM/admin password requirements,
and actual managed SQL/interserver authentication. It changes no passwords or
account records. The owner command `ragnarok-stack hosting-check` returns the same
JSON report. Both use the supervisor operation lock and verify the running era's
actual database volume. Remote game pages cannot invoke the owner action.

An account-policy pass is **not permission to publish the server**. The report
keeps `publicationReady: false` because it only checks account policy. The
separate `sharing-check` audits running listeners and privileges, and the
[Cloudflare sharing controller](FRIENDS_SHARING.md) verifies the protected public
HTTPS/WSS path before enabling Copy invitation. Public-server mode remains
unimplemented; the supported internet mode is invited friends.

## Mandatory policy

The persistent `settings.json.hosting_scope` contract accepts exactly `local`,
`lan`, `friends` or `public`. An absent key preserves existing behavior: the
shell's boolean LAN preference, or a direct CLI `--lan`, selects LAN; otherwise
hosting is local. No legacy setting implicitly enables internet mode. The existing
LAN checkbox now writes the explicit local/LAN scope. Invalid scope or legacy LAN
values fail closed rather than exposing a listener through truthy coercion.

Friends/Public provide the game-side policy contract; friends mode additionally
has a protected Cloudflare connector. They force `new_account: no` after mod assembly on every startup,
Repair and era switch, even if `open_registration` remains true. Settings shows
the effective owner-only policy and disables the conflicting signup control;
the saved Local/LAN preference survives unrelated edits. Internet scopes keep the
asset listener and raw game port configuration on loopback. A conflicting direct
`--lan` flag is rejected before engine work.

Prepare an era in Local mode first: change or disable its default GM login and
secure its internal service credentials. Internet startup requires that era's
credential journal before engine work, completes a pending migration through the
existing recovery path, and verifies the game-side policy before starting game
services. No account is renamed, recreated or assigned a default password.

The admin check counts every enabled non-service account with `group_id > 0`,
including renamed GMs, plus the shipped `ragnarok` login if its group changed.
Passwords must fit the app's 8–23 printable-ASCII game-password contract, contain
something besides spaces, and differ from the username. This is a minimum format
check, not an entropy estimate or a substitute for auditing custom privilege
configuration. Password values never leave SQL. The byte-sensitive character
check uses MariaDB's [binary REGEXP behavior](https://mariadb.com/docs/server/reference/sql-functions/string-functions/regular-expressions-overview).

Owner account writes and backups recheck internet policy before restarting game
services. For example, enabling a disabled GM that still has a short password
updates its state but keeps game services stopped and reports that outcome.
Change the password or disable that account, then start the server. The same
protection applies when an operation fails and would otherwise restart the old
services. Database and character identities are preserved.

Generated signup config is checked for the final assignment and rejects custom
imports. Service verification requires an intact, ready per-era journal and
matching private files; it authenticates SQL root/application credentials, rejects
the shared SQL root password and checks the managed interserver row. Missing or
damaged state remains an explicit recovery error.

## Acceptance

Unit and real-binary tests cover strict/migrated scope behavior, mandatory signup,
and invalid/conflicting/unprepared scope rejection before startup or Repair
reaches the engine. `tests/e2e/hosting-guards-settings.cjs` owns one stopped,
marked disposable world with both eras already secured. It uses the same
`RO_E2E_WORLD` and read-only asset selection `RO_E2E_CLIENT_JSON` inputs as the
era/service credential fixtures. It exercises unsafe renamed-GM startup,
disable/enable/password recovery, enforced suffix-signup rejection despite an
open saved preference, the Settings report and native GM gameplay in both eras.
It deliberately inserts a disposable privileged fixture; never run it on player
data. It restores the original owner settings and stops its own server, retaining
only disposable fixture accounts and screenshot/report evidence.
