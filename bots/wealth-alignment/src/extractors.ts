import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

import { MAX_RAW_TEXT_BYTES } from "./constants.js";

export type ExtractionMethod = "raw_text" | "pdftotext" | "tesseract" | "vision" | "fallback";

export type FileKind = "text" | "pdf" | "image" | "binary";

export interface ExtractionResult {
  text: string;
  method: ExtractionMethod;
  warnings: string[];
}

export interface ExtractorRuntimeBindings {
  pdfExtractor: string;
  imageExtractor: string;
  pdfRenderer: string;
  visionEnabled: boolean;
  visionModel: string;
  visionMaxPages: number;
  openrouterApiKey?: string | undefined;
  openrouterReferer: string;
  openrouterTitle: string;
}

type ExecFileAsyncImpl = (
  file: string,
  args: ReadonlyArray<string>,
  options?: {
    timeout?: number;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsyncImpl: ExecFileAsyncImpl = promisify(execFile) as unknown as ExecFileAsyncImpl;
let currentExecFile: ExecFileAsyncImpl = execFileAsyncImpl;
export const setExecFileAsync = (impl: ExecFileAsyncImpl): void => {
  currentExecFile = impl;
};
export const resetExecFileAsync = (): void => {
  currentExecFile = execFileAsyncImpl;
};
const runExec = async (
  file: string,
  args: ReadonlyArray<string>,
  options?: { timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> =>
  currentExecFile(file, args, options);

export type FetchImpl = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

let currentFetch: FetchImpl | undefined;
export const setOpenRouterFetch = (impl: FetchImpl | undefined): void => {
  currentFetch = impl;
};
const resolveFetch = (): FetchImpl => {
  if (currentFetch !== undefined) {
    return currentFetch;
  }
  const native = (globalThis as { fetch?: unknown }).fetch;
  /* v8 ignore next 3 -- node 22 ships with native fetch; this guards older runtimes */
  if (typeof native !== "function") {
    throw new Error("Global fetch is not available; pass an explicit fetch impl.");
  }
  return native as FetchImpl;
};

const TEXT_EXTENSIONS = new Set([".txt", ".csv", ".tsv", ".md", ".log"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const PDF_MAGIC = Buffer.from("%PDF-", "utf8");

export const detectFileKind = (filePath: string, head: Buffer): FileKind => {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }
  if (PDF_EXTENSIONS.has(ext) || head.subarray(0, 5).equals(PDF_MAGIC)) {
    return "pdf";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (head.length === 0) {
    return "text";
  }
  for (const byte of head.subarray(0, Math.min(head.length, 512))) {
    if (byte === 0) {
      return "binary";
    }
  }
  return "text";
};

const truncate = (text: string): string =>
  text.length > MAX_RAW_TEXT_BYTES ? text.slice(0, MAX_RAW_TEXT_BYTES) : text;

const stringifyExecError = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const errno = (error as NodeJS.ErrnoException).code;
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.length > 0) {
      return stderr.trim();
    }
    if (errno !== undefined) {
      return errno;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const isMissingBinaryError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT";
};

export const extractWithPdftotext = async (
  filePath: string,
  runtime: Pick<ExtractorRuntimeBindings, "pdfExtractor">,
): Promise<{ text: string; warnings: string[]; missing: boolean }> => {
  const warnings: string[] = [];
  try {
    const result = await runExec(
      runtime.pdfExtractor,
      ["-layout", "-enc", "UTF-8", filePath, "-"],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const text = truncate(result.stdout.toString());
    return { text, warnings, missing: false };
  } catch (error) {
    if (isMissingBinaryError(error)) {
      warnings.push(
        `\`${runtime.pdfExtractor}\` not found. Install poppler-utils, or rerun with \`--use-vision\`.`,
      );
      return { text: "", warnings, missing: true };
    }
    warnings.push(`pdftotext failed: ${stringifyExecError(error)}`);
    return { text: "", warnings, missing: false };
  }
};

export const extractWithTesseract = async (
  filePath: string,
  runtime: Pick<ExtractorRuntimeBindings, "imageExtractor">,
): Promise<{ text: string; warnings: string[]; missing: boolean }> => {
  const warnings: string[] = [];
  try {
    const result = await runExec(
      runtime.imageExtractor,
      [filePath, "-", "-l", "eng", "--psm", "6"],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const text = truncate(result.stdout.toString());
    return { text, warnings, missing: false };
  } catch (error) {
    if (isMissingBinaryError(error)) {
      warnings.push(
        `\`${runtime.imageExtractor}\` not found. Install tesseract-ocr, or rerun with \`--use-vision\`.`,
      );
      return { text: "", warnings, missing: true };
    }
    warnings.push(`tesseract failed: ${stringifyExecError(error)}`);
    return { text: "", warnings, missing: false };
  }
};

export const renderPdfPages = async (
  filePath: string,
  runtime: Pick<ExtractorRuntimeBindings, "pdfRenderer" | "visionMaxPages">,
): Promise<Buffer[]> => {
  const tempDir = await mkdtemp(join(tmpdir(), "wealth-pdf-"));
  try {
    await runExec(
      runtime.pdfRenderer,
      [
        "-png",
        "-r",
        "150",
        "-f",
        "1",
        "-l",
        String(runtime.visionMaxPages),
        filePath,
        join(tempDir, "page"),
      ],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const entries = (await readdir(tempDir)).filter((name) => name.endsWith(".png")).sort();
    const buffers: Buffer[] = [];
    for (const name of entries) {
      buffers.push(await readFile(join(tempDir, name)));
    }
    return buffers;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const VISION_PROMPT = [
  "Extract every transaction or money line from this finance document.",
  "Return one entry per line in TSV format with three columns:",
  "date (YYYY-MM-DD), description, amount.",
  "Use a leading + for inflows and - for outflows.",
  "Include account/balance lines as labelled rows when relevant.",
  "Do not invent values. Do not add commentary.",
].join(" ");

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export const extractWithOpenRouter = async (
  imageBuffers: ReadonlyArray<Buffer>,
  imageMimeType: "image/png" | "image/jpeg",
  runtime: Pick<
    ExtractorRuntimeBindings,
    "openrouterApiKey" | "visionModel" | "openrouterReferer" | "openrouterTitle"
  >,
): Promise<{ text: string; warnings: string[] }> => {
  const warnings: string[] = [];
  if (runtime.openrouterApiKey === undefined || runtime.openrouterApiKey.length === 0) {
    return {
      text: "",
      warnings: [
        "OPENROUTER_API_KEY is not set; cannot run vision extraction. Set the secret and retry.",
      ],
    };
  }
  if (imageBuffers.length === 0) {
    return { text: "", warnings: ["No images were available for vision extraction."] };
  }
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: VISION_PROMPT },
    ...imageBuffers.map((buffer) => ({
      type: "image_url",
      image_url: {
        url: `data:${imageMimeType};base64,${buffer.toString("base64")}`,
      },
    })),
  ];
  const payload = {
    model: runtime.visionModel,
    messages: [{ role: "user", content }],
    temperature: 0,
    max_tokens: 2048,
    zdr: true,
    data_collection: "deny" as const,
  };
  const fetchImpl = resolveFetch();
  const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": runtime.openrouterReferer,
      "X-Title": runtime.openrouterTitle,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    return {
      text: "",
      warnings: [
        `OpenRouter vision call failed (${String(response.status)}): ${detail.slice(0, 200)}`,
      ],
    };
  }
  const body = (await response.json()) as OpenRouterChatResponse;
  const message = body.choices?.[0]?.message?.content;
  if (typeof message !== "string" || message.trim().length === 0) {
    return {
      text: "",
      warnings: ["OpenRouter vision response did not include text content."],
    };
  }
  return { text: truncate(message), warnings };
};

const readHead = async (filePath: string, bytes: number = 16): Promise<Buffer> => {
  const buffer = await readFile(filePath);
  return buffer.subarray(0, Math.min(bytes, buffer.length));
};

export const extractText = async (
  filePath: string,
  runtime: ExtractorRuntimeBindings,
): Promise<ExtractionResult> => {
  const head = await readHead(filePath);
  const kind = detectFileKind(filePath, head);
  if (kind === "text") {
    const buffer = await readFile(filePath);
    const text = truncate(buffer.toString("utf8"));
    return { text, method: "raw_text", warnings: [] };
  }
  if (kind === "pdf") {
    const result = await extractWithPdftotext(filePath, runtime);
    if (result.missing || result.text.trim().length === 0) {
      return {
        text: result.text,
        method: "fallback",
        warnings:
          result.warnings.length > 0
            ? result.warnings
            : ["pdftotext returned no text. Rerun with `--use-vision` to retry via OpenRouter."],
      };
    }
    return { text: result.text, method: "pdftotext", warnings: result.warnings };
  }
  if (kind === "image") {
    const result = await extractWithTesseract(filePath, runtime);
    if (result.missing || result.text.trim().length === 0) {
      return {
        text: result.text,
        method: "fallback",
        warnings:
          result.warnings.length > 0
            ? result.warnings
            : ["tesseract returned no text. Rerun with `--use-vision` to retry via OpenRouter."],
      };
    }
    return { text: result.text, method: "tesseract", warnings: result.warnings };
  }
  return {
    text: "",
    method: "fallback",
    warnings: [
      `Unsupported binary file type for ${filePath}. Only .txt/.csv/.pdf/.png/.jpg are extracted locally.`,
    ],
  };
};

const imageMimeFromPath = (filePath: string): "image/png" | "image/jpeg" => {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  return "image/jpeg";
};

export const extractTextWithVision = async (
  filePath: string,
  runtime: ExtractorRuntimeBindings,
): Promise<ExtractionResult> => {
  if (runtime.visionEnabled === false) {
    return {
      text: "",
      method: "fallback",
      warnings: [
        "Vision extraction is disabled in configuration. Set `visionEnabled: true` to allow OpenRouter calls.",
      ],
    };
  }
  const head = await readHead(filePath);
  const kind = detectFileKind(filePath, head);
  let images: Buffer[] = [];
  let mime: "image/png" | "image/jpeg" = "image/png";
  if (kind === "pdf") {
    images = await renderPdfPages(filePath, runtime);
    mime = "image/png";
  } else if (kind === "image") {
    images = [await readFile(filePath)];
    mime = imageMimeFromPath(filePath);
  } else {
    return {
      text: "",
      method: "fallback",
      warnings: [`Vision extraction is only supported for PDF, PNG, and JPG inputs (got ${kind}).`],
    };
  }
  const result = await extractWithOpenRouter(images, mime, runtime);
  if (result.text.length === 0) {
    return { text: "", method: "fallback", warnings: result.warnings };
  }
  return { text: result.text, method: "vision", warnings: result.warnings };
};
