import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Deterministic Matrix echo for `verify`.
 *
 * The nonce-correlated setup check must not depend on an LLM choosing to
 * relay tool output — a small model reliably EXECUTES the tool but not
 * reliably repeats its result. So the binary posts the verification echo to
 * its own room itself, exactly like Mail Sentinel's degradation notices:
 * resolve this agent's Matrix identity from the node's runtime config, read
 * the access-token secret, send one fixed-format message. The LLM may still
 * post its own relay on top; two matching messages are harmless, zero is a
 * failed check.
 *
 * Fail-soft by contract: any resolution or send failure returns
 * `{ sent: false }` and the caller still prints the echo for the LLM path.
 * Nothing read here (tokens, room ids, paths) is ever printed.
 */

const DEFAULT_CONFIG_PATH = "/etc/sovereign-node/sovereign-node.json5";

type RuntimeDocument = {
  matrix?: {
    adminBaseUrl?: string;
    alertRoom?: { roomId?: string };
    operatorRoom?: { roomId?: string };
  };
  bots?: {
    instances?: Array<{
      id?: string;
      matrix?: { alertRoom?: { roomId?: string } };
    }>;
  };
  openclawProfile?: {
    agents?: Array<{
      id?: string;
      workspace?: string;
      botInstanceId?: string;
      matrix?: { accessTokenSecretRef?: string };
    }>;
  };
};

export type MatrixReplyTarget = {
  homeserverUrl: string;
  roomId: string;
  accessToken: string;
};

type ResolveDeps = {
  env?: Record<string, string | undefined>;
  argv1?: string | undefined;
  readFileFn?: (path: string, encoding: "utf8") => Promise<string>;
};

/**
 * Resolve this bot's own room + credentials from the runtime config. The
 * agent is located by its workspace (derived from the running binary path,
 * never from input); the room follows the same precedence the node applies:
 * instance override → operator room → alert room.
 */
export const resolveMatrixReplyTarget = async (
  deps: ResolveDeps = {},
): Promise<MatrixReplyTarget | undefined> => {
  const env = deps.env ?? process.env;
  const argv1 = deps.argv1 ?? process.argv[1];
  const readFileFn = deps.readFileFn ?? (async (path, encoding) => readFile(path, encoding));
  try {
    const configPath = env.SOVEREIGN_NODE_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
    const parsed = JSON.parse(await readFileFn(configPath, "utf8")) as RuntimeDocument;

    const binPath = typeof argv1 === "string" && argv1.length > 0 ? resolvePath(argv1) : "";
    const agent = parsed.openclawProfile?.agents?.find(
      (entry) =>
        typeof entry.workspace === "string" &&
        entry.workspace.length > 0 &&
        binPath.startsWith(`${entry.workspace}/`),
    );
    const tokenRef = agent?.matrix?.accessTokenSecretRef;
    if (agent === undefined || typeof tokenRef !== "string" || !tokenRef.startsWith("file:")) {
      return undefined;
    }
    const accessToken = (await readFileFn(tokenRef.slice("file:".length), "utf8")).trim();
    if (accessToken.length === 0) {
      return undefined;
    }

    const instance = parsed.bots?.instances?.find(
      (candidate) => candidate.id === agent.botInstanceId,
    );
    const roomId =
      instance?.matrix?.alertRoom?.roomId ??
      parsed.matrix?.operatorRoom?.roomId ??
      parsed.matrix?.alertRoom?.roomId;
    const homeserverUrl = parsed.matrix?.adminBaseUrl;
    if (
      typeof roomId !== "string" ||
      roomId.length === 0 ||
      typeof homeserverUrl !== "string" ||
      homeserverUrl.length === 0
    ) {
      return undefined;
    }
    return { homeserverUrl, roomId, accessToken };
  } catch {
    return undefined;
  }
};

type SendDeps = {
  fetchImpl?: typeof fetch;
  resolveTarget?: () => Promise<MatrixReplyTarget | undefined>;
  txnId?: string;
};

/** Post `text` to the bot's own room. Returns whether the room accepted it. */
export const sendOwnRoomMessage = async (text: string, deps: SendDeps = {}): Promise<boolean> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveTarget = deps.resolveTarget ?? resolveMatrixReplyTarget;
  try {
    const target = await resolveTarget();
    if (target === undefined) {
      return false;
    }
    const txnId = deps.txnId ?? `node-operator-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const base = target.homeserverUrl.endsWith("/")
      ? target.homeserverUrl
      : `${target.homeserverUrl}/`;
    const endpoint = new URL(
      `_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      base,
    ).toString();
    const response = await fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${target.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body: text }),
    });
    return response.ok;
  } catch {
    return false;
  }
};
