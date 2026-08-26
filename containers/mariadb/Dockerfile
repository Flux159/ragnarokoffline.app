# MariaDB on Alpine.
#
# The official mariadb image is ~485 MB, most of it a Debian userland we never
# use. That, plus dropping the server tooling this image never invokes (see
# below), gets it to roughly a quarter. The version is pinned rather than
# floating: MariaDB cannot open a data directory written by a newer major
# version, so an unannounced upgrade would leave existing characters unreadable.
FROM alpine:3.23

# One layer on purpose. A later `rm` only hides files from the filesystem view —
# they stay in the layer that added them, and both layers ship. The install and
# the prune have to be the same step for the bytes to actually go away.
RUN apk add --no-cache mariadb mariadb-client tzdata \
    # Alpine ships skip-networking enabled, so the server comes up on its unix
    # socket only. A local client works and every TCP client is refused, which
    # looks like the database being down rather than unreachable.
    && sed -i 's/^skip-networking/#skip-networking/' /etc/my.cnf.d/mariadb-server.cnf \
    && sed -i 's/^#bind-address=.*/bind-address=0.0.0.0/' /etc/my.cnf.d/mariadb-server.cnf \
    # Alpine's mariadb packages put ~198 MB in /usr/bin, of which this image
    # calls six: the server, the client, mariadb-admin's ping/shutdown, and the
    # three mariadb-install-db shells out to. The rest is maintenance and test
    # tooling — aria/myisam repair, the embedded server, RocksDB, Galera SST, a
    # connector test harness — for a database created once from a fixed schema
    # and never administered by hand. Scoped to package-owned files, so
    # busybox's applets, which also live in /usr/bin, are untouched.
    && keep=' mariadbd mariadb mariadb-admin my_print_defaults resolveip mariadb-install-db mariadbd-safe ' \
    && apk info -L mariadb mariadb-client mariadb-common 2>/dev/null \
       | grep '^usr/bin/' \
       | while read -r f; do \
             case "$keep" in *" ${f#usr/bin/} "*) continue ;; esac; \
             rm -f "/$f"; \
         done \
    # Compat symlinks (mysqld, mysql, …) whose targets just went.
    && find /usr/bin -type l ! -exec test -e {} \; -delete \
    && rm -rf /var/cache/apk/* /usr/share/man /usr/share/doc /usr/share/mariadb/mysql-test \
    # Fail the build, not the first boot, if the prune took something needed.
    && mariadbd --version >/dev/null \
    && mariadb --version >/dev/null \
    && mariadb-admin --version >/dev/null \
    && sh -n /usr/bin/mariadb-install-db

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /docker-entrypoint-initdb.d /run/mysqld \
    && chown -R mysql:mysql /run/mysqld

VOLUME /var/lib/mysql
EXPOSE 3306
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
