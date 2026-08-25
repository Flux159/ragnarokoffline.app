# MariaDB on Alpine.
#
# The official mariadb image is ~485 MB, most of it a Debian userland we never
# use — this is ~half that. The version is pinned rather than floating: MariaDB
# cannot open a data directory written by a newer major version, so an
# unannounced upgrade would leave existing characters unreadable.
FROM alpine:3.23

RUN apk add --no-cache mariadb mariadb-client tzdata \
    && rm -rf /var/cache/apk/* /usr/share/man /usr/share/doc \
    # Alpine ships skip-networking enabled, so the server comes up on its unix
    # socket only. A local client works and every TCP client is refused, which
    # looks like the database being down rather than unreachable.
    && sed -i 's/^skip-networking/#skip-networking/' /etc/my.cnf.d/mariadb-server.cnf \
    && sed -i 's/^#bind-address=.*/bind-address=0.0.0.0/' /etc/my.cnf.d/mariadb-server.cnf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /docker-entrypoint-initdb.d /run/mysqld \
    && chown -R mysql:mysql /run/mysqld

VOLUME /var/lib/mysql
EXPOSE 3306
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
