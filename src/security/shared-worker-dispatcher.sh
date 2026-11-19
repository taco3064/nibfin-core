#!/bin/sh
set -eu
program=/usr/local/libexec/nibfin/core-rollout/worker-dispatch.py
if [ ! -e "$program" ] && [ ! -L "$program" ]; then
  program=/opt/nibfin/core/src/security/shared-worker-dispatch.py
fi
exec /usr/bin/python3 -I "$program" "$@"
