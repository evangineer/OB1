/*
 * Portions of this file are derived from or materially adapted from OpenClaw's
 * Matrix extension:
 * https://github.com/openclaw/openclaw/tree/main/extensions/matrix
 *
 * See THIRD_PARTY_NOTICE.md in this directory for attribution and license terms.
 */

import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import { MatrixEventEvent, type MatrixEvent } from "matrix-js-sdk";

type MatrixDecryptIfNeededClient = {
  decryptEventIfNeeded?: (
    event: MatrixEvent,
    opts?: {
      isRetry?: boolean;
    },
  ) => Promise<void>;
};

type MatrixDecryptRetryState = {
  event: MatrixEvent;
  roomId: string;
  eventId: string;
  attempts: number;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type MatrixCryptoRetrySignalSource = {
  on: (eventName: string, listener: (...args: unknown[]) => void) => void;
};

const MATRIX_DECRYPT_RETRY_BASE_DELAY_MS = 1_500;
const MATRIX_DECRYPT_RETRY_MAX_DELAY_MS = 30_000;
const MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS = 8;

function resolveDecryptRetryKey(roomId: string, eventId: string): string | null {
  if (!roomId || !eventId) {
    return null;
  }
  return `${roomId}|${eventId}`;
}

function isDecryptionFailure(event: MatrixEvent): boolean {
  return (
    typeof (event as { isDecryptionFailure?: () => boolean }).isDecryptionFailure === "function" &&
    (event as { isDecryptionFailure: () => boolean }).isDecryptionFailure()
  );
}

export class MatrixDecryptBridge {
  private readonly trackedEncryptedEvents = new WeakSet<object>();
  private readonly decryptedMessageDedupe = new Map<string, number>();
  private readonly decryptRetries = new Map<string, MatrixDecryptRetryState>();
  private readonly failedDecryptionsNotified = new Set<string>();
  private activeRetryRuns = 0;
  private readonly retryIdleResolvers = new Set<() => void>();
  private cryptoRetrySignalsBound = false;

  constructor(
    private readonly deps: {
      client: MatrixDecryptIfNeededClient;
      emitDecryptedEvent: (roomId: string, event: MatrixEvent) => void;
      emitMessage: (roomId: string, event: MatrixEvent) => void;
      emitFailedDecryption: (roomId: string, event: MatrixEvent, error: Error) => void;
    },
  ) {}

  shouldEmitUnencryptedMessage(roomId: string, eventId: string): boolean {
    if (!eventId) {
      return true;
    }
    const key = `${roomId}|${eventId}`;
    const createdAt = this.decryptedMessageDedupe.get(key);
    if (createdAt === undefined) {
      return true;
    }
    this.decryptedMessageDedupe.delete(key);
    return false;
  }

  attachEncryptedEvent(event: MatrixEvent, roomId: string): void {
    if (this.trackedEncryptedEvents.has(event)) {
      return;
    }
    this.trackedEncryptedEvents.add(event);
    event.on(MatrixEventEvent.Decrypted, (decryptedEvent: MatrixEvent, err?: Error) => {
      this.handleEncryptedEventDecrypted({
        roomId,
        encryptedEvent: event,
        decryptedEvent,
        err,
      });
    });
  }

  retryPendingNow(reason: string): void {
    const pending = Array.from(this.decryptRetries.entries());
    if (pending.length === 0) {
      return;
    }
    console.log(`Retrying pending decryptions due to ${reason}`);
    for (const [retryKey, state] of pending) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.inFlight) {
        continue;
      }
      void this.runDecryptRetry(retryKey);
    }
  }

  bindCryptoRetrySignals(crypto: MatrixCryptoRetrySignalSource | undefined): void {
    if (!crypto || this.cryptoRetrySignalsBound) {
      return;
    }
    this.cryptoRetrySignalsBound = true;

    const trigger = (reason: string): void => {
      this.retryPendingNow(reason);
    };

    crypto.on(CryptoEvent.KeyBackupDecryptionKeyCached, () => {
      trigger("crypto.keyBackupDecryptionKeyCached");
    });
    crypto.on(CryptoEvent.RehydrationCompleted, () => {
      trigger("dehydration.RehydrationCompleted");
    });
    crypto.on(CryptoEvent.DevicesUpdated, () => {
      trigger("crypto.devicesUpdated");
    });
    crypto.on(CryptoEvent.KeysChanged, () => {
      trigger("crossSigning.keysChanged");
    });
  }

  stop(): void {
    for (const retryKey of this.decryptRetries.keys()) {
      this.clearDecryptRetry(retryKey);
    }
  }

  async drainPendingDecryptions(reason: string): Promise<void> {
    for (let attempts = 0; attempts < MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS; attempts += 1) {
      if (this.decryptRetries.size === 0) {
        return;
      }
      this.retryPendingNow(reason);
      await this.waitForActiveRetryRunsToFinish();
      const hasPendingRetryTimers = Array.from(this.decryptRetries.values()).some(
        (state) => state.timer || state.inFlight,
      );
      if (!hasPendingRetryTimers) {
        return;
      }
    }
  }

  private handleEncryptedEventDecrypted(params: {
    roomId: string;
    encryptedEvent: MatrixEvent;
    decryptedEvent: MatrixEvent;
    err?: Error;
  }): void {
    const decryptedRoomId = params.decryptedEvent.getRoomId() || params.roomId;
    const retryEventId = params.decryptedEvent.getId() || params.encryptedEvent.getId() || "";
    const retryKey = resolveDecryptRetryKey(decryptedRoomId, retryEventId);

    if (params.err) {
      this.emitFailedDecryptionOnce(retryKey, decryptedRoomId, params.decryptedEvent, params.err);
      this.scheduleDecryptRetry({
        event: params.encryptedEvent,
        roomId: decryptedRoomId,
        eventId: retryEventId,
      });
      return;
    }

    if (isDecryptionFailure(params.decryptedEvent)) {
      this.emitFailedDecryptionOnce(
        retryKey,
        decryptedRoomId,
        params.decryptedEvent,
        new Error("Matrix event failed to decrypt"),
      );
      this.scheduleDecryptRetry({
        event: params.encryptedEvent,
        roomId: decryptedRoomId,
        eventId: retryEventId,
      });
      return;
    }

    if (retryKey) {
      this.clearDecryptRetry(retryKey);
    }
    this.rememberDecryptedMessage(decryptedRoomId, retryEventId);
    this.deps.emitDecryptedEvent(decryptedRoomId, params.decryptedEvent);
    this.deps.emitMessage(decryptedRoomId, params.decryptedEvent);
  }

  private emitFailedDecryptionOnce(
    retryKey: string | null,
    roomId: string,
    event: MatrixEvent,
    error: Error,
  ): void {
    if (retryKey) {
      if (this.failedDecryptionsNotified.has(retryKey)) {
        return;
      }
      this.failedDecryptionsNotified.add(retryKey);
    }
    this.deps.emitFailedDecryption(roomId, event, error);
  }

  private scheduleDecryptRetry(params: {
    event: MatrixEvent;
    roomId: string;
    eventId: string;
  }): void {
    const retryKey = resolveDecryptRetryKey(params.roomId, params.eventId);
    if (!retryKey) {
      return;
    }
    const existing = this.decryptRetries.get(retryKey);
    if (existing?.timer || existing?.inFlight) {
      return;
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    if (attempts > MATRIX_DECRYPT_RETRY_MAX_ATTEMPTS) {
      this.clearDecryptRetry(retryKey);
      console.log(
        `Giving up decryption retry for ${params.eventId} in ${params.roomId} after ${attempts - 1} attempts`,
      );
      return;
    }
    const delayMs = Math.min(
      MATRIX_DECRYPT_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1),
      MATRIX_DECRYPT_RETRY_MAX_DELAY_MS,
    );
    const next: MatrixDecryptRetryState = {
      event: params.event,
      roomId: params.roomId,
      eventId: params.eventId,
      attempts,
      inFlight: false,
      timer: null,
    };
    next.timer = setTimeout(() => {
      void this.runDecryptRetry(retryKey);
    }, delayMs);
    this.decryptRetries.set(retryKey, next);
  }

  private async runDecryptRetry(retryKey: string): Promise<void> {
    const state = this.decryptRetries.get(retryKey);
    if (!state || state.inFlight) {
      return;
    }

    state.inFlight = true;
    state.timer = null;
    this.activeRetryRuns += 1;
    const canDecrypt = typeof this.deps.client.decryptEventIfNeeded === "function";
    if (!canDecrypt) {
      this.clearDecryptRetry(retryKey);
      this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
      this.resolveRetryIdleIfNeeded();
      return;
    }

    try {
      await this.deps.client.decryptEventIfNeeded?.(state.event, {
        isRetry: true,
      });
    } catch {
      // retry with backoff until the configured cap
    } finally {
      state.inFlight = false;
      this.activeRetryRuns = Math.max(0, this.activeRetryRuns - 1);
      this.resolveRetryIdleIfNeeded();
    }

    if (this.decryptRetries.get(retryKey) !== state) {
      return;
    }
    if (isDecryptionFailure(state.event)) {
      this.scheduleDecryptRetry(state);
      return;
    }

    this.clearDecryptRetry(retryKey);
  }

  private clearDecryptRetry(retryKey: string): void {
    const state = this.decryptRetries.get(retryKey);
    if (state?.timer) {
      clearTimeout(state.timer);
    }
    this.decryptRetries.delete(retryKey);
    this.failedDecryptionsNotified.delete(retryKey);
  }

  private rememberDecryptedMessage(roomId: string, eventId: string): void {
    if (!eventId) {
      return;
    }
    const now = Date.now();
    this.pruneDecryptedMessageDedupe(now);
    this.decryptedMessageDedupe.set(`${roomId}|${eventId}`, now);
  }

  private pruneDecryptedMessageDedupe(now: number): void {
    const ttlMs = 30_000;
    for (const [key, createdAt] of this.decryptedMessageDedupe) {
      if (now - createdAt > ttlMs) {
        this.decryptedMessageDedupe.delete(key);
      }
    }
  }

  private async waitForActiveRetryRunsToFinish(): Promise<void> {
    if (this.activeRetryRuns === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.retryIdleResolvers.add(resolve);
    });
  }

  private resolveRetryIdleIfNeeded(): void {
    if (this.activeRetryRuns !== 0 || this.retryIdleResolvers.size === 0) {
      return;
    }
    const resolvers = Array.from(this.retryIdleResolvers);
    this.retryIdleResolvers.clear();
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
