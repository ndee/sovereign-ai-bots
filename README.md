# sovereign-ai-bots

Installable bot packages for Sovereign AI Node.

This repository contains the packaged bot modules consumed by `sovereign-ai-node`. It is not the runtime itself. It is the bot package layer.

## Purpose

`sovereign-ai-bots` exists to keep bot packages:

- modular
- inspectable
- versioned
- installable
- separate from the core runtime

Sovereign AI Node provides the runtime, Matrix control plane, and policy boundaries.  
This repository provides the installable bot packages that run inside that environment.

## Relationship to Sovereign AI Node

### `sovereign-ai-node`
Provides:

- the runtime kernel
- Matrix integration
- agent and tool contracts
- installer and operator flows
- local-first execution

### `sovereign-ai-bots`
Provides:

- packaged bot definitions
- bot workspace files
- bot manifests
- installable module versions

In short:

**Node runs bots.  
This repo defines packaged bots.**

## Package structure

Each bot package lives under:

`bots/<id>/`

A package currently contains:

- `sovereign-bot.json` — package manifest
- `workspace/` — files copied into the managed bot workspace

## Current packages

- `mail-sentinel`
- `node-operator`
- `bitcoin-skill-match`

## Tooling

The catalog validation and probe tooling now use TypeScript.

Common commands:

- `pnpm lint` -- Biome checks for `src/`
- `pnpm typecheck` -- TypeScript type-checking
- `pnpm test:coverage:unit` -- Vitest with 100% coverage on the catalog validator and Mail Sentinel model probe
- `pnpm build` -- build the CLI entrypoints into `dist/`
- `pnpm catalog:lint` -- validate all `bots/**/*.json` files and canonical JSON formatting
- `pnpm catalog:typecheck` -- schema-check all bot manifests
- `pnpm catalog:test` -- run catalog invariants
- `pnpm catalog:smoke` -- copy source-backed host resources into a temp directory
- `pnpm probe:mail-sentinel-model` -- manually probe the Mail Sentinel model declared in `bots/mail-sentinel/sovereign-bot.json` via OpenRouter

## Current package roles

### `mail-sentinel`
The first concrete module for Sovereign AI Node.

It:

- monitors IMAP-based mail
- classifies important signals
- pushes relevant alerts into Matrix
- adapts local scoring behavior from feedback
- supports installer-managed per-instance config, state, and scheduling

### `node-operator`
The operational bot for interacting with the local node.

It:

- inspects node state
- assists with operator-facing tasks
- exposes controlled operational functionality

## Trust model

Bot packages should remain compatible with the Sovereign AI Node trust model:

- local-first by default
- no mandatory telemetry
- cloud or hybrid behavior only when explicitly enabled
- tool access mediated by node policy boundaries
- inspectable package contents before installation

## Long-term direction

Over time, this repo should grow into a catalog of specialized modules for Sovereign AI Node, including:

- mail
- documents
- calendars
- operations
- security
- finance

## Related repo

- `sovereign-ai-node` — open-core runtime a
