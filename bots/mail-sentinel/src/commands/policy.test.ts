import { beforeEach, describe, expect, it, vi } from "vitest";

import { getFakeRuntime, resetFakeRuntime } from "../__fixtures__/fake-runtime.js";

vi.mock("../config/runtime.js", () => ({
  resolveToolRuntime: async () => getFakeRuntime(),
}));

vi.mock("../state/io.js", async () => {
  const actual = await vi.importActual<typeof import("../state/io.js")>("../state/io.js");
  return {
    ...actual,
    withLockedState: async <T>(_p: string, action: () => Promise<T>) => action(),
  };
});

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => "00000000-0000-0000-0000-000000000000",
  };
});

const { policyAdd, policyImportantSender, policyList, policyRemove } = await import("./policy.js");

describe("commands/policy", () => {
  beforeEach(() => {
    resetFakeRuntime();
  });

  describe("policyList", () => {
    it("requires an instance id", async () => {
      await expect(policyList({})).rejects.toThrow("Expected --instance <id>");
    });

    it("flattens the configured policies", async () => {
      const runtime = getFakeRuntime();
      runtime.policy.senderPolicies.push({ id: "s1", match: "a@b" });
      runtime.policy.domainPolicies.push({ id: "d1", match: "*.b" });
      const result = await policyList({ instance: "ms-core" });
      expect(result.count).toBe(2);
    });
  });

  describe("policyAdd", () => {
    it("requires an instance id", async () => {
      await expect(policyAdd({ json: false })).rejects.toThrow("Expected --instance <id>");
    });

    it("rejects a missing --type", async () => {
      await expect(policyAdd({ instance: "ms-core", json: false })).rejects.toThrow(
        "Expected --type",
      );
    });

    it("rejects a sender policy without --match", async () => {
      await expect(policyAdd({ instance: "ms-core", json: false, type: "sender" })).rejects.toThrow(
        "'sender' requires --match",
      );
    });

    it("rejects a category policy without --category", async () => {
      await expect(
        policyAdd({ instance: "ms-core", json: false, type: "category" }),
      ).rejects.toThrow("requires --category");
    });

    it("rejects a time policy without --schedule", async () => {
      await expect(policyAdd({ instance: "ms-core", json: false, type: "time" })).rejects.toThrow(
        "requires --schedule",
      );
    });

    it("rejects a content policy without --pattern", async () => {
      await expect(
        policyAdd({ instance: "ms-core", json: false, type: "content" }),
      ).rejects.toThrow("requires --pattern");
    });

    it("adds a sender policy with the provided flags", async () => {
      const runtime = getFakeRuntime();
      const result = await policyAdd({
        instance: "ms-core",
        json: false,
        type: "sender",
        match: "a@b",
        minZone: "amber",
        maxZone: "red",
        reason: "why",
        boost: "2",
      });
      expect(result.changed).toBe(true);
      expect(runtime.policy.senderPolicies).toHaveLength(1);
      expect(runtime.policy.senderPolicies[0]?.boost).toBe(2);
      expect(result.policy.type).toBe("sender");
    });

    it("adds a mute policy with action: mute", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "mute",
        match: "noreply@*",
      });
      expect(runtime.policy.mutePolicies[0]?.action).toBe("mute");
    });

    it("adds a content policy with amountThreshold parsed to a number", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "content",
        pattern: "invoice",
        amountThreshold: "250",
      });
      expect(runtime.policy.contentPolicies[0]?.amountThreshold).toBe(250);
    });

    it("derives a subject-scoped literal rule from --contains", async () => {
      const runtime = getFakeRuntime();
      const result = await policyAdd({
        instance: "ms-core",
        json: false,
        type: "content",
        contains: "freigegeben (final)",
        maxZone: "gray",
      });
      const entry = runtime.policy.contentPolicies[0];
      // --contains is escaped to a literal-match regex and defaults to the subject scope.
      expect(entry?.pattern).toBe("freigegeben \\(final\\)");
      expect(entry?.scope).toBe("subject");
      expect(entry?.maxZone).toBe("gray");
      expect(result.policy.type).toBe("content");
    });

    it("honours an explicit --scope with a raw --pattern", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "content",
        pattern: "DOWN",
        scope: "subject",
        minZone: "red",
      });
      const entry = runtime.policy.contentPolicies[0];
      expect(entry?.pattern).toBe("DOWN");
      expect(entry?.scope).toBe("subject");
      expect(entry?.minZone).toBe("red");
    });

    it("accepts a snippet-scoped content policy", async () => {
      const runtime = getFakeRuntime();
      const result = await policyAdd({
        instance: "ms-core",
        json: false,
        type: "content",
        contains: "payment receipt",
        scope: "snippet",
        maxZone: "amber",
      });
      const entry = runtime.policy.contentPolicies[0];
      expect(entry?.scope).toBe("snippet");
      expect(entry?.pattern).toBe("payment receipt");
      expect(entry?.maxZone).toBe("amber");
      expect(result.policy.scope).toBe("snippet");
    });

    it("lets --pattern win over --contains and keeps the any scope by default", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "content",
        pattern: "raw.*regex",
        contains: "ignored literal",
      });
      const entry = runtime.policy.contentPolicies[0];
      expect(entry?.pattern).toBe("raw.*regex");
      expect(entry?.scope).toBeUndefined();
    });

    it("rejects a content policy without --pattern or --contains", async () => {
      await expect(
        policyAdd({ instance: "ms-core", json: false, type: "content" }),
      ).rejects.toThrow("requires --pattern <regex> or --contains <text>");
    });

    it("rejects an invalid --scope value", async () => {
      await expect(
        policyAdd({
          instance: "ms-core",
          json: false,
          type: "content",
          pattern: "x",
          scope: "header",
        }),
      ).rejects.toThrow("--scope must be one of subject|body|snippet|any");
    });

    it("adds a category policy", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "category",
        category: "risk-escalation",
      });
      expect(runtime.policy.categoryPolicies).toHaveLength(1);
    });

    it("adds a time policy", async () => {
      const runtime = getFakeRuntime();
      await policyAdd({
        instance: "ms-core",
        json: false,
        type: "time",
        schedule: "09:00-17:00",
      });
      expect(runtime.policy.timePolicies).toHaveLength(1);
    });

    it("rejects a receiver policy without --match", async () => {
      await expect(
        policyAdd({ instance: "ms-core", json: false, type: "receiver" }),
      ).rejects.toThrow("'receiver' requires --match");
    });

    it("adds a receiver policy with the provided flags", async () => {
      const runtime = getFakeRuntime();
      const result = await policyAdd({
        instance: "ms-core",
        json: false,
        type: "receiver",
        match: "me@business.com",
        minZone: "red",
        boost: "5",
        reason: "business email",
      });
      expect(result.changed).toBe(true);
      expect(runtime.policy.receiverPolicies).toHaveLength(1);
      expect(runtime.policy.receiverPolicies[0]?.match).toBe("me@business.com");
      expect(runtime.policy.receiverPolicies[0]?.boost).toBe(5);
      expect(result.policy.type).toBe("receiver");
    });

    it("adds a receiver policy with a --target and surfaces it via policyList", async () => {
      const runtime = getFakeRuntime();
      const result = await policyAdd({
        instance: "ms-core",
        json: false,
        type: "receiver",
        match: "cc@business.com",
        target: "cc",
        minZone: "amber",
      });
      expect(runtime.policy.receiverPolicies[0]?.target).toBe("cc");
      expect(result.policy.target).toBe("cc");
      const listed = await policyList({ instance: "ms-core" });
      expect(listed.policies[0]?.target).toBe("cc");
    });

    it("rejects an invalid --target value", async () => {
      await expect(
        policyAdd({
          instance: "ms-core",
          json: false,
          type: "receiver",
          match: "x@y",
          target: "bcc",
        }),
      ).rejects.toThrow("--target must be one of to|cc|delivered_to|alias");
    });

    it("rejects --target on a non-receiver policy type", async () => {
      await expect(
        policyAdd({
          instance: "ms-core",
          json: false,
          type: "sender",
          match: "x@y",
          target: "cc",
        }),
      ).rejects.toThrow("--target is only valid for policy type 'receiver'");
    });
  });

  describe("policyRemove", () => {
    it("requires an instance id", async () => {
      await expect(policyRemove({})).rejects.toThrow("Expected --instance <id>");
    });

    it("rejects a missing --id", async () => {
      await expect(policyRemove({ instance: "ms-core" })).rejects.toThrow(
        "Expected --id <policy-id>",
      );
    });

    it("removes a matching policy and reports changed=true", async () => {
      const runtime = getFakeRuntime();
      runtime.policy.senderPolicies.push({ id: "s1", match: "a@b" });
      const result = await policyRemove({ instance: "ms-core", id: "s1" });
      expect(result.changed).toBe(true);
      expect(runtime.policy.senderPolicies).toHaveLength(0);
    });

    it("reports changed=false when no policy matches", async () => {
      const runtime = getFakeRuntime();
      runtime.policy.senderPolicies.push({ id: "s1", match: "a@b" });
      const result = await policyRemove({ instance: "ms-core", id: "missing" });
      expect(result.changed).toBe(false);
      expect(runtime.policy.senderPolicies).toHaveLength(1);
    });

    it("removes a receiver policy", async () => {
      const runtime = getFakeRuntime();
      runtime.policy.receiverPolicies.push({ id: "r1", match: "me@biz.com" });
      const result = await policyRemove({ instance: "ms-core", id: "r1" });
      expect(result.changed).toBe(true);
      expect(runtime.policy.receiverPolicies).toHaveLength(0);
    });
  });

  describe("policyImportantSender", () => {
    it("requires an instance id", async () => {
      await expect(policyImportantSender({})).rejects.toThrow("Expected --instance <id>");
    });

    it("rejects an empty --query", async () => {
      await expect(policyImportantSender({ instance: "ms-core", query: "   " })).rejects.toThrow(
        "Expected --query",
      );
    });

    it("returns not-found when no sender matches", async () => {
      const result = await policyImportantSender({
        instance: "ms-core",
        query: "nobody",
      });
      expect(result.status).toBe("not-found");
    });

    it("creates a sender policy when a unique match is found", async () => {
      const runtime = getFakeRuntime();
      runtime.state.messages.m1 = {
        key: "m1",
        uid: 1,
        from: "Alice Smith <alice@example.com>",
        fromAddress: "alice@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      const result = await policyImportantSender({
        instance: "ms-core",
        query: "alice@example.com",
      });
      expect(result.status).toBe("created");
      expect(runtime.policy.senderPolicies).toHaveLength(1);
    });

    it("reports ambiguous when multiple senders share a display name", async () => {
      const runtime = getFakeRuntime();
      runtime.state.messages.m1 = {
        key: "m1",
        uid: 1,
        from: "Alice Smith <alice@example.com>",
        fromAddress: "alice@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      runtime.state.messages.m2 = {
        key: "m2",
        uid: 2,
        from: "Alice Smith <other@example.com>",
        fromAddress: "other@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      const result = await policyImportantSender({
        instance: "ms-core",
        query: "alice smith",
      });
      expect(result.status).toBe("ambiguous");
    });

    it("announces via matrix when --announce is set", async () => {
      const runtime = getFakeRuntime();
      runtime.state.messages.m1 = {
        key: "m1",
        uid: 1,
        from: "Alice Smith <alice@example.com>",
        fromAddress: "alice@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      const send = vi.spyOn(runtime, "sendMatrixRoomMessage");
      await policyImportantSender({
        instance: "ms-core",
        query: "alice@example.com",
        announce: true,
      });
      expect(send).toHaveBeenCalled();
    });

    it("announces the failure when --announce is set and the command throws", async () => {
      const runtime = getFakeRuntime();
      // Force a failure by stubbing withLockedState to throw — instead we
      // monkey-patch readState to throw.
      runtime.readState = async () => {
        throw new Error("boom");
      };
      const send = vi.spyOn(runtime, "sendMatrixRoomMessage");
      await expect(
        policyImportantSender({ instance: "ms-core", query: "alice", announce: true }),
      ).rejects.toThrow("boom");
      expect(send).toHaveBeenCalled();
    });

    it("announces a non-Error thrown value (string) via String()", async () => {
      const runtime = getFakeRuntime();
      runtime.readState = async () => {
        throw "string-failure";
      };
      const send = vi.spyOn(runtime, "sendMatrixRoomMessage");
      await expect(
        policyImportantSender({ instance: "ms-core", query: "alice", announce: true }),
      ).rejects.toBe("string-failure");
      expect(send).toHaveBeenCalled();
    });

    it("returns 'updated' status when an existing policy is modified", async () => {
      const runtime = getFakeRuntime();
      runtime.state.messages.m1 = {
        key: "m1",
        uid: 1,
        from: "Alice <alice@example.com>",
        fromAddress: "alice@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      runtime.policy.senderPolicies.push({
        id: "existing",
        match: "alice@example.com",
        minZone: "gray",
        maxZone: "red",
        reason: "old reason",
      });
      const result = await policyImportantSender({
        instance: "ms-core",
        query: "alice@example.com",
      });
      // upserted.created=false because the entry exists.
      // upserted.changed=true because clearMaxZone + minZone=amber modified it.
      expect(result.status).toBe("updated");
    });

    it("returns 'unchanged' status when the policy already exists", async () => {
      const runtime = getFakeRuntime();
      runtime.state.messages.m1 = {
        key: "m1",
        uid: 1,
        from: "Alice <alice@example.com>",
        fromAddress: "alice@example.com",
        domain: "example.com",
        subject: "hi",
        normalizedThreadSubject: "hi",
        snippet: "hi",
        firstSeenAt: "2026-04-08T09:00:00Z",
        lastSeenAt: "2026-04-08T09:00:00Z",
      };
      runtime.policy.senderPolicies.push({
        id: "existing",
        match: "alice@example.com",
        minZone: "amber",
        reason: "Direct sender importance from 'alice@example.com'",
      });
      const result = await policyImportantSender({
        instance: "ms-core",
        query: "alice@example.com",
      });
      expect(result.status).toBe("unchanged");
    });
  });
});
