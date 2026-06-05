import { describe, expect, it } from "vitest";

import type { BulkConfig, ParsedMessage } from "../types.js";
import { detectBulkSignals } from "./bulk.js";

const DEFAULT_CONFIG: BulkConfig = {
  enabled: true,
  minSignals: 2,
  minLinks: 8,
  grayConfidence: 0.7,
};

type BulkInput = Pick<ParsedMessage, "headers" | "subject" | "text" | "fromAddress" | "from">;

const message = (overrides: Partial<BulkInput> = {}): BulkInput => ({
  headers: {},
  subject: "",
  text: "",
  fromAddress: "person@example.com",
  from: "Person <person@example.com>",
  ...overrides,
});

const manyLinks = (count: number): string =>
  Array.from({ length: count }, (_, index) => `https://example.com/path-${String(index)}`).join(
    " ",
  );

describe("scoring/bulk", () => {
  it("returns a neutral result when detection is disabled", () => {
    const result = detectBulkSignals(
      message({ headers: { "list-unsubscribe": "<mailto:u@x>" }, text: manyLinks(20) }),
      { ...DEFAULT_CONFIG, enabled: false },
    );
    expect(result).toEqual({ isBulk: false, confidence: 0, signals: [], ceiling: null });
  });

  it("does not suppress transactional mail riding bulk infra (single signal)", () => {
    // A receipt from noreply@ carries one list-unsubscribe header but no other
    // bulk cue → below the 2-signal threshold → not bulk, no ceiling. But the
    // automated-sender signal also fires here, so use a neutral sender.
    const result = detectBulkSignals(
      message({
        fromAddress: "billing@vendor.example",
        from: "Vendor Billing <billing@vendor.example>",
        headers: { "list-unsubscribe": "<mailto:unsub@vendor.example>" },
        subject: "Your receipt",
        text: "Thank you for your payment.",
      }),
      DEFAULT_CONFIG,
    );
    expect(result.isBulk).toBe(false);
    expect(result.ceiling).toBeNull();
    expect(result.signals).toEqual(["list-unsubscribe header"]);
    expect(result.confidence).toBeCloseTo(0.25);
  });

  it("flags a newsletter (list-unsubscribe + high link density) and caps at amber", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "weekly@digest.example",
        from: "Weekly Digest <weekly@digest.example>",
        headers: { "list-unsubscribe": "<https://digest.example/unsub>" },
        subject: "Your weekly roundup",
        text: manyLinks(10),
      }),
      DEFAULT_CONFIG,
    );
    expect(result.isBulk).toBe(true);
    expect(result.signals).toContain("list-unsubscribe header");
    expect(result.signals).toContain("high link density (10 links)");
    // 2 of 4 signals → confidence 0.5 → below grayConfidence → amber.
    expect(result.confidence).toBeCloseTo(0.5);
    expect(result.ceiling).toBe("amber");
  });

  it("tightens the cap to gray once confidence clears grayConfidence", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "newsletter@news.example",
        from: "Newsletter <newsletter@news.example>",
        headers: {
          "list-unsubscribe": "<https://news.example/unsub>",
          "list-id": "news.example",
        },
        subject: "This week's newsletter",
        text: `View in browser. Unsubscribe anytime. ${manyLinks(12)}`,
      }),
      DEFAULT_CONFIG,
    );
    expect(result.isBulk).toBe(true);
    // All five signals fire → 5/4 clamped to 1.0 → gray.
    expect(result.confidence).toBe(1);
    expect(result.ceiling).toBe("gray");
    expect(result.signals).toContain("bulk-mail infrastructure headers");
    expect(result.signals).toContain("newsletter / campaign language");
    expect(result.signals).toContain("automated bulk sender address");
  });

  it("detects bulk infra via a Precedence: bulk header", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "person@example.com",
        from: "Person <person@example.com>",
        headers: { precedence: "bulk" },
        subject: "Update",
        text: "Please update your preferences to keep receiving this.",
      }),
      DEFAULT_CONFIG,
    );
    expect(result.signals).toContain("bulk-mail infrastructure headers");
    expect(result.signals).toContain("newsletter / campaign language");
    expect(result.isBulk).toBe(true);
  });

  it("detects a plaintext newsletter via link density + markers (no headers)", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "person@example.com",
        from: "A Human <person@example.com>",
        subject: "Roundup",
        text: `${manyLinks(9)} You are receiving this because you subscribed.`,
      }),
      DEFAULT_CONFIG,
    );
    expect(result.isBulk).toBe(true);
    expect(result.signals).toEqual([
      "high link density (9 links)",
      "newsletter / campaign language",
    ]);
    expect(result.ceiling).toBe("amber");
  });

  it("recognizes German campaign language", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "marketing@shop.example",
        from: "Shop <marketing@shop.example>",
        subject: "Unser Newsletter",
        text: "Im Browser ansehen. Hier koennen Sie sich abmelden.",
      }),
      DEFAULT_CONFIG,
    );
    expect(result.signals).toContain("newsletter / campaign language");
    expect(result.signals).toContain("automated bulk sender address");
    expect(result.isBulk).toBe(true);
  });

  it("treats clean transactional mail as not bulk", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "alice@example.com",
        from: "Alice <alice@example.com>",
        subject: "Lunch tomorrow?",
        text: "Are you free for lunch? https://maps.example/place",
      }),
      DEFAULT_CONFIG,
    );
    expect(result.isBulk).toBe(false);
    expect(result.signals).toEqual([]);
    expect(result.ceiling).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("falls back to the From header when fromAddress is absent", () => {
    const result = detectBulkSignals(
      {
        headers: { "list-unsubscribe": "<mailto:u@x>" },
        subject: "Newsletter",
        text: "newsletter content",
        fromAddress: undefined,
        from: "no-reply@brand.example",
      },
      DEFAULT_CONFIG,
    );
    expect(result.signals).toContain("automated bulk sender address");
    expect(result.signals).toContain("list-unsubscribe header");
  });

  it("ignores an empty list-unsubscribe header value", () => {
    const result = detectBulkSignals(
      message({
        fromAddress: "alice@example.com",
        from: "Alice <alice@example.com>",
        headers: { "list-unsubscribe": "" },
        subject: "Hi",
        text: "short note",
      }),
      DEFAULT_CONFIG,
    );
    expect(result.signals).toEqual([]);
    expect(result.isBulk).toBe(false);
  });
});
