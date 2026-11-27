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

# GitHub CLI from its official apt repository (cli.github.com/packages). The slim base
# has no CA bundle, so ca-certificates comes first; apt-cache policy then fails the build
# if apt could not read that repository, instead of falling back to Debian's own gh.
ADD --chmod=644 https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  /etc/apt/keyrings/githubcli-archive-keyring.gpg
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && echo "deb [arch=$(dpkg --print-architecture)" \
    "signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg]" \
    "https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-cache policy gh | grep -q "https://cli.github.com/packages" \
  && apt-get install -y --no-install-recommends git gh \
  && rm -rf /var/lib/apt/lists/*

# The system libraries and fonts Playwright's Chromium needs, from Playwright's own
# installer at its current release. They need root, which Jobs do not have; a project's
# lockfile still decides the Playwright version and `npx playwright install chromium`
# downloads the browser into the tool cache. The playwright package is not kept.
RUN npm exec --yes --package=playwright@latest -- playwright --version \
  && npm exec --yes --package=playwright@latest -- playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# uv from Astral's official image, outside HOME so a login volume cannot shadow it.
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /uvx /usr/local/bin/

# Agent CLIs installed unmodified, as published, under /usr/local.
RUN npm install --global @openai/codex @anthropic-ai/claude-code rulesync \
  && npm cache clean --force

COPY --from=build /src/package.json /opt/nibfin/package.json
COPY --from=build /src/node_modules /opt/nibfin/node_modules
COPY --from=build /src/dist /opt/nibfin/dist
COPY skills /opt/nibfin/skills
COPY templates /opt/nibfin/templates
RUN chmod +x /opt/nibfin/dist/cli/main.js \
  && ln -s /opt/nibfin/dist/cli/main.js /usr/local/bin/nibfin \
  && mkdir /workspace \
  && chown node:node /workspace

# The base image's non-root user (uid/gid 1000); Claude Code refuses
# permission bypass as root.
USER node
WORKDIR /workspace
CMD ["nibfin", "--help"]
