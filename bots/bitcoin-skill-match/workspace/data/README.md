# Community State

`data/community-state.json` is the bot's local memory for the skill-sharing network.

Top-level sections:
- `skills`: normalized skill tags used across profiles and requests
- `regions`: normalized location labels used for matching
- `members`: one entry per community member
- `requests`: open or fulfilled skill searches
- `trustEdges`: direct trust relationships between members
- `introductions`: consent and status for suggested intros

Recommended member fields:
- `memberId`
- `createdByMatrixUserId`
- `createdByDisplayName`
- `updatedByMatrixUserId`
- `updatedByDisplayName`
- `createdAt`
- `updatedAt`
- `matrixHandle`
- `displayName`
- `region`
- `offers`
- `seeks`
- `contactLevel`
- `settlementPreferences`
- `trustLinks`
- `notes`

Recommended request fields:
- `requestId`
- `requestedBy`
- `createdByMatrixUserId`
- `createdByDisplayName`
- `updatedByMatrixUserId`
- `updatedByDisplayName`
- `createdAt`
- `updatedAt`
- `skill`
- `region`
- `preferredTrustDegree`
- `status`
- `notes`

Recommended trust edge fields:
- `fromMemberId`
- `toMemberId`
- `relation`
- `strength`
- `updatedAt`

Ownership rules:
- All human users may read and query all entries
- Only the creator of a member profile or request may update or delete it
- Use `createdByMatrixUserId` as the ownership key for enforcement
- Use the exact canonical field names listed above; do not rename them to `owner*`
- Always read and write the workspace-relative file `data/community-state.json`
- If a legacy entry has no `createdByMatrixUserId`, keep it readable but do not modify or delete it automatically
