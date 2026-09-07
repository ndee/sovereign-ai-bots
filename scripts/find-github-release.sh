#!/usr/bin/env bash
# Resolve exactly one GitHub Release by tag, including draft releases.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <tag>\n' "$0" >&2
  exit 2
fi

TAG="$1"

[[ -n "${GH_TOKEN:-}" ]] || {
  printf 'GH_TOKEN is required\n' >&2
  exit 2
}
[[ "${GITHUB_REPOSITORY:-}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]] || {
  printf 'GITHUB_REPOSITORY must be owner/repository\n' >&2
  exit 2
}

# GET /releases/tags/{tag} excludes draft releases. List every page and
# require exactly one exact tag_name match instead.
if ! pages="$(gh api --paginate --slurp \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2026-03-10' \
  "repos/$GITHUB_REPOSITORY/releases?per_page=100")"; then
  printf 'GitHub releases API request failed for %s\n' "$GITHUB_REPOSITORY" >&2
  exit 3
fi

if ! matches="$(jq -ce --arg tag "$TAG" '
  if type != "array" or any(.[]; type != "array") then
    error("GitHub releases response was not paginated arrays")
  end
  | [ .[][] | select(.tag_name == $tag) ]
' <<<"$pages")"; then
  printf 'GitHub releases API returned an invalid response for %s\n' \
    "$GITHUB_REPOSITORY" >&2
  exit 3
fi

match_count="$(jq -r 'length' <<<"$matches")"
if [[ "$match_count" == "0" ]]; then
  printf 'release %s does not exist\n' "$TAG" >&2
  exit 4
fi
if [[ "$match_count" != "1" ]]; then
  printf 'release %s is ambiguous: %s matches\n' "$TAG" "$match_count" >&2
  exit 5
fi

if ! jq -e --arg tag "$TAG" '
  .[0] |
  type == "object" and
  (.id | (type == "number") and (floor == .) and (. > 0)) and
  (.tag_name | (type == "string") and (. == $tag)) and
  (.target_commitish | (type == "string") and test("^[0-9a-f]{40}$")) and
  (.draft | type == "boolean")
' <<<"$matches" >/dev/null; then
  printf 'release %s has invalid GitHub metadata\n' "$TAG" >&2
  exit 3
fi

jq -c '.[0]' <<<"$matches"
