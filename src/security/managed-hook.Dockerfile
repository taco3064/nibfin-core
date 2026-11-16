# Separate maintained recipe: no model credential or gateway is used by Hooks.
FROM nibfin-managed-agent-input
RUN rm /usr/local/bin/codex
LABEL io.nibfin.resource-kind="offline-hooks"
