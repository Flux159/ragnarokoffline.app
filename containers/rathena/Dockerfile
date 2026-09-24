# rAthena, built arm64-native. Two stages so the shipped image carries no toolchain.
#
# Upstream's compose builds rAthena at *run* time from a bind-mounted source tree,
# which means a multi-minute first boot and a mutable working copy. We compile at
# image build time instead: the app just starts containers.

FROM alpine:3.23 AS build

# libunwind is pinned by upstream version, not by Alpine's package revision.
# Alpine's repository carries only the current -rN for a branch: the moment
# libunwind is rebuilt as -r1, an `=1.8.1-r0` pin stops resolving and the image
# build fails outright -- on a release tag, most likely. `~1.8.1` keeps the
# version deterministic while tolerating a repackage. The build-time -dev and
# the runtime library must move together.

RUN apk add --no-cache \
        bash git make cmake gcc g++ \
        zlib-dev mariadb-dev linux-headers libunwind-dev~1.8.1 binutils

WORKDIR /rathena
COPY . /rathena

# Must match roBrowser's `packetver` and the era of the client GRFs. The
# default comes from the first line of config/PACKETVERS, the rest from the
# lines after it; bootstrap.sh and images.yml pass both.
ARG PACKETVER=20221005
# Further packet versions, built into the same image under a -<packetver>
# suffix, the way pre-renewal is built in under -prere. See below.
ARG EXTRA_PACKETVERS=""
ENV CXXFLAGS="-g -O2 -fno-omit-frame-pointer -fno-optimize-sibling-calls"
ENV CPPFLAGS="-DRAGNAROK_CRASH_TRACE"
ENV LIBS="-lunwind"
ENV LDFLAGS="-Wl,--build-id=sha1 -rdynamic"

RUN sh /rathena/ragnarok-crash-tests/verify.sh

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
    && mkdir -p /symbols/re \
    && for binary in login-server char-server map-server web-server; do \
        objcopy --only-keep-debug "$binary" "/symbols/re/$binary.debug" \
        && readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/re/BUILD_IDS" \
        && strip --strip-debug "$binary" \
        && objcopy --add-gnu-debuglink="/symbols/re/$binary.debug" "$binary" || exit 1; \
    done
RUN mkdir -p /out/re \
    && cp login-server char-server map-server web-server /out/re/
RUN make clean \
    && ./configure --enable-packetver=${PACKETVER} --enable-prere \
    && make -j"$(nproc)" char map \
    && mkdir -p /symbols/pre-re \
    && for binary in char-server map-server; do \
        objcopy --only-keep-debug "$binary" "/symbols/pre-re/$binary.debug" \
        && readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/pre-re/BUILD_IDS" \
        && strip --strip-debug "$binary" \
        && objcopy --add-gnu-debuglink="/symbols/pre-re/$binary.debug" "$binary" || exit 1; \
    done \
    && mkdir -p /out/pre-re \
    && cp char-server map-server /out/pre-re/
# Every other packet version, the same two passes again. packets.hpp is
# included by src/common, so no object survives a change of PACKETVER and each
# version is a full build -- which is why config/PACKETVERS is kept short.
#
# The suffix goes after the era's (map-server-prere-20200401), and the files
# land flat in /out/extra, which the final stage copies straight into /rathena:
# rAthena chdirs to the directory of argv[0], so every build has to sit beside
# conf/, db/ and npc/, exactly as the pre-renewal pair does.
#
# conf/, db/ and npc/ are shared, and can be: packetver changes what goes over
# the wire, not what the server reads from disk.
RUN set -e; mkdir -p /out/extra; \
    for ver in $EXTRA_PACKETVERS; do \
        case "$ver" in *[!0-9]*|"") echo "bad packetver: $ver" >&2; exit 1;; esac; \
        [ "$ver" != "$PACKETVER" ] || { echo "$ver is already the default" >&2; exit 1; }; \
        make clean >/dev/null \
        && ./configure --enable-packetver="$ver" \
        && make -j"$(nproc)" server \
        && mkdir -p "/symbols/re-$ver" /out/re-$ver \
        && for binary in login-server char-server map-server web-server; do \
            objcopy --only-keep-debug "$binary" "/symbols/re-$ver/$binary.debug" \
            && readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/re-$ver/BUILD_IDS" \
            && strip --strip-debug "$binary" \
            && objcopy --add-gnu-debuglink="/symbols/re-$ver/$binary.debug" "$binary" \
            && cp "$binary" "/out/re-$ver/$binary" \
            && cp "$binary" "/out/extra/$binary-$ver" || exit 1; \
        done \
        && make clean >/dev/null \
        && ./configure --enable-packetver="$ver" --enable-prere \
        && make -j"$(nproc)" char map \
        && mkdir -p "/symbols/pre-re-$ver" /out/pre-re-$ver \
        && for binary in char-server map-server; do \
            objcopy --only-keep-debug "$binary" "/symbols/pre-re-$ver/$binary.debug" \
            && readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/pre-re-$ver/BUILD_IDS" \
            && strip --strip-debug "$binary" \
            && objcopy --add-gnu-debuglink="/symbols/pre-re-$ver/$binary.debug" "$binary" \
            && cp "$binary" "/out/pre-re-$ver/$binary" \
            && cp "$binary" "/out/extra/$binary-prere-$ver" || exit 1; \
        done \
        || exit 1; \
    done
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
#
# Every packet version gets the same check, for the same reason: each extra
# version is another make clean between passes.
RUN set -e; \
    for suffix in "" $(for ver in $EXTRA_PACKETVERS; do echo "-$ver"; done); do \
        grep -qa "npc/re/scripts_main.conf"     /out/re$suffix/map-server     || { echo "re$suffix map-server is not renewal"      >&2; exit 1; }; \
        ! grep -qa "npc/pre-re/scripts_main.conf" /out/re$suffix/map-server   || { echo "re$suffix map-server has pre-re in it"    >&2; exit 1; }; \
        grep -qa "npc/pre-re/scripts_main.conf" /out/pre-re$suffix/map-server || { echo "pre-re$suffix map-server is not pre-re"   >&2; exit 1; }; \
        ! grep -qa "npc/re/scripts_main.conf"   /out/pre-re$suffix/map-server || { echo "pre-re$suffix map-server has renewal in it" >&2; exit 1; }; \
    done; \
    echo "era check: re and pre-re map-servers differ as expected, for every packet version"

FROM scratch AS debug-symbols
COPY --from=build /symbols/ /

FROM alpine:3.23

RUN apk add --no-cache mariadb-connector-c zlib libstdc++ libgcc bash tzdata libunwind~1.8.1 \
    && adduser -D -h /rathena rathena

WORKDIR /rathena
COPY --from=build /rathena/ragnarok-crash-tests/libunwind-COPYING /usr/share/licenses/libunwind/COPYING
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
# The other packet versions, already named <binary>[-prere]-<packetver>.
COPY --from=build /out/extra/ /rathena/
COPY --from=build /rathena/conf       /rathena/conf
COPY --from=build /rathena/db         /rathena/db
COPY --from=build /rathena/npc        /rathena/npc
COPY --from=build /rathena/sql-files  /rathena/sql-files

RUN mkdir -p /rathena/log /rathena/save /rathena/conf/import \
    && chown -R rathena:rathena /rathena

USER rathena
