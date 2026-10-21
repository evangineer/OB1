// G5 incoming rule against the real SyncApi, real RustCrypto and a fake homeserver.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type MatrixClient } from "matrix-js-sdk";
import { RustCrypto } from "matrix-js-sdk/lib/rust-crypto/rust-crypto.js";
import { installSyncDurability, latchIncomingFailure } from "./snapshot-scheduler.js";
import { startFakeHomeserver, type FakeHomeserver } from "./test-fixtures/fake-homeserver.js";

// matrix-js-sdk's timeoutSignal() (http-api/utils) arms an 80 s timer per /sync and never clears it,
// which would keep this test process alive for ~80 s after the tests finish. No test here runs that
// long, so unref long timers to let the process exit as soon as cleanup is done.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const handle = realSetTimeout(fn, ms, ...args);
  if ((ms ?? 0) >= 60_000) handle.unref();
  return handle;
}) as typeof setTimeout;

const userId = "@bot:localhost";
const deviceId = "TESTDEV";

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// The hooks are installed once per prototype (idempotent), so each test plugs in its own behaviour here.
let currentSave: () => Promise<void> = async () => {};
let currentOnIncomingFailure: (reason: string) => void = () => {};
installSyncDurability(RustCrypto.prototype, {
  save: () => currentSave(),
  onIncomingFailure: (r) => currentOnIncomingFailure(r),
});

const toDeviceSync = {
  next_batch: "s1",
  to_device: { events: [{ type: "m.dummy", sender: "@other:localhost", content: {} }] },
};

/** Lets every pending microtask and one macrotask turn run, so an unblocked sync loop would have issued its fetch. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

async function startBot(hs: FakeHomeserver): Promise<{ client: MatrixClient; syncFetches: () => number }> {
  let syncFetches = 0;
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/sync(\?|$)/.test(url)) syncFetches++;
    return fetch(input, init);
  };
  const client = createClient({ baseUrl: hs.url, userId, deviceId, accessToken: "test-token", fetchFn });
  await client.initRustCrypto({ useIndexedDB: false });
  latchIncomingFailure(client, RustCrypto.prototype);
  return { client, syncFetches: () => syncFetches };
}

test("after a sync with to-device events, the next /sync waits for the save", { timeout: 20_000 }, async (t) => {
  const hs = await startFakeHomeserver({}, { userId, deviceId });
  let client: MatrixClient | undefined;
  t.after(async () => {
    client?.stopClient();
    await hs.close();
  });
  {
    hs.queueSync(toDeviceSync);
    const entered = deferred();
    const release = deferred();
    let saves = 0;
    currentSave = async () => {
      saves++;
      entered.resolve();
      await release.promise;
    };
    const failures: string[] = [];
    currentOnIncomingFailure = (r) => failures.push(r);

    const bot = await startBot(hs);
    client = bot.client;
    await client.startClient();

    await entered.promise;
    await drain();
    assert.equal(bot.syncFetches(), 1, "no second /sync is requested while the save is pending");
    assert.equal(hs.requests.filter((r) => /\/sync$/.test(r.path)).length, 1);

    const second = hs.waitForRequests(/\/sync$/, 2);
    release.resolve();
    await second;
    assert.equal(saves, 1);
    assert.deepEqual(failures, []);
  }
});

test("failed incoming crypto processing: no save, onIncomingFailure, no second /sync", { timeout: 20_000 }, async (t) => {
  const hs = await startFakeHomeserver({}, { userId, deviceId });
  const proto = RustCrypto.prototype as unknown as { receiveSyncChanges: (...a: unknown[]) => Promise<unknown> };
  const original = proto.receiveSyncChanges;
  let client: MatrixClient | undefined;
  t.after(async () => {
    proto.receiveSyncChanges = original;
    client?.stopClient();
    await hs.close();
  });
  {
    hs.queueSync(toDeviceSync);
    let saves = 0;
    currentSave = async () => {
      saves++;
    };
    const failed = deferred<string>();
    const bot = await startBot(hs);
    client = bot.client;
    currentOnIncomingFailure = (r) => {
      client?.stopClient();
      failed.resolve(r);
    };
    proto.receiveSyncChanges = async () => {
      throw new Error("simulated olm processing failure");
    };
    await client.startClient();

    assert.equal(await failed.promise, "incoming crypto processing failed");
    await drain();
    assert.equal(saves, 0, "save is never entered after failed processing");
    assert.equal(bot.syncFetches(), 1, "no second /sync after the failure");
  }
});
