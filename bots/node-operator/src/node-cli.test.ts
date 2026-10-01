import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NODE_CLI_CANDIDATES,
  type NodeCliInvocation,
  resolveNodeCli,
  runNodeCli,
} from "./node-cli.js";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot !== undefined) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("resolveNodeCli", () => {
  it("probes the fixed candidates in order and reports the first hit", async () => {
    const seen: string[] = [];
    const result = await resolveNodeCli({}, async (path) => {
      seen.push(path);
      return path === NODE_CLI_CANDIDATES[1];
    });
    expect(seen).toEqual([...NODE_CLI_CANDIDATES]);
    // A .js candidate runs under the current node binary.
    expect(result?.command).toBe(process.execPath);
    expect(result?.args).toEqual([NODE_CLI_CANDIDATES[1]]);
  });

  it("returns a direct invocation for a non-js candidate", async () => {
    const result = await resolveNodeCli({}, async (path) => path === NODE_CLI_CANDIDATES[0]);
    expect(result).toEqual({ command: NODE_CLI_CANDIDATES[0], args: [] });
  });

  it("returns undefined when nothing exists", async () => {
    expect(await resolveNodeCli({}, async () => false)).toBeUndefined();
  });

  it("prefers an absolute SOVEREIGN_NODE_CLI override and ignores a relative one", async () => {
    const absolute = await resolveNodeCli(
      { SOVEREIGN_NODE_CLI: "/custom/sovereign-node" },
      async (path) => path === "/custom/sovereign-node",
    );
    expect(absolute).toEqual({ command: "/custom/sovereign-node", args: [] });

    const relative = await resolveNodeCli(
      { SOVEREIGN_NODE_CLI: "relative/path" },
      async () => false,
    );
    expect(relative).toBeUndefined();
  });

  it("uses the real filesystem probe by default without throwing", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "node-operator-cli-test-"));
    const present = join(tempRoot, "sovereign-node");
    await writeFile(present, "#!/bin/sh\n", { mode: 0o755 });
    const result = await resolveNodeCli({ SOVEREIGN_NODE_CLI: present });
    expect(result).toEqual({ command: present, args: [] });
  });

  it("treats an unreadable override as absent with the default probe", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "node-operator-cli-test-"));
    const missing = join(tempRoot, "does-not-exist");
    // The fixed candidates are absent on dev and CI hosts, so the probe
    // falls all the way through.
    const result = await resolveNodeCli({ SOVEREIGN_NODE_CLI: missing });
    expect(result).toBeUndefined();
  });
});

describe("runNodeCli", () => {
  const nodeEval = (script: string): NodeCliInvocation => ({
    command: process.execPath,
    args: ["-e", script],
  });

  it("captures stdout from a successful invocation", async () => {
    const result = await runNodeCli([], async () => nodeEval("console.log('{\"ok\":true}')"));
    expect(result).toEqual({ ok: true, stdout: '{"ok":true}\n' });
  });

  it("passes the fixed argv through to the executable", async () => {
    const result = await runNodeCli(["diagnostics", "--json"], async () =>
      nodeEval("console.log(JSON.stringify(process.argv.slice(1)))"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.stdout)).toEqual(["diagnostics", "--json"]);
    }
  });

  it("reports exec-failed on a non-zero exit without leaking output", async () => {
    const result = await runNodeCli([], async () =>
      nodeEval("console.error('secret stderr'); process.exit(3)"),
    );
    expect(result).toEqual({ ok: false, reason: "exec-failed" });
  });

  it("reports cli-not-found when no CLI can be resolved", async () => {
    const result = await runNodeCli([], async () => undefined);
    expect(result).toEqual({ ok: false, reason: "cli-not-found" });
  });
});
