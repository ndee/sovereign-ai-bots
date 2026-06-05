# E2E artifacts for issue #98 (subject-based policy rules)

Live-run proof artifacts. Not part of any release; this branch holds binaries only.

## Browser-captured artifacts (Element.io Matrix client)

Captured by driving the real **Element web client** (`https://app.element.io`),
logged in as the `operator` account against the live homeserver
`brave-freedom-badger-ad52.sovereign-ai-node.com`, viewing the Mail Sentinel
alert room. These replace the earlier terminal/local-HTML screenshots.

| File | What it shows |
|------|---------------|
| `subject-policy-proof.png` | Element alert room — the `mail-sentinel` bot's 🔴 RED alert for the subject-policy proof email (`subjpolicy-…: nightly status — node DOWN`, confidence low/30%, "no action required") forced to RED by the subject rule |
| `element-alert-room.png` | Same RED alert in the alert-room timeline (with the verify-device toast) |
| `element-login.png` | Element sign-in against the live homeserver as `operator` |
| `subject-policy-run.webm` | Screen recording of the Element session: login → alert room → the RED subject-policy alert |

## Supporting CLI / state proof

| File | What it shows |
|------|---------------|
| `e2e-proof-98.txt` | `policy list` (scope=subject), zone history (final zone = red), alert audit (policyModifiers reference the rule), Element alert text |
| `cucumber-run.log` | The 3-scenario / 19-step cucumber run (all passed) |

Node: `root@204.168.143.168` · Bots ref `74d18d7` (PR#113+#114 merged).
