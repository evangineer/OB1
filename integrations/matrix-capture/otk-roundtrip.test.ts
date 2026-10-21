import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = path.join(import.meta.dirname, "test-fixtures", "otk-roundtrip.ts");

function run(mode: string, snapshotPath: string): string {
  const res = spawnSync(process.execPath, ["--import", "tsx", fixture, mode, snapshotPath], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `${mode} failed: ${res.stderr}`);
  return res.stdout.trim();
}

test("one-time keys survive a snapshot restore in a separate process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otk-"));
  try {
    const snap = path.join(dir, "snap.bin");
    const generated = JSON.parse(run("generate", snap));
    const restored = JSON.parse(run("restore", snap));
    assert.ok(Array.isArray(generated) && generated.length > 0);
    assert.deepEqual(restored, generated);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
