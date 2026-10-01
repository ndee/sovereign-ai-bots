# Node Operator

This workspace hosts the **deterministic** Node Operator daemon
(`bin/node-operator.js serve`, run by `sovereign-node-operator.service`).

There is no AI agent here. Incoming Matrix messages are parsed by a closed,
bounded grammar in code; only explicitly authorized operator Matrix IDs may
execute commands, and every command maps to a fixed internal function. No
model participates in command selection or argument construction.

Commands (in the Sovereign Node control room):

- `status` — overall state, headline, and the most important issue
- `health` — the full safe component list
- `explain <code>` — plain-language meaning of a SAN error code
- `support` — how to reach Node Status in the local web interface
- `help` — this command list
- `version` — the running build identity
- `verify <nonce>` — internal: setup verification challenge echo

Authorization: the explicit operator allowlist in the node's runtime
configuration. Room membership alone grants nothing; unauthorized senders
are ignored silently. DMs are disabled by default.
