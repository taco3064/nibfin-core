# Separate maintained recipe for the Claude agent: the prepared managed Agent
# image plus Claude Code's tool sandbox, the pinned CLI and Nibfin's tool shell.
# Core replaces the input token with the prepared Agent image ID.
FROM nibfin-managed-agent-input
RUN rm /usr/local/bin/codex
# The same immutable Debian snapshot line the Agent recipe wrote (plain HTTP,
# authenticated by apt's InRelease signature check); apt resolves the
# dependencies. No other source may be consulted.
RUN prefix='deb \[check-valid-until=no\] http://snapshot\.debian\.org/archive/debian/' \
    && snapshot="${prefix}[0-9]{8}T[0-9]{6}Z/ [a-z]+ main" \
    && grep -Eqx "$snapshot" /etc/apt/sources.list \
    && ! grep -Evqx "$snapshot" /etc/apt/sources.list \
    && test -z "$(ls -A /etc/apt/sources.list.d)" \
    && apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap socat \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/bwrap && test -x /usr/bin/socat
# Core supplies the CLI version from claude-package.mjs, the verified pin.
ARG CLAUDE_VERSION
COPY claude-package.mjs /opt/nibfin/claude/install.mjs
RUN node /opt/nibfin/claude/install.mjs && rm /opt/nibfin/claude/install.mjs
COPY --chmod=0755 nibfin-bash /opt/nibfin/claude/bin/nibfin-bash
# Without --bare the CLI reads managed policy, user dirs and project memory found
# upward from its cwd /work; none may exist in the image.
RUN test ! -e /etc/claude-code && test ! -e /root/.claude && \
    test ! -e /home/node/.claude && test ! -e /.claude && \
    test ! -e /CLAUDE.md && test ! -e /CLAUDE.local.md && \
    test ! -e /work/.claude && test ! -e /work/CLAUDE.md && \
    test ! -e /work/CLAUDE.local.md && test ! -e /usr/local/bin/codex
LABEL io.nibfin.claude-version="${CLAUDE_VERSION}"
LABEL io.nibfin.claude-managed-settings="absent"
LABEL io.nibfin.resource-kind="claude-agent"
