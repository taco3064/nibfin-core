#!/bin/sh
set -eu
version=$(/bin/cat /opt/nibfin/core/.node-version)
case "$version" in ""|*[!0-9.]*) exit 1 ;; esac
exec "/opt/nibfin/tools/node-v${version}-linux-x64/bin/node" \
  /opt/nibfin/core/src/security/shared-worker-entry.mjs "$@"
