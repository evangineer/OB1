import assert from "node:assert/strict";
import test from "node:test";
import { runShutdown } from "./shutdown.js";

test("done resolves to exit 0", async () => {
  assert.deepEqual(await runShutdown(async () => {}, 1000), { outcome: "done", exitCode: 0 });
  assert.deepEqual(await runShutdown(async () => ({ ok: true, databases: 1 }), 1000), {
    outcome: "done",
    exitCode: 0,
  });
});

test("never-resolving steps time out with exit 1", async () => {
  assert.deepEqual(await runShutdown(() => new Promise(() => {}), 20), { outcome: "timeout", exitCode: 1 });
});

test("a failed save is save-failed with exit 1", async () => {
  assert.deepEqual(await runShutdown(async () => ({ ok: false, error: new Error("x") }), 1000), {
    outcome: "save-failed",
    exitCode: 1,
  });
});

test("rejecting steps are treated as save-failed", async () => {
  assert.deepEqual(
    await runShutdown(async () => {
      throw new Error("boom");
    }, 1000),
    { outcome: "save-failed", exitCode: 1 },
  );
});
