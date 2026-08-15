import { describe, expect, it } from "vitest";
import {
  buildLookbackImapSearchQuery,
  IMAP_SEARCH_SINCE_SLACK_MS,
  resolveImapSearchSinceDate,
} from "./imap-search-query.js";

describe("resolveImapSearchSinceDate", () => {
  it("subtracts the lookback window plus one day of slack, at UTC day granularity", () => {
    const now = new Date("2026-08-15T10:30:00.000Z");
    expect(resolveImapSearchSinceDate("1h", now)).toBe("2026-08-14");
    expect(resolveImapSearchSinceDate("15m", now)).toBe("2026-08-14");
    expect(resolveImapSearchSinceDate("2d", now)).toBe("2026-08-12");
  });

  it("covers a lookback that crosses midnight", () => {
    // 00:30Z minus 1h is 23:30Z the day before; the slack day pushes it back once more.
    expect(resolveImapSearchSinceDate("1h", new Date("2026-08-15T00:30:00.000Z"))).toBe(
      "2026-08-13",
    );
  });

  it("uses exactly one day of slack", () => {
    expect(IMAP_SEARCH_SINCE_SLACK_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("falls back to the default lookback window instead of an unbounded search", () => {
    const now = new Date("2026-08-15T10:30:00.000Z");
    expect(resolveImapSearchSinceDate("1w", now)).toBe(resolveImapSearchSinceDate("1h", now));
    expect(resolveImapSearchSinceDate("", now)).toBe("2026-08-14");
  });
});

describe("buildLookbackImapSearchQuery", () => {
  it("emits a since: term the sovereign-tool query parser understands", () => {
    expect(buildLookbackImapSearchQuery("1h", new Date("2026-08-15T10:30:00.000Z"))).toBe(
      "since:2026-08-14",
    );
  });

  it("never emits ALL", () => {
    expect(buildLookbackImapSearchQuery("nonsense", new Date("2026-08-15T10:30:00.000Z"))).toMatch(
      /^since:\d{4}-\d{2}-\d{2}$/,
    );
  });
});
