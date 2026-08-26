#!/bin/sh
# Initialise on first boot, then hand over to the server.
#
# The same environment variables as the official image, so callers do not have
# to care which one they are talking to.
set -e

DATADIR=/var/lib/mysql
SOCK=/run/mysqld/init.sock

# The image creates this and hands it to mysql, but the ownership does not
# always survive into the running container — nebula-slim's image loader drops
# uid/gid, so the directory arrives root-owned and mariadbd, which runs as
# mysql, cannot create its socket in it ("Bind on unix socket: Permission
# denied"). We are still root here, so just assert it every boot; the official
# image does the same thing for the same reason.
mkdir -p /run/mysqld
chown mysql:mysql /run/mysqld

if [ ! -d "$DATADIR/mysql" ]; then
    echo "initialising a new database in $DATADIR"
    chown -R mysql:mysql "$DATADIR"
    mariadb-install-db --user=mysql --datadir="$DATADIR" --skip-test-db >/dev/null

    # Bring the server up on a private socket only: nothing can reach it over
    # the network until the schema is in and the passwords are set.
    mariadbd --user=mysql --datadir="$DATADIR" --skip-networking \
             --socket="$SOCK" &
    init_pid=$!

    tries=60
    until mariadb-admin --socket="$SOCK" ping >/dev/null 2>&1; do
        tries=$((tries - 1))
        [ $tries -le 0 ] && { echo "database failed to start for initialisation" >&2; exit 1; }
        sleep 1
    done

    mariadb --socket="$SOCK" <<SQL
CREATE DATABASE IF NOT EXISTS \`${MARIADB_DATABASE:-ragnarok}\`;
CREATE USER IF NOT EXISTS '${MARIADB_USER:-ragnarok}'@'%' IDENTIFIED BY '${MARIADB_PASSWORD:-ragnarok}';
GRANT ALL PRIVILEGES ON \`${MARIADB_DATABASE:-ragnarok}\`.* TO '${MARIADB_USER:-ragnarok}'@'%';
FLUSH PRIVILEGES;
SQL

    # Imported in filename order, like the official image, so 01- comes first.
    # Still as passwordless root: the account is locked down afterwards, or
    # these would all fail with access denied.
    for f in /docker-entrypoint-initdb.d/*.sql; do
        [ -f "$f" ] || continue
        echo "importing $(basename "$f")"
        mariadb --socket="$SOCK" "${MARIADB_DATABASE:-ragnarok}" < "$f"
    done

    # Last, so everything above could still connect.
    mariadb --socket="$SOCK" <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY '${MARIADB_ROOT_PASSWORD:-ragnarok}';
FLUSH PRIVILEGES;
SQL

    mariadb-admin --socket="$SOCK" --user=root --password="${MARIADB_ROOT_PASSWORD:-ragnarok}" shutdown
    wait "$init_pid" 2>/dev/null || true
    echo "initialisation complete"
fi

exec mariadbd --user=mysql --datadir="$DATADIR" --bind-address=0.0.0.0
