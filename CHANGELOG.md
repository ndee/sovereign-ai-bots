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

[Unreleased]: https://github.com/ndee/sovereign-ai-bots/compare/v2.0.7...HEAD
[2.0.7]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.7
[2.0.0]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.0
