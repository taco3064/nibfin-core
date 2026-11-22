FROM nibfin-reviewed-go-input AS go
FROM nibfin-reviewed-node-input
# Immutable Debian snapshot over plain HTTP: the base image has no CA bundle, so
# TLS is unavailable here. Authenticity comes from apt verifying the snapshot's
# signed InRelease against the base image's Debian keyring, plus per-file hashes.
# Accepted limit: with check-valid-until=no, HTTP does not stop an on-path replay
# of an older genuinely signed snapshot index.
# No moving suite, repository mirror or npm version range is consulted.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
    && . /etc/os-release \
    && printf 'deb [check-valid-until=no] %s %s main\n' \
       http://snapshot.debian.org/archive/debian/20261115T000000Z/ \
       "$VERSION_CODENAME" > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
       fontconfig fonts-dejavu-core \
       libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 \
       libatk-bridge2.0-0 libatspi2.0-0 libx11-6 libxcomposite1 \
       libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 \
       libxkbcommon0 libasound2 libcups2 libdrm2 \
       libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION
ARG GO_VERSION
ARG NPM_VERSION
COPY managed-npm /opt/nibfin-tools
RUN cd /opt/nibfin-tools \
    && npm ci --ignore-scripts --no-audit --no-fund \
    && ln -s /opt/nibfin-tools/node_modules/@openai/codex/bin/codex.js \
       /usr/local/bin/codex \
    && ln -sf /opt/nibfin-tools/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /opt/nibfin-tools/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && test "$(npm --version)" = "${NPM_VERSION}" \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && mkdir -p /session /etc/codex
LABEL io.nibfin.codex-version="codex-cli ${CODEX_VERSION}"
COPY --from=go /usr/local/go /usr/local/go
ENV GOCACHE=/tmp/go-build GOPATH=/tmp/go
RUN ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && test "$(go env GOVERSION)" = "go${GO_VERSION}"
