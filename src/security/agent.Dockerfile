FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
       fontconfig fonts-dejavu-core \
       libglib2.0-0 libnspr4 libnss3 libdbus-1-3 libatk1.0-0 \
       libatk-bridge2.0-0 libatspi2.0-0 libx11-6 libxcomposite1 \
       libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libxcb1 \
       libxkbcommon0 libasound2 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global npm@11.9.0 @openai/codex@0.138.0
RUN mkdir -p /session /etc/codex
