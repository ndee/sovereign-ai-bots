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
- `matrixHandle`
- `displayName`
- `region`
- `offers`
- `seeks`
- `contactLevel`
- `settlementPreferences`
- `trustLinks`
- `notes`
- `updatedAt`

Recommended request fields:
- `requestId`
- `requestedBy`
- `skill`
- `region`
- `preferredTrustDegree`
- `status`
- `notes`
- `createdAt`

Recommended trust edge fields:
- `fromMemberId`
- `toMemberId`
- `relation`
- `strength`
- `updatedAt`
