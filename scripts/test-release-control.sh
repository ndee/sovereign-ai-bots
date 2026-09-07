#!/usr/bin/env bash
# Contract tests for draft-aware GitHub Release lookup and staged verification.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOOKUP="$REPO_ROOT/scripts/find-github-release.sh"
WORK_DIR="$(mktemp -d --tmpdir github-release-control.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "api" && "$2" == "--paginate" && "$3" == "--slurp" ]] || {
  printf 'unexpected gh invocation: %s\n' "$*" >&2
  exit 64
}

if [[ "${MOCK_GH_FAILURE:-false}" == "true" ]]; then
  printf 'mock GitHub API failure\n' >&2
  exit 17
fi

cat "$MOCK_GH_PAGES"
EOF
chmod 0755 "$WORK_DIR/bin/gh"

export GH_TOKEN=test-token
export GITHUB_REPOSITORY=example/project
export PATH="$WORK_DIR/bin:$PATH"

cat >"$WORK_DIR/pages.json" <<'EOF'
[
  [
    {"id":11,"tag_name":"v1.2.3","target_commitish":"1111111111111111111111111111111111111111","draft":false},
    {"id":12,"tag_name":"v1.2.30","target_commitish":"1212121212121212121212121212121212121212","draft":false}
  ],
  [
    {"id":22,"tag_name":"v2.1.0","target_commitish":"2222222222222222222222222222222222222222","draft":true}
  ]
]
EOF
export MOCK_GH_PAGES="$WORK_DIR/pages.json"

published_json="$(bash "$LOOKUP" v1.2.3)"
jq -e '.id == 11 and .draft == false and .tag_name == "v1.2.3"' \
  <<<"$published_json" >/dev/null

draft_json="$(bash "$LOOKUP" v2.1.0)"
jq -e '.id == 22 and .draft == true and .tag_name == "v2.1.0"' \
  <<<"$draft_json" >/dev/null

set +e
bash "$LOOKUP" v9.9.9 >"$WORK_DIR/missing.out" 2>"$WORK_DIR/missing.err"
missing_status=$?
set -e
[[ "$missing_status" == "4" ]] || {
  printf 'missing release returned %s instead of 4\n' "$missing_status" >&2
  exit 1
}
grep -q 'does not exist' "$WORK_DIR/missing.err"

cat >"$WORK_DIR/duplicate-pages.json" <<'EOF'
[
  [{"id":31,"tag_name":"v3.0.0","draft":true}],
  [{"id":32,"tag_name":"v3.0.0","draft":false}]
]
EOF
export MOCK_GH_PAGES="$WORK_DIR/duplicate-pages.json"
set +e
bash "$LOOKUP" v3.0.0 >"$WORK_DIR/duplicate.out" 2>"$WORK_DIR/duplicate.err"
duplicate_status=$?
set -e
[[ "$duplicate_status" == "5" ]] || {
  printf 'duplicate release returned %s instead of 5\n' "$duplicate_status" >&2
  exit 1
}
grep -q 'is ambiguous: 2 matches' "$WORK_DIR/duplicate.err"

export MOCK_GH_FAILURE=true
set +e
bash "$LOOKUP" v1.2.3 >"$WORK_DIR/api-failure.out" 2>"$WORK_DIR/api-failure.err"
api_status=$?
set -e
[[ "$api_status" == "3" ]] || {
  printf 'API failure returned %s instead of 3\n' "$api_status" >&2
  exit 1
}
grep -q 'GitHub releases API request failed' "$WORK_DIR/api-failure.err"
unset MOCK_GH_FAILURE

printf '{"not":"paginated arrays"}\n' >"$WORK_DIR/malformed.json"
export MOCK_GH_PAGES="$WORK_DIR/malformed.json"
set +e
bash "$LOOKUP" v1.2.3 >"$WORK_DIR/malformed.out" 2>"$WORK_DIR/malformed.err"
malformed_status=$?
set -e
[[ "$malformed_status" == "3" ]] || {
  printf 'malformed API response returned %s instead of 3\n' "$malformed_status" >&2
  exit 1
}
grep -q 'returned an invalid response' "$WORK_DIR/malformed.err"

cat >"$WORK_DIR/bad-metadata-pages.json" <<'EOF'
[[{"id":41,"tag_name":"v4.0.0","target_commitish":"4444444444444444444444444444444444444444","draft":null}]]
EOF
export MOCK_GH_PAGES="$WORK_DIR/bad-metadata-pages.json"
set +e
bash "$LOOKUP" v4.0.0 >"$WORK_DIR/bad-metadata.out" 2>"$WORK_DIR/bad-metadata.err"
bad_metadata_status=$?
set -e
[[ "$bad_metadata_status" == "3" ]] || {
  printf 'invalid release metadata returned %s instead of 3\n' "$bad_metadata_status" >&2
  exit 1
}
grep -q 'has invalid GitHub metadata' "$WORK_DIR/bad-metadata.err"

# Stage the current control-plane scripts, then create a tagged checkout with a
# deliberately broken old verifier. Invoking the staged copy must still work.
TOOL_DIR="$WORK_DIR/release-control"
install -d -m 0755 "$TOOL_DIR"
install -m 0755 \
  "$REPO_ROOT/scripts/find-github-release.sh" \
  "$REPO_ROOT/scripts/verify-github-assets.sh" \
  "$TOOL_DIR/"

TAGGED_REPO="$WORK_DIR/tagged-repo"
mkdir -p "$TAGGED_REPO/scripts"
git -C "$TAGGED_REPO" init -q
git -C "$TAGGED_REPO" config user.name test
git -C "$TAGGED_REPO" config user.email test@example.invalid
printf 'tagged contents\n' >"$TAGGED_REPO/README"
printf '#!/usr/bin/env bash\nexit 99\n' >"$TAGGED_REPO/scripts/verify-github-assets.sh"
git -C "$TAGGED_REPO" add README scripts/verify-github-assets.sh
git -C "$TAGGED_REPO" commit -qm fixture
tag_sha="$(git -C "$TAGGED_REPO" rev-parse HEAD)"
tag="v2.1.0"
git -C "$TAGGED_REPO" tag "$tag"

asset="$WORK_DIR/example.tgz"
printf 'release asset\n' >"$asset"
asset_size="$(stat -c '%s' "$asset")"
asset_digest="sha256:$(sha256sum "$asset" | awk '{print $1}')"
jq -cn \
  --arg tag "$tag" \
  --arg sha "$tag_sha" \
  --arg name "$(basename "$asset")" \
  --argjson size "$asset_size" \
  --arg digest "$asset_digest" \
  '[[{id:22,tag_name:$tag,target_commitish:$sha,draft:true,immutable:false,assets:[{name:$name,size:$size,digest:$digest,state:"uploaded"}]}]]' \
  >"$WORK_DIR/staged-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/staged-pages.json"

(
  cd "$TAGGED_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 22 "$asset"
)

set +e
(
  cd "$TAGGED_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 23 "$asset"
) >"$WORK_DIR/wrong-id.out" 2>"$WORK_DIR/wrong-id.err"
wrong_id_status=$?
set -e
[[ "$wrong_id_status" != "0" ]] || {
  printf 'verifier accepted the wrong release id\n' >&2
  exit 1
}

jq --arg wrong_sha '0000000000000000000000000000000000000000' \
  '.[0][0].target_commitish = $wrong_sha' \
  "$WORK_DIR/staged-pages.json" >"$WORK_DIR/wrong-target-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/wrong-target-pages.json"
set +e
(
  cd "$TAGGED_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" draft "$tag" "$tag_sha" 22 "$asset"
) >"$WORK_DIR/wrong-target.out" 2>"$WORK_DIR/wrong-target.err"
wrong_target_status=$?
set -e
[[ "$wrong_target_status" != "0" ]] || {
  printf 'verifier accepted the wrong target commitish\n' >&2
  exit 1
}

jq '.[0][0].draft = false | .[0][0].immutable = true' \
  "$WORK_DIR/staged-pages.json" >"$WORK_DIR/published-pages.json"
export MOCK_GH_PAGES="$WORK_DIR/published-pages.json"
(
  cd "$TAGGED_REPO"
  bash "$TOOL_DIR/verify-github-assets.sh" published "$tag" "$tag_sha" 22 "$asset"
)

# The workflow must use only staged control-plane verification after checkout.
grep -Fq 'bash "$RUNNER_TEMP/release-control/find-github-release.sh" "$TAG"' \
  "$REPO_ROOT/.github/workflows/release.yml"
[[ "$(grep -Fc 'bash "$RUNNER_TEMP/release-control/verify-github-assets.sh"' \
  "$REPO_ROOT/.github/workflows/release.yml")" == "2" ]]

printf 'GitHub release control contract passed.\n'
