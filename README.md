# E2E artifacts for issue #122 (subject-scope filter on the live classification path)

Live-run proof artifacts. Not part of any release; this branch holds binaries only.

Node: `root@204.168.143.168` · homeserver `https://brave-freedom-badger-ad52.sovereign-ai-node.com`
· bots ref `5ff7adb` (includes PR #123, the #122 fix). Run id `e2e-1780680824150`, 2/2 scenarios passed.

- `artifacts/subject-scope-in-scope-red-tile.png` — the live `mail-sentinel` 🔴 RED alert for the
  IN-scope message ("Routine subject reference"), escalated by a `scope=subject` content rule.
- `artifacts/subject-scope-alert-room-timeline.png` — the Element "Alerts" room: the in-scope message
  is RED, and **no** "Weekly status digest" (out-of-scope, body-only marker) alert is present.
- `artifacts/element-login.png`, `artifacts/element-signed-in.png`, `artifacts/element-alert-room.png`
  — real Element web client (`https://app.element.io`) + operator login flow.
- `artifacts/subject-scope-element-run.webm` — screen recording of the Element session.
- `artifacts/e2e-proof-122.txt` — written proof: scenarios, results, and the in/out-of-scope asymmetry.
- `artifacts/cucumber-run.log` — full cucumber run log (2 scenarios, 14 steps, all passed).
- `artifacts/subject-scope-report.json` — cucumber JSON report for the run.
