import { executeOperatorCommand, parseOperatorMessage } from "./dispatch.js";
import { resolveMatrixReplyTarget, type ServeContext, sendOwnRoomMessage } from "./matrix-reply.js";

/**
 * The deterministic Matrix daemon (`node-operator.js serve`).
 *
 * Runs as a systemd service declared in the bot manifest, with its OWN
 * Matrix client — the OpenClaw gateway has no account and no binding for
 * this bot, so no LLM ever sees the control room. Every incoming event goes
 * through code:
 *
 *   1. Only the configured Sovereign Node room is processed. DMs and any
 *      other room are ignored entirely (Maintained Beta default:
 *      allowOperatorDms=false; even when enabled, only the room's event
 *      shape is supported today and non-room traffic stays ignored).
 *   2. Only `m.room.message` events with a stable string sender and a
 *      string body participate; malformed events are dropped silently.
 *   3. The bot's own events are dropped (no self-loops; also covers any
 *      other bot account since it will not be in the allowlist).
 *   4. The sender must be in the EXPLICIT operator allowlist. Room
 *      membership grants nothing: unauthorized members are ignored
 *      silently — no reply, no echo, no error that could be farmed.
 *   5. The text is parsed by the closed deterministic grammar; authorized
 *      senders with an unrecognised message get fixed help text.
 *
 * The initial sync's `next_batch` is taken WITHOUT processing its timeline,
 * so restarts never replay history as fresh commands.
 */

/** Long-poll window for /sync. */
export const SYNC_TIMEOUT_MS = 30_000;

/** Backoff after a failed sync before trying again. */
export const SYNC_ERROR_BACKOFF_MS = 5_000;

type SyncEvent = {
  type?: unknown;
  sender?: unknown;
  event_id?: unknown;
  content?: { body?: unknown; msgtype?: unknown };
};

type SyncResponse = {
  next_batch?: unknown;
  rooms?: { join?: Record<string, { timeline?: { events?: unknown } }> };
};

export type ServeDeps = {
  fetchImpl?: typeof fetch;
  resolveContext?: () => Promise<ServeContext | undefined>;
  sleep?: (ms: number) => Promise<void>;
  /** Test bound: stop after this many sync iterations. */
  maxIterations?: number;
  log?: (line: string) => void;
};

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const syncUrl = (context: ServeContext, since: string | undefined, timeoutMs: number): string => {
  const base = context.homeserverUrl.endsWith("/")
    ? context.homeserverUrl
    : `${context.homeserverUrl}/`;
  const url = new URL("_matrix/client/v3/sync", base);
  url.searchParams.set("timeout", String(timeoutMs));
  if (since !== undefined) {
    url.searchParams.set("since", since);
  }
  return url.toString();
};

/** Extract the room-message events for OUR room only; everything else is dropped. */
export const extractRoomEvents = (
  body: unknown,
  roomId: string,
): Array<{ sender: string; eventId: string; text: string }> => {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const events = (body as SyncResponse).rooms?.join?.[roomId]?.timeline?.events;
  if (!Array.isArray(events)) {
    return [];
  }
  const extracted: Array<{ sender: string; eventId: string; text: string }> = [];
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const event = raw as SyncEvent;
    if (event.type !== "m.room.message") {
      continue;
    }
    if (typeof event.sender !== "string" || event.sender.length === 0) {
      // No stable sender identity — drop.
      continue;
    }
    if (typeof event.event_id !== "string" || event.event_id.length === 0) {
      continue;
    }
    if (typeof event.content?.body !== "string") {
      continue;
    }
    extracted.push({ sender: event.sender, eventId: event.event_id, text: event.content.body });
  }
  return extracted;
};

/**
 * Handle one event end-to-end. Exported for tests. Returns what was done:
 * "unauthorized" and "self" produce NO reply by design.
 */
export const handleRoomEvent = async (
  context: ServeContext,
  event: { sender: string; eventId: string; text: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<"replied" | "self" | "unauthorized"> => {
  if (event.sender === context.botUserId) {
    return "self";
  }
  if (!context.authorizedUserIds.includes(event.sender)) {
    // Explicit allowlist only. Membership, power levels, or mentions grant
    // nothing. Silent by design: no reply an outsider could farm.
    return "unauthorized";
  }
  const parsed = parseOperatorMessage(event.text, context.botUserId);
  const outcome = await executeOperatorCommand(parsed);
  await sendOwnRoomMessage(outcome.text, {
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    resolveTarget: async () => context,
    ...(outcome.replyRelatesToTrigger ? { inReplyToEventId: event.eventId } : {}),
  });
  return "replied";
};

/** The daemon loop. Returns only when maxIterations is reached (tests). */
export const runServe = async (deps: ServeDeps = {}): Promise<void> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveContext = deps.resolveContext ?? resolveMatrixReplyTarget;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  let context: ServeContext | undefined;
  let since: string | undefined;
  let iterations = 0;

  while (deps.maxIterations === undefined || iterations < deps.maxIterations) {
    iterations += 1;
    try {
      if (context === undefined) {
        context = await resolveContext();
        if (context === undefined) {
          log("node-operator serve: node not configured yet; retrying");
          await sleep(SYNC_ERROR_BACKOFF_MS);
          continue;
        }
        if (context.authorizedUserIds.length === 0) {
          log("node-operator serve: no authorized operators configured; commands are disabled");
        }
        since = undefined;
      }
      // First sync (no since): take the position WITHOUT processing events,
      // so a restart never replays old messages as fresh commands.
      const response = await fetchImpl(
        syncUrl(context, since, since === undefined ? 0 : SYNC_TIMEOUT_MS),
        {
          method: "GET",
          headers: { Authorization: `Bearer ${context.accessToken}`, Accept: "application/json" },
        },
      );
      if (response.status === 401) {
        // Token was rotated (identity repair) — re-resolve and continue.
        context = undefined;
        await sleep(SYNC_ERROR_BACKOFF_MS);
        continue;
      }
      if (!response.ok) {
        await sleep(SYNC_ERROR_BACKOFF_MS);
        continue;
      }
      const body: unknown = JSON.parse(await response.text());
      const nextBatch = (body as SyncResponse).next_batch;
      const isInitial = since === undefined;
      if (typeof nextBatch === "string" && nextBatch.length > 0) {
        since = nextBatch;
      }
      if (isInitial) {
        continue;
      }
      for (const event of extractRoomEvents(body, context.roomId)) {
        await handleRoomEvent(context, event, { fetchImpl });
      }
    } catch {
      await sleep(SYNC_ERROR_BACKOFF_MS);
    }
  }
};
