# Mail Sentinel data

Mail Sentinel stores local state here at runtime.

This directory is the default packaged location for instance state. Active installs can
override the exact state path per Mail Sentinel instance through the installed tool config.

- Seen messages
- Mailbox cursor state (`lastSeenUid` plus IMAP `UIDVALIDITY`)
- Sent alerts
- User feedback
- Learned score adjustments
- Reminder scheduling

If the IMAP server reports a different `UIDVALIDITY` value on a later scan, Mail Sentinel resets the stored UID cursor once and re-scans the mailbox so future polling continues from the new epoch.
