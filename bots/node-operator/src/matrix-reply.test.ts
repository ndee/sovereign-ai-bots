import { describe, expect, it, vi } from "vitest";

import { resolveMatrixReplyTarget, sendOwnRoomMessage } from "./matrix-reply.js";

const WORKSPACE = "/var/lib/sovereign-node/node-operator/workspace";
const BIN = `${WORKSPACE}/bin/node-operator.js`;

const runtimeDocument = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    matrix: {
      adminBaseUrl: "http://127.0.0.1:8008",
      alertRoom: { roomId: "!alerts:example.org" },
      operatorRoom: { roomId: "!operator:example.org" },
    },
    bots: {
      instances: [
        {
          id: "node-operator-operator-room",
          matrix: { alertRoom: { roomId: "!operator:example.org" } },
        },
      ],
    },
    openclawProfile: {
      agents: [
        {
          id: "node-operator",
          workspace: WORKSPACE,
          botInstanceId: "node-operator-operator-room",
          matrix: { accessTokenSecretRef: "file:/etc/secrets/node-operator-token" },
        },
      ],
    },
    ...overrides,
  });

const files = (config: string): ((path: string, encoding: "utf8") => Promise<string>) => {
  return async (path) => {
    if (path === "/etc/sovereign-node/sovereign-node.json5") return config;
    if (path === "/custom/config.json") return config;
    if (path === "/etc/secrets/node-operator-token") return "syt_token_value\n";
    throw new Error(`ENOENT ${path}`);
  };
};

describe("resolveMatrixReplyTarget", () => {
  it("resolves this agent's room and token from the runtime config", async () => {
    const target = await resolveMatrixReplyTarget({
      env: {},
      argv1: BIN,
      readFileFn: files(runtimeDocument()),
    });
    expect(target).toEqual({
      homeserverUrl: "http://127.0.0.1:8008",
      roomId: "!operator:example.org",
      accessToken: "syt_token_value",
    });
  });

  it("honours SOVEREIGN_NODE_CONFIG and room precedence fallbacks", async () => {
    const noInstance = JSON.parse(runtimeDocument()) as Record<string, never> & {
      bots: { instances: unknown[] };
      matrix: { operatorRoom?: unknown };
      openclawProfile: { agents: Array<{ botInstanceId?: string }> };
    };
    noInstance.bots.instances = [];
    const agent = noInstance.openclawProfile.agents[0];
    if (agent !== undefined) {
      agent.botInstanceId = undefined;
    }
    const viaOperatorRoom = await resolveMatrixReplyTarget({
      env: { SOVEREIGN_NODE_CONFIG: "/custom/config.json" },
      argv1: BIN,
      readFileFn: files(JSON.stringify(noInstance)),
    });
    expect(viaOperatorRoom?.roomId).toBe("!operator:example.org");

    noInstance.matrix.operatorRoom = undefined;
    const viaAlertRoom = await resolveMatrixReplyTarget({
      env: {},
      argv1: BIN,
      readFileFn: files(JSON.stringify(noInstance)),
    });
    expect(viaAlertRoom?.roomId).toBe("!alerts:example.org");
  });

  it("returns undefined for unknown agents, non-file refs, empty tokens, or broken config", async () => {
    // Binary outside any known workspace.
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: "/elsewhere/bin/other.js",
        readFileFn: files(runtimeDocument()),
      }),
    ).toBeUndefined();

    // env-style secret ref is not readable by this helper.
    const envRef = JSON.parse(runtimeDocument()) as {
      openclawProfile: { agents: Array<{ matrix: { accessTokenSecretRef: string } }> };
    };
    const refAgent = envRef.openclawProfile.agents[0];
    if (refAgent !== undefined) {
      refAgent.matrix.accessTokenSecretRef = "env:TOKEN";
    }
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: BIN,
        readFileFn: files(JSON.stringify(envRef)),
      }),
    ).toBeUndefined();

    // Empty token file.
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: BIN,
        readFileFn: async (path) =>
          path === "/etc/sovereign-node/sovereign-node.json5" ? runtimeDocument() : "   ",
      }),
    ).toBeUndefined();

    // Unreadable / invalid config, or missing argv1.
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: BIN,
        readFileFn: async () => {
          throw new Error("EACCES");
        },
      }),
    ).toBeUndefined();
    expect(
      await resolveMatrixReplyTarget({ env: {}, argv1: BIN, readFileFn: async () => "{not json" }),
    ).toBeUndefined();
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: undefined,
        readFileFn: files(runtimeDocument()),
      }),
    ).toBeUndefined();
    expect(
      await resolveMatrixReplyTarget({ env: {}, argv1: "", readFileFn: files(runtimeDocument()) }),
    ).toBeUndefined();
  });

  it("returns undefined when the resolved room or homeserver is missing", async () => {
    const noRooms = JSON.parse(runtimeDocument()) as {
      matrix: Record<string, unknown>;
      bots: { instances: unknown[] };
      openclawProfile: { agents: Array<{ botInstanceId?: string }> };
    };
    noRooms.bots.instances = [];
    const agent = noRooms.openclawProfile.agents[0];
    if (agent !== undefined) {
      agent.botInstanceId = undefined;
    }
    noRooms.matrix = { adminBaseUrl: "http://127.0.0.1:8008" };
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: BIN,
        readFileFn: files(JSON.stringify(noRooms)),
      }),
    ).toBeUndefined();

    const noHomeserver = JSON.parse(runtimeDocument()) as { matrix: Record<string, unknown> };
    (noHomeserver.matrix as { adminBaseUrl?: string }).adminBaseUrl = undefined;
    expect(
      await resolveMatrixReplyTarget({
        env: {},
        argv1: BIN,
        readFileFn: files(JSON.stringify(noHomeserver)),
      }),
    ).toBeUndefined();
  });

  it("uses process defaults without throwing when nothing is configured", async () => {
    // On a dev machine the default config path does not exist — must resolve
    // to undefined, never throw.
    expect(await resolveMatrixReplyTarget()).toBeUndefined();
    // A whitespace-only override falls back to the default path.
    expect(
      await resolveMatrixReplyTarget({
        env: { SOVEREIGN_NODE_CONFIG: "   " },
        argv1: BIN,
        readFileFn: files(runtimeDocument()),
      }),
    ).toBeDefined();
  });
});

describe("sendOwnRoomMessage", () => {
  const target = {
    homeserverUrl: "http://127.0.0.1:8008",
    roomId: "!operator:example.org",
    accessToken: "syt_token_value",
  };

  it("PUTs the message to the resolved room with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const sent = await sendOwnRoomMessage("Verification abc confirmed.", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTarget: async () => target,
      txnId: "txn-1",
    });
    expect(sent).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "http://127.0.0.1:8008/_matrix/client/v3/rooms/!operator%3Aexample.org/send/m.room.message/txn-1",
    );
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer syt_token_value");
    expect(JSON.parse(String(init.body))).toEqual({
      msgtype: "m.text",
      body: "Verification abc confirmed.",
    });
  });

  it("handles trailing-slash homeservers and generates a txn id by default", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const sent = await sendOwnRoomMessage("x", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveTarget: async () => ({ ...target, homeserverUrl: "http://127.0.0.1:8008/" }),
    });
    expect(sent).toBe(true);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("/send/m.room.message/node-operator-");
  });

  it("fails soft on missing target, rejected send, or network error", async () => {
    expect(await sendOwnRoomMessage("x", { resolveTarget: async () => undefined })).toBe(false);
    // Default resolver on an unconfigured host: resolves undefined → false.
    expect(
      await sendOwnRoomMessage("x", {
        fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      }),
    ).toBe(false);
    expect(
      await sendOwnRoomMessage("x", {
        fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
        resolveTarget: async () => target,
      }),
    ).toBe(false);
    expect(
      await sendOwnRoomMessage("x", {
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
        resolveTarget: async () => target,
      }),
    ).toBe(false);
  });
});
