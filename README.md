# E2E artifacts for issue #102 (preview excerpt + signal-chip evidence on alerts & digests)

Live-run proof artifacts. Not part of any release; this branch holds binaries only.

Node: `root@204.168.143.168` · homeserver `https://brave-freedom-badger-ad52.sovereign-ai-node.com`
· bots ref `5ff7adb` (PR #116 / commit `048b51a` "#102 excerpt" reachable; confirmed live in the
deployed `mail-sentinel.js` bundle). Run id `e2e-1780686705115`, **2/2 scenarios, 26/26 steps passed**.

Tested against `sovereign-ai-node-pro/e2e`, feature `features/alert-preview-excerpt.feature`
(tag `@preview-excerpt-102`).

## Acceptance criteria — all PASS

- **Every alert has a short useful preview when available** — the RED `invoice-overdue` alert
  carries an excerpt (320 chars, capped to the #102 320-char / 5-line limits), derived from the
  local snippet, plus a signal chip; the Matrix alert renders the quoted excerpt and `Signals:` line.
- **Digest items include enough context to judge importance** — every pending amber digest item the
  node holds carries an excerpt + reasons; a forced flush posts a real AMBER DIGEST tile whose body
  is judgeable without opening the mail (item line + `Why it matters:` + quoted excerpt + `Signals:`).
- **Preview respects privacy / local-first** — the excerpt is asserted to be a prefix of the local
  `state.messages[messageKey].snippet`, capped, with no externally fetched content.

## Artifacts

- `artifacts/preview-excerpt-red-alert-tile.png` — the live `mail-sentinel` 🔴 RED alert for
  `invoice-overdue`, showing the quoted preview excerpt and the `Signals:` chip under the
  `Why it matters:` line.
- `artifacts/preview-excerpt-digest-tile.png` — the live 🟠 AMBER DIGEST tile: two items, each with
  its own `Why it matters:`, quoted excerpt, and `Signals:` chip — judgeable without opening the mail.
- `artifacts/preview-excerpt-alert-room-timeline.png` — the Element "Alerts" room timeline showing the
  AMBER DIGEST tile in context.
- `artifacts/element-landing.png`, `artifacts/element-login.png`, `artifacts/element-credentials.png`,
  `artifacts/element-signed-in.png`, `artifacts/element-alert-room.png` — real Element web client
  (`https://app.element.io`) + operator login flow against the node's homeserver.
- `artifacts/preview-excerpt-element-run.webm` — screen recording of the Element session.
- `artifacts/preview-excerpt-final.png` — final room view at end of the session.
- `artifacts/e2e-proof-102.txt` — written proof: scenarios, results, rendered tiles, and the
  privacy/local-first argument.
- `artifacts/cucumber-run.log` — full cucumber run log (2 scenarios, 26 steps, all passed).
- `artifacts/preview-excerpt-report.json` — cucumber JSON report for the run.
