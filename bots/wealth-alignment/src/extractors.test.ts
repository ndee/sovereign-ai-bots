import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractorRuntimeBindings, FetchImpl } from "./extractors.js";
import {
  detectFileKind,
  extractText,
  extractTextWithVision,
  extractWithOpenRouter,
  extractWithPdftotext,
  extractWithTesseract,
  renderPdfPages,
  resetExecFileAsync,
  setExecFileAsync,
  setOpenRouterFetch,
} from "./extractors.js";

const baseRuntime: ExtractorRuntimeBindings = {
  pdfExtractor: "pdftotext",
  imageExtractor: "tesseract",
  pdfRenderer: "pdftoppm",
  visionEnabled: true,
  visionModel: "qwen/qwen2-vl-72b-instruct",
  visionMaxPages: 2,
  openrouterApiKey: "test-key",
  openrouterReferer: "https://example.com",
  openrouterTitle: "test",
};

interface ExecCall {
  file: string;
  args: ReadonlyArray<string>;
}

const installExecStub = (
  handler: (call: ExecCall) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>,
): ExecCall[] => {
  const calls: ExecCall[] = [];
  setExecFileAsync(async (file, args) => {
    calls.push({ file, args });
    return handler({ file, args });
  });
  return calls;
};

describe("wealth-alignment/extractors", () => {
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wealth-extract-"));
  });

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    resetExecFileAsync();
    setOpenRouterFetch(undefined);
  });

  it("detects file kinds by extension and magic bytes", () => {
    expect(detectFileKind("a.txt", Buffer.from("hello"))).toBe("text");
    expect(detectFileKind("a.csv", Buffer.from(""))).toBe("text");
    expect(detectFileKind("a.unknown", Buffer.from("plain text"))).toBe("text");
    expect(detectFileKind("a.pdf", Buffer.from(""))).toBe("pdf");
    expect(detectFileKind("a.unknown", Buffer.from("%PDF-1.4"))).toBe("pdf");
    expect(detectFileKind("a.png", Buffer.from(""))).toBe("image");
    expect(detectFileKind("a.bin", Buffer.from([0, 1, 2, 3]))).toBe("binary");
    expect(detectFileKind("a.empty", Buffer.alloc(0))).toBe("text");
  });

  it("extracts text from a plain-text file", async () => {
    const filePath = join(tempDir as string, "note.txt");
    await writeFile(filePath, "hello world", "utf8");
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("raw_text");
    expect(result.text).toBe("hello world");
  });

  it("extracts text from a PDF via pdftotext", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\nbinary data");
    const calls = installExecStub(async () => ({
      stdout: "2026-04-01 Salary +3000.00",
      stderr: "",
    }));
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("pdftotext");
    expect(result.text).toContain("Salary");
    expect(calls[0]?.file).toBe("pdftotext");
  });

  it("falls back to needs-review when pdftotext is missing", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => {
      const error = Object.assign(new Error("not found"), { code: "ENOENT" });
      throw error;
    });
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
    expect(result.warnings.join(" ")).toContain("pdftotext");
  });

  it("falls back when pdftotext returns empty text", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => ({ stdout: "   ", stderr: "" }));
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
  });

  it("captures pdftotext failures with stderr", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => {
      throw Object.assign(new Error("boom"), { stderr: "syntax error", code: 1 });
    });
    const result = await extractWithPdftotext(filePath, baseRuntime);
    expect(result.text).toBe("");
    expect(result.warnings.join(" ")).toContain("syntax error");
    expect(result.missing).toBe(false);
  });

  it("captures pdftotext failures without stderr", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => {
      throw Object.assign(new Error("boom"), { code: 2 });
    });
    const result = await extractWithPdftotext(filePath, baseRuntime);
    expect(result.warnings[0]).toContain("pdftotext failed");
  });

  it("captures pdftotext failures from non-Error throws", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => {
      throw "string failure";
    });
    const result = await extractWithPdftotext(filePath, baseRuntime);
    expect(result.warnings[0]).toContain("string failure");
  });

  it("captures bare Error throws without stderr or errno", async () => {
    const filePath = join(tempDir as string, "bank.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async () => {
      throw new Error("plain boom");
    });
    const result = await extractWithPdftotext(filePath, baseRuntime);
    expect(result.warnings[0]).toContain("plain boom");
  });

  it("extracts text from images via tesseract", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    installExecStub(async () => ({ stdout: "Salary 3000.00", stderr: "" }));
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("tesseract");
    expect(result.text).toContain("Salary");
  });

  it("falls back when tesseract is missing", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    installExecStub(async () => {
      throw Object.assign(new Error("no tess"), { code: "ENOENT" });
    });
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
    expect(result.warnings.join(" ")).toContain("tesseract");
  });

  it("captures tesseract failures with stderr and bare errors", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    installExecStub(async () => {
      throw Object.assign(new Error("ocr boom"), { stderr: "engine boom", code: 1 });
    });
    const stderrResult = await extractWithTesseract(filePath, baseRuntime);
    expect(stderrResult.warnings.join(" ")).toContain("engine boom");

    installExecStub(async () => {
      throw Object.assign(new Error("ocr fail"), { code: 2 });
    });
    const errnoResult = await extractWithTesseract(filePath, baseRuntime);
    expect(errnoResult.warnings.join(" ")).toContain("tesseract failed");
  });

  it("falls back when tesseract returns empty text", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    installExecStub(async () => ({ stdout: "", stderr: "" }));
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
  });

  it("returns fallback for binary files of unknown type", async () => {
    const filePath = join(tempDir as string, "blob.dat");
    await writeFile(filePath, Buffer.from([0, 0, 0, 0, 1, 2, 3]));
    const result = await extractText(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
  });

  it("renders PDF pages via pdftoppm", async () => {
    const filePath = join(tempDir as string, "doc.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async (call) => {
      // Drop two PNG files in the temp output directory
      const outputPrefix = call.args[call.args.length - 1] as string;
      const pageDir = outputPrefix.replace(/\/page$/, "");
      await writeFile(join(pageDir, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await writeFile(join(pageDir, "page-2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: "", stderr: "" };
    });
    const buffers = await renderPdfPages(filePath, baseRuntime);
    expect(buffers).toHaveLength(2);
  });

  it("calls OpenRouter with ZDR + deny data_collection", async () => {
    const calls: Array<{ url: string; init: { body?: string; headers?: Record<string, string> } }> =
      [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return {
        ok: true,
        status: 200,
        async text() {
          return "ok";
        },
        async json() {
          return {
            choices: [{ message: { content: "2026-04-01\tSalary\t+3000.00" } }],
          };
        },
      };
    };
    setOpenRouterFetch(fetchImpl);
    const result = await extractWithOpenRouter(
      [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
      "image/png",
      baseRuntime,
    );
    expect(result.text).toContain("Salary");
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(body.zdr).toBe(true);
    expect(body.data_collection).toBe("deny");
    expect(body.model).toBe(baseRuntime.visionModel);
    expect(calls[0]?.init.headers?.Authorization).toBe(`Bearer ${baseRuntime.openrouterApiKey}`);
  });

  it("returns warnings when the API key is missing", async () => {
    const result = await extractWithOpenRouter([Buffer.from([0])], "image/png", {
      ...baseRuntime,
      openrouterApiKey: undefined,
    });
    expect(result.text).toBe("");
    expect(result.warnings[0]).toContain("OPENROUTER_API_KEY");
  });

  it("returns warnings when no images are passed", async () => {
    const result = await extractWithOpenRouter([], "image/png", baseRuntime);
    expect(result.warnings[0]).toContain("No images");
  });

  it("returns warnings on HTTP error", async () => {
    setOpenRouterFetch(async () => ({
      ok: false,
      status: 503,
      async text() {
        return "upstream broken";
      },
      async json() {
        return {};
      },
    }));
    const result = await extractWithOpenRouter([Buffer.from([0])], "image/png", baseRuntime);
    expect(result.warnings[0]).toContain("503");
  });

  it("returns warnings when content is missing or empty", async () => {
    setOpenRouterFetch(async () => ({
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return { choices: [{ message: { content: "" } }] };
      },
    }));
    const result = await extractWithOpenRouter([Buffer.from([0])], "image/png", baseRuntime);
    expect(result.warnings[0]).toContain("did not include text");
  });

  it("extractTextWithVision skips when disabled", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    const result = await extractTextWithVision(filePath, {
      ...baseRuntime,
      visionEnabled: false,
    });
    expect(result.method).toBe("fallback");
    expect(result.warnings[0]).toContain("disabled");
  });

  it("extractTextWithVision routes PDFs through pdftoppm before calling OpenRouter", async () => {
    const filePath = join(tempDir as string, "doc.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    installExecStub(async (call) => {
      const outputPrefix = call.args[call.args.length - 1] as string;
      const pageDir = outputPrefix.replace(/\/page$/, "");
      await writeFile(join(pageDir, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: "", stderr: "" };
    });
    setOpenRouterFetch(async () => ({
      ok: true,
      status: 200,
      async text() {
        return "ok";
      },
      async json() {
        return { choices: [{ message: { content: "2026-04-01\tSalary\t+1000" } }] };
      },
    }));
    const result = await extractTextWithVision(filePath, baseRuntime);
    expect(result.method).toBe("vision");
    expect(result.text).toContain("Salary");
  });

  it("extractTextWithVision uses single image for image inputs", async () => {
    const filePath = join(tempDir as string, "scan.jpg");
    await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff]));
    setOpenRouterFetch(async () => ({
      ok: true,
      status: 200,
      async text() {
        return "ok";
      },
      async json() {
        return { choices: [{ message: { content: "2026-04-01\tSalary\t+1000" } }] };
      },
    }));
    const result = await extractTextWithVision(filePath, baseRuntime);
    expect(result.method).toBe("vision");
  });

  it("extractTextWithVision rejects unsupported file kinds", async () => {
    const filePath = join(tempDir as string, "blob.dat");
    await writeFile(filePath, Buffer.from([0, 0, 0]));
    const result = await extractTextWithVision(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
    expect(result.warnings.join(" ")).toContain("only supported");
  });

  it("extractTextWithVision surfaces empty vision responses", async () => {
    const filePath = join(tempDir as string, "scan.png");
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    setOpenRouterFetch(async () => ({
      ok: true,
      status: 200,
      async text() {
        return "";
      },
      async json() {
        return { choices: [{ message: { content: "" } }] };
      },
    }));
    const result = await extractTextWithVision(filePath, baseRuntime);
    expect(result.method).toBe("fallback");
  });

  it("falls back to globalThis.fetch when no impl is set", async () => {
    const original = (globalThis as { fetch?: unknown }).fetch;
    let called = false;
    (globalThis as { fetch?: unknown }).fetch = (async () => {
      called = true;
      return {
        ok: true,
        status: 200,
        text: async () => "ok",
        json: async () => ({ choices: [{ message: { content: "stub" } }] }),
      };
    }) as unknown as typeof fetch;
    setOpenRouterFetch(undefined);
    try {
      const result = await extractWithOpenRouter([Buffer.from([0])], "image/png", baseRuntime);
      expect(called).toBe(true);
      expect(result.text).toBe("stub");
    } finally {
      (globalThis as { fetch?: unknown }).fetch = original;
    }
  });

  it("renderPdfPages cleans up its temp directory", async () => {
    const filePath = join(tempDir as string, "doc.pdf");
    await writeFile(filePath, "%PDF-1.4\n");
    let leakedDir: string | undefined;
    installExecStub(async (call) => {
      const outputPrefix = call.args[call.args.length - 1] as string;
      leakedDir = outputPrefix.replace(/\/page$/, "");
      await writeFile(join(leakedDir, "page-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: "", stderr: "" };
    });
    await renderPdfPages(filePath, baseRuntime);
    expect(leakedDir).toBeDefined();
    await expect(readdir(leakedDir as string)).rejects.toThrow();
  });
});
