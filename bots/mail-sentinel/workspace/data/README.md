# Mail Sentinel data

Mail Sentinel stores local state here at runtime.

This directory is the default packaged location for instance state. Active installs can
override the exact state path per Mail Sentinel instance through the installed tool config.

- Seen messages
- Sent alerts
- User feedback
- Learned score adjustments
- Reminder scheduling

`mail-sentinel-ledger.json` beside the state file is the content-free outcome
ledger: one outcome state per message identifier, with no subject, sender or
body. `reconcile` and `integrity` read it.
