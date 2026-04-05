import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadMailSentinelModel,
  probeOpenRouter,
  runMailSentinelModelProbe,
} from "./mail-sentinel-chat-model.js";

const tempRoots: string[] = [];

describe("mail sentinel model probe", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (path) => {
        const { rm } = await import("node:fs/promises");
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it("loads the model from the mail sentinel manifest", async () => {
    const rootDir = await createProbeRoot({ model: "qwen/test" });
    await expect(loadMailSentinelModel(rootDir)).resolves.toEqual({
      manifestPath: join(rootDir, "bots", "mail-sentinel", "sovereign-bot.json"),
      model: "qwen/test",
    });
  });

  it("skips when OPENROUTER_API_KEY is missing", async () => {
    await expect(probeOpenRouter("qwen/test", { env: {} })).resolves.toEqual({
      ok: false,
      skipped: true,
      reason: "OPENROUTER_API_KEY is not set",
    });
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(probeOpenRouter("qwen/test")).resolves.toEqual({
        ok: false,
        skipped: true,
        reason: "OPENROUTER_API_KEY is not set",
      });
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousApiKey;
      }
    }
  });

  it("returns success details when the probe call works", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer secret",
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "qwen/test",
          tool_choice: "auto",
        });
        return new Response(
          JSON.stringify({
            id: "resp-1",
            choices: [{ finish_reason: "stop" }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );

    await expect(
      probeOpenRouter("qwen/test", {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      skipped: false,
      finish_reason: "stop",
      id: "resp-1",
    });

    await expect(
      probeOpenRouter("qwen/test", {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              choices: [{}],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      }),
    ).resolves.toEqual({
      ok: true,
      skipped: false,
    });
  });

  it("returns failure details for HTTP and transport errors", async () => {
    await expect(
      probeOpenRouter("qwen/test", {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl: async () => new Response("denied", { status: 401 }),
      }),
    ).resolves.toEqual({
      ok: false,
      skipped: false,
      status: 401,
      detail: "denied",
    });

    await expect(
      probeOpenRouter("qwen/test", {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl: async () => {
          throw new Error("network down");
        },
      }),
    ).resolves.toEqual({
      ok: false,
      skipped: false,
      detail: "network down",
    });

    await expect(
      probeOpenRouter("qwen/test", {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl: async () => {
          throw "boom";
        },
      }),
    ).resolves.toEqual({
      ok: false,
      skipped: false,
      detail: "boom",
    });
  });

  it("runs the full probe flow and returns an exit code", async () => {
    const rootDir = await createProbeRoot({ model: "qwen/test" });
    const result = await runMailSentinelModelProbe(rootDir, {
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual({
      manifest: join(rootDir, "bots", "mail-sentinel", "sovereign-bot.json"),
      model: "qwen/test",
      probe: {
        ok: false,
        skipped: true,
        reason: "OPENROUTER_API_KEY is not set",
      },
    });

    await expect(
      runMailSentinelModelProbe(rootDir, {
        env: { OPENROUTER_API_KEY: "secret" },
        fetchImpl: async () => new Response("denied", { status: 401 }),
      }),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("fails when the manifest is missing or invalid", async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-probe-missing-"));
    tempRoots.push(missingRoot);
    await expect(loadMailSentinelModel(missingRoot)).rejects.toThrow();

    const invalidRoot = await mkdtemp(join(tmpdir(), "mail-sentinel-probe-invalid-"));
    tempRoots.push(invalidRoot);
    const manifestPath = join(invalidRoot, "bots", "mail-sentinel", "sovereign-bot.json");
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, '{"agentTemplate":{"model":"   "}}\n', "utf8");
    await expect(loadMailSentinelModel(invalidRoot)).rejects.toThrow();
  });
});

async function createProbeRoot(options: { model: string }): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "mail-sentinel-probe-test-"));
  tempRoots.push(rootDir);
  const manifestPath = join(rootDir, "bots", "mail-sentinel", "sovereign-bot.json");
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        agentTemplate: {
          model: options.model,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return rootDir;
}
