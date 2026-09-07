# Managed internal credentials

Settings → Accounts → **Secure internal server credentials** replaces this era’s
shared database root/application passwords and `s1/p1` interserver password with
independent system-generated values. It saves a backup first, disconnects players
while their data is saved, and restarts the server. It preserves game accounts,
passwords, IDs, groups and characters. Run it for each era you intend to host.
Internet mode will require these credentials; this action alone does not enable
or authorize internet access.

The equivalent trusted-owner command is `ragnarok-stack secure-services`, with the
same optional `--lan` and `--ram` flags as `up`. The database must already be running
in the selected era. The runtime image must advertise
`app.ragnarokoffline.private-db-files=v1`; an older image is rejected before a
migration journal or password change. Custom SQL/interserver accounts are refused
before the first migration rather than silently replacing an unsupported setup.
Startup reloads a changed bundled image archive even when its image tags already
exist in the VM cache; a successful load is recorded only after both images exist.

## Persistence and recovery

Each era’s immutable journal lives under
`state/private/service-credentials/{renewal,prerenewal}/credentials.json`, outside
the served asset root. Database secrets are 256-bit hex values; the interserver
secret has 138 random bits in 23 base64url characters, fitting the pinned protocol’s
24-byte field including its terminator. Generation uses `/dev/urandom` on Unix and
[BCryptGenRandom](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptgenrandom)
with the system provider on Windows. No crate dependencies are added.

The journal and derived files are written privately, synced and published before
SQL changes. Only verified new database logins and the exact interserver row
produce a `ready` marker. A pending migration can retry with its journal or the
known legacy root password; completed migrations never fall back to that password.
Repeated preparation/startup uses the same credentials. It does not regenerate
secrets because an account or file is missing.

Keep this private state with the VM save disk. Losing or corrupting the journal
can make an already-secured database inaccessible. Preserve the journal, disk and
pre-migration SQL backup when recovering; do not delete the marker or substitute
known defaults. Restoring a SQL backup into an accessible managed database keeps
its current SQL credentials and reapplies its current interserver secret. Restore
stops game writers first, retains a pre-restore backup, and leaves the game stopped
until the owner restarts it. A failed SQL import may be partial and is reported as
such. SQL backup era metadata/portable restore and scheduled retention remain part
of the broader backup work.

Host protection uses owner-only Unix ancestors/files and explicit protected
owner-plus-SYSTEM Windows DACLs. Unsupported filesystems, symlinks/reparse points,
and secret-file hard links fail closed. Game config is readable by `USER rathena`
inside the container while its host ancestor stays private. Windows copies are
staged beneath private app state. SQL clients receive a private option-file path,
and SQL is carried through bounded stdin; generated passwords are never command
arguments. The database receives `_FILE` paths, not password environment values.

The image bootstrap, supervisor migration, generated config, backup/restore and
owner account operations must be deployed together. This work does not provide
invite/session authentication, mandatory internet signup policy, a tunnel provider
or a public registration portal; those requirements remain separate gates.
