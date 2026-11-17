FROM node@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
COPY src/security/claude-package.mjs /opt/nibfin/claude/install.mjs
RUN node /opt/nibfin/claude/install.mjs && rm /opt/nibfin/claude/install.mjs
COPY src/claude-model-entry.mjs /opt/nibfin/claude/model-entry.mjs
COPY src/claude-work-bridge.mjs src/claude-work-limits.json \
     src/claude-work-transport.mjs /opt/nibfin/claude/src/
COPY --chmod=0755 bin/claude-work-tools.mjs /opt/nibfin/claude/bin/work-tools
RUN mkdir -p /session/work-channel
LABEL io.nibfin.claude-version="2.1.326"
