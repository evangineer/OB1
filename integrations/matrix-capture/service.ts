/*
 * Portions of the Matrix crypto persistence and decryption retry flow in this file
 * are derived from or materially adapted from OpenClaw's Matrix extension:
 * https://github.com/openclaw/openclaw/tree/main/extensions/matrix
 *
 * See THIRD_PARTY_NOTICE.md in this directory for attribution and license terms.
 */

import { join } from "node:path";
import type * as MatrixSdk from "matrix-js-sdk";
import { VerificationMethod } from "matrix-js-sdk/lib/types.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase.js";
import {
  VerifierEvent,
  type GeneratedSas,
  type ShowSasCallbacks,
  type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types.js";
import { MatrixDecryptBridge } from "./decrypt-bridge.js";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || "public";
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
  process.env.MATRIX_INDEXEDDB_SNAPSHOT_PATH || join(MATRIX_INDEXEDDB_PATH, "crypto-idb-snapshot.json");
const MATRIX_USE_INDEXEDDB = (process.env.MATRIX_USE_INDEXEDDB || "false") === "true";
const MATRIX_SECRET_STORAGE_KEY = process.env.MATRIX_SECRET_STORAGE_KEY;
const MATRIX_SECRET_STORAGE_KEY_BASE64 = process.env.MATRIX_SECRET_STORAGE_KEY_BASE64;
const MATRIX_SECRET_STORAGE_PASSPHRASE = process.env.MATRIX_SECRET_STORAGE_PASSPHRASE;
const SNAPSHOT_WRITE_INTERVAL_MS = 60_000;
const MATRIX_CRYPTO_DEBUG = (process.env.MATRIX_CRYPTO_DEBUG || "false") === "true";

const ALLOWED_MSG_TYPES = new Set(["m.text", "m.notice"]);
const seenEventIds = new Set<string>();
const handledVerificationRequests = new Set<string>();
const TIMELINE_DEBUG = (process.env.MATRIX_TIMELINE_DEBUG || "false") === "true";

type RuntimeMatrixSdk = Pick<
  typeof MatrixSdk,
  | "ClientEvent"
  | "HttpApiEvent"
  | "CryptoEvent"
  | "KnownMembership"
  | "MatrixEventEvent"
  | "RoomEvent"
  | "createClient"
>;
let matrixSdk: RuntimeMatrixSdk;
let supabase: SupabaseClient<Database> | undefined;

type MatrixEvent = MatrixSdk.MatrixEvent;
type MatrixRoom = MatrixSdk.Room;
let snapshotPersistTimer: NodeJS.Timeout | undefined;
let snapshotPersistInFlight = false;

function requireEnv(name: string, value: string | undefined): void {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabase) {
    requireEnv("SUPABASE_URL", SUPABASE_URL);
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
    // The deployment chooses the exposed tenant schema at runtime. The checked-in
    // placeholder types only model the `thoughts` table shape, so we intentionally
    // cast the dynamic schema selection here.
    supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: {
        schema: SUPABASE_SCHEMA as "public",
      },
    }) as SupabaseClient<Database>;
  }

  return supabase;
}

function debugTimeline(message: string, details: Record<string, unknown>): void {
  if (!TIMELINE_DEBUG) return;
  console.log(`[timeline] ${message} ${JSON.stringify(details)}`);
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

async function persistIndexedDbSnapshot(reason: string): Promise<void> {
  if (!MATRIX_USE_INDEXEDDB || snapshotPersistInFlight) return;
  snapshotPersistInFlight = true;

  try {
    await persistIdbToDisk({
      snapshotPath: MATRIX_INDEXEDDB_SNAPSHOT_PATH,
    });
    console.log(`Persisted Matrix IndexedDB snapshot (${reason})`);
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
  await restoreIdbFromDisk(MATRIX_INDEXEDDB_SNAPSHOT_PATH);
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

async function installRustCryptoDiagnostics(): Promise<void> {
  if (!MATRIX_CRYPTO_DEBUG) return;

  const [{ OutgoingRequestProcessor }, { RustCrypto }] = await Promise.all([
    import("matrix-js-sdk/lib/rust-crypto/OutgoingRequestProcessor.js"),
    import("matrix-js-sdk/lib/rust-crypto/rust-crypto.js"),
  ]);

  const outgoingProto = OutgoingRequestProcessor.prototype as {
    __ob1CryptoDebugPatched?: boolean;
    makeOutgoingRequest: (msg: unknown, uiaCallback?: unknown) => Promise<void>;
  };

  if (!outgoingProto.__ob1CryptoDebugPatched) {
    const originalMakeOutgoingRequest = outgoingProto.makeOutgoingRequest;
    outgoingProto.makeOutgoingRequest = async function patchedMakeOutgoingRequest(
      this: unknown,
      msg: unknown,
      uiaCallback?: unknown
    ): Promise<void> {
      const request = msg as {
        body?: Record<string, unknown>;
        constructor?: { name?: string };
        id?: string;
        type?: number | string;
      };
      const body = request.body;
      const oneTimeKeys =
        body && typeof body === "object" && "one_time_keys" in body
          ? (body.one_time_keys as Record<string, unknown>)
          : undefined;
      const fallbackKeys =
        body && typeof body === "object" && "fallback_keys" in body
          ? (body.fallback_keys as Record<string, unknown>)
          : undefined;

      if (request.constructor?.name === "KeysUploadRequest" || request.type === 0 || oneTimeKeys) {
        console.log(
          `Matrix crypto debug: outgoing keys/upload request=${JSON.stringify({
            fallbackKeyCount: fallbackKeys ? Object.keys(fallbackKeys).length : 0,
            fallbackKeys: fallbackKeys ? Object.keys(fallbackKeys) : [],
            id: request.id,
            oneTimeKeyCount: oneTimeKeys ? Object.keys(oneTimeKeys).length : 0,
            oneTimeKeys: oneTimeKeys ? Object.keys(oneTimeKeys) : [],
            type: request.type,
          })}`
        );
      }

      return await originalMakeOutgoingRequest.call(this, msg, uiaCallback);
    };
    outgoingProto.__ob1CryptoDebugPatched = true;
  }

  const rustProto = RustCrypto.prototype as {
    __ob1CryptoDebugPatched?: boolean;
    processKeyCounts: (
      oneTimeKeysCounts?: Record<string, number>,
      unusedFallbackKeys?: string[],
    ) => Promise<void>;
  };

  if (!rustProto.__ob1CryptoDebugPatched) {
    const originalProcessKeyCounts = rustProto.processKeyCounts;
    rustProto.processKeyCounts = async function patchedProcessKeyCounts(
      this: unknown,
      oneTimeKeysCounts?: Record<string, number>,
      unusedFallbackKeys?: string[],
    ): Promise<void> {
      console.log(
        `Matrix crypto debug: sync key counts=${JSON.stringify({
          oneTimeKeysCounts: oneTimeKeysCounts || {},
          unusedFallbackKeys: unusedFallbackKeys || [],
        })}`
      );
      return await originalProcessKeyCounts.call(this, oneTimeKeysCounts, unusedFallbackKeys);
    };
    rustProto.__ob1CryptoDebugPatched = true;
  }
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
    debugTimeline("queueCapture.capture_immediate", {
      eventId: event.getId(),
      roomId: room.roomId,
    });
    void captureMessage(event, room);
    return;
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
  await installRustCryptoDiagnostics();

  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);
  requireEnv("OPENROUTER_API_KEY", OPENROUTER_API_KEY);
  requireEnv("MATRIX_HOMESERVER_URL", MATRIX_HOMESERVER_URL);
  requireEnv("MATRIX_ACCESS_TOKEN", MATRIX_ACCESS_TOKEN);
  requireEnv("MATRIX_USER_ID", MATRIX_USER_ID);
  const deviceId = await resolveDeviceId();
  console.log(
    `Matrix capture startup: userId=${MATRIX_USER_ID} deviceId=${deviceId} indexeddb=${MATRIX_USE_INDEXEDDB} snapshotPath=${MATRIX_INDEXEDDB_SNAPSHOT_PATH}`
  );

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
  console.log("Matrix crypto initialized");

  const decryptBridge = new MatrixDecryptBridge({
    client,
    emitDecryptedEvent: (roomId, event) => {
      debugTimeline("queueCapture.decrypted", {
        decryptionFailure: event.isDecryptionFailure(),
        eventId: event.getId(),
        eventType: event.getType(),
        roomId,
      });
    },
    emitMessage: (roomId, event) => {
      const room = client.getRoom(roomId);
      if (!room) {
        debugTimeline("captureMessage.skip.missing_room", {
          eventId: event.getId(),
          roomId,
        });
        return;
      }
      debugTimeline("queueCapture.retry.capture", {
        eventId: event.getId(),
        roomId,
      });
      void captureMessage(event, room);
    },
    emitFailedDecryption: (roomId, event, error) => {
      debugTimeline("queueCapture.retry.failed_decryption", {
        error: String(error),
        eventId: event.getId(),
        roomId,
      });
    },
  });
  decryptBridge.bindCryptoRetrySignals(
    crypto as unknown as { on: (eventName: string, listener: (...args: unknown[]) => void) => void },
  );

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
    if (toStartOfTimeline) {
      queueCapture(event, room, toStartOfTimeline);
      return;
    }
    if (event.isEncrypted()) {
      debugTimeline("queueCapture.await_decrypt", {
        eventId: event.getId(),
        roomId: room.roomId,
      });
      decryptBridge.attachEncryptedEvent(event, room.roomId);
      return;
    }
    if (
      event.getType() === "m.room.message" &&
      !event.isDecryptionFailure() &&
      decryptBridge.shouldEmitUnencryptedMessage(room.roomId, event.getId() || "")
    ) {
      queueCapture(event, room, toStartOfTimeline);
    }
  });

  (
    crypto as unknown as {
      on: (event: string, listener: (request: VerificationRequest) => void) => void;
    }
  ).on(sdk.CryptoEvent.VerificationRequestReceived, (request: VerificationRequest) => {
    void handleVerificationRequest(request);
  });

  (
    crypto as unknown as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
    }
  ).on("UserTrustStatusChanged", (...args: unknown[]) => {
    console.log("Matrix crypto event: UserTrustStatusChanged", args.length);
  });

  client.once(sdk.ClientEvent.Sync, (state) => {
    if (state === "PREPARED") {
      console.log("Matrix client prepared");
    }
  });

  client.on(sdk.ClientEvent.Sync, (state, prevState, data) => {
    if (state === "ERROR") {
      console.warn("Matrix sync entered ERROR state", {
        data,
        prevState,
      });
    }
  });

  client.on(sdk.HttpApiEvent.SessionLoggedOut, (error: unknown) => {
    console.warn("Matrix session logged out", error);
  });

  await client.startClient({
    initialSyncLimit: 20,
    lazyLoadMembers: true,
  });

  const shutdown = async () => {
    console.log("Stopping Matrix capture service");
    client.stopClient();
    decryptBridge.stop();
    await decryptBridge.drainPendingDecryptions("matrix capture shutdown");
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
