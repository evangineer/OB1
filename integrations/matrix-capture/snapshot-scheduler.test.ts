import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import * as wasm from "@matrix-org/matrix-sdk-crypto-wasm";
import type { PersistResult } from "./idb-persistence.js";
import { StartupGate } from "./crypto-guard.js";
import {
  SnapshotScheduler,
  installPublishDurability,
  installSyncDurability,
  isPublishingRequest,
  latchIncomingFailure,
} from "./snapshot-scheduler.js";

type Logged = { level: "log" | "warn" | "error"; msg: string };

function recordingLog(): { log: Pick<Console, "log" | "warn" | "error">; lines: Logged[] } {
  const lines: Logged[] = [];
  const fmt = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  return {
    lines,
    log: {
      log: (...a: unknown[]) => lines.push({ level: "log", msg: fmt(a) }),
      warn: (...a: unknown[]) => lines.push({ level: "warn", msg: fmt(a) }),
      error: (...a: unknown[]) => lines.push({ level: "error", msg: fmt(a) }),
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const openGate = { wait: () => Promise.resolve() };
const OK: PersistResult = { ok: true, databases: 2 };
const FAIL: PersistResult = { ok: false, error: new Error("disk full") };

test("saves are serialised and coalesced: 3 calls during one in-flight save give 2 persists", async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let persists = 0;
  const persist = () => {
    persists++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<PersistResult>((resolve) =>
      releases.push(() => {
        active--;
        resolve(OK);
      }),
    );
  };
  const { log, lines } = recordingLog();
  const s = new SnapshotScheduler({ persist, gate: openGate, onFatal: () => assert.fail("fatal"), log });

  const first = s.save("first");
  await new Promise((r) => setImmediate(r));
  assert.equal(persists, 1);
  const more = [s.save("a"), s.save("b"), s.save("c")];
  await new Promise((r) => setImmediate(r));
  assert.equal(persists, 1, "a save requested while one runs must wait for it");
  releases.shift()!();
  assert.deepEqual(await first, OK);
  await new Promise((r) => setImmediate(r));
  assert.equal(persists, 2, "queued calls run after the in-flight save, never skipped");
  releases.shift()!();
  for (const r of await Promise.all(more)) assert.deepEqual(r, OK);
  assert.equal(persists, 2, "calls queued together share one persist");
  assert.equal(maxActive, 1);
  assert.ok(lines.some((l) => l.level === "log" && l.msg === "Persisted Matrix IndexedDB snapshot (first)"));
});

test("the startup gate blocks saves until it opens", async () => {
  const gate = new StartupGate();
  let persists = 0;
  const s = new SnapshotScheduler({
    persist: async () => {
      persists++;
      return OK;
    },
    gate,
    onFatal: () => assert.fail("fatal"),
    log: recordingLog().log,
  });
  const p = s.save("gated");
  await new Promise((r) => setImmediate(r));
  assert.equal(persists, 0);
  gate.open();
  assert.deepEqual(await p, OK);
  assert.equal(persists, 1);
});

test("failure escalation: warn, warn, error; onFatal at 600 s not 599 s; success resets", async () => {
  let t = 0;
  let next: PersistResult = FAIL;
  const fatals: string[] = [];
  const { log, lines } = recordingLog();
  const s = new SnapshotScheduler({
    persist: async () => next,
    gate: openGate,
    onFatal: (r) => fatals.push(r),
    now: () => t,
    log,
  });

  assert.equal((await s.save("r1")).ok, false);
  t = 1_000;
  await s.save("r2");
  t = 2_000;
  await s.save("r3");
  assert.deepEqual(
    lines.map((l) => l.level),
    ["warn", "warn", "error"],
  );
  assert.ok(!lines.some((l) => l.msg.startsWith("Persisted")), "no success log on failure");
  t = 599_000;
  await s.save("r4");
  assert.deepEqual(fatals, []);
  t = 600_000;
  await s.save("r5");
  assert.deepEqual(fatals, ["snapshot saves failing for 600s"]);

  next = OK;
  t = 601_000;
  assert.equal((await s.save("ok")).ok, true);
  next = FAIL;
  lines.length = 0;
  t = 700_000;
  await s.save("again");
  assert.deepEqual(lines.map((l) => l.level), ["warn"], "a success resets the streak");
  t = 1_299_000;
  await s.save("again2");
  assert.deepEqual(fatals, ["snapshot saves failing for 600s"], "the 600 s clock restarts after a success");
  t = 1_300_000;
  await s.save("again3");
  assert.equal(fatals.length, 2);
});

test("a thrown persist counts as a failed save", async () => {
  const { log, lines } = recordingLog();
  const s = new SnapshotScheduler({
    persist: async () => {
      throw new Error("boom");
    },
    gate: openGate,
    onFatal: () => {},
    log,
  });
  const r = await s.save("x");
  assert.equal(r.ok, false);
  assert.equal(lines[0]?.level, "warn");
});

test("saveUntilOk backs off 1 s doubling to 30 s and stops on success", async () => {
  const delays: number[] = [];
  let calls = 0;
  const s = new SnapshotScheduler({
    persist: async () => (++calls >= 8 ? OK : FAIL),
    gate: openGate,
    onFatal: () => {},
    log: recordingLog().log,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  await s.saveUntilOk("shutdown");
  assert.equal(calls, 8);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

// ---- publish durability ----

function fakeProcessor(order: string[]) {
  class Proc {
    async makeOutgoingRequest(msg: unknown, _uia?: unknown): Promise<string> {
      order.push("send");
      return `sent:${String(msg)}`;
    }
  }
  return Proc;
}

test("publishing requests: gate, then save, then send", async () => {
  const order: string[] = [];
  const Proc = fakeProcessor(order);
  const opts = {
    gate: { wait: async () => void order.push("gate") },
    isPublishing: (m: unknown) => m === "publish",
    beforePublish: async () => void order.push("save"),
  };
  installPublishDurability(Proc.prototype, opts);
  installPublishDurability(Proc.prototype, opts); // idempotent
  assert.equal(await new Proc().makeOutgoingRequest("publish"), "sent:publish");
  assert.deepEqual(order, ["gate", "save", "send"]);
  order.length = 0;
  await new Proc().makeOutgoingRequest("query");
  assert.deepEqual(order, ["gate", "send"]);
});

test("a throwing beforePublish sends nothing and surfaces the error", async () => {
  const order: string[] = [];
  const Proc = fakeProcessor(order);
  installPublishDurability(Proc.prototype, {
    gate: openGate,
    isPublishing: () => true,
    beforePublish: async () => {
      throw new Error("snapshot save failed");
    },
  });
  await assert.rejects(new Proc().makeOutgoingRequest("publish"), /snapshot save failed/);
  assert.deepEqual(order, []);
});

test("a closed gate holds every request", async () => {
  const order: string[] = [];
  const Proc = fakeProcessor(order);
  const gate = new StartupGate();
  installPublishDurability(Proc.prototype, { gate, isPublishing: () => false, beforePublish: async () => {} });
  const p = new Proc().makeOutgoingRequest("query");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, []);
  gate.open();
  await p;
  assert.deepEqual(order, ["send"]);
});

// ---- the classifier, against the real WASM classes (same ESM instance as matrix-js-sdk) ----

test("isPublishingRequest recognises the six publishing request classes", async () => {
  await wasm.initAsync();
  const publishing = [
    new wasm.KeysUploadRequest("1", "{}"),
    new wasm.SignatureUploadRequest("2", "{}"),
    new wasm.UploadSigningKeysRequest("{}"),
    new wasm.ToDeviceRequest("3", "m.dummy", "txn", "{}"),
    new wasm.KeysBackupRequest("4", "{}", "1"),
    new wasm.PutDehydratedDeviceRequest("{}"),
  ];
  for (const r of publishing) assert.equal(isPublishingRequest(r), true, r.constructor.name);
  assert.equal(isPublishingRequest(new wasm.KeysClaimRequest("5", "{}")), false);
  assert.equal(isPublishingRequest(new wasm.KeysQueryRequest("6", "{}")), false);
  assert.equal(isPublishingRequest({}), false);
  assert.equal(isPublishingRequest(undefined), false);

  // Requests produced at runtime by a real OlmMachine: proves class identity matches.
  const machine = await wasm.OlmMachine.initialize(
    new wasm.UserId("@t:example.org"),
    new wasm.DeviceId("TESTDEV"),
  );
  try {
    const initial = await machine.outgoingRequests();
    const upload = initial.find((r: unknown) => r instanceof wasm.KeysUploadRequest);
    assert.ok(upload, "OlmMachine produced a KeysUploadRequest");
    assert.equal(isPublishingRequest(upload), true);

    await machine.updateTrackedUsers([new wasm.UserId("@other:example.org")]);
    const later = await machine.outgoingRequests();
    const query = later.find((r: unknown) => r instanceof wasm.KeysQueryRequest);
    assert.ok(query, "OlmMachine produced a KeysQueryRequest");
    assert.equal(isPublishingRequest(query), false);
  } finally {
    machine.close();
  }
});

// ---- sync durability hooks, unit level ----

function fakeCryptoClass(opts: { preprocessRejects?: boolean } = {}) {
  const calls: string[] = [];
  class Crypto {
    async preprocessToDeviceMessages(events: unknown[]): Promise<unknown[]> {
      calls.push("preprocess");
      if (opts.preprocessRejects) throw new Error("olm failure");
      return events;
    }
    async onSyncCompleted(_s: unknown): Promise<void> {
      calls.push("onSyncCompleted");
    }
  }
  return { Crypto, calls };
}

test("sync hook: to-device events make the instance dirty and onSyncCompleted saves after the original", async () => {
  const { Crypto, calls } = fakeCryptoClass();
  const failures: string[] = [];
  const opts = {
    save: async () => void calls.push("save"),
    onIncomingFailure: (r: string) => failures.push(r),
  };
  installSyncDurability(Crypto.prototype, opts);
  installSyncDurability(Crypto.prototype, opts); // idempotent
  const a = new Crypto();
  const b = new Crypto();

  await a.onSyncCompleted({});
  assert.deepEqual(calls, ["onSyncCompleted"], "not dirty: no save");
  calls.length = 0;

  await a.preprocessToDeviceMessages([]);
  await a.onSyncCompleted({});
  assert.deepEqual(calls, ["preprocess", "onSyncCompleted"], "empty events: no save");
  calls.length = 0;

  await a.preprocessToDeviceMessages([{ type: "m.dummy" }]);
  await b.onSyncCompleted({});
  assert.deepEqual(calls, ["preprocess", "onSyncCompleted"], "dirty state is per instance");
  calls.length = 0;
  await a.onSyncCompleted({});
  assert.deepEqual(calls, ["onSyncCompleted", "save"]);
  calls.length = 0;
  await a.onSyncCompleted({});
  assert.deepEqual(calls, ["onSyncCompleted"], "dirty clears after a save");
  assert.deepEqual(failures, []);
});

test("sync hook: a rejecting preprocess latches failure; onSyncCompleted reports and never saves", async () => {
  const { Crypto, calls } = fakeCryptoClass({ preprocessRejects: true });
  const failures: string[] = [];
  installSyncDurability(Crypto.prototype, {
    save: async () => void calls.push("save"),
    onIncomingFailure: (r) => failures.push(r),
  });
  const c = new Crypto();
  await assert.rejects(c.preprocessToDeviceMessages([{ type: "m.dummy" }]), /olm failure/);
  let settled = false;
  void c.onSyncCompleted({}).finally(() => (settled = true));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(failures, ["incoming crypto processing failed"]);
  assert.equal(settled, false, "onSyncCompleted never settles once failed: the sync loop cannot continue");
  assert.ok(!calls.includes("save"));
});

test("latchIncomingFailure: SyncUnexpectedError latches the client's crypto instance", async () => {
  const { Crypto, calls } = fakeCryptoClass();
  const failures: string[] = [];
  installSyncDurability(Crypto.prototype, {
    save: async () => void calls.push("save"),
    onIncomingFailure: (r) => failures.push(r),
  });
  const crypto = new Crypto();
  const other = new Crypto();
  const client = Object.assign(new EventEmitter(), { getCrypto: () => crypto });
  latchIncomingFailure(client as never, Crypto.prototype);

  await crypto.preprocessToDeviceMessages([{ type: "m.dummy" }]);
  client.emit("sync.unexpectedError", new Error("processing threw"));
  void crypto.onSyncCompleted({});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(failures, ["incoming crypto processing failed"]);
  assert.ok(!calls.includes("save"));

  await other.preprocessToDeviceMessages([{ type: "m.dummy" }]);
  await other.onSyncCompleted({});
  assert.ok(calls.includes("save"), "the latch is per instance");
});
