# bitcoin-skill-match-core

Profile intake checklist:
1. Identify the actor from the latest inbound Matrix sender
2. Capture `offers`, `seeks`, `region`, and `contactLevel`
3. Ask for settlement preferences and trust links if relevant
4. Update `data/community-state.json` with `createdByMatrixUserId`, `createdByDisplayName`, `createdAt`, `updatedAt`, and `updatedByMatrixUserId`
5. Confirm exactly what was stored without inventing another person's name

Match query checklist:
1. Parse the requested skill, region, trust degree, and settlement hints
2. Inspect `members`, `requests`, `trustEdges`, `skills`, and `regions`
3. Rank exact skill match above adjacent skills or broad categories
4. Rank 1st degree above 2nd degree above regional fallback
5. Return matches plus a clear next-step intro suggestion
6. Allow every human user to query all stored entries; only redact contact details according to `contactLevel`

Mutation guard checklist:
1. For edits or deletes, load the existing entry first
2. If `createdByMatrixUserId` is missing, refuse the mutation and explain that the legacy entry must be recreated by its owner
3. If the current Matrix sender does not match `createdByMatrixUserId`, refuse the mutation
4. Never delete or rewrite another user's offer or request on their behalf

Intro workflow checklist:
1. Check both users' `contactLevel`
2. Share direct contact only if the stored preference allows it
3. Otherwise draft a consent-first Matrix intro
4. Record the intro state in `introductions`
