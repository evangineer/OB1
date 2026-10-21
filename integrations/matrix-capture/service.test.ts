// G1/G2 end to end: the real service, started through the entrypoint, against a fake homeserver.
// Each refusal must exit 1 with its named line, having published and saved nothing.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeHomeserver, type FakeHandlers, type FakeHomeserver } from "./test-fixtures/fake-homeserver.js";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const userId = "@bot:localhost";
const deviceId = "TESTDEV";
const EXIT_DEADLINE_MS = 60_000;

const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
});

type Run = { code: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean };

/** Starts the service through the entrypoint; `done` resolves on exit (SIGKILL after the deadline). */
function startService(hs: FakeHomeserver, dataDir: string): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn("sh", ["entrypoint.sh", process.execPath, "--import", "tsx", "service.ts"], {
    cwd: pkgDir,
    env: {
      ...process.env,
      MATRIX_USE_INDEXEDDB: "true",
      MATRIX_INDEXEDDB_PATH: dataDir,
      MATRIX_DEVICE_ID: deviceId,
      MATRIX_HOMESERVER_URL: hs.url,
      MATRIX_ACCESS_TOKEN: "test-token",
      MATRIX_USER_ID: userId,
      SUPABASE_URL: "http://127.0.0.1:9",
      SUPABASE_SERVICE_ROLE_KEY: "dummy",
      OPENROUTER_API_KEY: "dummy",
      OPENROUTER_BASE: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const done = new Promise<Run>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EXIT_DEADLINE_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
  return { child, done };
}

function runService(hs: FakeHomeserver, dataDir: string): Promise<Run> {
  return startService(hs, dataDir).done;
}

function firstRefusal(output: string): string | undefined {
  return output.split("\n").find((line) => line.includes("refusing to start"));
}

const PUBLISHING = [
  /\/keys\/upload$/,
  /\/keys\/signatures\/upload$/,
  /\/keys\/device_signing\/upload$/,
  /\/sendToDevice\//,
];

function publishRequests(hs: FakeHomeserver): string[] {
  return hs.requests
    .filter(
      (r) =>
        PUBLISHING.some((p) => p.test(r.path)) ||
        ((r.method === "PUT" || r.method === "POST") && /\/room_keys\//.test(r.path)),
    )
    .map((r) => `${r.method} ${r.path}`);
}

async function setup(t: { after: (fn: () => Promise<void> | void) => void }, handlers: FakeHandlers = {}) {
  const hs = await startFakeHomeserver(handlers, { userId, deviceId });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-test-"));
  t.after(async () => {
    await hs.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { hs, dataDir, snapshotPath: path.join(dataDir, "crypto-idb-snapshot.json") };
}

function describe(run: Run): string {
  return `exit=${run.code ?? run.signal} timedOut=${run.timedOut}\n${run.output}`;
}

test("refuses on a corrupt snapshot (G2)", { timeout: 90_000 }, async (t) => {
  const { hs, dataDir, snapshotPath } = await setup(t);
  const corrupt = Buffer.from("this is not a v8 snapshot \u0000\u0001\u0002");
  fs.writeFileSync(snapshotPath, corrupt, { mode: 0o600 });

  const run = await runService(hs, dataDir);

  assert.equal(run.code, 1, describe(run));
  assert.match(firstRefusal(run.output) ?? "", /^refusing to start: G2 restore failed/, describe(run));
  assert.deepEqual(fs.readFileSync(snapshotPath), corrupt, "snapshot bytes are unchanged");
  assert.equal(fs.existsSync(`${snapshotPath}.tmp`), false, "no .tmp left behind");
  assert.deepEqual(publishRequests(hs), []);
});

test("refuses on a device-key mismatch without publishing or saving (G1)", { timeout: 90_000 }, async (t) => {
  const { hs, dataDir, snapshotPath } = await setup(t, {
    "^POST .*/keys/query$": () => ({
      body: {
        device_keys: {
          [userId]: {
            [deviceId]: {
              user_id: userId,
              device_id: deviceId,
              keys: { [`ed25519:${deviceId}`]: "server-ed25519", [`curve25519:${deviceId}`]: "server-curve25519" },
            },
          },
        },
        failures: {},
      },
    }),
  });

  const run = await runService(hs, dataDir);

  assert.equal(run.code, 1, describe(run));
  assert.match(
    firstRefusal(run.output) ?? "",
    /^refusing to start: G1 device-key mismatch for @bot:localhost\/TESTDEV/,
    describe(run),
  );
  assert.deepEqual(publishRequests(hs), [], "nothing published");
  assert.equal(fs.existsSync(snapshotPath), false, "no snapshot saved");
});

test("refuses when /keys/query fails (Review Focus 4)", { timeout: 90_000 }, async (t) => {
  const { hs, dataDir, snapshotPath } = await setup(t, {
    "^POST .*/keys/query$": () => ({ status: 502, body: { errcode: "M_UNKNOWN", error: "bad gateway" } }),
  });

  const run = await runService(hs, dataDir);

  assert.equal(run.code, 1, describe(run));
  assert.match(firstRefusal(run.output) ?? "", /^refusing to start: G1 could not verify device keys: 502/, describe(run));
  assert.deepEqual(publishRequests(hs), [], "nothing published");
  assert.equal(fs.existsSync(snapshotPath), false, "no snapshot saved");
});

test("SIGTERM during a stalled startup exits promptly without saving (G1/G7)", { timeout: 90_000 }, async (t) => {
  // The homeserver holds /keys/query open, so startup is blocked inside the G1 check.
  const { hs, dataDir, snapshotPath } = await setup(t, {
    "^POST .*/keys/query$": () => new Promise<never>(() => {}),
  });

  const { child, done } = startService(hs, dataDir);
  await Promise.race([
    hs.waitForRequests(/\/keys\/query$/, 1),
    done.then((run) => assert.fail(`service exited early: ${describe(run)}`)),
  ]);
  const killedAt = Date.now();
  child.kill("SIGTERM");
  const run = await done;
  const elapsed = Date.now() - killedAt;

  assert.equal(run.code, 1, describe(run));
  assert.ok(elapsed < 5_000, `exited ${elapsed}ms after SIGTERM: ${describe(run)}`);
  assert.match(run.output, /^received SIGTERM during startup; exiting$/m, describe(run));
  assert.equal(firstRefusal(run.output), undefined, describe(run));
  assert.doesNotMatch(run.output, /Stopping Matrix capture service/, describe(run));
  assert.deepEqual(publishRequests(hs), [], "nothing published");
  assert.equal(fs.existsSync(snapshotPath), false, "no snapshot saved");
});

test("a new device saves before publishing, exits 0 on SIGTERM, and restarts on its restored store (G1/G2/G5/G7)", { timeout: 150_000 }, async (t) => {
  let snapshotPath = "";
  const snapshotAtUpload: boolean[] = [];
  // The fake remembers the uploaded device keys and serves them from /keys/query, like Synapse.
  let uploadedDeviceKeys: unknown;
  const { hs, dataDir, snapshotPath: sp } = await setup(t, {
    "^POST .*/keys/upload$": ({ body }) => {
      snapshotAtUpload.push(fs.existsSync(snapshotPath));
      const deviceKeys = (body as { device_keys?: unknown } | undefined)?.device_keys;
      if (deviceKeys) uploadedDeviceKeys = deviceKeys;
      return { body: { one_time_key_counts: { signed_curve25519: 50 } } };
    },
    "^POST .*/keys/query$": () => ({
      body: { device_keys: { [userId]: uploadedDeviceKeys ? { [deviceId]: uploadedDeviceKeys } : {} }, failures: {} },
    }),
  });
  snapshotPath = sp;

  // The SDK's outgoing-request loop (and so the key upload) runs once a sync completes.
  hs.queueSync({ next_batch: "s1" });
  const { child, done } = startService(hs, dataDir);
  await Promise.race([
    hs.waitForRequests(/\/keys\/upload$/, 1),
    done.then((run) => assert.fail(`service exited early: ${describe(run)}`)),
  ]);
  child.kill("SIGTERM");
  const run = await done;

  assert.equal(run.code, 0, describe(run));
  assert.equal(firstRefusal(run.output), undefined, describe(run));
  assert.ok(snapshotAtUpload.length > 0, `keys were uploaded: ${describe(run)}`);
  assert.ok(snapshotAtUpload.every(Boolean), "every /keys/upload went out after a snapshot existed");
  assert.match(run.output, /Persisted Matrix IndexedDB snapshot \([^)]*shutdown[^)]*\)/, describe(run));
  assert.equal(fs.existsSync(`${snapshotPath}.tmp`), false);
  assert.ok(uploadedDeviceKeys, "device keys were published");

  // Restart on the same volume: the snapshot restores the same account, so G1 matches the server.
  const syncsBefore = hs.requests.filter((r) => /\/sync$/.test(r.path)).length;
  const second = startService(hs, dataDir);
  await Promise.race([
    hs.waitForRequests(/\/sync$/, syncsBefore + 1),
    second.done.then((r) => assert.fail(`restarted service exited early: ${describe(r)}`)),
  ]);
  second.child.kill("SIGTERM");
  const rerun = await second.done;

  assert.equal(rerun.code, 0, describe(rerun));
  assert.equal(firstRefusal(rerun.output), undefined, describe(rerun));
  assert.doesNotMatch(rerun.output, /no snapshot; starting with an empty crypto store/, describe(rerun));
  assert.doesNotMatch(rerun.output, /device not known to homeserver/, describe(rerun));
});
