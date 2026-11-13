#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?Configure NIBFIN_CD_TOKEN in the protected nibfin-rollout environment}"
test "$GITHUB_REPOSITORY" = taco3064/nibfin-core
test "$GITHUB_REF" = refs/heads/main
core=$(jq -er '.core.commit' rollout.json)
test "$core" = "$ROLLOUT_SOURCE"
[[ "$core" =~ ^[a-f0-9]{40}$ ]]
action=${ACTION_COMMIT:-}
automatic=${AUTOMATIC_ROLLOUT:-false}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
jq '.core' rollout.json > "$work/core-source.json"

consumer_pins() {
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
}

gh auth setup-git --hostname github.com
prepare() {
  local repo=$1 kind=$2 branch suffix existing old_core old_action
  suffix=${action:+-${action:0:12}}
  branch="cd/$kind-${core:0:12}$suffix"
  existing=$(gh pr list -R "taco3064/$repo" --state open --head "$branch" \
    --json url,isDraft --jq '.[0] // empty')
  if [[ -n "$existing" ]]; then
    if [[ "$automatic" == true && $(jq -r .isDraft <<< "$existing") == true ]]; then
      gh pr ready -R "taco3064/$repo" "$(jq -r .url <<< "$existing")"
    fi
    printf 'Existing rollout PR for %s: %s\n' "$repo" "$existing"
    return
  fi
  local checkout="$work/$kind-$repo"
  gh repo clone "taco3064/$repo" "$checkout" -- --depth 1 --branch main
  (
    cd "$checkout"
    git switch -c "$branch"
    if [[ "$kind" == action ]]; then
      cp "$work/core-source.json" core-source.json
    else
      old_core=$(jq -er '.core.commit' .nibfin/producer-pins.json)
      old_action=$(jq -er '.action.commit' .nibfin/producer-pins.json)
      [[ "$old_core" =~ ^[a-f0-9]{40}$ && "$old_action" =~ ^[a-f0-9]{40}$ ]]
      grep -Fq "$old_core" .github/workflows/nibfin-issue.yml
      sed -i "s/$old_core/$core/g" .github/workflows/nibfin-issue.yml
      if [[ "$repo" != nibfin-core || -e .github/workflows/nibfin-wake.yml ]]; then
        grep -Fq "$old_core" .github/workflows/nibfin-wake.yml
        grep -Fq "$old_action" .github/workflows/nibfin-wake.yml
        sed -i "s/$old_core/$core/g; s/$old_action/$action/g" \
          .github/workflows/nibfin-wake.yml
      fi
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
    local mode=()
    if [[ "$automatic" != true ]]; then mode+=(--draft); fi
    gh pr create -R "taco3064/$repo" "${mode[@]}" --base main --head "$branch" \
      --title "Prepare Core ${core:0:12} rollout" \
      --body "Core CD run $GITHUB_RUN_ID. Consumer merge waits for the safe host stop."
  )
}

publish_action() {
  local repo=taco3064/nibfin-act head number ci status
  local branch="cd/action-${core:0:12}"
  prepare nibfin-act action
  number=$(gh pr list -R "$repo" --state open --head "$branch" \
    --json number --jq '.[0].number // empty')
  if [[ -z "$number" ]]; then
    action=$(gh api "repos/$repo/branches/main" --jq .commit.sha)
    return
  fi
  head=$(gh pr view -R "$repo" "$number" --json headRefOid --jq .headRefOid)
  test "$(gh pr view -R "$repo" "$number" --json files --jq '.files[].path')" = \
    core-source.json
  gh api "repos/$repo/contents/core-source.json?ref=$head" \
    -H 'Accept: application/vnd.github.raw+json' > "$work/action-head.json"
  jq -e --slurp '.[0] == .[1]' "$work/action-head.json" "$work/core-source.json"
  for ((attempt=0; attempt<30; attempt++)); do
    ci=$(gh api "repos/$repo/actions/runs" --method GET -f event=pull_request \
      -f head_sha="$head" --jq '.workflow_runs[]
      | select(.path==".github/workflows/ci.yml")
      | .id' | head -n 1)
    [[ -z "$ci" ]] || break
    sleep 10
  done
  : "${ci:?Action PR CI did not start}"
  for ((attempt=0; attempt<90; attempt++)); do
    status=$(gh api "repos/$repo/actions/runs/$ci" --jq .conclusion)
    [[ -z "$status" ]] || break
    sleep 10
  done
  if [[ "$status" != success ]]; then
    printf 'Action PR CI %s concluded %s\n' "$ci" "${status:-still running}" >&2
    return 1
  fi
  gh pr merge -R "$repo" "$number" --rebase --match-head-commit "$head"
  action=$(gh pr view -R "$repo" "$number" --json mergeCommit --jq .mergeCommit.oid)
}

if [[ "$automatic" == true && -z "$action" ]]; then
  publish_action
fi
if [[ -z "$action" ]]; then
  prepare nibfin-act action
else
  consumer_pins
  for repo in nibfin-core nibfin-act gh-nibfin; do
    prepare "$repo" consumers
  done
  if [[ "$automatic" == true ]]; then
    cp "$work/producer-pins.json" activation.json
  fi
fi
