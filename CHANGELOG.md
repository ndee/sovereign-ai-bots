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

## [2.0.12] - 2026-08-24

POP3 support and real mail reconfiguration with post-install Settings UI, OpenRouter privacy routing, and security hardening (LAN-bound Pro API, secret-free install job records, per-node relay enrollment secret)

### Added

- mail-sentinel: `imapProtocol` config default (`imap`) and `protocol` tool binding so the node's read-only mail tool can serve the mailbox over POP3 as well as IMAP. Existing instances without the key keep using IMAP.

### Changed

- Mail Sentinel sends the semantic reviewer only the minimum necessary payload
  (ndee/sovereign-ai-node-pro#377, #373): thread context, policy hints, matched
  rule ids, and the parsed amount are no longer sent; the sender is the bare
  address (or, with `llmSenderDetail: "domain"`, the domain only); the body
  snippet has quoted replies and signatures stripped and URLs, phone numbers,
  and IBANs masked, capped at 300 characters. Bulk/newsletter detection and
  sender mutes now run before the reviewer, so suppressed mail never leaves the
  node. The candidate file is written 0600 inside a private temp directory. A
  provider privacy-routing refusal ("No endpoints found …") is treated as a
  classification degradation and is never retried.

## [2.0.11] - 2026-08-20

mail-sentinel scan reliability: lobster CLI resolution, bot-unit npm PATH, IMAP error surfacing and opening-search retry

### Fixed

- Mail Sentinel's semantic reviewer was permanently unavailable on nodes where
  the `lobster` CLI only lives in the service user's npm prefix
  (`<passwd home>/.npm-global/bin`, where the node installer puts it — Pro web
  installer, Pi image): the scan unit's fixed system `PATH` does not contain
  that directory, so every classification failed with `spawn lobster ENOENT`
  and every candidate was capped at amber with "semantic reviewer unavailable"
  (bots#150). The runtime now resolves the executable — `SOVEREIGN_LOBSTER_EXECUTABLE`
  override, `PATH`, the service user's npm prefix, `$HOME/.npm-global/bin`,
  `/usr/local/bin`, `/usr/bin` — and a missing binary is reported with the
  locations that were searched instead of the bare `ENOENT`.
- Mail Sentinel gave the IMAP search that opens every scan exactly one shot.
  Against a remote provider (Gmail on cathouse-pi) the same small `SINCE`
  search answered anywhere between 3 s and well past the 60 s per-call
  ceiling on a per-connection basis, so roughly half of all scans failed with
  SAN-MAIL-001 and no mail was triaged on those ticks (bots#152). The search
  is now retried once on a fresh connection (transient failures only — a
  missing tool is still surfaced immediately); a late first attempt shows up
  as a scan warning, and an exhausted retry names the attempt count.
- Mail Sentinel announced "back to normal" while the semantic reviewer was
  still broken: a scan with no candidate mail reset the degradation state to
  healthy, so a permanently failing reviewer produced `⚠️ SAN-LLM-001` /
  `✅ back to normal` on alternating ticks (bots#151). A quiet scan is no
  evidence either way — `classification-degraded` now persists until a scan
  actually classifies a candidate without failure.

## [2.0.10] - 2026-08-16

Mail Sentinel 2.0.10 — scans stay bounded as the mailbox grows (bots#146,
pro#341, pro#342).

### Fixed

- Mail Sentinel scans on a busy mailbox grew slower with every 30-minute tick
  until they ran into the scan unit's `TimeoutStartSec=300` and were SIGKILLed,
  leaving the mailbox silently untriaged. The bounded `SINCE <date>` search
  (bots#142) is day-granular, so it returns the same 24–48h of mail on every
  tick — and the scan re-read every one of those messages (a fresh IMAP
  connection plus a full body download each) before deciding it already knew
  them. Reads are now bounded by the UID watermark: anything at or below
  `lastSeenUid` is never re-fetched, so a steady-state scan reads only mail
  that arrived since the last tick. A UIDVALIDITY change still re-reads the
  mailbox in full.
- A scan now finishes on its own terms instead of the supervisor's: every
  sovereign-tool child is bounded by a 60s per-call timeout, and the
  per-message loop stops reading once a 180s budget is spent, deferring the
  remaining (higher-UID) messages to the next tick via the watermark. Deferrals
  are reported as `deferredMessages` plus a warning.
- A scan killed by `SIGTERM` (systemd's `TimeoutStartSec`, an operator's
  Ctrl-C) used to die before it could persist anything, so exactly the scans
  that hung long enough to be killed were never counted: `consecutiveFailures`
  under-reported outages and the degradation notice fired late or not at all.
  The scan now records the failure the moment the signal lands
  (`lastError.code: MAIL_SENTINEL_SCAN_INTERRUPTED`), then unwinds normally so
  the state lock is released and the CLI exits non-zero. The recording is
  idempotent, so the dying tool child and the signal never double-count.
- `status` now also reports `lastImapSuccessAt` ("Last successful mail
  retrieval"): `lastPollAt` keeps advancing through an outage, whereas this is
  the timestamp that says how long mail has actually gone untriaged.

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

[Unreleased]: https://github.com/ndee/sovereign-ai-bots/compare/v2.0.12...HEAD
[2.0.12]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.12
[2.0.11]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.11
[2.0.10]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.10
[2.0.9]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.9
[2.0.8]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.8
[2.0.7]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.7
[2.0.0]: https://github.com/ndee/sovereign-ai-bots/releases/tag/v2.0.0
