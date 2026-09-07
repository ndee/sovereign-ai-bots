#!/usr/bin/env bash
# Contract tests for draft-aware release control and CI-gated publication.

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

# Replace the release API mock with an Actions/ref API mock for the CI gate.
cat >"$WORK_DIR/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

request="$*"
case "$request" in
  *git/ref/heads/main*)
    [[ "${MOCK_GATE_FAILURE:-}" != "main" ]] || exit 17
    printf '%s\n' "$MOCK_MAIN_SHA"
    ;;
  *actions/workflows/ci.yml/runs*)
    [[ "${MOCK_GATE_FAILURE:-}" != "runs" ]] || exit 17
    cat "$MOCK_CI_RUNS"
    ;;
  *actions/runs/*/jobs*)
    [[ "${MOCK_GATE_FAILURE:-}" != "jobs" ]] || exit 17
    cat "$MOCK_CI_JOBS"
    ;;
  *)
    printf 'unexpected gate gh invocation: %s\n' "$request" >&2
    exit 64
    ;;
esac
EOF
chmod 0755 "$WORK_DIR/bin/gh"

CI_GATE="$REPO_ROOT/scripts/check-release-ci-gate.sh"
approved_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
newer_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
export MOCK_MAIN_SHA="$approved_sha"
cat >"$WORK_DIR/ci-jobs.json" <<'EOF'
[{"jobs":[{"id":201,"name":"Release Gate","conclusion":"success"}]}]
EOF
export MOCK_CI_JOBS="$WORK_DIR/ci-jobs.json"
cat >"$WORK_DIR/ci-runs.json" <<EOF
[{"workflow_runs":[
  {"id":101,"name":"CI","event":"push","head_branch":"main","head_sha":"$approved_sha","status":"completed","conclusion":"success","run_attempt":1}
]}]
EOF
export MOCK_CI_RUNS="$WORK_DIR/ci-runs.json"

[[ "$(bash "$CI_GATE" workflow-run "$approved_sha" 101 CI success push main example/project)" == "$approved_sha" ]]
[[ "$(bash "$CI_GATE" workflow-dispatch)" == "$approved_sha" ]]
[[ "$(bash "$CI_GATE" revalidate "$approved_sha")" == "$approved_sha" ]]

set +e
bash "$CI_GATE" workflow-run "$approved_sha" 101 CI failure push main example/project \
  >"$WORK_DIR/failed-ci.out" 2>"$WORK_DIR/failed-ci.err"
failed_ci_status=$?
set -e
[[ "$failed_ci_status" == "4" ]]
grep -q 'not an approved successful main CI run' "$WORK_DIR/failed-ci.err"

export MOCK_MAIN_SHA="$newer_sha"
set +e
bash "$CI_GATE" workflow-run "$approved_sha" 101 CI success push main example/project \
  >"$WORK_DIR/stale.out" 2>"$WORK_DIR/stale.err"
stale_status=$?
set -e
[[ "$stale_status" == "5" ]]
grep -q 'is stale; current main is' "$WORK_DIR/stale.err"

export MOCK_MAIN_SHA="$approved_sha"
cat >"$WORK_DIR/failed-gate-jobs.json" <<'EOF'
[{"jobs":[{"id":201,"name":"Release Gate","conclusion":"failure"}]}]
EOF
export MOCK_CI_JOBS="$WORK_DIR/failed-gate-jobs.json"
set +e
bash "$CI_GATE" workflow-run "$approved_sha" 101 CI success push main example/project \
  >"$WORK_DIR/failed-gate.out" 2>"$WORK_DIR/failed-gate.err"
failed_gate_status=$?
set -e
[[ "$failed_gate_status" == "4" ]]
grep -q 'exactly one successful Release Gate job' "$WORK_DIR/failed-gate.err"

export MOCK_CI_JOBS="$WORK_DIR/ci-jobs.json"
cat >"$WORK_DIR/no-matching-run.json" <<EOF
[{"workflow_runs":[
  {"id":102,"name":"CI","event":"push","head_branch":"main","head_sha":"$newer_sha","status":"completed","conclusion":"success","run_attempt":1}
]}]
EOF
export MOCK_CI_RUNS="$WORK_DIR/no-matching-run.json"
set +e
bash "$CI_GATE" workflow-dispatch \
  >"$WORK_DIR/manual-ungated.out" 2>"$WORK_DIR/manual-ungated.err"
manual_ungated_status=$?
set -e
[[ "$manual_ungated_status" == "4" ]]
grep -q 'no successful push CI run' "$WORK_DIR/manual-ungated.err"

export MOCK_GATE_FAILURE=jobs
set +e
bash "$CI_GATE" workflow-run "$approved_sha" 101 CI success push main example/project \
  >"$WORK_DIR/gate-api.out" 2>"$WORK_DIR/gate-api.err"
gate_api_status=$?
set -e
[[ "$gate_api_status" == "3" ]]
grep -q 'GitHub CI jobs lookup failed' "$WORK_DIR/gate-api.err"
unset MOCK_GATE_FAILURE

# The workflow must use only staged control-plane verification after checkout.
grep -Fq 'bash "$RUNNER_TEMP/release-control/find-github-release.sh" "$TAG"' \
  "$REPO_ROOT/.github/workflows/release.yml"
[[ "$(grep -Fc 'bash "$RUNNER_TEMP/release-control/verify-github-assets.sh"' \
  "$REPO_ROOT/.github/workflows/release.yml")" == "2" ]]

# Release mutation is downstream of the terminal CI gate and cannot be
# triggered directly by a main push. Publication has a second exact-head gate.
grep -Fq 'workflow_run:' "$REPO_ROOT/.github/workflows/release.yml"
! grep -Eq '^  push:' "$REPO_ROOT/.github/workflows/release.yml"
grep -Fq "github.event.workflow_run.conclusion == 'success'" \
  "$REPO_ROOT/.github/workflows/release.yml"
grep -Fq "github.event.workflow_run.head_repository.full_name == github.repository" \
  "$REPO_ROOT/.github/workflows/release.yml"
grep -Fq "if: needs.ci_gate.outputs.process == 'true'" \
  "$REPO_ROOT/.github/workflows/release.yml"
grep -Fq "if: github.event_name == 'workflow_run'" \
  "$REPO_ROOT/.github/workflows/release.yml"

for required_job in lint typecheck catalog_test unit_test build artifact_contract smoke; do
  grep -Fq "      - $required_job" "$REPO_ROOT/.github/workflows/ci.yml"
done
grep -Fq 'if: always() && github.event_name ==' "$REPO_ROOT/.github/workflows/ci.yml"

mutation_gate_line="$(grep -n 'Revalidate current main before release mutation' \
  "$REPO_ROOT/.github/workflows/release.yml" | cut -d: -f1)"
release_action_line="$(grep -n 'Open or advance the release PR' \
  "$REPO_ROOT/.github/workflows/release.yml" | cut -d: -f1)"
publish_gate_line="$(grep -n 'Revalidate current main immediately before publication' \
  "$REPO_ROOT/.github/workflows/release.yml" | cut -d: -f1)"
publish_line="$(grep -n 'Publish the immutable release' \
  "$REPO_ROOT/.github/workflows/release.yml" | cut -d: -f1)"
[[ "$mutation_gate_line" -lt "$release_action_line" ]]
[[ "$publish_gate_line" -lt "$publish_line" ]]
grep -Fq "steps.publish_gate.outputs.publish == 'true'" \
  "$REPO_ROOT/.github/workflows/release.yml"

printf 'GitHub release control contract passed.\n'
