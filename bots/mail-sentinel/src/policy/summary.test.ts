import { describe, expect, it } from "vitest";

import type { FlattenedPolicyEntry } from "../types.js";
import {
  describeEffect,
  describeRoute,
  groupByType,
  mergeDuplicatePolicies,
  POLICY_TYPE_ORDER,
  policyTarget,
  resolveEffectiveRouting,
} from "./summary.js";

describe("policy/summary", () => {
  describe("policyTarget", () => {
    it("formats content rules as scope:/pattern/", () => {
      expect(policyTarget({ id: "c", type: "content", pattern: "invoice", scope: "subject" })).toBe(
        "subject:/invoice/",
      );
    });

    it("defaults a scope-less content rule to any and an absent pattern to empty", () => {
      expect(policyTarget({ id: "c", type: "content" })).toBe("any://");
    });

    it("formats category, time, and match-based rules", () => {
      expect(policyTarget({ id: "k", type: "category", category: "risk" })).toBe("risk");
      expect(policyTarget({ id: "t", type: "time", schedule: "09:00-17:00" })).toBe("09:00-17:00");
      expect(policyTarget({ id: "s", type: "sender", match: "a@b" })).toBe("a@b");
    });

    it("falls back to empty strings when fields are absent", () => {
      expect(policyTarget({ id: "k", type: "category" })).toBe("");
      expect(policyTarget({ id: "t", type: "time" })).toBe("");
      expect(policyTarget({ id: "s", type: "sender" })).toBe("");
    });
  });

  describe("mergeDuplicatePolicies", () => {
    it("collapses entries identical in type, target, and effect", () => {
      const merged = mergeDuplicatePolicies([
        { id: "s1", type: "sender", match: "a@b", minZone: "amber" },
        { id: "s2", type: "sender", match: "a@b", minZone: "amber" },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.ids).toEqual(["s1", "s2"]);
      expect(merged[0]?.count).toBe(2);
    });

    it("keeps same-target entries with different effects separate", () => {
      const merged = mergeDuplicatePolicies([
        { id: "x1", type: "sender", match: "a@b", minZone: "red" },
        { id: "x2", type: "sender", match: "a@b", maxZone: "amber" },
      ]);
      expect(merged).toHaveLength(2);
    });

    it("treats a missing id as an empty string in the id list", () => {
      const merged = mergeDuplicatePolicies([{ type: "sender", match: "a@b" }]);
      expect(merged[0]?.ids).toEqual([""]);
      // A second id-less duplicate collapses into the same group.
      const both = mergeDuplicatePolicies([
        { type: "sender", match: "a@b" },
        { type: "sender", match: "a@b" },
      ]);
      expect(both).toHaveLength(1);
      expect(both[0]?.ids).toEqual(["", ""]);
    });

    it("distinguishes mute-type rules from non-muting ones via the effect key", () => {
      const merged = mergeDuplicatePolicies([
        { id: "m", type: "mute", match: "a@b" },
        { id: "s", type: "sender", match: "a@b" },
      ]);
      expect(merged).toHaveLength(2);
    });
  });

  describe("groupByType", () => {
    it("groups by canonical type order and drops empty sections", () => {
      const merged = mergeDuplicatePolicies([
        { id: "t1", type: "time", schedule: "00:00-01:00" },
        { id: "s1", type: "sender", match: "a@b" },
      ]);
      const sections = groupByType(merged);
      expect(sections.map((section) => section.type)).toEqual(["sender", "time"]);
    });

    it("returns no sections for an empty input", () => {
      expect(groupByType([])).toEqual([]);
    });

    it("orders every supported type", () => {
      expect(POLICY_TYPE_ORDER).toEqual([
        "sender",
        "domain",
        "receiver",
        "category",
        "content",
        "time",
        "mute",
      ]);
    });
  });

  describe("resolveEffectiveRouting", () => {
    it("ignores non-routing types and empty targets", () => {
      const routes = resolveEffectiveRouting([
        { id: "c1", type: "content", pattern: "invoice", boost: 2 },
        { id: "t1", type: "time", schedule: "09:00-17:00" },
        { id: "s0", type: "sender", match: "", minZone: "amber" },
      ]);
      expect(routes).toEqual([]);
    });

    it("accumulates floor via zoneMax and ceiling via zoneMin across entries", () => {
      const routes = resolveEffectiveRouting([
        { id: "a", type: "sender", match: "x@y", minZone: "amber" },
        { id: "b", type: "sender", match: "x@y", minZone: "red" },
        { id: "c", type: "sender", match: "x@y", maxZone: "red" },
        { id: "d", type: "sender", match: "x@y", maxZone: "amber" },
      ]);
      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({ floor: "red", ceiling: "amber", boost: 0, muted: false });
    });

    it("sums boosts and lets mute force the ceiling to gray", () => {
      const routes = resolveEffectiveRouting([
        { id: "p1", type: "sender", match: "x@y", boost: 2 },
        { id: "p2", type: "sender", match: "x@y", boost: 3 },
        { id: "m1", type: "mute", match: "x@y" },
      ]);
      const sender = routes.find((route) => route.type === "sender");
      const mute = routes.find((route) => route.type === "mute");
      expect(sender).toMatchObject({ boost: 5 });
      expect(mute).toMatchObject({ muted: true, ceiling: "gray" });
    });

    it("ignores non-finite boosts and out-of-range zones", () => {
      const routes = resolveEffectiveRouting([
        {
          id: "p",
          type: "sender",
          match: "x@y",
          boost: Number.POSITIVE_INFINITY,
          minZone: "purple" as never,
          maxZone: "purple" as never,
        },
      ]);
      // Nothing resolved to a real effect, so the route is filtered out.
      expect(routes).toEqual([]);
    });

    it("honours an explicit action:mute on a sender rule", () => {
      const routes = resolveEffectiveRouting([
        { id: "p", type: "sender", match: "x@y", action: "mute" },
      ]);
      expect(routes[0]).toMatchObject({ muted: true, ceiling: "gray" });
    });

    it("honours a muted:true flag", () => {
      const routes = resolveEffectiveRouting([
        { id: "p", type: "sender", match: "x@y", muted: true },
      ]);
      expect(routes[0]).toMatchObject({ muted: true });
    });
  });

  describe("describeEffect", () => {
    it("reports MUTED for muting entries", () => {
      expect(describeEffect({ id: "m", type: "mute", match: "a@b" })).toBe("MUTED");
    });

    it("reports floor, ceiling, and boost", () => {
      expect(
        describeEffect({ id: "p", type: "sender", match: "a@b", minZone: "amber", maxZone: "red" }),
      ).toBe("floor=amber ceiling=red");
      expect(describeEffect({ id: "p", type: "sender", match: "a@b", boost: 2 })).toBe("boost +2");
      expect(describeEffect({ id: "p", type: "sender", match: "a@b", boost: -1 })).toBe("boost -1");
    });

    it("omits a zero boost and returns an empty string for a bare rule", () => {
      expect(describeEffect({ id: "p", type: "sender", match: "a@b", boost: 0 })).toBe("");
      expect(describeEffect({ id: "p", type: "sender", match: "a@b" })).toBe("");
    });

    it("ignores a non-finite boost", () => {
      expect(describeEffect({ id: "p", type: "sender", match: "a@b", boost: Number.NaN })).toBe("");
    });
  });

  describe("describeRoute", () => {
    const base = { type: "sender" as const, target: "a@b" };

    it("reports MUTED, floor, ceiling, boost, and the no-effect fallback", () => {
      expect(describeRoute({ ...base, floor: "amber", ceiling: null, boost: 0, muted: true })).toBe(
        "MUTED",
      );
      expect(
        describeRoute({ ...base, floor: "amber", ceiling: "red", boost: 2, muted: false }),
      ).toBe("floor amber ceiling red boost +2");
      expect(describeRoute({ ...base, floor: null, ceiling: null, boost: -3, muted: false })).toBe(
        "boost -3",
      );
      expect(describeRoute({ ...base, floor: null, ceiling: null, boost: 0, muted: false })).toBe(
        "no zone effect",
      );
    });
  });
});

// A typed reference so the helpers are exercised with the public entry shape.
const _typecheck: FlattenedPolicyEntry = { id: "x", type: "sender", match: "a@b" };
void _typecheck;
