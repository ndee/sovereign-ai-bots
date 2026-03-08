# node-operator-core

Checklist:
1. Check health (`status`, `doctor`)
2. Confirm intended action
3. Execute one atomic allowed command
4. Report result and next action

Human Matrix users:
1. Accept invite/remove requests only in a direct/private chat from `{{MATRIX_OPERATOR_USER_ID}}`
2. If the operator wants to sign into the existing operator account on another device, use `sovereign-node onboarding issue --ttl-minutes <minutes> --json` instead of a new-user invite
3. For new local human users, ask only for the bare localpart if it is missing, default TTL to 1440 minutes, and use `sovereign-node users invite <username> --json` unless a custom TTL is explicitly requested
4. For removal, ask for explicit confirmation first, then use `sovereign-node users remove <username> --json`
5. Keep one-time codes only inside that operator DM
