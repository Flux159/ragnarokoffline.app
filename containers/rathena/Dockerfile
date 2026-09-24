# rAthena, built arm64-native. Two stages so the shipped image carries no toolchain.
#
# Upstream's compose builds rAthena at *run* time from a bind-mounted source tree,
# which means a multi-minute first boot and a mutable working copy. We compile at
# image build time instead: the app just starts containers.

# Which stage the final image takes its binaries from. `compiled` builds them
# here, one packet version after another -- what bootstrap.sh does. images.yml
# instead compiles each packet version on its own runner, in parallel, and
# hands the results back in as a build context: BINARIES=prebuilt with
# --build-context prebuilt=<dir>. Both routes run the same `build` stage below,
# so the binaries are the same either way.
ARG BINARIES=compiled

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

# Every packet version the image carries (config/PACKETVERS), and which of them
# is the default. The default is built under the plain names (map-server); the
# rest get a -<packetver> suffix after the era's (map-server-prere-20250402),
# the way pre-renewal is carried under -prere. Everything lands flat in
# /out/bin, which the final stage copies straight into /rathena.
ARG DEFAULT_PACKETVER=20221005
ARG PACKETVERS=20221005
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
#
# The same is true of every packet version: packets.hpp is included from
# src/common, so no object survives a change of PACKETVER, and each version is
# two more full passes -- which is why config/PACKETVERS is kept short.
#
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
RUN set -e; mkdir -p /out/bin; \
    for ver in $PACKETVERS; do \
        case "$ver" in *[!0-9]*|"") echo "bad packetver: $ver" >&2; exit 1;; esac; \
        if [ "$ver" = "$DEFAULT_PACKETVER" ]; then suffix=""; else suffix="-$ver"; fi; \
        if [ -f Makefile ]; then make clean >/dev/null; fi; \
        ./configure --enable-packetver="$ver"; \
        make -j"$(nproc)" server; \
        mkdir -p "/symbols/re$suffix"; \
        for binary in login-server char-server map-server web-server; do \
            objcopy --only-keep-debug "$binary" "/symbols/re$suffix/$binary.debug"; \
            readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/re$suffix/BUILD_IDS"; \
            strip --strip-debug "$binary"; \
            objcopy --add-gnu-debuglink="/symbols/re$suffix/$binary.debug" "$binary"; \
            cp "$binary" "/out/bin/$binary$suffix"; \
        done; \
        make clean >/dev/null; \
        ./configure --enable-packetver="$ver" --enable-prere; \
        make -j"$(nproc)" char map; \
        mkdir -p "/symbols/pre-re$suffix"; \
        for binary in char-server map-server; do \
            objcopy --only-keep-debug "$binary" "/symbols/pre-re$suffix/$binary.debug"; \
            readelf -n "$binary" | sed -n "s/.*Build ID: /$binary /p" >> "/symbols/pre-re$suffix/BUILD_IDS"; \
            strip --strip-debug "$binary"; \
            objcopy --add-gnu-debuglink="/symbols/pre-re$suffix/$binary.debug" "$binary"; \
            cp "$binary" "/out/bin/$binary-prere$suffix"; \
        done; \
        re="/out/bin/map-server$suffix"; pre="/out/bin/map-server-prere$suffix"; \
        grep -qa "npc/re/scripts_main.conf"       "$re"  || { echo "$re is not renewal"         >&2; exit 1; }; \
        ! grep -qa "npc/pre-re/scripts_main.conf" "$re"  || { echo "$re has pre-re in it"       >&2; exit 1; }; \
        grep -qa "npc/pre-re/scripts_main.conf"   "$pre" || { echo "$pre is not pre-re"         >&2; exit 1; }; \
        ! grep -qa "npc/re/scripts_main.conf"     "$pre" || { echo "$pre has renewal in it"     >&2; exit 1; }; \
        echo "era check: $re and $pre differ as expected"; \
    done
# conf/, db/ and npc/ are shared by every build, and can be: packetver changes
# what goes over the wire, not what the server reads from disk. Taken after
# `make server`, which fills db/import from db/import-tmpl.
RUN mkdir -p /out/tree \
    && cp -R conf db npc sql-files /out/tree/ \
    && cp ragnarok-crash-tests/libunwind-COPYING /out/libunwind-COPYING

FROM scratch AS compiled
COPY --from=build /out/ /

FROM scratch AS debug-symbols
COPY --from=build /symbols/ /

FROM ${BINARIES} AS binaries

FROM alpine:3.23

RUN apk add --no-cache mariadb-connector-c zlib libstdc++ libgcc bash tzdata libunwind~1.8.1 \
    && adduser -D -h /rathena rathena

WORKDIR /rathena
COPY --from=binaries /libunwind-COPYING /usr/share/licenses/libunwind/COPYING
# The pre-renewal pair sits beside them under its own names, in the same
# directory rather than a subdirectory.
#
# rAthena chdirs to the directory of argv[0] at startup (src/common/core.cpp),
# then reads conf/, db/ and npc/ relative to that. A binary in /rathena/pre-re/
# therefore looks for /rathena/pre-re/conf and dies with "File not found:
# conf/inter_athena.conf". Same directory, different name, and every relative
# path keeps working -- the era comes from how the binary was compiled, not
# from where it sits.
COPY --from=binaries /bin/  /rathena/
COPY --from=binaries /tree/ /rathena/

# Every build the list names has to be here. With prebuilt binaries a missing
# or half-extracted artifact would otherwise ship an image that only fails
# when a player picks that version.
ARG DEFAULT_PACKETVER=20221005
ARG PACKETVERS=20221005
RUN set -e; \
    for ver in $PACKETVERS; do \
        if [ "$ver" = "$DEFAULT_PACKETVER" ]; then suffix=""; else suffix="-$ver"; fi; \
        for binary in login-server char-server map-server web-server char-server-prere map-server-prere; do \
            [ -x "/rathena/$binary$suffix" ] || { echo "missing /rathena/$binary$suffix" >&2; exit 1; }; \
        done; \
    done; \
    mkdir -p /rathena/log /rathena/save /rathena/conf/import \
    && chown -R rathena:rathena /rathena

USER rathena
