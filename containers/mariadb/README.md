# Database bootstrap credentials

The image accepts `MARIADB_ROOT_PASSWORD_FILE` and `MARIADB_PASSWORD_FILE`.
Mount a private directory read-only and set each variable to its container file
path. Files must contain the exact password: 1–256 printable ASCII bytes, without
a newline. Leading/trailing spaces, quotes and backslashes are preserved. Do not
set both a password value and its file variable. Files, container configuration
and host staging directories must be accessible only to the owner; passwords do
not belong in the asset root, logs or command arguments.

Legacy `MARIADB_ROOT_PASSWORD` / `MARIADB_PASSWORD` callers remain supported, with
`ragnarok` used only when the variable is absent. An explicitly empty password is
an error. These legacy values remain visible in container creation metadata, so
new managed credentials must use files. The entrypoint clears inherited password
variables before starting database processes. Application user/database names
accept only ASCII letters, digits and underscores; the application user cannot
be `root`.

These inputs initialize **new volumes only**. Replacing a password file does not
rotate an existing account. Supervisor-driven rotation, private CLI option files,
credential recovery and per-era migration are separate work; this image change
alone does not make internet hosting safe or change existing app credentials.

The private initialization server listens only on its Unix socket. Password SQL
uses a private stdin stream with error output suppressed; quoting uses explicit
`NO_BACKSLASH_ESCAPES` plus doubled quotes. The entrypoint stops its exact child
with SIGTERM and waits for clean shutdown instead of passing the root password to
`mariadb-admin`. See MariaDB's [shutdown documentation](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/shutdown)
and [string literal documentation](https://mariadb.com/docs/server/reference/sql-structure/sql-language-structure/string-literals).

A new volume gets `.ragnarok-initializing` before schema creation. Only successful
credential initialization and clean shutdown remove it. A failed or interrupted
first boot leaves the next start blocked before any network listener opens.
Preserve that volume and its logs for recovery; do not delete the marker to bypass
the check. Restore a verified backup, or explicitly discard a confirmed unused
new volume and initialize a replacement. Legacy volumes without this marker
continue to open normally; their credential policy must be audited separately.

## Validation

With a real Docker daemon (the test never publishes host ports):

```sh
docker build -t ragnarokmac/mariadb:11.4 containers/mariadb
python3 tests/integration/mariadb-secrets.py
```

The test creates UUID-named disposable volumes, authenticates real root/application
connections with punctuation-bearing secrets, rejects the known default, checks
process/log/metadata exposure, verifies clean restart and retained rows/passwords,
and exercises invalid inputs and interrupted initialization. It removes only its
own containers/volumes. Both native architectures run it in `images.yml` before
bundling. Manual workflow runs upload seven-day artifacts and **do not publish**
the rolling `images` release. Publishing remains limited to a matching main push.
