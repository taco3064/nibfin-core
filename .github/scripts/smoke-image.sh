#!/bin/sh
# Smoke-checks a built Nibfin image: every tool runs as the non-root uid 1000, and
# the system libraries and fonts for Playwright's Chromium are present.
# Usage: smoke-image.sh <image>
set -eu

image="$1"

docker run --rm "$image" sh -euc '
  echo "uid=$(id -u) gid=$(id -g)"
  test "$(id -u)" -eq 1000
  for tool in nibfin codex claude rulesync gh git uv; do
    version=$("$tool" --version)
    echo "$tool: $version"
  done
  for package in libnss3 libgbm1 libxkbcommon0 fonts-liberation fonts-noto-color-emoji; do
    dpkg-query -W -f "\${Package}: \${Status}\n" "$package" | grep " installed$"
  done
'
