# Mail Sentinel workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `config/default-rules.json` contains the packaged default local relevance rules and is refreshed from the bot package on install/update.
- `config/user-policy.json` is the operator-managed override layer and is only created when missing.
- runtime config is resolved per Mail Sentinel instance via `mail-sentinel.js --instance <id>`.
- instance-scoped paths such as state, rules, policy, alert room, and timers are provided from the installed tool configuration.
- `data/` is the default local state location when an instance keeps the packaged workspace layout.
- mailbox cursor state tracks both `lastSeenUid` and the server's IMAP `UIDVALIDITY` value; if the mailbox UID epoch changes, the next scan clears the cursor and rebuilds it by re-scanning the mailbox.
- visible Matrix alerts use a compact operator format: the zone/category share one line, the subject is the headline, and sender display is normalized for readability.
- visible AMBER digests no longer number items or show alert IDs; when an operator replies to a digest item, Mail Sentinel resolves the target by subject or sender.
