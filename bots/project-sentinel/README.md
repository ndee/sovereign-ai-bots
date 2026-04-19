# Project Sentinel

Project Sentinel is a project intelligence bot for Sovereign AI Node.

It watches a small set of curated upstream and community sources, scores each item against project-specific lanes, and routes only relevant signals into Matrix.

## What It Is

- a digest-first watcher for dependencies and ecosystem changes that matter to Sovereign AI Node
- a Matrix-native operating surface for alerts, digest review, and routing feedback
- a local-policy system that adjusts future routing without implying local model training

## What It Is Not

- not a broad AI news bot
- not a dashboard product
- not a generic assistant persona
- not a crawler or discovery engine

## Supported Source Types In v1

- RSS / Atom feeds
- GitHub releases
- GitHub issues
- GitHub discussions when `GITHUB_TOKEN` or the configured `githubTokenEnv` variable is available
- curated static source definitions in `config/sources.json`

## Default Lanes

- `matrix`
- `openclaw`
- `mail_stack`
- `ops_security`
- `local_first_ai`

## Default Profile

The seeded workspace config includes one enabled profile:

- `sovereign-ai-node`

It ships with a small curated source set for Matrix, OpenClaw, Proton Bridge, and Ubuntu security notices. GitHub discussions support is present but the default discussion source is disabled until a GitHub token is available.

## Routing Model

Each normalized signal is scored from:

- source trust tier
- configured lane priorities
- tracked repositories and organizations
- profile keywords
- release, security, breaking-change, and operations heuristics
- local source and lane weights from operator feedback

Routing output:

- `RED` = immediate Matrix alert
- `AMBER` = queued for digest
- `GRAY` = silent

Recent red alerts from the same source are suppressed into amber when the new score is only marginally red, which keeps official feeds from repeating themselves too aggressively.

## Configuration

Seeded files in the bot workspace:

- `config/sources.json` - operator-owned source and project profile config
- `config/user-policy.json` - local routing adjustments and overrides
- `data/project-sentinel-state.json` - dedupe, delivery, digest queue, and feedback state

`config/sources.json` is the human-editable control file for:

- watched projects
- lane priorities
- keywords
- repository and organization hints
- source allow/block lists
- alert thresholds and digest cadence
- enabled and disabled sources

## Feedback

Operator feedback updates local policy only.

Supported actions:

- `more-like-this`
- `less-like-this`
- `always-alert`
- `digest-only`
- `not-relevant`

These actions update local source weights, lane weights, source routing bounds, and muted fingerprints. No local model training is implied or performed.

## Matrix Fit

Project Sentinel is intended to sit beside other Sovereign AI Node bots as a calm dependency and ecosystem watcher.

It uses Matrix for:

- immediate red alerts
- amber digests
- source control commands
- operator feedback

## Intentionally Out Of Scope For v1

- generic web crawling
- social media ingestion
- search-engine discovery
- dashboards
- a general conversational assistant layer
