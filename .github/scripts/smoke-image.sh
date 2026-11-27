#!/bin/sh
# Smoke-checks a built Nibfin image: every tool runs as the non-root uid 1000, and
# the system libraries and fonts for Playwright's Chromium are present, and the
# workflow templates ship in the image (nibfin render-workflows renders a user set).
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
  zero=$(printf "%064d" 0)
  nibfin render-workflows --set execution --channel user \
    --image "ghcr.io/taco3064/nibfin@sha256:$zero" --default-branch main |
    grep -F "IMAGE_REF: ghcr.io/taco3064/nibfin@sha256:$zero" > /dev/null
  echo "render-workflows: rendered the user execution set"
'
