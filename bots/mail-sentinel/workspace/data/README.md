# Mail Sentinel data

Mail Sentinel stores local state here at runtime.

This directory is the default packaged location for instance state. Active installs can
override the exact state path per Mail Sentinel instance through the installed tool config.

- Seen messages
- Mailbox checkpoints (`lastSeenUid` plus the last observed IMAP `UIDVALIDITY`)
- Sent alerts
- User feedback
- Learned score adjustments
- Reminder scheduling

If the IMAP server reports a different `UIDVALIDITY`, Mail Sentinel clears the saved `lastSeenUid` checkpoint and re-scans from the mailbox view the server now considers authoritative.
