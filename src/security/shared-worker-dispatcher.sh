#!/bin/sh
set -eu
exec /usr/bin/python3 -I /opt/nibfin/core/src/security/shared-worker-dispatch.py "$@"
