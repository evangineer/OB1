/*
 * Portions of this file are derived from or materially adapted from OpenClaw's
 * Matrix extension:
 * https://github.com/openclaw/openclaw/tree/main/extensions/matrix
 *
 * See THIRD_PARTY_NOTICE.md in this directory for attribution and license terms.
 */

import "fake-indexeddb/auto";

import fs from "node:fs";
import path from "node:path";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";

type IdbStoreSnapshot = {
  name: string;
  keyPath: IDBObjectStoreParameters["keyPath"];
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }[];
  records: { key: IDBValidKey; value: unknown }[];
};

type IdbDatabaseSnapshot = {
  name: string;
  version: number;
  stores: IdbStoreSnapshot[];
};

const SNAPSHOT_LOCK_TIMEOUT_MS = 10_000;

async function withSnapshotLock<T>(snapshotPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${snapshotPath}.lock`;
  const deadline = Date.now() + SNAPSHOT_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Matrix IndexedDB snapshot lock at ${lockPath}`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {}
  }
}

function isValidIdbIndexSnapshot(value: unknown): value is IdbStoreSnapshot["indexes"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbStoreSnapshot["indexes"][number]>;
  return (
    typeof candidate.name === "string" &&
    (typeof candidate.keyPath === "string" ||
      (Array.isArray(candidate.keyPath) &&
        candidate.keyPath.every((entry) => typeof entry === "string"))) &&
    typeof candidate.multiEntry === "boolean" &&
    typeof candidate.unique === "boolean"
  );
}

function isValidIdbRecordSnapshot(value: unknown): value is IdbStoreSnapshot["records"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "key" in value && "value" in value;
}

function isValidIdbStoreSnapshot(value: unknown): value is IdbStoreSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbStoreSnapshot>;
  const validKeyPath =
    candidate.keyPath === null ||
    typeof candidate.keyPath === "string" ||
    (Array.isArray(candidate.keyPath) &&
      candidate.keyPath.every((entry) => typeof entry === "string"));
  return (
    typeof candidate.name === "string" &&
    validKeyPath &&
    typeof candidate.autoIncrement === "boolean" &&
    Array.isArray(candidate.indexes) &&
    candidate.indexes.every((entry) => isValidIdbIndexSnapshot(entry)) &&
    Array.isArray(candidate.records) &&
    candidate.records.every((entry) => isValidIdbRecordSnapshot(entry))
  );
}

function isValidIdbDatabaseSnapshot(value: unknown): value is IdbDatabaseSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<IdbDatabaseSnapshot>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.version === "number" &&
    Number.isFinite(candidate.version) &&
    candidate.version > 0 &&
    Array.isArray(candidate.stores) &&
    candidate.stores.every((entry) => isValidIdbStoreSnapshot(entry))
  );
}

function parseSnapshotPayload(data: string): IdbDatabaseSnapshot[] | null {
  const parsed = JSON.parse(data) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  if (!parsed.every((entry) => isValidIdbDatabaseSnapshot(entry))) {
    throw new Error("Malformed IndexedDB snapshot payload");
  }
  return parsed;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result), { once: true });
    req.addEventListener("error", () => reject(req.error), { once: true });
  });
}

async function dumpIndexedDatabases(databasePrefix?: string): Promise<IdbDatabaseSnapshot[]> {
  const idb = fakeIndexedDB;
  const dbList = await idb.databases();
  const snapshot: IdbDatabaseSnapshot[] = [];
  const expectedPrefix = databasePrefix ? `${databasePrefix}::` : null;

  for (const { name, version } of dbList) {
    if (!name || !version) {
      continue;
    }
    if (expectedPrefix && !name.startsWith(expectedPrefix)) {
      continue;
    }
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const r = idb.open(name, version);
      r.addEventListener("success", () => resolve(r.result), { once: true });
      r.addEventListener("error", () => reject(r.error), { once: true });
    });

    const stores: IdbStoreSnapshot[] = [];
    for (const storeName of db.objectStoreNames) {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const storeInfo: IdbStoreSnapshot = {
        name: storeName,
        keyPath: store.keyPath as IDBObjectStoreParameters["keyPath"],
        autoIncrement: store.autoIncrement,
        indexes: [],
        records: [],
      };
      for (const idxName of store.indexNames) {
        const idx = store.index(idxName);
        storeInfo.indexes.push({
          name: idxName,
          keyPath: idx.keyPath,
          multiEntry: idx.multiEntry,
          unique: idx.unique,
        });
      }
      const keys = await idbReq(store.getAllKeys());
      const values = await idbReq(store.getAll());
      storeInfo.records = keys.map((k, i) => ({ key: k, value: values[i] }));
      stores.push(storeInfo);
    }
    snapshot.push({ name, version, stores });
    db.close();
  }
  return snapshot;
}

async function restoreIndexedDatabases(snapshot: IdbDatabaseSnapshot[]): Promise<void> {
  const idb = fakeIndexedDB;
  for (const dbSnap of snapshot) {
    await new Promise<void>((resolve, reject) => {
      const r = idb.open(dbSnap.name, dbSnap.version);
      r.addEventListener("upgradeneeded", () => {
        const db = r.result;
        for (const storeSnap of dbSnap.stores) {
          const opts: IDBObjectStoreParameters = {};
          if (storeSnap.keyPath !== null) {
            opts.keyPath = storeSnap.keyPath;
          }
          if (storeSnap.autoIncrement) {
            opts.autoIncrement = true;
          }
          const store = db.createObjectStore(storeSnap.name, opts);
          for (const idx of storeSnap.indexes) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            });
          }
        }
      });
      r.addEventListener(
        "success",
        () => {
          void (async () => {
            const db = r.result;
            for (const storeSnap of dbSnap.stores) {
              if (storeSnap.records.length === 0) {
                continue;
              }
              const tx = db.transaction(storeSnap.name, "readwrite");
              const store = tx.objectStore(storeSnap.name);
              for (const rec of storeSnap.records) {
                if (storeSnap.keyPath !== null) {
                  store.put(rec.value);
                } else {
                  store.put(rec.value, rec.key);
                }
              }
              await new Promise<void>((res) => {
                tx.addEventListener("complete", () => res(), { once: true });
              });
            }
            db.close();
            resolve();
          })().catch(reject);
        },
        { once: true },
      );
      r.addEventListener("error", () => reject(r.error), { once: true });
    });
  }
}

export async function restoreIdbFromDisk(snapshotPath: string): Promise<boolean> {
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return false;
  }
  try {
    return await withSnapshotLock(snapshotPath, async () => {
      if (!fs.existsSync(snapshotPath)) {
        return false;
      }
      const data = fs.readFileSync(snapshotPath, "utf8");
      const snapshot = parseSnapshotPayload(data);
      if (!snapshot) {
        return false;
      }
      await restoreIndexedDatabases(snapshot);
      console.log(`Restored ${snapshot.length} IndexedDB database(s) from ${snapshotPath}`);
      return true;
    });
  } catch (error) {
    console.warn(`Failed to restore IndexedDB snapshot from ${snapshotPath}:`, error);
    return false;
  }
}

export async function persistIdbToDisk(params: {
  snapshotPath: string;
  databasePrefix?: string;
}): Promise<void> {
  const snapshotPath = params.snapshotPath;
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const persistedCount = await withSnapshotLock(snapshotPath, async () => {
      const snapshot = await dumpIndexedDatabases(params.databasePrefix);
      if (snapshot.length === 0) {
        return 0;
      }
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
      fs.chmodSync(snapshotPath, 0o600);
      return snapshot.length;
    });
    if (persistedCount > 0) {
      console.log(`Persisted ${persistedCount} IndexedDB database(s) to ${snapshotPath}`);
    }
  } catch (error) {
    console.warn("Failed to persist IndexedDB snapshot:", error);
  }
}
