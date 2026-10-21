// G5/G6: gated, serialised, coalesced snapshot saves with honest logging and escalation,
// plus the matrix-js-sdk hooks that make the crypto store durable before publishing and
// before acknowledging to-device messages with the next /sync.
import {
  KeysBackupRequest,
  KeysUploadRequest,
  PutDehydratedDeviceRequest,
  SignatureUploadRequest,
  ToDeviceRequest,
  UploadSigningKeysRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";
import type { MatrixClient } from "matrix-js-sdk";
import type { StartupGate } from "./crypto-guard.js";
import type { PersistResult } from "./idb-persistence.js";

export type SnapshotSchedulerOptions = {
  persist: () => Promise<PersistResult>;
  gate: Pick<StartupGate, "wait">;
  onFatal: (reason: string) => void;
  now?: () => number;
  log?: Pick<Console, "log" | "warn" | "error">;
  /** Consecutive failures from which a failed save logs at `error` (default 3). */
  errorAfter?: number;
  /** Continuous-failure duration after which `onFatal` is called (default 600 000 ms). */
  fatalAfterMs?: number;
  /** Delay used by `saveUntilOk` between attempts (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
};

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Pending = { reasons: string[]; promise: Promise<PersistResult> };

export class SnapshotScheduler {
  readonly #persist: () => Promise<PersistResult>;
  readonly #gate: Pick<StartupGate, "wait">;
  readonly #onFatal: (reason: string) => void;
  readonly #now: () => number;
  readonly #log: Pick<Console, "log" | "warn" | "error">;
  readonly #errorAfter: number;
  readonly #fatalAfterMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  /** The save currently running, if any. */
  #running: Promise<PersistResult> | undefined;
  /** The save queued behind the running one; later callers share it. */
  #queued: Pending | undefined;
  #poisoned: Error | undefined;
  #failures = 0;
  #failingSince: number | undefined;
  #fatalReported = false;

  constructor(opts: SnapshotSchedulerOptions) {
    this.#persist = opts.persist;
    this.#gate = opts.gate;
    this.#onFatal = opts.onFatal;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? console;
    this.#errorAfter = opts.errorAfter ?? 3;
    this.#fatalAfterMs = opts.fatalAfterMs ?? 600_000;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Permanently disables persistence (spec G5: a failed incoming sync is never snapshotted).
   * Synchronous, so it takes effect before any save or publish that is already waiting can persist.
   */
  poison(reason: string): void {
    if (this.#poisoned) return;
    this.#poisoned = new Error(`snapshot saves disabled: ${reason}`);
    this.#log.error(this.#poisoned.message);
  }

  async save(reason: string): Promise<PersistResult> {
    if (this.#poisoned) return { ok: false, error: this.#poisoned };
    await this.#gate.wait();
    if (this.#poisoned) return { ok: false, error: this.#poisoned };
    if (this.#queued) {
      if (!this.#queued.reasons.includes(reason)) this.#queued.reasons.push(reason);
      return this.#queued.promise;
    }
    if (!this.#running) return this.#start([reason]);
    const reasons = [reason];
    const after = this.#running;
    const promise = after.then(
      () => {
        this.#queued = undefined;
        return this.#start(reasons);
      },
      () => {
        this.#queued = undefined;
        return this.#start(reasons);
      },
    );
    this.#queued = { reasons, promise };
    return promise;
  }

  async saveUntilOk(reason: string): Promise<void> {
    let delay = BACKOFF_START_MS;
    for (;;) {
      const result = await this.save(reason);
      if (result.ok) return;
      if (this.#poisoned) throw this.#poisoned;
      await this.#sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  #start(reasons: string[]): Promise<PersistResult> {
    const run = this.#runOnce(reasons.join(", "));
    this.#running = run;
    const clear = () => {
      if (this.#running === run) this.#running = undefined;
    };
    run.then(clear, clear);
    return run;
  }

  async #runOnce(reason: string): Promise<PersistResult> {
    if (this.#poisoned) return { ok: false, error: this.#poisoned };
    let result: PersistResult;
    try {
      result = await this.#persist();
    } catch (error) {
      result = { ok: false, error };
    }
    if (result.ok) {
      this.#failures = 0;
      this.#failingSince = undefined;
      this.#fatalReported = false;
      this.#log.log(`Persisted Matrix IndexedDB snapshot (${reason})`);
      return result;
    }
    this.#failures++;
    const now = this.#now();
    this.#failingSince ??= now;
    const line = `Matrix IndexedDB snapshot save failed (${reason}; ${this.#failures} consecutive): ${errMessage(result.error)}`;
    if (this.#failures >= this.#errorAfter) this.#log.error(line);
    else this.#log.warn(line);
    const elapsed = now - this.#failingSince;
    if (!this.#fatalReported && elapsed >= this.#fatalAfterMs) {
      this.#fatalReported = true;
      this.#onFatal(`snapshot saves failing for ${Math.floor(elapsed / 1000)}s`);
    }
    return result;
  }
}

type Patchable = { __ob1DurablePatched?: boolean };

type OutgoingProto = Patchable & {
  makeOutgoingRequest: (this: unknown, msg: unknown, uiaCallback?: unknown) => Promise<unknown>;
};

/**
 * Wraps `OutgoingRequestProcessor.prototype.makeOutgoingRequest`: every request waits at the startup
 * gate, and publishing requests are sent only after `beforePublish()` (a successful save) resolves.
 */
export function installPublishDurability(
  proto: object,
  opts: { gate: Pick<StartupGate, "wait">; isPublishing: (msg: unknown) => boolean; beforePublish: () => Promise<void> },
): void {
  const p = proto as OutgoingProto;
  if (Object.prototype.hasOwnProperty.call(p, "__ob1DurablePatched")) return;
  const original = p.makeOutgoingRequest;
  p.makeOutgoingRequest = async function durableMakeOutgoingRequest(this: unknown, msg: unknown, uiaCallback?: unknown) {
    await opts.gate.wait();
    if (opts.isPublishing(msg)) await opts.beforePublish();
    return original.call(this, msg, uiaCallback);
  };
  Object.defineProperty(p, "__ob1DurablePatched", { value: true });
}

type SyncState = { dirty: boolean; failed: boolean };
/** Per RustCrypto instance (Ruling R3); the hooks live on the prototype. */
const syncStates = new WeakMap<object, SyncState>();

export type SyncDurabilityOptions = {
  save: () => Promise<void>;
  onIncomingFailure: (reason: string) => void;
  /** Called synchronously when an instance's failure latch is set; the service passes `scheduler.poison`. */
  onLatched?: (reason: string) => void;
  log?: Pick<Console, "error">;
};
/** Options of each prototype on which installSyncDurability ran. */
const syncProtos = new WeakMap<object, SyncDurabilityOptions>();

function stateOf(instance: object): SyncState {
  let s = syncStates.get(instance);
  if (!s) {
    s = { dirty: false, failed: false };
    syncStates.set(instance, s);
  }
  return s;
}

type SyncProto = Patchable & {
  preprocessToDeviceMessages: (this: object, events: unknown[]) => Promise<unknown[]>;
  onSyncCompleted: (this: object, syncState: unknown) => Promise<void> | void;
};

export const INCOMING_FAILURE = "incoming crypto processing failed";

function setFailedLatch(instance: object, opts: SyncDurabilityOptions): void {
  stateOf(instance).failed = true;
  opts.onLatched?.(INCOMING_FAILURE);
}

/** Never settles: holds the sync loop so it cannot issue (and acknowledge with) another /sync. */
function holdSyncLoop(): Promise<void> {
  return new Promise<void>(() => {});
}

/**
 * Wraps the Rust crypto sync callbacks. A sync that delivered to-device events is saved after the
 * original `onSyncCompleted` and before it returns, which holds back the next /sync.
 *
 * Failed incoming processing sets a per-instance latch and synchronously calls `onLatched` (which
 * poisons the scheduler, so no save or publish can follow). `onSyncCompleted` then skips the original
 * (it would kick outgoing requests), reports `onIncomingFailure("incoming crypto processing failed")`
 * and never settles, so the sync loop cannot acknowledge the unprocessed messages with another /sync.
 * A rejecting `save()` is fatal in the same way: logged at error, reported through
 * `onIncomingFailure("snapshot save failed: <message>")`, and the loop is held.
 */
export function installSyncDurability(proto: object, opts: SyncDurabilityOptions): void {
  const p = proto as SyncProto;
  if (Object.prototype.hasOwnProperty.call(p, "__ob1DurablePatched")) return;
  const originalPreprocess = p.preprocessToDeviceMessages;
  const originalCompleted = p.onSyncCompleted;

  p.preprocessToDeviceMessages = async function durablePreprocess(this: object, events: unknown[]) {
    const state = stateOf(this);
    if (Array.isArray(events) && events.length > 0) state.dirty = true;
    try {
      return await originalPreprocess.call(this, events);
    } catch (err) {
      setFailedLatch(this, opts);
      throw err;
    }
  };

  const log = opts.log ?? console;
  p.onSyncCompleted = async function durableOnSyncCompleted(this: object, syncState: unknown) {
    const state = stateOf(this);
    if (!state.failed) await originalCompleted.call(this, syncState);
    if (state.failed) {
      opts.onIncomingFailure(INCOMING_FAILURE);
      return holdSyncLoop();
    }
    if (state.dirty) {
      try {
        await opts.save();
      } catch (err) {
        const reason = `snapshot save failed: ${errMessage(err)}`;
        log.error(`Matrix sync held: ${reason}`);
        opts.onIncomingFailure(reason);
        return holdSyncLoop();
      }
      state.dirty = false;
    }
  };

  Object.defineProperty(p, "__ob1DurablePatched", { value: true });
  syncProtos.set(p, opts);
}

/**
 * `SyncApi.doSync` catches processing errors and emits `ClientEvent.SyncUnexpectedError` (sync.js:769)
 * before calling `onSyncCompleted` (:788). Latch that on the client's crypto instance.
 */
export function latchIncomingFailure(client: Pick<MatrixClient, "on" | "getCrypto">, proto: object): void {
  const opts = syncProtos.get(proto);
  if (!opts) {
    throw new Error("latchIncomingFailure: installSyncDurability has not been applied to this prototype");
  }
  // "sync.unexpectedError" is ClientEvent.SyncUnexpectedError.
  (client as unknown as { on: (event: string, listener: () => void) => void }).on("sync.unexpectedError", () => {
    const crypto = client.getCrypto();
    if (crypto && Object.prototype.isPrototypeOf.call(proto, crypto)) {
      setFailedLatch(crypto, opts);
    }
  });
}

/** Requests that publish or commit crypto state (spec G5). Same class objects as matrix-js-sdk imports. */
export function isPublishingRequest(msg: unknown): boolean {
  return (
    msg instanceof KeysUploadRequest ||
    msg instanceof SignatureUploadRequest ||
    msg instanceof UploadSigningKeysRequest ||
    msg instanceof ToDeviceRequest ||
    msg instanceof KeysBackupRequest ||
    msg instanceof PutDehydratedDeviceRequest
  );
}
