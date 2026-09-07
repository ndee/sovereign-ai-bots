#!/usr/bin/env bash
# Fail-closed gate between the required main CI run and release mutation.

set -euo pipefail

MODE="${1:-}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

api() {
  gh api \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2026-03-10' \
    "$@"
}

current_main_sha() {
  local sha
  if ! sha="$(api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')"; then
    echo 'GitHub main-ref lookup failed.' >&2
    return 3
  fi
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo 'GitHub main-ref lookup returned an invalid SHA.' >&2
    return 3
  fi
  printf '%s\n' "$sha"
}

require_release_gate_job() {
  local run_id="$1"
  local jobs_json
  if [[ ! "$run_id" =~ ^[1-9][0-9]*$ ]]; then
    echo 'CI run id is invalid.' >&2
    return 4
  fi
  if ! jobs_json="$(api --paginate --slurp \
    "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs?per_page=100")"; then
    echo 'GitHub CI jobs lookup failed.' >&2
    return 3
  fi
  if ! jq -e '
    type == "array" and all(.[]; type == "object" and (.jobs | type == "array"))
  ' <<<"$jobs_json" >/dev/null; then
    echo 'GitHub CI jobs lookup returned an invalid response.' >&2
    return 3
  fi
  if ! jq -e '
    [.[] | .jobs[] | select(.name == "Release Gate")] as $gates |
    ($gates | length) == 1 and $gates[0].conclusion == "success"
  ' <<<"$jobs_json" >/dev/null; then
    echo 'The CI run does not contain exactly one successful Release Gate job.' >&2
    return 4
  fi
}

case "$MODE" in
  workflow-run)
    EXPECTED_SHA="${2:-}"
    CI_RUN_ID="${3:-}"
    CI_WORKFLOW_NAME="${4:-}"
    CI_CONCLUSION="${5:-}"
    CI_EVENT="${6:-}"
    CI_HEAD_BRANCH="${7:-}"
    CI_HEAD_REPOSITORY="${8:-}"
    if [[ "$CI_WORKFLOW_NAME" != "CI" || "$CI_CONCLUSION" != "success" || \
      "$CI_EVENT" != "push" || "$CI_HEAD_BRANCH" != "main" || \
      "$CI_HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" || \
      ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo 'The workflow_run payload is not an approved successful main CI run.' >&2
      exit 4
    fi
    require_release_gate_job "$CI_RUN_ID" || exit $?
    ;;
  workflow-dispatch)
    CI_RUN_ID="${2:-}"
    if [[ ! "$CI_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
      echo 'Manual recovery requires a valid CI run id.' >&2
      exit 4
    fi
    EXPECTED_SHA="$(current_main_sha)" || exit $?
    run_json=''
    if ! run_json="$(api "repos/$GITHUB_REPOSITORY/actions/runs/$CI_RUN_ID")"; then
      echo 'GitHub CI run lookup failed.' >&2
      exit 3
    fi
    if ! jq -e --arg repo "$GITHUB_REPOSITORY" --arg sha "$EXPECTED_SHA" '
      type == "object" and
      .name == "CI" and .event == "push" and .head_branch == "main" and
      .head_repository.full_name == $repo and .head_sha == $sha and
      .status == "completed" and .conclusion == "success"
    ' <<<"$run_json" >/dev/null; then
      echo 'The requested CI run is not a successful push CI run for current main.' >&2
      exit 4
    fi
    if [[ "$(jq -r '.id' <<<"$run_json")" != "$CI_RUN_ID" ]]; then
      echo 'GitHub returned a different CI run id.' >&2
      exit 3
    fi
    require_release_gate_job "$CI_RUN_ID" || exit $?
    ;;
  revalidate)
    EXPECTED_SHA="${2:-}"
    if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo 'Approved main SHA is invalid.' >&2
      exit 4
    fi
    ;;
  *)
    echo 'usage: check-release-ci-gate.sh workflow-run <sha> <run-id> <name> <conclusion> <event> <branch> <head-repo>' >&2
    echo '       check-release-ci-gate.sh workflow-dispatch <ci-run-id>' >&2
    echo '       check-release-ci-gate.sh revalidate <sha>' >&2
    exit 64
    ;;
esac

CURRENT_SHA="$(current_main_sha)" || exit $?
if [[ "$CURRENT_SHA" != "$EXPECTED_SHA" ]]; then
  printf 'Approved CI SHA %s is stale; current main is %s.\n' \
    "$EXPECTED_SHA" "$CURRENT_SHA" >&2
  exit 5
fi

printf '%s\n' "$EXPECTED_SHA"
