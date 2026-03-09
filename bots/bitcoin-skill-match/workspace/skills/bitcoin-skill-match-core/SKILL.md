# bitcoin-skill-match-core

Profile intake checklist:
1. In direct Matrix chats, call `session_status` first and extract the actor from the current session key
2. In rooms, identify the actor from the latest inbound Matrix sender label
2. Capture `offers`, `seeks`, `region`, and `contactLevel`
3. Ask for settlement preferences and trust links if relevant
4. Read `data/community-state.json` from the current workspace before changing it
5. Update `data/community-state.json` with the exact field names `createdByMatrixUserId`, `createdByDisplayName`, `createdAt`, `updatedAt`, and `updatedByMatrixUserId`
6. Use the full Matrix user id from `session_status` or the room sender, not a bare localpart
7. Keep `notes` as an array; never rename it to `note`
8. Never rename those ownership fields to `owner*`
9. Confirm exactly what was stored without inventing another person's name

Match query checklist:
1. Read `data/community-state.json` from the current workspace before answering
2. Parse the requested skill, region, trust degree, and settlement hints
3. Inspect `members`, `requests`, `trustEdges`, `skills`, and `regions`
4. Rank exact skill match above adjacent skills or broad categories
5. Rank 1st degree above 2nd degree above regional fallback
6. Return matches plus a clear next-step intro suggestion
7. Allow every human user to query all stored entries; only redact contact details according to `contactLevel`

Mutation guard checklist:
1. For edits or deletes, read `data/community-state.json` from the current workspace first
2. If `createdByMatrixUserId` is missing, refuse the mutation and explain that the legacy entry must be recreated by its owner
3. If the current Matrix sender does not match `createdByMatrixUserId`, refuse the mutation
4. Never delete or rewrite another user's offer or request on their behalf
5. If you cannot find the entry in `data/community-state.json`, say so plainly; do not assume a different file path

Intro workflow checklist:
1. Check both users' `contactLevel`
2. Share direct contact only if the stored preference allows it
3. Otherwise draft a consent-first Matrix intro
4. Record the intro state in `introductions`
