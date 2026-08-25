# MariaDB on Alpine.
#
# The official mariadb image is ~485 MB, most of it a Debian userland we never
# use — this is ~half that. The version is pinned rather than floating: MariaDB
# cannot open a data directory written by a newer major version, so an
# unannounced upgrade would leave existing characters unreadable.
FROM alpine:3.23

RUN apk add --no-cache mariadb mariadb-client tzdata \
    && rm -rf /var/cache/apk/* /usr/share/man /usr/share/doc

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /docker-entrypoint-initdb.d /run/mysqld \
    && chown -R mysql:mysql /run/mysqld

VOLUME /var/lib/mysql
EXPOSE 3306
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
