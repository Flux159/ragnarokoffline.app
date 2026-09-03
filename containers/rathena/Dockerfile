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
ARG PACKETVER=20221005

# Renewal, and then the same source again for pre-renewal.
#
# Pre-renewal is a compile-time decision in rAthena, not a setting:
# --enable-prere becomes -DPRERE, which switches every RENEWAL define in
# src/config/renewal.hpp and selects db/pre-re and npc/pre-re over db/re and
# npc/re. There is no runtime flag to add; the only way to offer both is to
# carry both binaries.
#
# Only char and map: src/login and src/web contain no reference to RENEWAL or
# PRERE, so their binaries are identical either way. char does -- and more to
# the point src/common/mmo.hpp changes under RENEWAL, so a char-server must be
# built to match the map-server it talks to.
#
# make clean between the passes is load-bearing. PRERE arrives through
# CPPFLAGS, and make does not rebuild on a changed compiler flag -- without the
# clean the second pass relinks the first pass's objects and produces a
# renewal binary under a pre-renewal name.
RUN ./configure --enable-packetver=${PACKETVER} \
    && make -j"$(nproc)" server \
    && strip login-server char-server map-server web-server || true
RUN mkdir -p /out/re \
    && cp login-server char-server map-server web-server /out/re/
RUN make clean \
    && ./configure --enable-packetver=${PACKETVER} --enable-prere \
    && make -j"$(nproc)" char map \
    && (strip char-server map-server || true) \
    && mkdir -p /out/pre-re \
    && cp char-server map-server /out/pre-re/
# Prove the two binaries are actually different eras.
#
# map_reloadnpc names one of two paths under #ifdef RENEWAL, so exactly one of
# these literals is compiled into any given map-server. It is the cheapest
# unambiguous marker of which branch was taken, and it survives stripping
# because it is a string constant rather than a symbol.
#
# Worth checking because the way this goes wrong is silent: a missed `make
# clean` relinks the first pass's objects under the second pass's name, and the
# result is a server that runs perfectly and is quietly the wrong era. Nobody
# would find that until a player reported damage numbers that felt off.
RUN set -e; \
    grep -qa "npc/re/scripts_main.conf"     /out/re/map-server     || { echo "re map-server is not renewal"      >&2; exit 1; }; \
    ! grep -qa "npc/pre-re/scripts_main.conf" /out/re/map-server   || { echo "re map-server has pre-re in it"    >&2; exit 1; }; \
    grep -qa "npc/pre-re/scripts_main.conf" /out/pre-re/map-server || { echo "pre-re map-server is not pre-re"   >&2; exit 1; }; \
    ! grep -qa "npc/re/scripts_main.conf"   /out/pre-re/map-server || { echo "pre-re map-server has renewal in it" >&2; exit 1; }; \
    echo "era check: re and pre-re map-servers differ as expected"

FROM alpine:3.23

RUN apk add --no-cache mariadb-connector-c zlib libstdc++ libgcc bash tzdata \
    && adduser -D -h /rathena rathena

WORKDIR /rathena
COPY --from=build /out/re/login-server /out/re/char-server \
                  /out/re/map-server /out/re/web-server /rathena/
# The pre-renewal pair sits beside them under its own names, in the same
# directory rather than a subdirectory.
#
# rAthena chdirs to the directory of argv[0] at startup (src/common/core.cpp),
# then reads conf/, db/ and npc/ relative to that. A binary in /rathena/pre-re/
# therefore looks for /rathena/pre-re/conf and dies with "File not found:
# conf/inter_athena.conf". Same directory, different name, and every relative
# path keeps working -- the era comes from how the binary was compiled, not
# from where it sits.
COPY --from=build /out/pre-re/char-server /rathena/char-server-prere
COPY --from=build /out/pre-re/map-server  /rathena/map-server-prere
COPY --from=build /rathena/conf       /rathena/conf
COPY --from=build /rathena/db         /rathena/db
COPY --from=build /rathena/npc        /rathena/npc
COPY --from=build /rathena/sql-files  /rathena/sql-files

RUN mkdir -p /rathena/log /rathena/save /rathena/conf/import \
    && chown -R rathena:rathena /rathena

USER rathena
