import { readFile } from "node:fs/promises";

import {
  DEFAULT_IMAGE_EXTRACTOR,
  DEFAULT_PDF_EXTRACTOR,
  DEFAULT_PDF_RENDERER,
  DEFAULT_VISION_MAX_PAGES,
  DEFAULT_VISION_MODEL,
  OPENROUTER_REFERER,
  OPENROUTER_TITLE,
} from "./constants.js";
import type { ExtractorRuntimeBindings } from "./extractors.js";
import { loadState, saveState } from "./state.js";
import type { WealthState } from "./types.js";
import { resolveRelativeToBase, stripSingleTrailingNewline } from "./util.js";

export interface WealthRuntime {
  instanceId: string;
  agentId: string;
  workspaceDir: string;
  statePath: string;
  inboxPath: string;
  extractor: ExtractorRuntimeBindings;
  readState: () => Promise<WealthState>;
  writeState: (state: WealthState) => Promise<void>;
}

interface RuntimeConfigDocument {
  sovereignTools?: {
    instances?: Array<{
      id: string;
      config?: Record<string, unknown>;
      secretRefs?: Record<string, unknown>;
    }>;
  };
  openclawProfile?: {
    agents?: Array<{
      id: string;
      workspace: string;
    }>;
  };
}

const parseRuntimeConfigDocument = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    /* v8 ignore next 1 -- legacy JS-config fallback */
    return new Function(`"use strict"; return (${raw});`)();
  }
};

const DEFAULT_CONFIG_PATH = "/etc/sovereign-ai-node/node-config.json";
const DEFAULT_STATE_PATH = "data/wealth-alignment-state.json";
const DEFAULT_INBOX_PATH = "inbox";

const stringFromConfig = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberFromConfig = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
};

const booleanFromConfig = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
};

const resolveSecretRef = async (ref: unknown): Promise<string | undefined> => {
  if (typeof ref !== "string" || ref.length === 0) {
    return undefined;
  }
  if (ref.startsWith("env:")) {
    const value = process.env[ref.slice(4)];
    return value !== undefined && value.length > 0 ? value : undefined;
  }
  /* v8 ignore start -- file-based secret refs are exercised on real hosts */
  if (ref.startsWith("file:")) {
    try {
      const value = stripSingleTrailingNewline(await readFile(ref.slice(5), "utf8"));
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  /* v8 ignore stop */
  return ref;
};

export interface RuntimeOverrides {
  workspaceDir?: string;
  statePath?: string;
  inboxPath?: string;
  agentId?: string;
  extractor?: Partial<ExtractorRuntimeBindings>;
}

const defaultExtractor = (
  overrides: Partial<ExtractorRuntimeBindings> = {},
): ExtractorRuntimeBindings => ({
  pdfExtractor: overrides.pdfExtractor ?? DEFAULT_PDF_EXTRACTOR,
  imageExtractor: overrides.imageExtractor ?? DEFAULT_IMAGE_EXTRACTOR,
  pdfRenderer: overrides.pdfRenderer ?? DEFAULT_PDF_RENDERER,
  visionEnabled: overrides.visionEnabled ?? false,
  visionModel: overrides.visionModel ?? DEFAULT_VISION_MODEL,
  visionMaxPages: overrides.visionMaxPages ?? DEFAULT_VISION_MAX_PAGES,
  openrouterApiKey: overrides.openrouterApiKey,
  openrouterReferer: overrides.openrouterReferer ?? OPENROUTER_REFERER,
  openrouterTitle: overrides.openrouterTitle ?? OPENROUTER_TITLE,
});

export const createRuntime = (instanceId: string, overrides: RuntimeOverrides): WealthRuntime => {
  const workspaceDir = overrides.workspaceDir ?? process.cwd();
  const statePath = resolveRelativeToBase(overrides.statePath ?? DEFAULT_STATE_PATH, workspaceDir);
  const inboxPath = resolveRelativeToBase(overrides.inboxPath ?? DEFAULT_INBOX_PATH, workspaceDir);
  return {
    instanceId,
    agentId: overrides.agentId ?? instanceId,
    workspaceDir,
    statePath,
    inboxPath,
    extractor: defaultExtractor(overrides.extractor),
    readState: () => loadState(statePath),
    writeState: (state) => saveState(statePath, state),
  };
};

export const resolveRuntime = async (
  instanceId: string,
  configPath?: string,
): Promise<WealthRuntime> => {
  const overrides: RuntimeOverrides = {};
  /* v8 ignore next -- DEFAULT_CONFIG_PATH fallback is exercised on real Sovereign Node hosts only */
  const path = configPath ?? process.env.SOVEREIGN_NODE_CONFIG ?? DEFAULT_CONFIG_PATH;
  try {
    const raw = stripSingleTrailingNewline(await readFile(path, "utf8"));
    const document = parseRuntimeConfigDocument(raw) as RuntimeConfigDocument;
    const instance = document.sovereignTools?.instances?.find((entry) => entry.id === instanceId);
    const config = instance?.config ?? {};
    const secretRefs = instance?.secretRefs ?? {};
    const workspace = stringFromConfig(
      document.openclawProfile?.agents?.find((agent) => agent.id === instanceId)?.workspace,
    );
    if (workspace !== undefined) {
      overrides.workspaceDir = workspace;
    }
    const statePath = stringFromConfig(config.statePath);
    if (statePath !== undefined) {
      overrides.statePath = statePath;
    }
    const inboxPath = stringFromConfig(config.inboxPath);
    if (inboxPath !== undefined) {
      overrides.inboxPath = inboxPath;
    }
    const agentId = stringFromConfig(config.agentId);
    if (agentId !== undefined) {
      overrides.agentId = agentId;
    }
    const extractor: Partial<ExtractorRuntimeBindings> = {};
    const pdfExtractor = stringFromConfig(config.pdfExtractor);
    if (pdfExtractor !== undefined) {
      extractor.pdfExtractor = pdfExtractor;
    }
    const imageExtractor = stringFromConfig(config.imageExtractor);
    if (imageExtractor !== undefined) {
      extractor.imageExtractor = imageExtractor;
    }
    const pdfRenderer = stringFromConfig(config.pdfRenderer);
    if (pdfRenderer !== undefined) {
      extractor.pdfRenderer = pdfRenderer;
    }
    const visionModel = stringFromConfig(config.visionModel);
    if (visionModel !== undefined) {
      extractor.visionModel = visionModel;
    }
    extractor.visionEnabled = booleanFromConfig(config.visionEnabled, false);
    extractor.visionMaxPages = numberFromConfig(config.visionMaxPages, DEFAULT_VISION_MAX_PAGES);
    const apiKey = await resolveSecretRef(secretRefs.openrouterApiKey);
    if (apiKey !== undefined) {
      extractor.openrouterApiKey = apiKey;
    }
    overrides.extractor = extractor;
  } catch (error) {
    /* v8 ignore start -- runtime config is optional */
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    /* v8 ignore stop */
  }
  return createRuntime(instanceId, overrides);
};
