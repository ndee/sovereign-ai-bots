# bitcoin-skill-match-core

Profile intake checklist:
1. In direct Matrix chats, call `session_status` first
1a. `session_status` takes no arguments; call it with `{}` only
2. In a direct Matrix chat, extract the actor from `session_status.sessionKey` when it matches `agent:<agentId>:matrix:direct:@user:server`
3. If `session_status.sessionKey` does not expose the actor, use `session_status.origin.from` when it matches `matrix:@user:server`
4. Use only the extracted suffix that starts with `@`; never store the full `agent:<agentId>:matrix:direct:@user:server` session key as an owner id
5. If neither value exposes a full Matrix user id, refuse the mutation for that turn; never write placeholders and never ask a second question before checking `session_status`
6. In rooms, identify the actor from the latest inbound Matrix sender label
7. Capture `offers`, `seeks`, `region`, and `contactLevel`
8. Ask for settlement preferences and trust links if relevant
9. Read `data/community-state.json` from the current workspace before changing it
10. Update `data/community-state.json` with the exact field names `createdByMatrixUserId`, `createdByDisplayName`, `createdAt`, `updatedAt`, and `updatedByMatrixUserId`
11. Use the full Matrix user id from `session_status` or the room sender, not a bare localpart
12. Use `member:<createdByMatrixUserId>` as the default self-owned `memberId`
13. Default `createdByDisplayName` and `updatedByDisplayName` to the actor's Matrix localpart unless the user explicitly provided a public display name in this turn
14. Keep `notes` as an array; never rename it to `note`
15. Never rename those ownership fields to `owner*`
16. Do not create a top-level `offers` array; offers belong only in `members[].offers[]`
17. Requests belong only in the top-level `requests[]` array
18. After any create, update, or delete, read `data/community-state.json` again and verify the marker changed as intended before replying
19. For a new offer or profile write, if no member exists for the current actor, create `member:<currentActor>` first
20. Never attach a new offer to another user's `members[]` record, even as a draft, placeholder, or pending approval
21. If the latest turn starts a fresh create request, ignore any older foreign-owned delete or update target from the same chat
22. Confirm exactly what was stored without inventing another person's name or reusing another user's profile

Match query checklist:
1. Read `data/community-state.json` from the current workspace before answering
2. Parse the requested skill, region, trust degree, and settlement hints
3. Inspect `members`, `requests`, `trustEdges`, `skills`, and `regions`
4. For offer queries, search inside `members[].offers[]`
5. Never assume a top-level `offers[]` collection exists in canonical state
6. Rank exact skill match above adjacent skills or broad categories
7. Rank 1st degree above 2nd degree above regional fallback
8. Return matches plus a clear next-step intro suggestion
9. Allow every human user to query all stored entries; only redact contact details according to `contactLevel`

Mutation guard checklist:
1. For direct Matrix create, update, or delete, call `session_status` before anything else and resolve the actor from that tool output
1a. Never pass a guessed `sessionKey`, placeholder, or Matrix handle into `session_status`; it is a zero-argument tool
2. For edits or deletes, read `data/community-state.json` from the current workspace first
3. If `createdByMatrixUserId` is missing, refuse the mutation and explain that the legacy entry must be recreated by its owner
4. If the current Matrix sender does not match `createdByMatrixUserId`, refuse the mutation
5. Never delete or rewrite another user's offer or request on their behalf
6. If you cannot find the entry in `data/community-state.json`, say so plainly; do not assume a different file path
7. Never write `<to-be-resolved>`, `owner*`, `note`, or a bare localpart into stored state
8. On offer deletes, locate the offer under `members[].offers[]`, compare the enclosing member's `createdByMatrixUserId` to the current actor, and refuse on mismatch
9. On request deletes, compare `requests[].createdByMatrixUserId` to the current actor and refuse on mismatch
10. Never skip the ownership check just because the current DM session already exists
11. On offer creates, verify the enclosing member's `createdByMatrixUserId` equals the current actor before writing
12. If an offer create would land under another user's member record, stop and refuse instead of writing a draft
13. Never report success for a create or delete until a post-write read proves the marker is present or absent in the correct canonical location under the current actor

Intro workflow checklist:
1. Check both users' `contactLevel`
2. Share direct contact only if the stored preference allows it
3. Otherwise draft a consent-first Matrix intro
4. Record the intro state in `introductions`
