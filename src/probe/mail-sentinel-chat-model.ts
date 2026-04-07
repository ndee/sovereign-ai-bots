import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

const manifestPathSegments = ["bots", "mail-sentinel", "sovereign-bot.json"] as const;
const nonEmptyStringSchema = z.string().refine((value) => value.trim() !== "", {
  message: "must not be empty",
});
const manifestSchema = z.object({
  agentTemplate: z.object({
    model: nonEmptyStringSchema,
  }),
});

interface OpenRouterChoice {
  readonly finish_reason?: string;
}

interface OpenRouterResponse {
  readonly id?: string;
  readonly choices?: readonly OpenRouterChoice[];
}

export interface ProbeSuccess {
  readonly ok: true;
  readonly skipped: false;
  readonly finish_reason?: string;
  readonly id?: string;
}

export interface ProbeSkipped {
  readonly ok: false;
  readonly skipped: true;
  readonly reason: string;
}

export interface ProbeFailure {
  readonly ok: false;
  readonly skipped: false;
  readonly status?: number;
  readonly detail: string;
}

export type ProbeResult = ProbeSuccess | ProbeSkipped | ProbeFailure;

export interface ProbeReport {
  readonly manifest: string;
  readonly model: string;
  readonly probe: ProbeResult;
}

export interface ProbeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

export async function loadMailSentinelModel(
  rootDir: string,
): Promise<{ manifestPath: string; model: string }> {
  const manifestPath = join(resolve(rootDir), ...manifestPathSegments);
  const raw = await readFile(manifestPath, "utf8");
  const parsed = manifestSchema.parse(JSON.parse(raw));
  return {
    manifestPath,
    model: parsed.agentTemplate.model,
  };
}

export async function probeOpenRouter(
  model: string,
  dependencies: ProbeDependencies = {},
): Promise<ProbeResult> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      skipped: true,
      reason: "OPENROUTER_API_KEY is not set",
    };
  }

  const payload = {
    model,
    messages: [{ role: "user", content: "Reply with ok." }],
    tools: [
      {
        type: "function",
        function: {
          name: "ping",
          description: "Return pong",
          parameters: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 32,
  };

  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ndee/sovereign-ai-bots",
        "X-Title": "Mail Sentinel chat model probe",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        status: response.status,
        detail: await response.text(),
      };
    }
    const body = (await response.json()) as OpenRouterResponse;
    const choice = body.choices?.[0];
    return {
      ok: true,
      skipped: false,
      ...(choice?.finish_reason === undefined ? {} : { finish_reason: choice.finish_reason }),
      ...(body.id === undefined ? {} : { id: body.id }),
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runMailSentinelModelProbe(
  rootDir: string,
  dependencies: ProbeDependencies = {},
): Promise<{ exitCode: number; report: ProbeReport }> {
  const { manifestPath, model } = await loadMailSentinelModel(rootDir);
  const probe = await probeOpenRouter(model, dependencies);
  return {
    exitCode: probe.ok || probe.skipped ? 0 : 1,
    report: {
      manifest: manifestPath,
      model,
      probe,
    },
  };
}
