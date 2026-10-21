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
import v8 from "node:v8";
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

export type RestoreResult =
  | { status: "absent" }
  | { status: "restored"; databases: number }
  | { status: "failed"; error: unknown };

export type PersistResult = { ok: true; databases: number } | { ok: false; error: unknown };

export type PersistenceOptions = {
  factory?: IDBFactory;
  log?: Pick<Console, "warn">;
  /** Test-only fault hook, invoked just before the snapshot is renamed into place. */
  beforeRename?: () => void;
};

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

function parseSnapshotPayload(data: Buffer): IdbDatabaseSnapshot[] | null {
  const parsed = v8.deserialize(data) as unknown;
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

async function dumpIndexedDatabases(
  idb: IDBFactory,
  databasePrefix?: string,
): Promise<IdbDatabaseSnapshot[]> {
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

function waitForTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => resolve(), { once: true });
    tx.addEventListener("abort", () => reject(tx.error ?? new Error("IndexedDB transaction aborted")), {
      once: true,
    });
    tx.addEventListener("error", () => reject(tx.error ?? new Error("IndexedDB transaction error")), {
      once: true,
    });
  });
}

function openForRestore(idb: IDBFactory, dbSnap: IdbDatabaseSnapshot): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    r.addEventListener("success", () => resolve(r.result), { once: true });
    r.addEventListener("error", () => reject(r.error ?? new Error("IndexedDB open failed")), {
      once: true,
    });
    r.addEventListener(
      "blocked",
      () => reject(new Error(`IndexedDB open blocked for ${dbSnap.name}`)),
      { once: true },
    );
  });
}

async function restoreIndexedDatabases(
  idb: IDBFactory,
  snapshot: IdbDatabaseSnapshot[],
): Promise<void> {
  for (const dbSnap of snapshot) {
    const db = await openForRestore(idb, dbSnap);
    try {
      for (const storeSnap of dbSnap.stores) {
        if (storeSnap.records.length === 0) {
          continue;
        }
        const tx = db.transaction(storeSnap.name, "readwrite");
        const done = waitForTransaction(tx);
        done.catch(() => {});
        try {
          const store = tx.objectStore(storeSnap.name);
          for (const rec of storeSnap.records) {
            if (storeSnap.keyPath !== null) {
              store.put(rec.value);
            } else {
              store.put(rec.value, rec.key);
            }
          }
        } catch (error) {
          try {
            tx.abort();
          } catch {}
          throw error;
        }
        await done;
      }
    } finally {
      db.close();
    }
  }
}

export async function restoreIdbFromDisk(
  snapshotPath: string,
  opts: PersistenceOptions = {},
): Promise<RestoreResult> {
  const idb = opts.factory ?? fakeIndexedDB;
  const log = opts.log ?? console;
  if (!snapshotPath || !fs.existsSync(snapshotPath)) {
    return { status: "absent" };
  }
  try {
    const data = fs.readFileSync(snapshotPath);
    const snapshot = parseSnapshotPayload(data);
    if (!snapshot) {
      return { status: "absent" };
    }
    await restoreIndexedDatabases(idb, snapshot);
    return { status: "restored", databases: snapshot.length };
  } catch (error) {
    log.warn(`Failed to restore IndexedDB snapshot from ${snapshotPath}:`, error);
    return { status: "failed", error };
  }
}

export async function persistIdbToDisk(
  params: { snapshotPath: string; databasePrefix?: string } & PersistenceOptions,
): Promise<PersistResult> {
  const idb = params.factory ?? fakeIndexedDB;
  const log = params.log ?? console;
  const snapshotPath = params.snapshotPath;
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const snapshot = await dumpIndexedDatabases(idb, params.databasePrefix);
    if (snapshot.length === 0) {
      return { ok: true, databases: 0 };
    }
    fs.writeFileSync(snapshotPath, v8.serialize(snapshot));
    fs.chmodSync(snapshotPath, 0o600);
    return { ok: true, databases: snapshot.length };
  } catch (error) {
    log.warn("Failed to persist IndexedDB snapshot:", error);
    return { ok: false, error };
  }
}
