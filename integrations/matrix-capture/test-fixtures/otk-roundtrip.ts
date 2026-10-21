// Test fixture: one-time-key round trip across a snapshot restore (separate processes).
import "fake-indexeddb/auto";
import { createRequire } from "node:module";
import { persistIdbToDisk, restoreIdbFromDisk } from "../idb-persistence.js";

const [mode, snapshotPath] = process.argv.slice(2);
if ((mode !== "generate" && mode !== "restore") || !snapshotPath) {
  console.error("usage: otk-roundtrip.ts <generate|restore> <snapshotPath>");
  process.exit(2);
}

if (mode === "restore") {
  const result = await restoreIdbFromDisk(snapshotPath);
  if (result.status !== "restored") {
    console.error(`restore status was ${result.status}`);
    process.exit(1);
  }
}

// Load the CommonJS build via require(): under tsx on newer Node, the ESM entry point
// of this package fails to expose its named exports.
type Wasm = typeof import("@matrix-org/matrix-sdk-crypto-wasm");
const wasm = createRequire(import.meta.url)("@matrix-org/matrix-sdk-crypto-wasm") as Wasm;
const { initAsync, OlmMachine, UserId, DeviceId, KeysUploadRequest } = wasm;
await initAsync();
const machine = await OlmMachine.initialize(
  new UserId("@t:example.org"),
  new DeviceId("TESTDEV"),
  "ob1-test",
);
const requests = await machine.outgoingRequests();
const upload = requests.find((r: unknown) => r instanceof KeysUploadRequest) as InstanceType<Wasm["KeysUploadRequest"]> | undefined;
if (!upload) {
  console.error("no KeysUploadRequest");
  process.exit(1);
}
const body = JSON.parse(upload.body) as { one_time_keys?: Record<string, unknown> };
const otks = body.one_time_keys ?? {};
const sorted = Object.keys(otks)
  .sort()
  .map((k) => [k, otks[k]]);
console.log(JSON.stringify(sorted));

machine.close();
if (mode === "generate") {
  const persisted = await persistIdbToDisk({ snapshotPath });
  if (!persisted.ok) {
    console.error("persist failed");
    process.exit(1);
  }
}
process.exit(0);
