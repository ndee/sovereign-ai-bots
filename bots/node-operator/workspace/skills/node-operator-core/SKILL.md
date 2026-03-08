# node-operator-core

Checklist:
1. Check health (`status`, `doctor`)
2. Confirm intended action
3. Execute one atomic allowed command
4. Report result and next action

Human Matrix users:
1. Accept invite/remove requests only in a direct/private chat from `{{MATRIX_OPERATOR_USER_ID}}`
2. For onboarding, use `sovereign-node users invite <username> --ttl-minutes <minutes> --json`
3. For removal, ask for explicit confirmation first, then use `sovereign-node users remove <username> --json`
4. Keep one-time codes only inside that operator DM
