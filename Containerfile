# Nibfin job image: the Core CLI with the tools that Nibfin jobs run.
# Built and published by .github/workflows/image.yml; hosts never build it.

FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

# GitHub CLI from its official apt repository (cli.github.com/packages).
ADD --chmod=644 https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  /etc/apt/keyrings/githubcli-archive-keyring.gpg
RUN echo "deb [arch=$(dpkg --print-architecture)" \
    "signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg]" \
    "https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git gh \
  && rm -rf /var/lib/apt/lists/*

# uv from Astral's official image, outside HOME so a login volume cannot shadow it.
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /uvx /usr/local/bin/

# Agent CLIs installed unmodified, as published, under /usr/local.
RUN npm install --global @openai/codex @anthropic-ai/claude-code rulesync \
  && npm cache clean --force

COPY --from=build /src/package.json /opt/nibfin/package.json
COPY --from=build /src/node_modules /opt/nibfin/node_modules
COPY --from=build /src/dist /opt/nibfin/dist
COPY skills /opt/nibfin/skills
RUN chmod +x /opt/nibfin/dist/cli/main.js \
  && ln -s /opt/nibfin/dist/cli/main.js /usr/local/bin/nibfin \
  && mkdir /workspace \
  && chown node:node /workspace

# The base image's non-root user (uid/gid 1000); Claude Code refuses
# permission bypass as root.
USER node
WORKDIR /workspace
CMD ["nibfin", "--help"]
