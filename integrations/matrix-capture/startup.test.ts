import assert from "node:assert/strict";
import test from "node:test";
import * as wasm from "@matrix-org/matrix-sdk-crypto-wasm";
import { OutgoingRequestProcessor } from "matrix-js-sdk/lib/rust-crypto/OutgoingRequestProcessor.js";
import type { StartupGate } from "./crypto-guard.js";
import type { RestoreResult } from "./idb-persistence.js";
import { installPublishDurability, isPublishingRequest } from "./snapshot-scheduler.js";
import { runStartup, type StartupDeps } from "./startup.js";

const ids = { userId: "@bot:example.org", deviceId: "DEV" };
const local = { ed25519: "ed-key", curve25519: "cu-key" };
const matching = { "ed25519:DEV": "ed-key", "curve25519:DEV": "cu-key" };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function harness(over: Partial<StartupDeps> & { restore?: () => Promise<RestoreResult> }) {
  await wasm.initAsync();
  const calls: string[] = [];
  const events: string[] = [];
  const http = {
    authedRequest: async (_m: string, path: string) => {
      calls.push(path);
      return "{}";
    },
  };
  const machine = { markRequestAsSent: async () => {} };
  class P extends OutgoingRequestProcessor {}
  const processor = new P(machine as never, http as never);
  const deps: StartupDeps = {
    assertWriterLock: () => events.push("lock"),
    removeLegacyLocks: () => events.push("legacy"),
    restore: async () => ({ status: "restored" }) as RestoreResult,
    installHooks: (gate: StartupGate) => {
      events.push("hooks");
      installPublishDurability(P.prototype, {
        gate,
        isPublishing: isPublishingRequest,
        beforePublish: async () => {},
      });
    },
    initCrypto: async () => {
      events.push("init");
      void processor.makeOutgoingRequest(new wasm.KeysBackupRequest("4", "{}", "1")).catch(() => {});
    },
    ownDeviceKeys: async () => local,
    serverDeviceKeys: async () => matching,
    ids,
    log: { log: () => {}, warn: () => {} },
    ...over,
  };
  return { deps, calls, events };
}

test("G1 mismatch rejects and no crypto request reaches HTTP, even after a flush", async () => {
  const { deps, calls } = await harness({ serverDeviceKeys: async () => ({ "ed25519:DEV": "other", "curve25519:DEV": "cu-key" }) });
  await assert.rejects(runStartup(deps), /G1 device-key mismatch/);
  await flush();
  assert.deepEqual(calls, []);
});

test("G1 match: backup request is recorded only after gate.open()", async () => {
  const { deps, calls, events } = await harness({});
  const { gate } = await runStartup(deps);
  assert.equal(gate.isOpen, true);
  await flush();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /room_keys\/keys/);
  assert.deepEqual(events, ["lock", "legacy", "hooks", "init"]);
});

test("restore failure rejects with G2; initCrypto and installHooks are not called", async () => {
  const { deps, events } = await harness({
    restore: async () => ({ status: "failed", error: new Error("disk") }) as RestoreResult,
  });
  await assert.rejects(runStartup(deps), /G2 restore failed: disk/);
  assert.deepEqual(events, ["lock", "legacy"]);
});

test("notes are logged: absent snapshot via warn, new device via log", async () => {
  const lines: string[] = [];
  const { deps } = await harness({
    restore: async () => ({ status: "absent" }) as RestoreResult,
    serverDeviceKeys: async () => undefined,
    log: { log: (m: string) => lines.push(`log:${m}`), warn: (m: string) => lines.push(`warn:${m}`) },
  });
  await runStartup(deps);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^warn:no snapshot/);
  assert.match(lines[1]!, /^log:device not known/);
});
