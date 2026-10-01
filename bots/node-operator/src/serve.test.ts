import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StatusCommandResult } from "./commands/status.js";
import type { ServeContext } from "./matrix-reply.js";
import { extractRoomEvents, handleRoomEvent, runServe } from "./serve.js";

const statusMocks = vi.hoisted(() => ({ getDiagnostics: vi.fn() }));
vi.mock("./commands/status.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./commands/status.js")>();
  return { ...original, getDiagnostics: statusMocks.getDiagnostics };
});

const ROOM = "!sovereign-node:example.org";
const BOT = "@node-operator:example.org";
const OPERATOR = "@operator:example.org";
const OBSERVER = "@observer:example.org";

const context: ServeContext = {
  homeserverUrl: "http://127.0.0.1:8008",
  roomId: ROOM,
  accessToken: "syt_token",
  botUserId: BOT,
  authorizedUserIds: [OPERATOR],
  allowOperatorDms: false,
};

const healthyResult: StatusCommandResult = {
  kind: "ok",
  diagnostics: {
    contractVersion: "2.0.0",
    overall: "healthy",
    checkedAt: "2026-07-30T12:00:00.000Z",
    headline: "All components are working normally.",
    components: [],
  },
};

const roomMessage = (sender: string, body: string, eventId = "$evt"): Record<string, unknown> => ({
  type: "m.room.message",
  sender,
  event_id: eventId,
  content: { msgtype: "m.text", body },
});

const syncBody = (
  events: Array<Record<string, unknown>>,
  roomId: string = ROOM,
  nextBatch = "batch-2",
): Record<string, unknown> => ({
  next_batch: nextBatch,
  rooms: { join: { [roomId]: { timeline: { events } } } },
});

let guardRoot: string;

beforeEach(async () => {
  guardRoot = await mkdtemp(join(tmpdir(), "node-operator-serve-guard-"));
  process.env.NODE_OPERATOR_GUARD_PATH = join(guardRoot, "guard.json");
  statusMocks.getDiagnostics.mockResolvedValue(healthyResult);
});

afterEach(async () => {
  statusMocks.getDiagnostics.mockReset();
  delete process.env.NODE_OPERATOR_GUARD_PATH;
  await rm(guardRoot, { recursive: true, force: true });
});

describe("extractRoomEvents", () => {
  it("keeps only well-formed room messages for the configured room", () => {
    const events = extractRoomEvents(
      syncBody([
        roomMessage(OPERATOR, "status", "$1"),
        { type: "m.room.member", sender: OPERATOR, event_id: "$2", content: {} },
        { type: "m.room.message", sender: "", event_id: "$3", content: { body: "x" } },
        { type: "m.room.message", sender: OPERATOR, content: { body: "no id" } },
        { type: "m.room.message", sender: OPERATOR, event_id: "$5", content: { body: 42 } },
        "not-an-object" as unknown as Record<string, unknown>,
      ]),
      ROOM,
    );
    expect(events).toEqual([{ sender: OPERATOR, eventId: "$1", text: "status" }]);
  });

  it("ignores other rooms and malformed sync bodies entirely", () => {
    expect(
      extractRoomEvents(syncBody([roomMessage(OPERATOR, "status")], "!other:x"), ROOM),
    ).toEqual([]);
    expect(extractRoomEvents(null, ROOM)).toEqual([]);
    expect(extractRoomEvents("junk", ROOM)).toEqual([]);
    expect(extractRoomEvents({ rooms: { join: { [ROOM]: { timeline: {} } } } }, ROOM)).toEqual([]);
  });
});

describe("handleRoomEvent", () => {
  it("executes commands from authorized operators and replies in the room", async () => {
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      sends.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await handleRoomEvent(
      context,
      { sender: OPERATOR, eventId: "$cmd", text: "status" },
      { fetchImpl },
    );
    expect(outcome).toBe("replied");
    expect(sends).toHaveLength(1);
    expect(String(sends[0]?.body.body)).toContain("Node status: Healthy");
    expect(sends[0]?.body["m.relates_to"]).toBeUndefined();
  });

  it("replies to verify with the exact VERIFY_OK body AND a reply relation", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sends.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
    await handleRoomEvent(
      context,
      { sender: OPERATOR, eventId: "$challenge", text: `${BOT}: verify ${nonce}` },
      { fetchImpl },
    );
    expect(sends[0]?.body).toBe(`VERIFY_OK ${nonce}`);
    expect(sends[0]?.["m.relates_to"]).toEqual({
      "m.in_reply_to": { event_id: "$challenge" },
    });
  });

  it("silently ignores unauthorized room members — membership grants nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const outcome = await handleRoomEvent(
      context,
      { sender: OBSERVER, eventId: "$x", text: "status" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(outcome).toBe("unauthorized");
    // No reply, no echo, nothing an outsider could farm.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores its own events — no self-command loops", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const outcome = await handleRoomEvent(
      context,
      { sender: BOT, eventId: "$self", text: "status" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(outcome).toBe("self");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers unrecognised text from an authorized operator with fixed help", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sends.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await handleRoomEvent(
      context,
      { sender: OPERATOR, eventId: "$q", text: "please restart everything" },
      { fetchImpl },
    );
    expect(String(sends[0]?.body)).toContain("I don't know that command.");
    expect(String(sends[0]?.body)).not.toContain("restart everything");
  });
});

describe("runServe", () => {
  it("skips the initial sync backlog and processes only new events in its room", async () => {
    const sends: string[] = [];
    let syncCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/sync")) {
        syncCalls += 1;
        if (syncCalls === 1) {
          // Backlog present on the FIRST sync — must not be replayed.
          return new Response(
            JSON.stringify(syncBody([roomMessage(OPERATOR, "status", "$old")], ROOM, "batch-1")),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(
            syncBody(
              [roomMessage(OPERATOR, "help", "$new"), roomMessage(OBSERVER, "status", "$intruder")],
              ROOM,
              "batch-2",
            ),
          ),
          { status: 200 },
        );
      }
      sends.push(String(JSON.parse(String(init?.body ?? "{}")).body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await runServe({
      fetchImpl,
      resolveContext: async () => context,
      sleep: async () => {},
      maxIterations: 2,
    });

    // Exactly one reply: the authorized operator's help — the backlog and the
    // unauthorized member produced nothing.
    expect(sends).toHaveLength(1);
    expect(sends[0]).toContain("I can help with your Sovereign AI Node");
  });

  it("retries when the node is not configured yet and warns when no operator is authorized", async () => {
    const logs: string[] = [];
    let resolveCalls = 0;
    await runServe({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ next_batch: "b" }), {
          status: 200,
        })) as unknown as typeof fetch,
      resolveContext: async () => {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return undefined;
        }
        return { ...context, authorizedUserIds: [] };
      },
      sleep: async () => {},
      maxIterations: 2,
      log: (line) => logs.push(line),
    });
    expect(logs.some((line) => line.includes("not configured"))).toBe(true);
    expect(logs.some((line) => line.includes("no authorized operators"))).toBe(true);
  });

  it("re-resolves the context after a 401 (token rotation) and survives errors", async () => {
    let syncCalls = 0;
    let resolves = 0;
    await runServe({
      fetchImpl: (async () => {
        syncCalls += 1;
        if (syncCalls === 1) {
          return new Response("{}", { status: 401 });
        }
        if (syncCalls === 2) {
          throw new Error("network blip");
        }
        if (syncCalls === 3) {
          return new Response("nope", { status: 502 });
        }
        return new Response(JSON.stringify({ next_batch: "b" }), { status: 200 });
      }) as unknown as typeof fetch,
      resolveContext: async () => {
        resolves += 1;
        return context;
      },
      sleep: async () => {},
      maxIterations: 5,
    });
    expect(resolves).toBeGreaterThanOrEqual(2);
    expect(syncCalls).toBeGreaterThanOrEqual(4);
  });

  it("normalises a trailing-slash homeserver in the sync URL", async () => {
    const urls: string[] = [];
    await runServe({
      fetchImpl: (async (url: string) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ next_batch: "b" }), { status: 200 });
      }) as unknown as typeof fetch,
      resolveContext: async () => ({ ...context, homeserverUrl: "http://127.0.0.1:8008/" }),
      sleep: async () => {},
      maxIterations: 1,
    });
    expect(urls[0]).toBe("http://127.0.0.1:8008/_matrix/client/v3/sync?timeout=0");
  });

  it("tolerates a sync body without a usable next_batch", async () => {
    let syncCalls = 0;
    await runServe({
      fetchImpl: (async () => {
        syncCalls += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }) as unknown as typeof fetch,
      resolveContext: async () => context,
      sleep: async () => {},
      maxIterations: 2,
    });
    expect(syncCalls).toBe(2);
  });
});

describe("handleRoomEvent defaults", () => {
  it("uses the module default fetch when none is injected (send fails soft)", async () => {
    // No fetchImpl: sendOwnRoomMessage falls back to global fetch, which
    // cannot reach the fake homeserver — the handler still completes.
    const outcome = await handleRoomEvent(
      { ...context, homeserverUrl: "http://127.0.0.1:1" },
      { sender: OPERATOR, eventId: "$default-fetch", text: "help" },
    );
    expect(outcome).toBe("replied");
  });
});

describe("runServe defaults", () => {
  it("uses the default resolver, logger and backoff when unconfigured", {
    timeout: 15_000,
  }, async () => {
    // On a dev machine the default context resolution finds nothing: the
    // daemon logs, sleeps its real backoff once, and returns after the
    // bounded iteration.
    const before = Date.now();
    await runServe({ maxIterations: 1 });
    expect(Date.now() - before).toBeGreaterThanOrEqual(4_000);
  });
});
