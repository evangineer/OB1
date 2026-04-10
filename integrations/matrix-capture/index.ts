import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import * as matrixSdk from "npm:matrix-js-sdk@36.2.0";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MATRIX_HOMESERVER_URL = Deno.env.get("MATRIX_HOMESERVER_URL")!;
const MATRIX_ACCESS_TOKEN = Deno.env.get("MATRIX_ACCESS_TOKEN")!;
const MATRIX_USER_ID = Deno.env.get("MATRIX_USER_ID")!;
const MATRIX_CAPTURE_SECRET = Deno.env.get("MATRIX_CAPTURE_SECRET")!;

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "openai/text-embedding-3-small";
const CHAT_MODEL = Deno.env.get("CHAT_MODEL") || "openai/gpt-4o-mini";
const MATRIX_ROOM_IDS = (Deno.env.get("MATRIX_ROOM_IDS") || "")
  .split(",")
  .map((roomId) => roomId.trim())
  .filter(Boolean);
const MATRIX_INITIAL_SYNC_LIMIT = Number.parseInt(
  Deno.env.get("MATRIX_INITIAL_SYNC_LIMIT") || "20",
  10
);
const MATRIX_MAX_EVENTS_PER_RUN = Number.parseInt(
  Deno.env.get("MATRIX_MAX_EVENTS_PER_RUN") || "20",
  10
);
const MATRIX_SYNC_TIMEOUT_MS = Number.parseInt(
  Deno.env.get("MATRIX_SYNC_TIMEOUT_MS") || "15000",
  10
);
const MATRIX_MAX_EVENT_AGE_MS = Number.parseInt(
  Deno.env.get("MATRIX_MAX_EVENT_AGE_MS") || `${24 * 60 * 60 * 1000}`,
  10
);
const ALLOWED_MSG_TYPES = new Set(["m.text", "m.notice"]);

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type MatrixEventLike = {
  getId?: () => string | undefined;
  getType?: () => string | undefined;
  getRoomId?: () => string | undefined;
  getSender?: () => string | undefined;
  getTs?: () => number;
  getContent?: () => Record<string, unknown>;
  getUnsigned?: () => Record<string, unknown>;
};

type MatrixRoomLike = {
  roomId?: string;
  name?: string;
  getLiveTimeline?: () => { getEvents?: () => MatrixEventLike[] };
};

type CapturableEvent = {
  body: string;
  eventId: string;
  roomId: string;
  roomName: string;
  sender: string;
  senderDisplay: string;
  timestamp: number;
  msgtype: string;
};

function getRequiredEnv(): string[] {
  const missing: string[] = [];

  for (const [key, value] of Object.entries({
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    OPENROUTER_API_KEY,
    MATRIX_HOMESERVER_URL,
    MATRIX_ACCESS_TOKEN,
    MATRIX_USER_ID,
    MATRIX_CAPTURE_SECRET,
  })) {
    if (!value) missing.push(key);
  }

  return missing;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAuthorized(req: Request): boolean {
  const bearer = req.headers.get("authorization");
  const sharedSecret = req.headers.get("x-matrix-capture-secret");

  return bearer === `Bearer ${MATRIX_CAPTURE_SECRET}` || sharedSecret === MATRIX_CAPTURE_SECRET;
}

function getRoomName(room: MatrixRoomLike): string {
  return room.name?.trim() || room.roomId || "unknown-room";
}

function getSenderDisplay(sender: string): string {
  const match = sender.match(/^@([^:]+):/);
  return match?.[1] || sender;
}

function extractEvent(event: MatrixEventLike, room: MatrixRoomLike): CapturableEvent | null {
  const type = event.getType?.();
  if (type !== "m.room.message") return null;

  const content = event.getContent?.() || {};
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "m.text";
  if (!ALLOWED_MSG_TYPES.has(msgtype)) return null;

  const body = typeof content.body === "string" ? content.body.trim() : "";
  if (!body) return null;

  if (content["m.relates_to"]) return null;

  const sender = event.getSender?.();
  const eventId = event.getId?.();
  const roomId = event.getRoomId?.() || room.roomId;
  const timestamp = event.getTs?.() || Date.now();

  if (!sender || !eventId || !roomId) return null;
  if (sender === MATRIX_USER_ID) return null;
  if (Date.now() - timestamp > MATRIX_MAX_EVENT_AGE_MS) return null;

  const unsigned = event.getUnsigned?.() || {};
  if (typeof unsigned.redacted_because === "object") return null;

  return {
    body,
    eventId,
    roomId,
    roomName: getRoomName(room),
    sender,
    senderDisplay: getSenderDisplay(sender),
    timestamp,
    msgtype,
  };
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${response.status} ${msg}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    const msg = await response.text().catch(() => "");
    throw new Error(`OpenRouter metadata extraction failed: ${response.status} ${msg}`);
  }

  const data = await response.json();

  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

async function waitForPrepared(client: matrixSdk.MatrixClient): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.stopClient();
      reject(new Error(`Matrix initial sync timed out after ${MATRIX_SYNC_TIMEOUT_MS}ms`));
    }, MATRIX_SYNC_TIMEOUT_MS);

    client.once(matrixSdk.ClientEvent.Sync, (state: string) => {
      if (state === "PREPARED") {
        clearTimeout(timer);
        resolve();
        return;
      }

      if (state === "ERROR") {
        clearTimeout(timer);
        reject(new Error("Matrix initial sync failed"));
      }
    });

    client.startClient({
      initialSyncLimit: MATRIX_INITIAL_SYNC_LIMIT,
      lazyLoadMembers: true,
      pollTimeout: Math.min(MATRIX_SYNC_TIMEOUT_MS, 5000),
    });
  });
}

async function isAlreadyCaptured(eventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id")
    .contains("metadata", { matrix_event_id: eventId })
    .limit(1);

  if (error) throw new Error(`Supabase dedupe check failed: ${error.message}`);

  return Boolean(data && data.length > 0);
}

async function ingestEvent(event: CapturableEvent): Promise<void> {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(event.body),
    extractMetadata(event.body),
  ]);

  const { error } = await supabase.from("thoughts").insert({
    content: event.body,
    embedding,
    created_at: new Date(event.timestamp).toISOString(),
    metadata: {
      ...metadata,
      source: "matrix",
      matrix_event_id: event.eventId,
      matrix_room_id: event.roomId,
      matrix_room_name: event.roomName,
      matrix_sender: event.sender,
      matrix_sender_display: event.senderDisplay,
      matrix_msgtype: event.msgtype,
      matrix_homeserver: MATRIX_HOMESERVER_URL,
      matrix_origin_server_ts: event.timestamp,
    },
  });

  if (error) {
    throw new Error(`Supabase insert failed for ${event.eventId}: ${error.message}`);
  }
}

function collectCandidateEvents(client: matrixSdk.MatrixClient): CapturableEvent[] {
  const allowedRooms = new Set(MATRIX_ROOM_IDS);
  const rooms = client.getRooms() as MatrixRoomLike[];

  const candidates = rooms
    .filter((room) => allowedRooms.size === 0 || allowedRooms.has(room.roomId || ""))
    .flatMap((room) => {
      const events = room.getLiveTimeline?.()?.getEvents?.() || [];
      return events
        .map((event) => extractEvent(event, room))
        .filter((event): event is CapturableEvent => Boolean(event));
    })
    .sort((a, b) => a.timestamp - b.timestamp);

  if (candidates.length <= MATRIX_MAX_EVENTS_PER_RUN) return candidates;
  return candidates.slice(candidates.length - MATRIX_MAX_EVENTS_PER_RUN);
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return json({
      ok: true,
      integration: "matrix-capture",
      route: "invoke with POST plus bearer secret to run a capture sync",
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const missing = getRequiredEnv();
  if (missing.length > 0) {
    return json({ error: "Missing required environment variables", missing }, 500);
  }

  const client = matrixSdk.createClient({
    baseUrl: MATRIX_HOMESERVER_URL,
    accessToken: MATRIX_ACCESS_TOKEN,
    userId: MATRIX_USER_ID,
    timelineSupport: true,
    useAuthorizationHeader: true,
  });

  try {
    await waitForPrepared(client);

    const candidates = collectCandidateEvents(client);
    const roomIdsSeen = [...new Set(candidates.map((event) => event.roomId))];
    const skipped: string[] = [];
    const ingested: string[] = [];

    for (const event of candidates) {
      if (await isAlreadyCaptured(event.eventId)) {
        skipped.push(event.eventId);
        continue;
      }

      await ingestEvent(event);
      ingested.push(event.eventId);
    }

    return json({
      ok: true,
      homeserver: MATRIX_HOMESERVER_URL,
      rooms_seen: roomIdsSeen,
      candidate_events: candidates.length,
      ingested_count: ingested.length,
      skipped_existing_count: skipped.length,
      ingested_event_ids: ingested,
      skipped_event_ids: skipped,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  } finally {
    client.stopClient();
  }
});
