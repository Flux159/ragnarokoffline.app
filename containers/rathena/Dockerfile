# rAthena, built arm64-native. Two stages so the shipped image carries no toolchain.
#
# Upstream's compose builds rAthena at *run* time from a bind-mounted source tree,
# which means a multi-minute first boot and a mutable working copy. We compile at
# image build time instead: the app just starts containers.

FROM alpine:3.23 AS build

RUN apk add --no-cache \
        bash git make cmake gcc g++ \
        zlib-dev mariadb-dev linux-headers

WORKDIR /rathena
COPY . /rathena

# Must match roBrowser's `packetver` and the era of the client GRFs.
ARG PACKETVER=20200401
RUN ./configure --enable-packetver=${PACKETVER} \
    && make -j"$(nproc)" server \
    && strip login-server char-server map-server web-server || true

FROM alpine:3.23

RUN apk add --no-cache mariadb-connector-c zlib libstdc++ libgcc bash tzdata \
    && adduser -D -h /rathena rathena

WORKDIR /rathena
COPY --from=build /rathena/login-server /rathena/char-server \
                  /rathena/map-server /rathena/web-server /rathena/
COPY --from=build /rathena/conf       /rathena/conf
COPY --from=build /rathena/db         /rathena/db
COPY --from=build /rathena/npc        /rathena/npc
COPY --from=build /rathena/sql-files  /rathena/sql-files

RUN mkdir -p /rathena/log /rathena/save /rathena/conf/import \
    && chown -R rathena:rathena /rathena

USER rathena
