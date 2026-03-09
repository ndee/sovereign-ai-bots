# bitcoin-skill-match-core

Profile and offer workflow:
1. For Matrix mutations, call `session_status` first.
2. `session_status` is zero-arg only. Pass whichever of `session_status.sessionKey` and `session_status.origin.from` the current turn exposed into the guarded state CLI; in DMs, `sessionKey` alone is sufficient.
3. Read current state with `sovereign-tool json-state show --instance bitcoin-skill-match-state --json`.
4. Capture `region`, `contactLevel`, `offers`, `seeks`, and settlement preferences.
5. Upsert the self-owned member with `entity members` when profile fields changed.
6. Upsert offers with `entity offers`; pass the mutation payload as one `--input-json` object with `marker`, `summary`, `region`, `contactLevel`, `settlementPreferences`, or `notes`. Prefer JSON arrays for `settlementPreferences` and `notes`.
7. Read state again and verify the offer is stored under the current sender's `member:<matrixUserId>`.

Request workflow:
1. Call `session_status` first for Matrix mutations.
2. Use `sessionKey` alone in DMs when that is the only exposed field; otherwise pass `origin.from` or both available fields.
3. Read current state with `show --json`.
4. Capture `requestId`, `skill`, `region`, trust preference, and settlement hints.
5. Upsert the request with `entity requests`.
6. Read state again and verify the request exists under `requests[]` with the same `createdByMatrixUserId`.

Delete workflow:
1. Call `session_status` first.
2. Use whichever actor fields the current `session_status` turn exposed; do not require both for DM deletes.
3. Read current state with `show --json`.
4. Confirm the target exists and is owned by the current actor.
5. Delete with `sovereign-tool json-state delete-self ... --json`.
6. Read state again and verify the target is gone before replying.

Match query workflow:
1. Read current state with `show --json`.
2. Search exact offer matches first inside `members[].offers[]`.
3. Then search related skills, same region, and trusted paths already present in state.
4. Return up to 3 strong matches with a short reason and a practical next step.
5. Allow every human user to query all stored entries; only redact direct contact data according to `contactLevel`.

Mutation guard checklist:
1. Never mutate `data/community-state.json` directly.
2. Never mutate another user's member, offer, or request.
3. Never append raw JSON as a positional argument to `sovereign-tool`.
4. Never pipe JSON through `echo ... | sovereign-tool ...`.
5. Never use shell substitution such as `$()` or backticks to build `sovereign-tool` commands.
6. Never use `jq`, `cat`, env vars, temp files, or guessed paths such as `/tmp/.openclaw_session` to recover session data.
7. Use only the literal values returned by the current `session_status` tool call.
8. Never call `session_status` with invented arguments or null placeholders.
9. Never write placeholders such as `<to-be-resolved>`.
10. Never store the full OpenClaw session key as an owner id.
11. If the current turn is a fresh create request, ignore any older delete target from the same chat.
12. If an entry is legacy and missing `createdByMatrixUserId`, refuse the mutation.
