FROM golang@sha256:8d48e12ec56735e9358640898b9d9b9fcca110612ed8a5567438c0a1baa24e66 AS go
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
# Immutable Debian snapshot, authenticated by the base image's Debian keyring.
# No moving suite, repository mirror or npm version range is consulted.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && . /etc/os-release \
    && printf 'deb [check-valid-until=no] %s %s main\n' \
       https://snapshot.debian.org/archive/debian/20261115T000000Z/ \
       "$VERSION_CODENAME" > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
       fontconfig fonts-dejavu-core \
       libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 \
       libatk-bridge2.0-0 libatspi2.0-0 libx11-6 libxcomposite1 \
       libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 \
       libxkbcommon0 libasound2 \
    && rm -rf /var/lib/apt/lists/*
COPY managed-npm /opt/nibfin-tools
RUN cd /opt/nibfin-tools \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && ln -s /opt/nibfin-tools/node_modules/@openai/codex/bin/codex.js \
       /usr/local/bin/codex \
    && ln -sf /opt/nibfin-tools/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /opt/nibfin-tools/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && test "$(npm --version)" = 11.9.0 \
    && test "$(codex --version)" = 'codex-cli 0.166.0' \
    && mkdir -p /session /etc/codex
LABEL io.nibfin.codex-version="codex-cli 0.166.0"
COPY --from=go /usr/local/go /usr/local/go
ENV GOCACHE=/tmp/go-build GOPATH=/tmp/go
RUN ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && test "$(go env GOVERSION)" = go1.27.1
