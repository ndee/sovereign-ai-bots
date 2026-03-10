# bitcoin-skill-match-core

Profile and offer workflow:
1. Read current state with `guarded_json_state` action `show`.
2. Never resolve the Matrix actor manually; `guarded_json_state` does that itself.
3. You do not have direct file access to the backing state file.
4. Capture `region`, `contactLevel`, `offers`, `seeks`, and settlement preferences.
5. Upsert the self-owned member with action `upsert-self` and `entity` `members` when profile fields changed.
6. Upsert offers only with `entity` `offers`; never try to embed offers inside an `entity members` write.
7. For offers, use one tool `input` object with allowed fields such as `marker`, `title`, `description`, `summary`, `region`, `regions`, `radiusKm`, `price`, `visibility`, `contactLevel`, `settlementPreferences`, or `notes`.
8. If the human did not provide a marker, omit it and let the guarded state path generate one automatically.
9. Even when richer fields such as `title`, `description`, `price`, or `radiusKm` are present, also set a concise `summary`.
10. Prefer JSON arrays for `settlementPreferences`, `regions`, and `notes`.
11. Read state again and verify the offer is stored under the current sender's `member:<matrixUserId>`.
12. If the human already provided enough information to save the offer, write it immediately instead of asking a redundant confirmation question.

Request workflow:
1. Read current state with action `show`.
2. Use `guarded_json_state` action `upsert-self` for request writes.
3. Capture `requestId`, `skill`, `region`, trust preference, and settlement hints.
4. Upsert the request with `entity` `requests`.
5. Read state again and verify the request exists under `requests[]` with the same `createdByMatrixUserId`.

Delete workflow:
1. Read current state with action `show`.
2. Confirm the target exists and is owned by the current actor.
3. Delete with `guarded_json_state` action `delete-self`.
4. Read state again and verify the target is gone before replying.

Match query workflow:
1. Read current state with action `show`.
2. Search exact offer matches first inside `members[].offers[]`.
3. Then search related skills, same region, and trusted paths already present in state.
4. Return up to 3 strong matches with a short reason and a practical next step.
5. Allow every human user to query all stored entries; only redact direct contact data according to `contactLevel`.

Mutation guard checklist:
1. Never mutate or read the backing state file directly.
2. Never mutate another user's member, offer, or request.
3. Never use `read`, `write`, `edit`, `grep`, `find`, `ls`, or `exec` against the state file.
4. Never append raw JSON outside the tool `input`.
5. Never use shell commands, temp files, env vars, or guessed paths to recover session data.
6. Never try to pass `--actor`, session keys, or copied Matrix metadata manually.
7. Never store the full OpenClaw session key as an owner id.
8. If the current turn is a fresh create request, ignore any older delete target from the same chat.
9. If an entry is legacy and missing `createdByMatrixUserId`, refuse the mutation.
10. Never send owner-managed fields such as `createdByMatrixUserId`, `createdByDisplayName`, `updatedByMatrixUserId`, or `updatedByDisplayName` in mutation payloads.
11. Never send nested `offers` arrays to `entity members`; use `entity offers` instead.
