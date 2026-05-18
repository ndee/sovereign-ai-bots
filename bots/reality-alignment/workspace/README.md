# Reality Alignment workspace

Provisioned by sovereign-node install flow.
Managed by Sovereign Node installer.

- `data/reality-alignment-state.json` stores wishes, alignment check-ins, resistance patterns, and aligned action steps.
- `IDENTITY.md` defines the bot's operating role, boundaries, and response style.
- `SOUL.md` carries the calmer long-form persona framing used at runtime.
- `AGENTS.md` defines the helper command surface and daily/weekly operating rules.
- `REFERENCE.md` contains the verbatim Dodson technique cards used by `level next`, `act as`, `future self`, `appreciation`, and `look 20s`.
- runtime config is resolved per Reality Alignment instance via `reality-alignment.js --instance <id>`.

Current operator model:

- active wishes can record the desired level each wish lives at
- daily check-ins record the operator's current level for that day
- next actions are meant to match the desired state, not just add effort from the current one

This bot is experimental and intended for personal self-coaching use. It is not therapy and not a manifestation engine.
