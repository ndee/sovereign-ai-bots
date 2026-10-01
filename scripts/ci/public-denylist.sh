#!/usr/bin/env bash
# Public-text denylist. Reads text on stdin and fails if any line matches the
# pattern kept in .github/public-denylist.pattern (that file is excluded from
# every scan, so the pattern never trips the check itself).
#
#   public-denylist.sh <label>        scan stdin
#   public-denylist.sh --self-test    prove it fails on a hit and passes clean
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pattern_file="${here}/../../.github/public-denylist.pattern"
pattern="$(head -n 1 "$pattern_file")"

scan() {
  local label="$1" hits
  if hits="$(grep -inE -- "$pattern" || true)" && [ -n "$hits" ]; then
    echo "::error::denylisted text found in ${label}:"
    echo "$hits"
    return 1
  fi
}

if [ "${1:-}" = "--self-test" ]; then
  # Build the sample at runtime so this file holds no literal hit.
  sample="see $(printf 'cat%s' 'house') for details"
  if printf '%s\n' "$sample" | scan "self-test sample" >/dev/null; then
    echo "self-test FAILED: sample hit was not detected" >&2
    exit 1
  fi
  printf 'a perfectly ordinary line\n' | scan "self-test clean"
  echo "self-test ok: sample hit rejected, clean text accepted"
  exit 0
fi

scan "${1:-input}"
