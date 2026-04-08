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

Catalog validation, probe tooling, and bot runtimes use TypeScript. The
`mail-sentinel` bot source lives under `bots/mail-sentinel/src/` and tsup
bundles it into a single file at `bots/mail-sentinel/workspace/bin/dist/
mail-sentinel.js` (gitignored). The manifest (`sovereign-bot.json`) and
systemd unit both reference the compiled `mail-sentinel.js`. `pnpm build`
must run before any `pnpm catalog:*` command because the validator
checks that `hostResources[].spec.source` exists on disk.

Common commands:

- `pnpm lint` -- Biome checks for `src/` and `bots/*/src/`
- `pnpm typecheck` -- TypeScript type-checking
- `pnpm build` -- build the root CLI entrypoints into `dist/` **and** every bot's
  compiled bundle into `bots/*/workspace/bin/dist/`
- `pnpm test:coverage:unit` -- Vitest with 100% coverage on catalog tooling
  and every bot's TypeScript source tree
- `pnpm catalog:lint` -- validate all `bots/**/*.json` files and canonical
  JSON formatting (run `pnpm build` first)
- `pnpm catalog:typecheck` -- schema-check all bot manifests
- `pnpm catalog:test` -- run catalog invariants
- `pnpm catalog:smoke` -- copy source-backed host resources into a temp
  directory
- `pnpm probe:mail-sentinel-model` -- manually probe the configured Mail
  Sentinel chat model via OpenRouter

### Running a bot CLI during development

To run `mail-sentinel` without a full build, use `tsx` against the
source entry point:

```bash
tsx bots/mail-sentinel/src/cli.ts <command> --instance <id> --json
```

For a production-style run, `pnpm build` first then invoke
`node bots/mail-sentinel/workspace/bin/dist/mail-sentinel.js ...`.

## Current package roles

### `mail-sentinel`
The first concrete module for Sovereign AI Node.

It:

- monitors IMAP-based mail
- classifies important signals
- pushes relevant alerts into Matrix
- adapts local scoring behavior from feedback

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
