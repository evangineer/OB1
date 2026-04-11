import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type * as MatrixSdk from "matrix-js-sdk";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase.js";
import {
  VerifierEvent,
  type GeneratedSas,
  type ShowSasCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";

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
const MATRIX_INDEXEDDB_SNAPSHOT_PATH =
  process.env.MATRIX_INDEXEDDB_SNAPSHOT_PATH || join(MATRIX_INDEXEDDB_PATH, "crypto-idb-snapshot.bin");
const MATRIX_USE_INDEXEDDB = (process.env.MATRIX_USE_INDEXEDDB || "false") === "true";
const MATRIX_SECRET_STORAGE_KEY = process.env.MATRIX_SECRET_STORAGE_KEY;
const MATRIX_SECRET_STORAGE_KEY_BASE64 = process.env.MATRIX_SECRET_STORAGE_KEY_BASE64;
const MATRIX_SECRET_STORAGE_PASSPHRASE = process.env.MATRIX_SECRET_STORAGE_PASSPHRASE;
const SNAPSHOT_WRITE_INTERVAL_MS = 15_000;
const ENCRYPTED_EVENT_RETRY_DELAYS_MS = [250, 1000, 3000, 7000, 15000];

const ALLOWED_MSG_TYPES = new Set(["m.text", "m.notice"]);
const seenEventIds = new Set<string>();
const handledVerificationRequests = new Set<string>();
const TIMELINE_DEBUG = (process.env.MATRIX_TIMELINE_DEBUG || "false") === "true";
const pendingEncryptedEventRetries = new Map<string, NodeJS.Timeout>();

type RuntimeMatrixSdk = Pick<
  typeof MatrixSdk,
  | "ClientEvent"
  | "CryptoEvent"
  | "KnownMembership"
  | "MatrixEventEvent"
  | "RoomEvent"
  | "createClient"
>;
let matrixSdk: RuntimeMatrixSdk;
let supabase: ReturnType<typeof createClient<Database>> | undefined;

type MatrixEvent = MatrixSdk.MatrixEvent;
type MatrixRoom = MatrixSdk.Room;
type MatrixIndexMetadata = {
  keyPath: string | string[] | null;
  multiEntry: boolean;
  name: string;
  unique: boolean;
};
type MatrixObjectStoreSnapshot = {
  autoIncrement: boolean;
  indexes: MatrixIndexMetadata[];
  keyPath: string | string[] | null;
  name: string;
  records: Array<{ key: unknown; value: unknown }>;
};
type MatrixDatabaseSnapshot = {
  name: string;
  objectStores: MatrixObjectStoreSnapshot[];
  version: number;
};
type MatrixIndexedDbSnapshot = {
  databases: MatrixDatabaseSnapshot[];
  savedAt: string;
};

let snapshotPersistTimer: NodeJS.Timeout | undefined;
let snapshotPersistInFlight = false;

function requireEnv(name: string, value: string | undefined): void {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function getSupabaseClient(): ReturnType<typeof createClient<Database>> {
  if (!supabase) {
    requireEnv("SUPABASE_URL", SUPABASE_URL);
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
    supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }

  return supabase;
}

function debugTimeline(message: string, details: Record<string, unknown>): void {
  if (!TIMELINE_DEBUG) return;
  console.log(`[timeline] ${message} ${JSON.stringify(details)}`);
}

function clearEncryptedRetry(eventId: string | null | undefined): void {
  if (!eventId) return;
  const timer = pendingEncryptedEventRetries.get(eventId);
  if (!timer) return;
  clearTimeout(timer);
  pendingEncryptedEventRetries.delete(eventId);
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

async function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function openDatabase(name: string, version?: number, onUpgrade?: (database: IDBDatabase) => void): Promise<IDBDatabase> {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);

  if (onUpgrade) {
    request.onupgradeneeded = () => {
      onUpgrade(request.result);
    };
  }

  return await requestToPromise(request);
}

async function withSnapshotLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = `${MATRIX_INDEXEDDB_SNAPSHOT_PATH}.lock`;
  const deadline = Date.now() + 10_000;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Matrix IndexedDB snapshot lock at ${lockPath}`, { cause: error });
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  }
}

function ensurePersistentIndexedDb(): void {
  if (typeof indexedDB !== "undefined") return;

  mkdirSync(MATRIX_INDEXEDDB_PATH, { recursive: true });
  mkdirSync(dirname(MATRIX_INDEXEDDB_SNAPSHOT_PATH), { recursive: true });

  const globalRecord = globalThis as Record<string, unknown>;
  globalRecord.window = globalThis;
  globalRecord.self = globalThis;
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.IDBFactory = IDBFactory;
  globalThis.IDBKeyRange = IDBKeyRange;
  globalThis.IDBDatabase = IDBDatabase;
  globalThis.IDBObjectStore = IDBObjectStore;
  globalThis.IDBIndex = IDBIndex;
  globalThis.IDBCursor = IDBCursor;
  globalThis.IDBCursorWithValue = IDBCursorWithValue;
  globalThis.IDBTransaction = IDBTransaction;
  globalThis.IDBRequest = IDBRequest;
  globalThis.IDBOpenDBRequest = IDBOpenDBRequest;
  globalThis.IDBVersionChangeEvent = IDBVersionChangeEvent;

  if (typeof indexedDB === "undefined") {
    throw new Error("Failed to initialize fake-indexeddb runtime");
  }
}

async function snapshotObjectStore(store: IDBObjectStore): Promise<MatrixObjectStoreSnapshot> {
  const records = await requestToPromise(store.getAll());
  const keys = await requestToPromise(store.getAllKeys());
  const indexes = Array.from(store.indexNames).map((name) => {
    const index = store.index(name);

    return {
      keyPath: index.keyPath,
      multiEntry: index.multiEntry,
      name,
      unique: index.unique,
    };
  });

  return {
    autoIncrement: store.autoIncrement,
    indexes,
    keyPath: store.keyPath,
    name: store.name,
    records: records.map((value, index) => ({
      key: keys[index],
      value,
    })),
  };
}

async function buildIndexedDbSnapshot(): Promise<MatrixIndexedDbSnapshot> {
  const databaseInfos = await indexedDB.databases();
  const snapshots: MatrixDatabaseSnapshot[] = [];

  for (const info of databaseInfos) {
    if (!info.name) continue;
    if (!info.name.startsWith(MATRIX_CRYPTO_DB_PREFIX)) continue;

    const database = await openDatabase(info.name);
    const objectStoreNames = Array.from(database.objectStoreNames);
    const objectStores: MatrixObjectStoreSnapshot[] = [];

    for (const storeName of objectStoreNames) {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      objectStores.push(await snapshotObjectStore(store));
      await transactionDone(transaction);
    }

    snapshots.push({
      name: info.name,
      objectStores,
      version: info.version ?? database.version,
    });

    database.close();
  }

  return {
    databases: snapshots,
    savedAt: new Date().toISOString(),
  };
}

async function restoreObjectStore(
  database: IDBDatabase,
  snapshot: MatrixObjectStoreSnapshot
): Promise<void> {
  const transaction = database.transaction(snapshot.name, "readwrite");
  const store = transaction.objectStore(snapshot.name);

  for (const record of snapshot.records) {
    if (snapshot.keyPath === null) {
      store.put(record.value, record.key as IDBValidKey);
    } else {
      store.put(record.value);
    }
  }

  await transactionDone(transaction);
}

async function restoreIndexedDbSnapshot(): Promise<void> {
  if (!existsSync(MATRIX_INDEXEDDB_SNAPSHOT_PATH)) return;

  await withSnapshotLock(async () => {
    if (!existsSync(MATRIX_INDEXEDDB_SNAPSHOT_PATH)) return;

    const snapshot = deserialize(readFileSync(MATRIX_INDEXEDDB_SNAPSHOT_PATH)) as MatrixIndexedDbSnapshot;

    for (const databaseSnapshot of snapshot.databases) {
      const database = await openDatabase(databaseSnapshot.name, databaseSnapshot.version, (upgradeDatabase) => {
        for (const storeSnapshot of databaseSnapshot.objectStores) {
          const store = upgradeDatabase.createObjectStore(storeSnapshot.name, {
            autoIncrement: storeSnapshot.autoIncrement,
            keyPath: storeSnapshot.keyPath,
          });

          for (const index of storeSnapshot.indexes) {
            if (!store.indexNames.contains(index.name)) {
              store.createIndex(index.name, index.keyPath as string | string[], {
                multiEntry: index.multiEntry,
                unique: index.unique,
              });
            }
          }
        }
      });

      for (const storeSnapshot of databaseSnapshot.objectStores) {
        await restoreObjectStore(database, storeSnapshot);
      }

      database.close();
    }
  });
}

async function persistIndexedDbSnapshot(reason: string): Promise<void> {
  if (!MATRIX_USE_INDEXEDDB || snapshotPersistInFlight) return;
  snapshotPersistInFlight = true;

  try {
    const snapshot = await buildIndexedDbSnapshot();

    await withSnapshotLock(async () => {
      const tempPath = `${MATRIX_INDEXEDDB_SNAPSHOT_PATH}.tmp`;
      writeFileSync(tempPath, serialize(snapshot), {
        mode: 0o600,
      });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, MATRIX_INDEXEDDB_SNAPSHOT_PATH);
      chmodSync(MATRIX_INDEXEDDB_SNAPSHOT_PATH, 0o600);
    });

    console.log(`Persisted Matrix IndexedDB snapshot (${reason}) to ${MATRIX_INDEXEDDB_SNAPSHOT_PATH}`);
  } finally {
    snapshotPersistInFlight = false;
  }
}

function scheduleSnapshotPersistence(): void {
  if (!MATRIX_USE_INDEXEDDB || snapshotPersistTimer) return;

  snapshotPersistTimer = setInterval(() => {
    void persistIndexedDbSnapshot("interval").catch((error) => {
      console.error("Failed to persist Matrix IndexedDB snapshot:", error);
    });
  }, SNAPSHOT_WRITE_INTERVAL_MS);
  snapshotPersistTimer.unref();
}

function stopSnapshotPersistence(): void {
  if (!snapshotPersistTimer) return;
  clearInterval(snapshotPersistTimer);
  snapshotPersistTimer = undefined;
}

async function preparePersistentIndexedDb(): Promise<void> {
  ensurePersistentIndexedDb();
  await restoreIndexedDbSnapshot();
}

async function persistSnapshotOnShutdown(): Promise<void> {
  stopSnapshotPersistence();

  try {
    await persistIndexedDbSnapshot("shutdown");
  } catch (error) {
    console.error("Failed to persist Matrix IndexedDB snapshot during shutdown:", error);
  }
}

async function loadMatrixSdk(): Promise<RuntimeMatrixSdk> {
  if (matrixSdk) return matrixSdk;

  if (MATRIX_USE_INDEXEDDB) {
    await preparePersistentIndexedDb();
    matrixSdk = (await import("matrix-js-sdk/lib/browser-index.js")) as RuntimeMatrixSdk;
  } else {
    matrixSdk = (await import("matrix-js-sdk")) as RuntimeMatrixSdk;
  }

  return matrixSdk;
}

function parseBase64Key(base64Value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64Value, "base64"));
}

async function getSecretStorageKey(
  keys: Record<string, MatrixSdk.SecretStorage.SecretStorageKeyDescription>
): Promise<[string, Uint8Array] | null> {
  const entries = Object.entries(keys);
  if (entries.length === 0) return null;

  const [keyId, keyInfo] = entries[0];

  if (MATRIX_SECRET_STORAGE_KEY_BASE64) {
    return [keyId, parseBase64Key(MATRIX_SECRET_STORAGE_KEY_BASE64)];
  }

  if (MATRIX_SECRET_STORAGE_KEY) {
    return [keyId, decodeRecoveryKey(MATRIX_SECRET_STORAGE_KEY)];
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
  const { data, error } = await getSupabaseClient()
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

  debugTimeline("captureMessage.enter", {
    bodyLength: body.length,
    encrypted: event.isEncrypted(),
    eventId,
    eventType: event.getType(),
    msgtype,
    roomId,
    sender,
    timestamp,
  });

  if (!eventId || !sender || !roomId || !timestamp) {
    debugTimeline("captureMessage.skip.missing", { eventId, roomId, sender, timestamp });
    return;
  }
  if (!shouldWatchRoom(roomId)) {
    debugTimeline("captureMessage.skip.unwatched_room", { eventId, roomId });
    return;
  }
  if (sender !== MATRIX_USER_ID) {
    debugTimeline("captureMessage.skip.other_sender", { eventId, sender });
    return;
  }
  if (!ALLOWED_MSG_TYPES.has(msgtype)) {
    debugTimeline("captureMessage.skip.msgtype", { eventId, msgtype });
    return;
  }
  if (!body) {
    debugTimeline("captureMessage.skip.empty_body", { eventId, msgtype });
    return;
  }
  if (Date.now() - timestamp > MATRIX_MAX_EVENT_AGE_MS) {
    debugTimeline("captureMessage.skip.old", {
      ageMs: Date.now() - timestamp,
      eventId,
      maxAgeMs: MATRIX_MAX_EVENT_AGE_MS,
    });
    return;
  }

  if (seenEventIds.has(eventId)) {
    debugTimeline("captureMessage.skip.seen", { eventId });
    return;
  }
  seenEventIds.add(eventId);

  try {
    if (await isAlreadyCaptured(eventId)) {
      debugTimeline("captureMessage.skip.already_captured", { eventId });
      return;
    }

    const [embedding, metadata] = await Promise.all([
      getEmbedding(body),
      extractMetadata(body),
    ]);

    debugTimeline("captureMessage.insert.start", {
      eventId,
      metadataType: metadata?.type,
      topics: Array.isArray(metadata?.topics) ? metadata.topics : [],
    });

    const { error } = await getSupabaseClient().from("thoughts").insert({
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

    debugTimeline("captureMessage.insert.success", { eventId, roomId });
    console.log(`Captured ${eventId} from ${room.name || roomId}`);
  } catch (error) {
    console.error(`Failed to capture ${eventId}:`, error);
    seenEventIds.delete(eventId);
  }
}

function queueCapture(event: MatrixEvent, room: MatrixRoom, toStartOfTimeline?: boolean): void {
  debugTimeline("queueCapture.event", {
    decryptedFailure: event.isDecryptionFailure(),
    encrypted: event.isEncrypted(),
    eventId: event.getId(),
    eventType: event.getType(),
    roomId: room.roomId,
    sender: event.getSender(),
    toStartOfTimeline: Boolean(toStartOfTimeline),
  });

  if (toStartOfTimeline) {
    debugTimeline("queueCapture.skip.backfill", {
      eventId: event.getId(),
      roomId: room.roomId,
    });
    return;
  }

  if (event.getType() === "m.room.message" && !event.isDecryptionFailure()) {
    clearEncryptedRetry(event.getId());
    debugTimeline("queueCapture.capture_immediate", {
      eventId: event.getId(),
      roomId: room.roomId,
    });
    void captureMessage(event, room);
    return;
  }

  if (event.isEncrypted()) {
    const eventId = event.getId();

    const retryCapture = (attempt: number) => {
      const currentEventId = event.getId();
      if (!currentEventId) return;

      if (event.getType() === "m.room.message" && !event.isDecryptionFailure()) {
        clearEncryptedRetry(currentEventId);
        debugTimeline("queueCapture.retry.capture", {
          attempt,
          eventId: currentEventId,
          roomId: room.roomId,
        });
        void captureMessage(event, room);
        return;
      }

      const delayMs = ENCRYPTED_EVENT_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        clearEncryptedRetry(currentEventId);
        debugTimeline("queueCapture.retry.give_up", {
          attempt,
          decryptionFailure: event.isDecryptionFailure(),
          eventId: currentEventId,
          eventType: event.getType(),
          roomId: room.roomId,
        });
        return;
      }

      debugTimeline("queueCapture.retry.schedule", {
        attempt,
        delayMs,
        decryptionFailure: event.isDecryptionFailure(),
        eventId: currentEventId,
        eventType: event.getType(),
        roomId: room.roomId,
      });

      const timer = setTimeout(() => {
        pendingEncryptedEventRetries.delete(currentEventId);
        retryCapture(attempt + 1);
      }, delayMs);
      pendingEncryptedEventRetries.set(currentEventId, timer);
    };

    event.once(matrixSdk.MatrixEventEvent.Decrypted, () => {
      clearEncryptedRetry(eventId);
      debugTimeline("queueCapture.decrypted", {
        decryptionFailure: event.isDecryptionFailure(),
        eventId: event.getId(),
        eventType: event.getType(),
        roomId: room.roomId,
      });
      void captureMessage(event, room);
    });
    debugTimeline("queueCapture.await_decrypt", {
      eventId: event.getId(),
      roomId: room.roomId,
    });
    if (eventId && !pendingEncryptedEventRetries.has(eventId)) {
      retryCapture(0);
    }
  }
}

function formatSas(sas: GeneratedSas): string {
  if (sas.emoji?.length) {
    return sas.emoji.map((entry: [string, string]) => `${entry[0]} ${entry[1]}`).join(" | ");
  }

  if (sas.decimal?.length) {
    return sas.decimal.join("-");
  }

  return "unavailable";
}

async function handleVerificationRequest(
  request: VerificationRequest
): Promise<void> {
  const requestId = request.transactionId || `${request.otherUserId}:${request.otherDeviceId || "unknown"}`;
  if (handledVerificationRequests.has(requestId)) return;
  handledVerificationRequests.add(requestId);

  if (request.otherUserId !== MATRIX_USER_ID) {
    return;
  }

  console.log(
    `Handling self-verification request ${requestId} from ${request.otherUserId} device ${request.otherDeviceId || "unknown"}`
  );

  try {
    await request.accept();
    console.log(`Accepted verification request ${requestId}`);

    const verifier = await waitForVerifier(requestId, request);

    verifier.on(VerifierEvent.ShowSas, (callbacks: ShowSasCallbacks) => {
      console.log(
        `Auto-confirming SAS for request ${requestId}: ${formatSas(callbacks.sas)}`
      );
      void callbacks.confirm().catch((error: unknown) => {
        console.error(`Failed to confirm SAS for request ${requestId}:`, error);
      });
    });

    verifier.on(VerifierEvent.Cancel, (error: Error | MatrixEvent) => {
      console.warn(`Verification ${requestId} was cancelled:`, error);
    });

    await verifier.verify();
    console.log(`Verification ${requestId} completed`);
  } catch (error) {
    handledVerificationRequests.delete(requestId);
    console.error(`Failed to handle verification request ${requestId}:`, error);
  }
}

async function waitForVerifier(
  requestId: string,
  request: VerificationRequest
) {
  if (request.verifier) {
    console.log(`Verification request ${requestId} already has verifier`);
    return request.verifier;
  }

  const start = Date.now();

  while (Date.now() - start < 30000) {
    if (request.verifier) {
      console.log(`Verification request ${requestId} obtained verifier`);
      return request.verifier;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for verifier on request ${requestId}`);
}

async function main(): Promise<void> {
  const sdk = await loadMatrixSdk();

  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("OPENROUTER_API_KEY", OPENROUTER_API_KEY);
  requireEnv("MATRIX_HOMESERVER_URL", MATRIX_HOMESERVER_URL);
  requireEnv("MATRIX_ACCESS_TOKEN", MATRIX_ACCESS_TOKEN);
  requireEnv("MATRIX_USER_ID", MATRIX_USER_ID);
  const deviceId = await resolveDeviceId();

  const client = sdk.createClient({
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
    storagePassword: MATRIX_USE_INDEXEDDB ? MATRIX_CRYPTO_STORE_PASSWORD : undefined,
  });

  if (MATRIX_USE_INDEXEDDB) {
    await persistIndexedDbSnapshot("post-init");
    scheduleSnapshotPersistence();
  }

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

  client.on(sdk.RoomEvent.MyMembership, (room, membership) => {
    if (!MATRIX_AUTOJOIN_INVITES) return;
    if (membership !== sdk.KnownMembership.Invite) return;

    void client.joinRoom(room.roomId).then(() => {
      console.log(`Joined invited room ${room.roomId}`);
    }).catch((error) => {
      console.error(`Failed to join room ${room.roomId}:`, error);
    });
  });

  client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
    if (!room) return;
    queueCapture(event, room, toStartOfTimeline);
  });

  (
    crypto as unknown as {
      on: (event: string, listener: (request: VerificationRequest) => void) => void;
    }
  ).on(sdk.CryptoEvent.VerificationRequestReceived, (request: VerificationRequest) => {
    void handleVerificationRequest(request);
  });

  client.once(sdk.ClientEvent.Sync, (state) => {
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
    await persistSnapshotOnShutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
