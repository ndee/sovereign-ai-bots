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
