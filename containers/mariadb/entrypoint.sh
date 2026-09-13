#!/bin/sh
# Initialise on first boot, then hand over to the server. Passwords may be
# supplied as MARIADB_{ROOT_PASSWORD,PASSWORD}_FILE; files contain the exact
# printable ASCII password without a newline. Existing databases are untouched.
set -eu
umask 077

DATADIR=/var/lib/mysql
SOCK=/run/mysqld/init.sock
PENDING="$DATADIR/.ragnarok-initializing"
init_pid=
fail() { echo "$1" >&2; exit 1; }
cleanup() {
    if [ -n "$init_pid" ]; then
        kill -TERM "$init_pid" 2>/dev/null || true
        wait "$init_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# The image loader can drop uid/gid. Only this socket directory belongs to
# mysql; secret files and the initialisation marker remain owned by root.
mkdir -p /run/mysqld
chown mysql:mysql /run/mysqld
chmod 755 /run/mysqld

# Never start a half-initialised database on the network after an interrupted
# first boot. In particular, DATADIR/mysql alone does not prove root was secured.
[ ! -e "$PENDING" ] || fail 'Database initialisation was interrupted. Preserve this volume and recover or restore it before starting; no network listener was opened.'

if [ ! -d "$DATADIR/mysql" ]; then
    # Do not use eval or export the resolved values. This function's stdout is
    # captured by the shell; values never become a command argument or log line.
    read_password() {
        value=$1
        secret_file=$2
        supplied=$3
        if [ "$4" = x ]; then
            [ -n "$secret_file" ] || fail 'Database password file path cannot be empty.'
            [ "$supplied" = no ] || fail 'Supply a password value or a password file, not both.'
            [ -f "$secret_file" ] && [ -r "$secret_file" ] || fail 'Cannot read database password file.'
            count=$(wc -c < "$secret_file")
            [ "$count" -ge 1 ] && [ "$count" -le 256 ] || fail 'Database password must contain 1–256 printable ASCII bytes without a newline.'
            invalid=$(LC_ALL=C tr -d '\040-\176' < "$secret_file" | wc -c)
            [ "$invalid" -eq 0 ] || fail 'Database password must contain 1–256 printable ASCII bytes without a newline.'
            value=$(cat "$secret_file")
        fi
        [ "${#value}" -ge 1 ] && [ "${#value}" -le 256 ] || fail 'Database password must contain 1–256 printable ASCII bytes without a newline.'
        invalid=$(printf '%s' "$value" | LC_ALL=C tr -d '\040-\176' | wc -c)
        [ "$invalid" -eq 0 ] || fail 'Database password must contain 1–256 printable ASCII bytes without a newline.'
        printf '%s' "$value"
    }
    root_supplied=no
    app_supplied=no
    [ "${MARIADB_ROOT_PASSWORD+x}" != x ] || root_supplied=yes
    [ "${MARIADB_PASSWORD+x}" != x ] || app_supplied=yes
    root_password=$(read_password "${MARIADB_ROOT_PASSWORD-ragnarok}" "${MARIADB_ROOT_PASSWORD_FILE-}" "$root_supplied" "${MARIADB_ROOT_PASSWORD_FILE+x}")
    app_password=$(read_password "${MARIADB_PASSWORD-ragnarok}" "${MARIADB_PASSWORD_FILE-}" "$app_supplied" "${MARIADB_PASSWORD_FILE+x}")
    database=${MARIADB_DATABASE-ragnarok}
    username=${MARIADB_USER-ragnarok}
    case "$database" in ''|*[!a-zA-Z0-9_]*) fail 'Database name must contain letters, digits or underscores.' ;; esac
    case "$username" in ''|*[!a-zA-Z0-9_]*) fail 'Database user must contain letters, digits or underscores.' ;; esac
    [ "${#database}" -le 64 ] && [ "${#username}" -le 80 ] || fail 'Database name or user is too long.'
    [ "$username" != root ] || fail 'The application database user cannot be root.'

    # Legacy value-based callers still work, but their exported secrets must
    # not be inherited by any database process. File-based callers avoid also
    # storing these values in the container's creation configuration.
    unset MARIADB_ROOT_PASSWORD MARIADB_PASSWORD MARIADB_ROOT_PASSWORD_FILE MARIADB_PASSWORD_FILE
    # Explicit SQL mode makes backslashes literal. A quote is represented by
    # two quotes; shell expansion does not evaluate the password as shell code.
    root_sql=$(printf '%s' "$root_password" | sed "s/'/''/g")
    app_sql=$(printf '%s' "$app_password" | sed "s/'/''/g")
    unset root_password app_password

    echo 'initialising a new database'
    chown -R mysql:mysql "$DATADIR"
    : > "$PENDING"
    mariadb-install-db --user=mysql --datadir="$DATADIR" --skip-test-db >/dev/null
    mariadbd --user=mysql --datadir="$DATADIR" --skip-networking --socket="$SOCK" &
    init_pid=$!
    tries=60
    until mariadb-admin --socket="$SOCK" ping >/dev/null 2>&1; do
        tries=$((tries - 1))
        [ "$tries" -gt 0 ] || fail 'Database failed to start for initialisation.'
        kill -0 "$init_pid" 2>/dev/null || fail 'Database stopped during initialisation.'
        sleep 1
    done

    # SQL errors can echo credentials. Emit a bounded explanation instead.
    mariadb --socket="$SOCK" 2>/dev/null <<SQL || fail 'Database account initialisation failed.'
SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';
CREATE DATABASE IF NOT EXISTS \`$database\`;
CREATE USER IF NOT EXISTS '$username'@'%' IDENTIFIED BY '$app_sql';
GRANT ALL PRIVILEGES ON \`$database\`.* TO '$username'@'%';
SQL
    unset app_sql
    for f in /docker-entrypoint-initdb.d/*.sql; do
        [ -f "$f" ] || continue
        echo "importing $(basename "$f")"
        mariadb --socket="$SOCK" "$database" < "$f" 2>/dev/null || fail 'Database schema import failed.'
    done
    mariadb --socket="$SOCK" 2>/dev/null <<SQL || fail 'Database root credential initialisation failed.'
SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';
ALTER USER 'root'@'localhost' IDENTIFIED BY '$root_sql';
SQL
    unset root_sql

    # SIGTERM is MariaDB's graceful shutdown. This is our exact child, so no
    # password-bearing mariadb-admin argument or broad process search is needed.
    kill -TERM "$init_pid"
    wait "$init_pid"
    init_pid=
    rm "$PENDING"
    echo 'initialisation complete'
fi

unset MARIADB_ROOT_PASSWORD MARIADB_PASSWORD MARIADB_ROOT_PASSWORD_FILE MARIADB_PASSWORD_FILE
trap - EXIT HUP INT TERM
exec mariadbd --user=mysql --datadir="$DATADIR" --bind-address=0.0.0.0
