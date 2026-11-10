#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?Configure NIBFIN_CD_TOKEN in the protected nibfin-rollout environment}"
test "$GITHUB_REPOSITORY" = taco3064/nibfin-core
test "$GITHUB_REF" = refs/heads/main
core=$(jq -er '.core.commit' rollout.json)
test "$core" = "$GITHUB_SHA"
[[ "$core" =~ ^[a-f0-9]{40}$ ]]
action=${ACTION_COMMIT:-}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
jq '.core' rollout.json > "$work/core-source.json"

if [[ -n "$action" ]]; then
  [[ "$action" =~ ^[a-f0-9]{40}$ ]]
  action_main=$(gh api repos/taco3064/nibfin-act/branches/main --jq .commit.sha)
  gh api "repos/taco3064/nibfin-act/compare/$action...$action_main" --jq .status |
    grep -Ex 'ahead|identical'
  gh api "repos/taco3064/nibfin-act/contents/core-source.json?ref=$action" \
    -H 'Accept: application/vnd.github.raw+json' > "$work/action-pin.json"
  jq -e --slurp '.[0] == .[1]' "$work/action-pin.json" "$work/core-source.json"
  jq --arg action "$action" 'del(.targets) |
    .action = {repository: "taco3064/nibfin-act", commit: $action}' \
    rollout.json > "$work/producer-pins.json"
fi

gh auth setup-git --hostname github.com
prepare() {
  local repo=$1 kind=$2 branch suffix existing old_core old_action
  suffix=${action:+-${action:0:12}}
  branch="cd/$kind-${core:0:12}$suffix"
  existing=$(gh pr list -R "taco3064/$repo" --state open --head "$branch" \
    --json url --jq '.[0].url // empty')
  if [[ -n "$existing" ]]; then
    printf 'Existing draft for %s: %s\n' "$repo" "$existing"
    return
  fi
  gh repo clone "taco3064/$repo" "$work/$repo" -- --depth 1 --branch main
  (
    cd "$work/$repo"
    git switch -c "$branch"
    if [[ "$kind" == action ]]; then
      cp "$work/core-source.json" core-source.json
    else
      old_core=$(jq -er '.core.commit' .nibfin/producer-pins.json)
      old_action=$(jq -er '.action.commit' .nibfin/producer-pins.json)
      [[ "$old_core" =~ ^[a-f0-9]{40}$ && "$old_action" =~ ^[a-f0-9]{40}$ ]]
      grep -Fq "$old_core" .github/workflows/nibfin-issue.yml
      grep -Fq "$old_core" .github/workflows/nibfin-wake.yml
      grep -Fq "$old_action" .github/workflows/nibfin-wake.yml
      sed -i "s/$old_core/$core/g" .github/workflows/nibfin-issue.yml
      sed -i "s/$old_core/$core/g; s/$old_action/$action/g" \
        .github/workflows/nibfin-wake.yml
      cp "$work/producer-pins.json" .nibfin/producer-pins.json
      if [[ "$repo" == gh-nibfin ]]; then
        cp "$work/producer-pins.json" internal/cli/producers.json
      fi
    fi
    if git diff --quiet; then
      printf '%s already matches the rollout.\n' "$repo"
      exit
    fi
    git -c user.name='Nibfin CD' -c user.email='nibfin-cd@users.noreply.github.com' \
      commit -am "Prepare Core $core rollout"
    git push origin "HEAD:refs/heads/$branch"
    gh pr create -R "taco3064/$repo" --draft --base main --head "$branch" \
      --title "Prepare Core ${core:0:12} rollout" \
      --body "Core CD run $GITHUB_RUN_ID. Keep as a draft until the host is ready."
  )
}

if [[ -z "$action" ]]; then
  prepare nibfin-act action
else
  for repo in nibfin-core nibfin-act gh-nibfin; do
    prepare "$repo" consumers
  done
fi
