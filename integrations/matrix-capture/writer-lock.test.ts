import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeLegacyLockDirs } from "./writer-lock.js";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(pkgDir, "entrypoint.sh");
const holdLock = path.join(pkgDir, "test-fixtures", "hold-lock.ts");
const wipeStore = path.join(pkgDir, "test-fixtures", "wipe-store.sh");
const nodeHold = [process.execPath, "--import", "tsx", holdLock];

const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "writer-lock-test-"));
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, MATRIX_INDEXEDDB_PATH: dir };
}

type Started = { child: ChildProcess; stderr: () => string };

/** Spawns a process and resolves once it prints `marker` on stdout. */
function startUntil(cmd: string, args: string[], env: NodeJS.ProcessEnv, marker = "HELD"): Promise<Started> {
  const child = spawn(cmd, args, { cwd: pkgDir, env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out waiting for ${marker}; stderr: ${err}`));
    }, 10_000);
    child.stdout!.on("data", (d) => {
      out += d;
      if (out.includes(marker)) {
        clearTimeout(timer);
        resolve({ child, stderr: () => err });
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`exited (${code ?? signal}) before ${marker}; stderr: ${err}`));
    });
  });
}

function killAndWait(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}

function runSync(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(cmd, args, { cwd: pkgDir, env, encoding: "utf8", timeout: 20_000 });
}

function startHolder(dir: string): Promise<Started> {
  return startUntil("sh", [entrypoint, ...nodeHold], envFor(dir));
}

test("second writer refuses while the first holds the lock", async () => {
  const dir = tmpDir();
  const first = await startHolder(dir);
  try {
    const second = runSync("sh", [entrypoint, ...nodeHold], envFor(dir));
    assert.equal(second.status, 75, second.stderr);
    assert.match(second.stderr, /refusing to start: G4 another writer holds /);
    assert.ok(second.stderr.includes(path.join(dir, ".writer.lock")), second.stderr);
    assert.ok(!second.stdout.includes("HELD"));
  } finally {
    await killAndWait(first.child);
  }
});

test("lock is released when the holder is SIGKILLed", async () => {
  const dir = tmpDir();
  const first = await startHolder(dir);
  await killAndWait(first.child, "SIGKILL");
  const next = await startHolder(dir);
  await killAndWait(next.child);
});

test("node without the entrypoint refuses when unlocked", () => {
  const dir = tmpDir();
  const r = runSync(process.execPath, nodeHold.slice(1), envFor(dir));
  assert.ok(!r.stdout.includes("HELD"), `accepted: ${r.stdout}`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to start: G4 not running under the writer lock/);
});

test("node without the entrypoint refuses while another writer holds the lock", async () => {
  const dir = tmpDir();
  const first = await startHolder(dir);
  try {
    const r = runSync(process.execPath, nodeHold.slice(1), envFor(dir));
    assert.ok(!r.stdout.includes("HELD"), `accepted: ${r.stdout}`);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /refusing to start: G4 not running under the writer lock/);
  } finally {
    await killAndWait(first.child);
  }
});

test("a wrong fd 9 refuses", () => {
  const dir = tmpDir();
  fs.closeSync(fs.openSync(path.join(dir, ".writer.lock"), "a"));
  const other = path.join(tmpDir(), "other");
  const r = runSync(
    "sh",
    ["-c", 'exec 9>>"$OTHER"; exec "$NODE" --import tsx "$HOLD"'],
    { ...envFor(dir), OTHER: other, NODE: process.execPath, HOLD: holdLock },
  );
  assert.ok(!r.stdout.includes("HELD"), `accepted: ${r.stdout}`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to start: G4 not running under the writer lock/);
});

test("a wipe under the lock keeps the lock inode", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, ".writer.lock");
  fs.closeSync(fs.openSync(lock, "a"));
  fs.writeFileSync(path.join(dir, "crypto-idb-snapshot.json"), "snapshot");
  fs.mkdirSync(path.join(dir, "crypto-idb-snapshot.json.lock"));
  fs.mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, "nested", "deeper", "f"), "x");
  fs.writeFileSync(path.join(dir, ".hidden"), "x");
  const inoBefore = fs.statSync(lock).ino;
  const backup = path.join(tmpDir(), "backup.tgz");

  // Holds the lock across the wipe, then blocks on stdin until the test lets it go.
  const wiper = await startUntil(
    "flock",
    ["-n", lock, "sh", "-c", 'sh "$WIPE" "$DIR" "$BACKUP" && echo WIPED && { read _ || true; }'],
    { ...process.env, WIPE: wipeStore, DIR: dir, BACKUP: backup },
    "WIPED",
  );
  try {
    const during = runSync("sh", [entrypoint, ...nodeHold], envFor(dir));
    assert.equal(during.status, 75, during.stderr);
    assert.match(during.stderr, /refusing to start: G4 another writer holds /);
  } finally {
    wiper.child.stdin!.end();
    await new Promise<void>((resolve) => {
      if (wiper.child.exitCode !== null) resolve();
      else wiper.child.once("exit", () => resolve());
    });
  }
  assert.equal(wiper.child.exitCode, 0, wiper.stderr());
  assert.equal(fs.statSync(lock).ino, inoBefore);
  assert.deepEqual(fs.readdirSync(dir), [".writer.lock"]);
  assert.ok(fs.statSync(backup).size > 0);
  const listing = runSync("tar", ["-tzf", backup], process.env);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /crypto-idb-snapshot\.json/);
});

test("wipe deletes nothing when the backup fails", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "crypto-idb-snapshot.json"), "snapshot");
  const r = runSync("sh", [wipeStore, dir, path.join(dir, "no", "such", "dir", "b.tgz")], process.env);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(dir, "crypto-idb-snapshot.json")));
});

test("legacy lock dir is removed with a warning", () => {
  const dir = tmpDir();
  const snap = path.join(dir, "crypto-idb-snapshot.json");
  const legacy = `${snap}.lock`;
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "owner"), "x");
  const mtime = new Date("2026-05-03T09:00:00.000Z");
  fs.utimesSync(legacy, mtime, mtime);
  const warnings: string[] = [];
  removeLegacyLockDirs(snap, { warn: (...a: unknown[]) => void warnings.push(a.map(String).join(" ")) });
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /legacy snapshot lock/);
  assert.ok(warnings[0].includes(mtime.toISOString()), warnings[0]);
});

test("removeLegacyLockDirs leaves non-directories alone and ignores absence", () => {
  const dir = tmpDir();
  const snap = path.join(dir, "crypto-idb-snapshot.json");
  const warnings: string[] = [];
  const log = { warn: (...a: unknown[]) => void warnings.push(a.map(String).join(" ")) };
  removeLegacyLockDirs(snap, log);
  const target = path.join(dir, "target");
  fs.mkdirSync(target);
  fs.symlinkSync(target, `${snap}.lock`);
  removeLegacyLockDirs(snap, log);
  assert.ok(fs.lstatSync(`${snap}.lock`).isSymbolicLink());
  assert.ok(fs.existsSync(target));
  assert.equal(warnings.length, 0);
});

test("a missing flock binary cannot check rather than accepting", () => {
  const dir = tmpDir();
  const r = runSync(
    "sh",
    ["-c", 'exec 9>>"$DIR/.writer.lock"; PATH=/nonexistent exec "$NODE" --import tsx "$HOLD"'],
    { ...envFor(dir), DIR: dir, NODE: process.execPath, HOLD: holdLock },
  );
  assert.ok(!r.stdout.includes("HELD"), `accepted: ${r.stdout}`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to start: G4 cannot check writer lock: /);
});
