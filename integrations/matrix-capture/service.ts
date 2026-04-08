import { mkdirSync } from "node:fs";
import * as matrixSdk from "matrix-js-sdk";
import setGlobalVars from "indexeddbshim/src/node-UnicodeIdentifiers";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const MATRIX_HOMESERVER_URL = process.env.MATRIX_HOMESERVER_URL!;
const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN!;
const MATRIX_USER_ID = process.env.MATRIX_USER_ID!;
const MATRIX_DEVICE_ID = process.env.MATRIX_DEVICE_ID;

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small";
const CHAT_MODEL = process.env.CHAT_MODEL || "openai/gpt-4o-mini";
const MATRIX_ROOM_IDS = new Set(
  (process.env.MATRIX_ROOM_IDS || "")
    .split(",")
    .map((roomId) => roomId.trim())
    .filter(Boolean)
);
const MATRIX_AUTOJOIN_INVITES = (process.env.MATRIX_AUTOJOIN_INVITES || "false") === "true";
const MATRIX_MAX_EVENT_AGE_MS = Number.parseInt(
  process.env.MATRIX_MAX_EVENT_AGE_MS || `${7 * 24 * 60 * 60 * 1000}`,
  10
);
const MATRIX_CRYPTO_DB_PREFIX = process.env.MATRIX_CRYPTO_DB_PREFIX || "ob1-matrix-capture";
const MATRIX_CRYPTO_STORE_PASSWORD = process.env.MATRIX_CRYPTO_STORE_PASSWORD;
const MATRIX_INDEXEDDB_PATH = process.env.MATRIX_INDEXEDDB_PATH || "/data/indexeddb";
const MATRIX_USE_INDEXEDDB = (process.env.MATRIX_USE_INDEXEDDB || "false") === "true";
const MATRIX_SECRET_STORAGE_KEY = process.env.MATRIX_SECRET_STORAGE_KEY;
const MATRIX_SECRET_STORAGE_KEY_BASE64 = process.env.MATRIX_SECRET_STORAGE_KEY_BASE64;
const MATRIX_SECRET_STORAGE_PASSPHRASE = process.env.MATRIX_SECRET_STORAGE_PASSPHRASE;

const ALLOWED_MSG_TYPES = new Set(["m.text", "m.notice"]);
const seenEventIds = new Set<string>();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type MatrixEvent = matrixSdk.MatrixEvent;
type MatrixRoom = matrixSdk.Room;

function requireEnv(name: string, value: string | undefined): void {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

async function resolveDeviceId(): Promise<string> {
  if (MATRIX_DEVICE_ID) return MATRIX_DEVICE_ID;

  const response = await fetch(
    `${MATRIX_HOMESERVER_URL.replace(/\/+$/, "")}/_matrix/client/v3/account/whoami`,
    {
      headers: {
        Authorization: `Bearer ${MATRIX_ACCESS_TOKEN}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to resolve Matrix device ID: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { device_id?: string };
  if (!body.device_id) {
    throw new Error("Matrix /account/whoami response did not include device_id");
  }

  return body.device_id;
}

function ensurePersistentIndexedDb(): void {
  if (typeof indexedDB !== "undefined") return;

  mkdirSync(MATRIX_INDEXEDDB_PATH, { recursive: true });

  const globalWithWindow = globalThis as typeof globalThis & { window: typeof globalThis };
  globalWithWindow.window = globalThis;

  setGlobalVars(globalThis, {
    checkOrigin: false,
    databaseBasePath: MATRIX_INDEXEDDB_PATH,
    sysDatabaseBasePath: MATRIX_INDEXEDDB_PATH,
  });

  if (typeof indexedDB === "undefined") {
    throw new Error(
      "Failed to initialize indexedDB. Install a persistent IndexedDB-backed runtime or configure indexeddbshim correctly."
    );
  }
}

function parseBase64Key(base64Value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64Value, "base64"));
}

async function getSecretStorageKey(
  keys: Record<string, matrixSdk.SecretStorage.SecretStorageKeyDescription>
): Promise<[string, Uint8Array] | null> {
  const entries = Object.entries(keys);
  if (entries.length === 0) return null;

  const [keyId, keyInfo] = entries[0];

  if (MATRIX_SECRET_STORAGE_KEY_BASE64) {
    return [keyId, parseBase64Key(MATRIX_SECRET_STORAGE_KEY_BASE64)];
  }

  if (MATRIX_SECRET_STORAGE_KEY) {
    return [keyId, new TextEncoder().encode(MATRIX_SECRET_STORAGE_KEY)];
  }

  if (MATRIX_SECRET_STORAGE_PASSPHRASE && "passphrase" in keyInfo && keyInfo.passphrase) {
    const derived = await deriveRecoveryKeyFromPassphrase(
      MATRIX_SECRET_STORAGE_PASSPHRASE,
      keyInfo.passphrase.salt,
      keyInfo.passphrase.iterations
    );
    return [keyId, derived];
  }

  return null;
}

function shouldWatchRoom(roomId: string): boolean {
  return MATRIX_ROOM_IDS.size === 0 || MATRIX_ROOM_IDS.has(roomId);
}

function getSenderDisplay(sender: string): string {
  const match = sender.match(/^@([^:]+):/);
  return match?.[1] || sender;
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

async function isAlreadyCaptured(eventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("thoughts")
    .select("id")
    .contains("metadata", { matrix_event_id: eventId })
    .limit(1);

  if (error) throw new Error(`Supabase dedupe check failed: ${error.message}`);

  return Boolean(data && data.length > 0);
}

async function captureMessage(event: MatrixEvent, room: MatrixRoom): Promise<void> {
  const eventId = event.getId();
  const roomId = room.roomId;
  const sender = event.getSender();
  const content = event.getContent();
  const body = typeof content.body === "string" ? content.body.trim() : "";
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "m.text";
  const timestamp = event.getTs();

  if (!eventId || !sender || !roomId || !timestamp) return;
  if (!shouldWatchRoom(roomId)) return;
  if (sender === MATRIX_USER_ID) return;
  if (!ALLOWED_MSG_TYPES.has(msgtype)) return;
  if (!body) return;
  if (Date.now() - timestamp > MATRIX_MAX_EVENT_AGE_MS) return;

  if (seenEventIds.has(eventId)) return;
  seenEventIds.add(eventId);

  try {
    if (await isAlreadyCaptured(eventId)) return;

    const [embedding, metadata] = await Promise.all([
      getEmbedding(body),
      extractMetadata(body),
    ]);

    const { error } = await supabase.from("thoughts").insert({
      content: body,
      embedding,
      created_at: new Date(timestamp).toISOString(),
      metadata: {
        ...metadata,
        source: "matrix",
        matrix_event_id: eventId,
        matrix_room_id: roomId,
        matrix_room_name: room.name || roomId,
        matrix_sender: sender,
        matrix_sender_display: getSenderDisplay(sender),
        matrix_msgtype: msgtype,
        matrix_homeserver: MATRIX_HOMESERVER_URL,
        matrix_origin_server_ts: timestamp,
        matrix_encrypted: event.isEncrypted(),
      },
    });

    if (error) throw new Error(error.message);

    console.log(`Captured ${eventId} from ${room.name || roomId}`);
  } catch (error) {
    console.error(`Failed to capture ${eventId}:`, error);
    seenEventIds.delete(eventId);
  }
}

function queueCapture(event: MatrixEvent, room: MatrixRoom, toStartOfTimeline?: boolean): void {
  if (toStartOfTimeline) return;

  if (event.getType() === "m.room.message" && !event.isDecryptionFailure()) {
    void captureMessage(event, room);
    return;
  }

  if (event.isEncrypted()) {
    event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
      void captureMessage(event, room);
    });
  }
}

async function main(): Promise<void> {
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("OPENROUTER_API_KEY", OPENROUTER_API_KEY);
  requireEnv("MATRIX_HOMESERVER_URL", MATRIX_HOMESERVER_URL);
  requireEnv("MATRIX_ACCESS_TOKEN", MATRIX_ACCESS_TOKEN);
  requireEnv("MATRIX_USER_ID", MATRIX_USER_ID);
  if (MATRIX_USE_INDEXEDDB) {
    ensurePersistentIndexedDb();
  }
  const deviceId = await resolveDeviceId();

  const client = matrixSdk.createClient({
    baseUrl: MATRIX_HOMESERVER_URL,
    accessToken: MATRIX_ACCESS_TOKEN,
    userId: MATRIX_USER_ID,
    deviceId,
    timelineSupport: true,
    useAuthorizationHeader: true,
    cryptoCallbacks: {
      getSecretStorageKey: async (opts) => getSecretStorageKey(opts.keys),
    },
  });

  await client.initRustCrypto({
    useIndexedDB: MATRIX_USE_INDEXEDDB,
    cryptoDatabasePrefix: MATRIX_USE_INDEXEDDB ? MATRIX_CRYPTO_DB_PREFIX : undefined,
    storagePassword: MATRIX_USE_INDEXEDDB ? MATRIX_CRYPTO_STORE_PASSWORD : undefined,
  });

  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Matrix crypto failed to initialize");
  }

  try {
    await crypto.bootstrapCrossSigning({});
    console.log("Cross-signing bootstrap complete");
  } catch (error) {
    console.warn("Cross-signing bootstrap did not complete:", error);
  }

  try {
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    console.log("Loaded session backup private key from secret storage");
  } catch (error) {
    console.warn("Failed to load session backup private key from secret storage:", error);
  }

  try {
    const backupCheck = await crypto.checkKeyBackupAndEnable();
    if (backupCheck) {
      console.log(
        `Key backup check complete: trusted=${backupCheck.trustInfo.trusted} matches=${backupCheck.trustInfo.matchesDecryptionKey}`
      );
    } else {
      console.log("No key backup configured on server");
    }
  } catch (error) {
    console.warn("Key backup check failed:", error);
  }

  client.on(matrixSdk.RoomEvent.MyMembership, (room, membership) => {
    if (!MATRIX_AUTOJOIN_INVITES) return;
    if (membership !== matrixSdk.KnownMembership.Invite) return;

    void client.joinRoom(room.roomId).then(() => {
      console.log(`Joined invited room ${room.roomId}`);
    }).catch((error) => {
      console.error(`Failed to join room ${room.roomId}:`, error);
    });
  });

  client.on(matrixSdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (!room) return;
    queueCapture(event, room, toStartOfTimeline);
  });

  client.once(matrixSdk.ClientEvent.Sync, (state) => {
    if (state === "PREPARED") {
      console.log("Matrix client prepared");
    }
  });

  await client.startClient({
    initialSyncLimit: 20,
    lazyLoadMembers: true,
  });

  const shutdown = async () => {
    console.log("Stopping Matrix capture service");
    client.stopClient();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
