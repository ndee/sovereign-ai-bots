import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import {
  collectAddresses,
  detectDeadlineSignal,
  normalizeHeaderMap,
  parseAddressFromList,
  parseHighestAmount,
  parseMessage,
  parseReceiverAddresses,
  parseReceiverBuckets,
} from "./parse.js";

describe("imap/parse", () => {
  it("matches the parseAddressFromList golden fixture", () => {
    expect({
      single: parseAddressFromList(["alice@example.com"]),
      empty: parseAddressFromList([]),
      notArray: parseAddressFromList(undefined),
    }).toEqual(loadGolden("parseAddressFromList"));
  });

  it("matches the normalizeHeaderMap golden fixture", () => {
    expect({
      fromArray: normalizeHeaderMap([
        { key: "From", value: "alice@example.com" },
        { name: "Subject", value: "  hi " },
        { key: "", value: "skipped" },
        { key: "X-Noise", value: 42 },
      ]),
      fromObject: normalizeHeaderMap({
        Subject: "Hello",
        "X-Multi": ["a", "b"],
        "X-NonString": 7,
      }),
      nonObject: normalizeHeaderMap("nope"),
    }).toEqual(loadGolden("normalizeHeaderMap"));
  });

  it("handles non-object header array entries gracefully", () => {
    expect(normalizeHeaderMap([null, undefined, 42, { nothing: true }])).toEqual({});
  });

  it("matches the parseHighestAmount golden fixture", () => {
    expect({
      eur: parseHighestAmount("Total: EUR 1.234,56"),
      usd: parseHighestAmount("$999.99 due"),
      multiple: parseHighestAmount("$100 and €200 and $1,500.75"),
      none: parseHighestAmount("no amounts here"),
    }).toEqual(loadGolden("parseHighestAmount"));
  });

  it("matches the detectDeadlineSignal golden fixture", () => {
    expect({
      today: detectDeadlineSignal("please respond today"),
      german: detectDeadlineSignal("bitte bis morgen antworten"),
      dateFormat: detectDeadlineSignal("due by 12/04/2026"),
      none: detectDeadlineSignal("ordinary mail"),
    }).toEqual(loadGolden("detectDeadlineSignal"));
  });

  it("matches the parseMessage golden fixture", () => {
    expect(
      parseMessage(
        {
          uid: 42,
          messageId: "<abc@ex>",
          from: ["Alice <alice@example.com>"],
          subject: "Re: Budget $500",
        },
        {
          message: {
            uid: 42,
            messageId: "<abc@ex>",
            from: ["Alice <alice@example.com>"],
            subject: "Re: Budget $500",
            text: "Please approve the $500 expense by tomorrow.",
            date: "2026-04-08T08:00:00.000Z",
            headers: [
              { key: "From", value: "alice@example.com" },
              { key: "Subject", value: "Re: Budget $500" },
            ],
          },
        },
      ),
    ).toEqual(loadGolden("parseMessage"));
  });

  it("falls back to a placeholder subject when neither summary nor message has one", () => {
    const parsed = parseMessage({ uid: 1 }, { message: { uid: 1 } });
    expect(parsed.subject).toBe("(no subject)");
    expect(parsed.from).toBe("(unknown sender)");
  });

  it("handles nullish inputs for parseHighestAmount and detectDeadlineSignal", () => {
    expect(parseHighestAmount(undefined)).toBeNull();
    expect(parseHighestAmount(null)).toBeNull();
    expect(detectDeadlineSignal(undefined)).toBe(false);
    expect(detectDeadlineSignal(null)).toBe(false);
  });

  it("omits fromAddress and domain when the from field is empty", () => {
    const parsed = parseMessage(
      { uid: 5, subject: "hi" },
      { message: { uid: 5, subject: "hi", from: [""], text: "" } },
    );
    expect(parsed.fromAddress).toBeUndefined();
    expect(parsed.domain).toBeUndefined();
  });

  it("keeps the raw body as bodyText and omits it when the body is not a string", () => {
    const withBody = parseMessage({ uid: 6 }, { message: { uid: 6, text: "a\n> b\nc" } });
    expect(withBody.bodyText).toBe("a\n> b\nc");
    expect(withBody.text).toBe("a > b c");
    const withoutBody = parseMessage({ uid: 7 }, { message: { uid: 7 } });
    expect(withoutBody).not.toHaveProperty("bodyText");
  });

  it("uses only the summary subject when the message omits one", () => {
    const parsed = parseMessage(
      { uid: 5, subject: "summary-only" },
      { message: { uid: 5, text: "hi" } },
    );
    expect(parsed.subject).toBe("summary-only");
  });

  it("extracts toAddresses from message.to and message.cc arrays", () => {
    const parsed = parseMessage(
      { uid: 10 },
      {
        message: {
          uid: 10,
          to: ["Me <me@business.com>", "Other <other@business.com>"],
          cc: ["CC User <cc@example.com>"],
          text: "hi",
        },
      },
    );
    expect(parsed.toAddresses).toEqual(["me@business.com", "other@business.com", "cc@example.com"]);
  });

  it("extracts toAddresses from headers when message.to is absent", () => {
    const parsed = parseMessage(
      { uid: 11 },
      {
        message: {
          uid: 11,
          text: "hi",
          headers: [
            { key: "To", value: "recipient@domain.com" },
            { key: "Delivered-To", value: "delivered@domain.com" },
          ],
        },
      },
    );
    expect(parsed.toAddresses).toContain("recipient@domain.com");
    expect(parsed.toAddresses).toContain("delivered@domain.com");
  });

  it("returns empty toAddresses when no receiver data is present", () => {
    const parsed = parseMessage({ uid: 12 }, { message: { uid: 12, text: "hi" } });
    expect(parsed.toAddresses).toEqual([]);
  });

  describe("parseReceiverAddresses", () => {
    it("extracts from array-style to and cc", () => {
      expect(
        parseReceiverAddresses(
          ["Alice <alice@a.com>", "Bob <bob@b.com>"],
          ["Carol <carol@c.com>"],
          {},
        ),
      ).toEqual(["alice@a.com", "bob@b.com", "carol@c.com"]);
    });

    it("extracts from comma-separated string", () => {
      expect(parseReceiverAddresses("alice@a.com, bob@b.com", undefined, {})).toEqual([
        "alice@a.com",
        "bob@b.com",
      ]);
    });

    it("deduplicates addresses across to, cc, and headers", () => {
      expect(
        parseReceiverAddresses(["alice@a.com"], undefined, { to: "alice@a.com", cc: "bob@b.com" }),
      ).toEqual(["alice@a.com", "bob@b.com"]);
    });

    it("extracts from delivered-to header", () => {
      expect(
        parseReceiverAddresses(undefined, undefined, { "delivered-to": "me@domain.com" }),
      ).toEqual(["me@domain.com"]);
    });

    it("returns empty array when no data is present", () => {
      expect(parseReceiverAddresses(undefined, undefined, {})).toEqual([]);
    });

    it("ignores empty strings and invalid entries", () => {
      expect(parseReceiverAddresses("", [], { to: "" })).toEqual([]);
    });
  });

  describe("collectAddresses", () => {
    it("merges and deduplicates across multiple sources", () => {
      expect(collectAddresses(["alice@a.com"], "bob@b.com, alice@a.com", undefined, 42)).toEqual([
        "alice@a.com",
        "bob@b.com",
      ]);
    });

    it("returns an empty array when no source yields an address", () => {
      expect(collectAddresses()).toEqual([]);
    });
  });

  describe("parseReceiverBuckets", () => {
    it("splits recipients into per-field buckets", () => {
      const buckets = parseReceiverBuckets(["me@business.com"], ["cc@example.com"], {
        cc: "extra-cc@example.com",
        "delivered-to": "alias@business.com",
        "x-original-to": "catchall@business.com",
        "envelope-to": "envelope@business.com",
        "x-forwarded-to": "forwarded@business.com",
      });
      expect(buckets.toAddresses).toContain("me@business.com");
      expect(buckets.toAddresses).toContain("cc@example.com");
      expect(buckets.ccAddresses).toEqual(["cc@example.com", "extra-cc@example.com"]);
      expect(buckets.deliveredToAddresses).toEqual(["alias@business.com"]);
      expect(buckets.aliasTargets).toEqual([
        "catchall@business.com",
        "envelope@business.com",
        "forwarded@business.com",
      ]);
    });

    it("returns empty buckets when no recipient data is present", () => {
      expect(parseReceiverBuckets(undefined, undefined, {})).toEqual({
        toAddresses: [],
        ccAddresses: [],
        deliveredToAddresses: [],
        aliasTargets: [],
      });
    });
  });

  describe("parseMessage recipient buckets", () => {
    it("populates cc, delivered-to, and alias buckets from fields and headers", () => {
      const parsed = parseMessage(
        { uid: 20 },
        {
          message: {
            uid: 20,
            to: ["Me <me@business.com>"],
            cc: ["CC <cc@example.com>"],
            text: "hi",
            headers: [
              { key: "Delivered-To", value: "alias@business.com" },
              { key: "X-Original-To", value: "catchall@business.com" },
            ],
          },
        },
      );
      expect(parsed.ccAddresses).toEqual(["cc@example.com"]);
      expect(parsed.deliveredToAddresses).toEqual(["alias@business.com"]);
      expect(parsed.aliasTargets).toEqual(["catchall@business.com"]);
    });

    it("omits recipient buckets entirely when their fields are empty", () => {
      const parsed = parseMessage(
        { uid: 21 },
        { message: { uid: 21, to: ["me@business.com"], text: "hi" } },
      );
      expect(parsed.ccAddresses).toBeUndefined();
      expect(parsed.deliveredToAddresses).toBeUndefined();
      expect(parsed.aliasTargets).toBeUndefined();
    });
  });
});
