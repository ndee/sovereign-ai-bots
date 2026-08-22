import { describe, expect, it } from "vitest";
import {
  MAX_LLM_SNIPPET_LENGTH,
  maskIbans,
  maskPhoneNumbers,
  maskUrls,
  sanitizeSnippet,
  stripQuotedReplies,
  stripSignature,
} from "./sanitize-snippet.js";

describe("scoring/sanitize-snippet", () => {
  describe("stripQuotedReplies", () => {
    it("drops lines that start with >", () => {
      expect(stripQuotedReplies("new text\n> old line\n  > nested\nmore")).toBe("new text\nmore");
    });

    it("cuts everything from an 'On ... wrote:' header onward", () => {
      expect(
        stripQuotedReplies(
          "Reply here.\nOn Mon, Apr 8, 2026 Alice <a@x> wrote:\n> quoted\nmore quoted",
        ),
      ).toBe("Reply here.");
    });

    it("cuts a wrapped 'On <date>\\n<person> wrote:' header", () => {
      expect(
        stripQuotedReplies(
          "Reply.\nOn Mon, 8 Apr 2026 at 10:00,\nAlice Example\n<alice@example.com> wrote:\nquoted",
        ),
      ).toBe("Reply.");
    });

    it("keeps a line starting with 'On' that is not an attribution", () => {
      expect(stripQuotedReplies("On balance we should proceed.\nSecond line.\nThird line.")).toBe(
        "On balance we should proceed.\nSecond line.\nThird line.",
      );
    });

    it("keeps an 'On' line near the end of the text without a wrote: line", () => {
      expect(stripQuotedReplies("Fine.\nOn the other hand")).toBe("Fine.\nOn the other hand");
    });

    it("cuts at the German 'Am ... schrieb' header", () => {
      expect(stripQuotedReplies("Antwort.\nAm 08.04.2026 um 10:00 schrieb Alice:\nalt")).toBe(
        "Antwort.",
      );
    });

    it("cuts at an Outlook original-message separator", () => {
      expect(stripQuotedReplies("Reply.\n-----Original Message-----\nFrom: x")).toBe("Reply.");
      expect(stripQuotedReplies("Reply.\n-----Ursprüngliche Nachricht-----\nVon: x")).toBe(
        "Reply.",
      );
    });

    it("cuts at a bare Von:/From: header line", () => {
      expect(stripQuotedReplies("Reply.\nVon: Alice <a@x>\nGesendet: heute")).toBe("Reply.");
      expect(stripQuotedReplies("Reply.\nFrom: Alice <a@x>\nSent: today")).toBe("Reply.");
    });

    it("handles CRLF line endings", () => {
      expect(stripQuotedReplies("a\r\n> b\r\nc")).toBe("a\nc");
    });
  });

  describe("stripSignature", () => {
    it("drops everything from the '-- ' separator onward", () => {
      expect(stripSignature("body\n-- \nAlice\n+49 123")).toBe("body");
      expect(stripSignature("body\n--\nAlice")).toBe("body");
    });

    it("drops a trailing sign-off and what follows", () => {
      expect(stripSignature("Please approve.\nThanks,\nAlice\nCEO")).toBe("Please approve.");
      expect(stripSignature("Bitte prüfen.\nMit freundlichen Grüßen\nAlice")).toBe("Bitte prüfen.");
    });

    it("keeps a sign-off word that appears early in the text", () => {
      const text = "Thanks\nline 2\nline 3\nline 4\nline 5\nline 6";
      expect(stripSignature(text)).toBe(text);
    });

    it("trims trailing blank lines", () => {
      expect(stripSignature("body\n\n\n")).toBe("body");
    });

    it("returns an empty string for empty input", () => {
      expect(stripSignature("")).toBe("");
    });
  });

  describe("maskUrls", () => {
    it("replaces URLs with a domain placeholder", () => {
      expect(maskUrls("see https://Pay.Example.com/invoice/123?token=abc now")).toBe(
        "see <url:pay.example.com> now",
      );
      expect(maskUrls("www.example.org/x")).toBe("<url:example.org>");
    });
  });

  describe("maskPhoneNumbers", () => {
    it("masks international and national numbers", () => {
      expect(maskPhoneNumbers("call +49 (0)30 1234567 or 0171/1234567")).toBe(
        "call <phone> or <phone>",
      );
    });

    it("keeps amounts, years and short digit runs", () => {
      expect(maskPhoneNumbers("pay $500 by 2026-04-08, ref 01234")).toBe(
        "pay $500 by 2026-04-08, ref 01234",
      );
      // Looks like a phone (leading 0, separators) but too few digits.
      expect(maskPhoneNumbers("ext 030 / 12 please")).toBe("ext 030 / 12 please");
    });
  });

  describe("maskIbans", () => {
    it("masks IBAN-like identifiers with and without spaces", () => {
      expect(maskIbans("IBAN DE89 3704 0044 0532 0130 00 or GB82WEST12345698765432")).toBe(
        "IBAN <iban> or <iban>",
      );
    });

    it("leaves ordinary words alone", () => {
      expect(maskIbans("Invoice 2026 due")).toBe("Invoice 2026 due");
    });
  });

  describe("sanitizeSnippet", () => {
    it("applies every step and compacts whitespace", () => {
      const text = [
        "Hi,",
        "please pay https://pay.example.com/x?t=1 (IBAN DE89 3704 0044 0532 0130 00).",
        "Call +49 30 1234567.",
        "",
        "Best regards,",
        "Alice",
        "-- ",
        "Alice Example | CEO",
        "On Mon, Apr 8 Bob wrote:",
        "> old",
      ].join("\n");
      expect(sanitizeSnippet(text)).toBe(
        "Hi, please pay <url:pay.example.com> (IBAN <iban>). Call <phone>.",
      );
    });

    it("caps the result after stripping", () => {
      const result = sanitizeSnippet(`${"word ".repeat(200)}\n> quoted`);
      expect(result).toHaveLength(MAX_LLM_SNIPPET_LENGTH);
      expect(result).not.toContain("quoted");
    });

    it("returns an empty string for non-string input", () => {
      expect(sanitizeSnippet(undefined)).toBe("");
      expect(sanitizeSnippet(null)).toBe("");
    });
  });
});
