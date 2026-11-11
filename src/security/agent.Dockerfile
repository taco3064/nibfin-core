FROM golang@sha256:8d48e12ec56735e9358640898b9d9b9fcca110612ed8a5567438c0a1baa24e66 AS go
FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
       fontconfig fonts-dejavu-core \
       libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 \
       libatk-bridge2.0-0 libatspi2.0-0 libx11-6 libxcomposite1 \
       libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 \
       libxkbcommon0 libasound2 \
    && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=0.166.0
LABEL io.nibfin.codex-version="codex-cli ${CODEX_VERSION}"
RUN npm install --global npm@11.9.0 "@openai/codex@${CODEX_VERSION}" \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}"
RUN mkdir -p /session /etc/codex
COPY --from=go /usr/local/go /usr/local/go
# Keep Go's default compiler and runtime parallelism within the two-CPU sandbox.
ENV GOCACHE=/tmp/go-build GOPATH=/tmp/go GOMAXPROCS=2
RUN ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && test "$(go env GOVERSION)" = go1.27.1
