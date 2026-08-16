# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
From this point forward, GitHub Release notes are auto-generated from commit history
by the `.github/workflows/release.yml` workflow.

Individual bot packages (under `bots/`) carry their own version field in each
`sovereign-bot.json`. Those versions evolve independently of this catalog-level
version.

## [Unreleased]

## [2.0.9] - 2026-08-16

Mail Sentinel 2.0.9 — semantic review survives a polluted stdout (bots#144).

### Fixed

- Every semantic review failed on the Raspberry Pi node with "lobster
  classification returned invalid JSON output", while the classifier itself was
  healthy. `lobster exec --shell` runs its command line through `/bin/sh -lc` —
  a *login* shell — so anything `/etc/profile.d/*` prints lands on stdout ahead
  of the pipeline payload. On Raspberry Pi OS `wifi-check.sh` emits "Wi-Fi is
  currently blocked by rfkill." via `gettext -s`, which writes to stdout rather
  than stderr, and the strict `JSON.parse` then rejected the whole stream.
  Classification now tolerates a non-JSON preamble (and trailing noise, e.g. a
  closing ``` fence) on both lobster's stdout and the model's own `output.text`.
  Genuinely absent or malformed payloads still fail, so a dead classifier is not
  masked. The failure was host-dependent, which is why CI and the amd64 nodes
  never reproduced it.

  Affected mail was not lost, but it was silently downgraded: a failed review is
  a non-fatal warning, so scans still reported success while every candidate
  fell back to amber with `confidence: unknown (0%)`.

- The "no structured JSON payload" error now carries a bounded stdout excerpt.
  Previously it gave no way to distinguish a dead classifier from a polluted
  stream, which is what made this require a live reproduction to diagnose.

## [2.0.8] - 2026-08-15

Mail Sentinel 2.0.8 — bounded IMAP search (bots#142).

### Fixed

- Every scan issued an unbounded `imap-search-mail --query ALL`. On a real,
  long-lived mailbox the server then has to enumerate every UID it has ever
  held, which exceeds the tool's 30 s IMAP socket timeout and fails every scan
  ("IMAP socket timeout during mail search"); `--limit` could not help because
  it is applied client-side after the server-side search. The configured
  `lookbackWindow` is now pushed into the IMAP search as
  `since:<YYYY-MM-DD>` (RFC 3501 `SINCE`, day granularity, computed in UTC as
  now − lookbackWindow − one day of slack for timezone/midnight skew), so the
  server only searches recent mail. An unparseable `lookbackWindow` falls back
  to the default `1h` bound rather than to an unbounded search.

### Added

- `scan --json` reports `imapSearchQuery`, the effective query the scan issued,
  so an operator or an e2e can prove the search was bounded.

## [2.0.7] - 2026-08-04

Mail Sentinel 2.0.7 — tool-executable readiness (node-pro #324).

### Added

- Mail Sentinel `status` CLI command: reports `ready`, the resolved
  sovereign-tool executable and whether it came from the
  `SOVEREIGN_TOOL_EXECUTABLE` override or the default path, plus the recorded
  degradation state, failure counters, and last error. Exit code is 0 either
  way — it is a status report, not a probe.
- New `tool-unavailable` degradation state with a one-time `SAN-TOOL-001`
  Matrix alert. A missing or non-executable sovereign-tool now degrades on the
  FIRST failed scan (instead of after three timer ticks) and names the install
  defect instead of misreporting a mailbox failure (`SAN-MAIL-001`).

### Changed

- A spawn-level `ENOENT`/`EACCES` from the sovereign-tool executable now throws
  a distinct "IMAP tool unavailable" error (code
  `MAIL_SENTINEL_TOOL_UNAVAILABLE`, `retryable: true`) instead of being
  collapsed into the generic "<command> failed" message, and the scan preflights
  tool availability so a broken install can never report a quiet inbox.

## [2.0.0] - 2026-04-14

Bootstrap release formalizing the semantic versioning scheme for this project.
See the [v2.0.0 GitHub Release](https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.0)
for details.

[Unreleased]: https://github.com/ndee/sovereign-ai-bots/compare/v2.0.9...HEAD
[2.0.9]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.9
[2.0.8]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.8
[2.0.7]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.7
[2.0.0]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.0
