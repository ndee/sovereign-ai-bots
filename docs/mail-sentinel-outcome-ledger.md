# Mail Sentinel: outcome ledger and reconcile

Mail Sentinel records one outcome per message it sees, so an operator can tell
"every message was checked" apart from "a quiet day". A message that could not
be read, was too large, or got no review verdict no longer leaves just one
warning in one scan's output. It is counted until the period ends.

This makes the gaps described in #172, #177 and #178 measurable. It does not
change how any of them behave: retries, the watermark and the alert zones work
exactly as before.

## The ledger file

`data/mail-sentinel-ledger.json` sits beside the state file. It is a separate
file because the state file holds mail content (subjects, senders, snippets)
and the ledger must not.

Each entry is keyed by `<protocol>:<uidValidity>:<uid>` and holds:

| Field | Meaning |
|---|---|
| `key` | Message identifier. Identifiers never match across key spaces, so a UIDVALIDITY change starts a new one. |
| `firstSeenAt` | When the scan or the inventory first recorded it. |
| `state` | Exactly one outcome state (below). |
| `reason` | Sub-cause where known, e.g. `timeout` for a read that hit the tool deadline or a review call the bot killed. |
| `review` | For verdicts: `reviewer`, `rules-only`, `policy-skipped` or `duplicate`. |
| `attempts` | Read or review attempts the scan made. |
| `updatedAt` | Last state change. |
| `inventoriedAt`, `scannedAt` | When the independent inventory listed it, and when a search returned it. |
| `outageAffected` | First seen while the bot was `classification-degraded` or `scans-failing`. |

No subject, sender, recipient, Message-ID, POP3 UIDL or body is ever written to
the ledger. Entries are kept for 45 days. Writes are atomic (temp file and
rename) and happen under the state lock. If the file cannot be read, it is
started again empty and the day gets the `ledger-reset` flag, so the lost
history stays visible.

## Outcome states

| Group | State | Meaning |
|---|---|---|
| Verdict | `red`, `amber`, `gray` | A zone was decided. `review` says how: by the semantic reviewer, by local rules only (below the candidate threshold, or bulk mail), skipped by a mute policy, or inherited from a duplicate Message-ID. |
| No verdict | `no-verdict:reviewer-unavailable` | The semantic reviewer gave no verdict and later scans will not try again. The alert still shows the fallback zone (usually amber) in the digest, but the ledger does **not** count it as an amber verdict. `reason` is `retries-exhausted` (the re-reviews below ran out), `recovery-failed` (the one recovery attempt failed too), `operator-feedback` (the operator gave feedback while it was retried), or, for a fallback gray that opened no alert and is never retried, how the last review call failed (`timeout`, `gateway-timeout`, `connection`, `http` or `invalid-reply`) or `postponed`. |
| | `no-verdict:refused` | The model provider refused the review under the configured privacy routing. |
| | `no-verdict:defaulted` | The reviewer replied without a usable confidence or zone, so defaults filled the gaps. |
| Not processed | `read-failed` | The message could not be read. `reason` is `timeout` or `other`. |
| | `too-large` | Above the read size limit, so never read. |
| | `not-returned` | Listed by the inventory, but no search returned it within the grace period. `reason` is `truncated` (the search matched more than it returned), `baseline` (the mail tool marks it as pre-existing), `outside-window` (it arrived during a long inventory gap, possibly before the search window) or `below-watermark` (returned only below the scan watermark, so skipped unread). |
| In flight | `pending` | Listed by the inventory and younger than 2 × `pollInterval` + 10 minutes. |
| | `deferred` | The scan's time budget ran out before it was read; the next scan picks it up. With reason `review-retry`: it was read, but its review gave no verdict (a failed call, or postponed because the reviewer had failed twice in a row or the time budget was spent), and later scans review it again (below). |

Each identifier is in exactly one state at a time. A later scan can move it,
for example from `read-failed` to a verdict when a re-read succeeds.

### Review on later scans

A mail whose review gave no verdict is reviewed again on later scans, with the
same minimised payload, after the new mail and under the same breaker and time
budget:

- At most 6 attempts, the first included, within 12 h of the first failure.
  The next attempt waits at least 0, 1, 2, 4 and 4 h after the previous one
  (5 minutes of slack), so on a 30-minute timer they fall at about 0, 0.5,
  1.5, 3.5, 7.5 and 11.5 h. At most 5 re-reviews per scan, oldest first.
- `attempts` counts every attempt; a postponed review counts none. The
  attempt is written to the state file before the call is made.
- A verdict moves the entry in place to `red`, `amber` or `gray` with
  `review: reviewer` and reason `late`. The alert keeps its id and short
  reference. A change to red sends one red message marked late; amber and
  gray change nothing visible except the alert itself.
- When the bounds are used up the entry becomes
  `no-verdict:reviewer-unavailable` (`retries-exhausted`). In the first scan
  in which the reviewer returns a real verdict again, every such mail up to 7
  days old gets exactly one recovery attempt (at most 5 per scan). A verdict
  then moves it to the verdict with reason `late`; otherwise the reason
  becomes `recovery-failed` and it stays not checked.
- Never retried: routing refusals, bulk and muted mail, a fallback gray, and
  an alert the operator has already given feedback on.
- An entry still `deferred` (`review-retry`) 12 h plus one poll interval after
  the scan first acted on it is closed as `retries-exhausted`.

## Coverage and the independent inventory

The scan runs `sovereign-tool mail-inventory` first, before its search, and
saves the result to the ledger before the search starts. The inventory lists
message identifiers outside the search path, with no result limit, no
watermark and no lookback window:

```
sovereign-tool mail-inventory --instance <mail-tool-instance> \
  [--after-uid <n> --uid-validity <v>] --timeout-ms 20000 --config-path <path> --json
```

- **IMAP** results carry `uidValidity`, `afterUid` (0 means a full listing),
  `uidValidityChanged`, `uidRanges` (ascending, inclusive) and `uidGaps`. The
  bot passes the highest identifier it has inventoried, so a long outage still
  lists every arrival.
- **POP3** results carry `uidValidity` and `messages[]`. Only messages with a
  POP3 index `uid` are counted. `baseline: true` marks the tool's own
  pre-existing mail. UIDL hashes are never stored.

The first run in a key space lists the mailbox as it already was. That
baseline is excluded from every period.

- **Coverage: full** for a day with at least one successful inventory run.
  That day's equation balances against the identifiers the inventory listed.
- **Coverage: partial** without one, including when the installed mail tool
  has no `mail-inventory` command. The equation then balances against the
  ledger's own record count, and mail the search never returned cannot be seen
  at all.

An inventory failure never fails a scan. No successful inventory for more than
24 hours puts the `inventory-gap` flag on the days affected.

## The equation

Per calendar day in the device's time zone (the day an identifier was first
inventoried with full coverage, or first recorded with partial coverage):

```
expected = red + amber + gray + no-verdict(*) + read-failed + too-large
         + not-returned + pending + deferred + residual
```

`residual` must be 0. A non-zero residual is shown as a reconciliation defect,
never hidden. It means the ledger and the independent count disagree, for
example because an entry was removed or holds a state the bot does not know.
On full-coverage days, messages a scan saw that the inventory never listed are
reported on their own line (`seen by a scan but not inventoried`), outside the
equation.

Day flags: `inventory-gap`, `coverage-break` (UIDVALIDITY changed, so the same
mail may be counted under new keys), `search-truncated`, `ledger-reset`.

## Commands

| Command | Output |
|---|---|
| `mail-sentinel.js reconcile --instance <id> [--limit <days>] [--json]` | The equation per day (default: the last 7 days with activity) and the totals, plus `lateVerdicts` per day and in the totals (verdicts that a later scan's review produced). Counts only, safe to share for support. |
| `mail-sentinel.js integrity --instance <id> [--limit <days>] [--json]` | For the operator's own room: per-day received / checked / not checked / in progress, and the unaccounted messages with arrival time, state, and sender and subject where the scan saw them. Never put this output in an export. |

## The `integrity` block in the state file

Every scan write recomputes `integrity` from the ledger, so a restart cannot
skew it. It contains counts only:

```json
{
  "integrity": {
    "version": 1,
    "updatedAt": "2026-10-19T12:00:00.000Z",
    "coverage": "partial",
    "inventory": "unsupported",
    "residual": 0,
    "unaccounted": 1,
    "inFlight": 0,
    "days": {
      "2026-10-19": {
        "coverage": "partial",
        "inventory": 12,
        "states": { "gray": 9, "amber": 2, "read-failed:timeout": 1 },
        "unaccounted": 1
      }
    }
  }
}
```

`states` folds a known sub-cause into the name (`read-failed:timeout`,
`not-returned:truncated`). On a partial day `inventory` is the ledger's own
record count. Optional per-day fields appear only when non-zero: `residual`,
`unaccounted`, `inFlight`, `outageAffected`, `lateVerdicts`,
`seenNotInventoried`, `uidGaps`, `flags`.

The state file also keeps `integrityDetails` (sender and subject of messages
that are currently unaccounted for), only so that `integrity` can name them.
It is content and stays in the state file.

## Operator surfaces

- **Digest.** Every amber digest carries one line, e.g. `Since the last digest:
  41 mails, 41 checked.` If anything was not checked, the line says how many
  and points to `integrity`. With partial coverage it ends with
  `Coverage: partial.`
- **Daily notice.** At most one Matrix notice per day when messages from the
  last 7 days are unaccounted for or a day's counts do not balance, e.g.
  `Mail Sentinel: 3 messages received today could not be checked: 2 could not
  be read, 1 got no review verdict. Check them in your mail client, or ask
  "integrity" for details.` It is built from counts only. If the send fails,
  the notice is retried with the next scan.
