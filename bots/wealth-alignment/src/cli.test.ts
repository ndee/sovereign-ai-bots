import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMainModule, reportError, runCli } from "./cli.js";

interface Harness {
  tempDir: string;
  inboxDir: string;
  configPath: string;
  baseArgs: string[];
}

const setupHarness = async (): Promise<Harness> => {
  const tempDir = await mkdtemp(join(tmpdir(), "wealth-cli-"));
  const workspaceDir = join(tempDir, "workspace");
  const inboxDir = join(workspaceDir, "inbox");
  const dataDir = join(workspaceDir, "data");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const configPath = join(tempDir, "node-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      sovereignTools: {
        instances: [
          {
            id: "wealth-alignment-core",
            config: {
              statePath: join(dataDir, "wealth-alignment-state.json"),
              inboxPath: inboxDir,
              agentId: "wealth-alignment-core",
            },
          },
        ],
      },
      openclawProfile: {
        agents: [{ id: "wealth-alignment-core", workspace: workspaceDir }],
      },
    }),
  );
  return {
    tempDir,
    inboxDir,
    configPath,
    baseArgs: ["--instance", "wealth-alignment-core", "--config-path", configPath, "--json"],
  };
};

const collectStdout = async (run: () => Promise<void>): Promise<string> => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
};

describe("wealth-alignment/cli", () => {
  let harness: Harness | undefined;

  beforeEach(async () => {
    harness = await setupHarness();
  });

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.tempDir, { recursive: true, force: true });
      harness = undefined;
    }
    vi.restoreAllMocks();
  });

  it("prints help without an instance", async () => {
    const text = await collectStdout(() => runCli(["help"]));
    expect(text).toContain("commands");
  });

  it("prints document types without an instance", async () => {
    const text = await collectStdout(() => runCli(["document-types", "--json"]));
    expect(text).toContain("bank_statement");
  });

  it("rejects unknown commands and missing command", async () => {
    const h = harness as Harness;
    await expect(runCli(["weird", ...h.baseArgs])).rejects.toThrow(/Unknown command/);
    await expect(runCli([])).rejects.toThrow(/Expected a command/);
  });

  it("rejects commands that require --instance", async () => {
    await expect(runCli(["documents"])).rejects.toThrow(/--instance/);
  });

  it("runs the full command surface end to end", async () => {
    const h = harness as Harness;
    const inboxFile = join(h.inboxDir, "bank.txt");
    await writeFile(
      inboxFile,
      [
        "Example Bank statement",
        "Statement period 2026-04-01 to 2026-04-30",
        "IBAN DE89370400440532013000",
        "Closing balance 2500.00",
        "2026-04-02 Salary Acme Corp +3000.00",
        "2026-04-05 Rent payment landlord 1100.00",
      ].join("\n"),
    );
    await collectStdout(() =>
      runCli(["import", ...h.baseArgs, "--path", inboxFile, "--kind", "bank_statement"]),
    );
    const docsOutput = await collectStdout(() => runCli(["documents", ...h.baseArgs]));
    const docs = JSON.parse(docsOutput) as { documents: Array<{ id: string }> };
    const id = docs.documents[0]?.id as string;

    const commands: Array<readonly string[]> = [
      ["parse", "--id", id],
      ["show-document", "--id", id],
      ["accounts"],
      ["transactions"],
      ["transactions", "--month", "2026-04"],
      ["income", "--month", "2026-04"],
      ["expenses", "--month", "2026-04"],
      ["cashflow", "--month", "2026-04"],
      ["net-worth"],
      ["assets"],
      ["liabilities"],
      ["what-changed", "--month", "2026-04"],
      ["summary"],
      ["weekly-review"],
      ["monthly-digest", "--month", "2026-04"],
      ["recurring"],
      ["top-categories", "--month", "2026-04"],
      ["next-step"],
      ["missing-data"],
      ["parsing-issues"],
      ["reparse", "--id", id],
    ];
    for (const command of commands) {
      const text = await collectStdout(() => runCli([...command, ...h.baseArgs]));
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("formats human-readable output without --json", async () => {
    const h = harness as Harness;
    const text = await collectStdout(() =>
      runCli(["summary", "--instance", "wealth-alignment-core", "--config-path", h.configPath]),
    );
    expect(text).toContain("Wealth Alignment summary");
  });

  it("reports errors as JSON when --json is passed and as text otherwise", () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const originalStdout = process.stdout.write.bind(process.stdout);
    const originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      reportError(new Error("boom"), ["--json"]);
      reportError("plain", []);
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
    expect(stdoutChunks.join("")).toContain("boom");
    expect(stderrChunks.join("")).toContain("plain");
  });

  it("reports whether the file is invoked as the main module", () => {
    expect(typeof isMainModule()).toBe("boolean");
    const original = process.argv[1];
    delete (process.argv as unknown as Record<number, string | undefined>)[1];
    try {
      expect(isMainModule()).toBe(false);
    } finally {
      if (typeof original === "string") {
        process.argv[1] = original;
      }
    }
  });
});
