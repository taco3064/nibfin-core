#!/usr/bin/env bash
set -euo pipefail

log=$(mktemp)
trap 'rm -f -- "$log"' EXIT

for attempt in 1 2 3; do
  if npm "$@" >"$log" 2>&1; then
    cat "$log"
    exit 0
  else
    status=$?
  fi
  cat "$log" >&2
  if [[ "$attempt" == 3 ]] ||
     ! grep -Eq '^npm (error|ERR!) code (ECONNRESET|ETIMEDOUT|EAI_AGAIN)$' "$log"; then
    exit "$status"
  fi
  printf 'npm network error on attempt %s of 3. Retrying.\n' "$attempt" >&2
  sleep "$((attempt * 5))"
done
