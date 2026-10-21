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

test("restore fails on a present but empty or non-array snapshot", async () => {
  for (const payload of [[], {}]) {
    const file = writeSnapshot(tmpDir(), payload);
    const res = await restoreIdbFromDisk(file, { factory: new IDBFactory(), log: quiet });
    assert.equal(res.status, "failed");
  }
});

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

async function seedOne(factory: IDBFactory, name: string): Promise<void> {
  const db = await openDb(factory, name, 1);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put({ id: "a", v: 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

test("a failure before rename leaves the old snapshot byte-identical", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "snap.json");
  const factory = new IDBFactory();
  await seedOne(factory, "db1");
  assert.equal((await persistIdbToDisk({ snapshotPath: file, factory, log: quiet })).ok, true);
  const before = fs.readFileSync(file);

  const res = await persistIdbToDisk({
    snapshotPath: file,
    factory,
    log: quiet,
    beforeRename: () => {
      throw new Error("injected");
    },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test("temp and final files are 0600, even over a leftover 0644 temp", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "snap.json");
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, "stale", { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  const factory = new IDBFactory();
  await seedOne(factory, "db1");
  let checked = false;
  const res = await persistIdbToDisk({
    snapshotPath: file,
    factory,
    log: quiet,
    beforeRename: () => {
      assert.equal(mode(tmp), 0o600);
      assert.equal(fs.readFileSync(tmp).includes("stale"), false);
      checked = true;
    },
  });
  assert.deepEqual(res, { ok: true, databases: 1 });
  assert.equal(checked, true);
  assert.equal(mode(file), 0o600);
  assert.equal(fs.existsSync(tmp), false);
});

test("restore ignores a leftover temp file", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "snap.json");
  fs.writeFileSync(`${file}.tmp`, "garbage");
  assert.deepEqual(await restoreIdbFromDisk(file, { factory: new IDBFactory(), log: quiet }), {
    status: "absent",
  });
});

test("a two-store write is never torn", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "snap.json");
  const real = new IDBFactory();
  const db0 = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = real.open("db1", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("a", { keyPath: "id" });
      r.result.createObjectStore("b", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db0.transaction(["a", "b"], "readwrite");
    tx.objectStore("a").put({ id: "k", v: 1 });
    tx.objectStore("b").put({ id: "k", v: 1 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db0.close();

  let fired = false;
  const hook = (db: IDBDatabase) => {
    const origTx = db.transaction.bind(db);
    db.transaction = ((names: string | string[], m?: IDBTransactionMode) => {
      const tx = origTx(names, m);
      const origStore = tx.objectStore.bind(tx);
      tx.objectStore = ((n: string) => {
        const store = origStore(n);
        if (n === "a") {
          const origGetAll = store.getAll.bind(store);
          store.getAll = ((...args: []) => {
            const req = origGetAll(...args);
            req.addEventListener("success", () => {
              if (fired) return;
              fired = true;
              const w = db.transaction(["a", "b"], "readwrite");
              w.objectStore("a").put({ id: "k", v: 2 });
              w.objectStore("b").put({ id: "k", v: 2 });
            });
            return req;
          }) as typeof store.getAll;
        }
        return store;
      }) as typeof tx.objectStore;
      return tx;
    }) as typeof db.transaction;
  };
  const wrapped = {
    databases: () => real.databases(),
    open: (name: string, version?: number) => {
      const r = real.open(name, version);
      r.addEventListener("success", () => hook(r.result));
      return r;
    },
  } as unknown as IDBFactory;

  const res = await persistIdbToDisk({ snapshotPath: file, factory: wrapped, log: quiet });
  assert.equal(res.ok, true);
  assert.equal(fired, true);

  const fresh = new IDBFactory();
  assert.equal((await restoreIdbFromDisk(file, { factory: fresh, log: quiet })).status, "restored");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = fresh.open("db1");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const get = (s: string) =>
    new Promise<{ v: number }>((resolve, reject) => {
      const q = db.transaction(s, "readonly").objectStore(s).get("k");
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  const [a, b] = [await get("a"), await get("b")];
  db.close();
  assert.equal(a.v, b.v);
});
