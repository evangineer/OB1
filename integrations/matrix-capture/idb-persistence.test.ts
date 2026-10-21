import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import v8 from "node:v8";
import { IDBFactory } from "fake-indexeddb";
import { persistIdbToDisk, restoreIdbFromDisk } from "./idb-persistence.js";

const quiet = { warn: () => {} };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "idb-persist-test-"));
}

function openDb(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("s", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function withDeadline<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms)),
  ]);
}

function writeSnapshot(dir: string, snapshot: unknown): string {
  const file = path.join(dir, "snap.json");
  fs.writeFileSync(file, v8.serialize(snapshot));
  return file;
}

test("restore distinguishes absent, restored and failed", async () => {
  const dir = tmpDir();
  const missing = path.join(dir, "missing.json");
  assert.deepEqual(await restoreIdbFromDisk(missing, { factory: new IDBFactory(), log: quiet }), {
    status: "absent",
  });

  const source = new IDBFactory();
  const db = await openDb(source, "db1", 1);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put({ id: "a", v: 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  const file = path.join(dir, "snap.json");
  const persisted = await persistIdbToDisk({ snapshotPath: file, factory: source, log: quiet });
  assert.deepEqual(persisted, { ok: true, databases: 1 });

  assert.deepEqual(await restoreIdbFromDisk(file, { factory: new IDBFactory(), log: quiet }), {
    status: "restored",
    databases: 1,
  });

  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "garbage");
  const res = await restoreIdbFromDisk(bad, { factory: new IDBFactory(), log: quiet });
  assert.equal(res.status, "failed");
});

test("restore fails instead of hanging when insertion aborts", async () => {
  const dir = tmpDir();
  const file = writeSnapshot(dir, [
    {
      name: "db1",
      version: 1,
      stores: [
        {
          name: "s",
          keyPath: "id",
          autoIncrement: false,
          indexes: [{ name: "byK", keyPath: "k", multiEntry: false, unique: true }],
          records: [
            { key: "a", value: { id: "a", k: 1 } },
            { key: "b", value: { id: "b", k: 1 } },
          ],
        },
      ],
    },
  ]);
  const res = await withDeadline(
    restoreIdbFromDisk(file, { factory: new IDBFactory(), log: quiet }),
  );
  assert.equal(res.status, "failed");
});

test("restore fails when the open is blocked", async () => {
  const dir = tmpDir();
  const factory = new IDBFactory();
  const holder = await openDb(factory, "db1", 1);
  const file = writeSnapshot(dir, [
    {
      name: "db1",
      version: 2,
      stores: [{ name: "t", keyPath: "id", autoIncrement: false, indexes: [], records: [] }],
    },
  ]);
  const res = await withDeadline(restoreIdbFromDisk(file, { factory, log: quiet }));
  holder.close();
  assert.equal(res.status, "failed");
});

test("restore fails on a transaction error", async () => {
  const dir = tmpDir();
  const file = writeSnapshot(dir, [
    {
      name: "db1",
      version: 1,
      stores: [
        {
          name: "s",
          keyPath: "id",
          autoIncrement: false,
          indexes: [],
          records: [{ key: "a", value: { notId: 1 } }],
        },
      ],
    },
  ]);
  const res = await withDeadline(
    restoreIdbFromDisk(file, { factory: new IDBFactory(), log: quiet }),
  );
  assert.equal(res.status, "failed");
});

test("persist reports failure when the directory is unwritable", async () => {
  const dir = tmpDir();
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const factory = new IDBFactory();
  (await openDb(factory, "db1", 1)).close();
  const res = await persistIdbToDisk({
    snapshotPath: path.join(blocker, "sub", "snap.json"),
    factory,
    log: quiet,
  });
  assert.equal(res.ok, false);
});
