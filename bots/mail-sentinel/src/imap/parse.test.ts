import { describe, expect, it } from "vitest";

import { loadGolden } from "../__fixtures__/load.js";
import {
  detectDeadlineSignal,
  normalizeHeaderMap,
  parseAddressFromList,
  parseHighestAmount,
  parseMessage,
  parseReceiverAddresses,
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
    const parsed = parseMessage(
      { uid: 12 },
      { message: { uid: 12, text: "hi" } },
    );
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
      expect(
        parseReceiverAddresses("alice@a.com, bob@b.com", undefined, {}),
      ).toEqual(["alice@a.com", "bob@b.com"]);
    });

    it("deduplicates addresses across to, cc, and headers", () => {
      expect(
        parseReceiverAddresses(
          ["alice@a.com"],
          undefined,
          { to: "alice@a.com", cc: "bob@b.com" },
        ),
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
});
