# Matrix-capture Crypto-store Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The capture bot refuses to run on crypto state that doesn't match its Matrix device, and never silently loses crypto state. It ships as a CI-built image pinned per tenant by digest, and ob1m is rotated to a fresh device.

**Architecture:**
- **Writer lock:** a kernel `flock`, taken by `entrypoint.sh` and inherited by node, guarantees one writer per volume.
- **`idb-persistence.ts`** gains typed results, a restore that can't hang, a consistent single-transaction dump and atomic exclusive-0600 writes.
- **New modules:**
  - `crypto-guard.ts`: the startup decision, the device-key check and the startup gate;
  - `startup.ts`: the dependency-injected startup sequence;
  - `snapshot-scheduler.ts`: serialised saves, escalation, and the SDK hooks for durable-before-publish and save-before-next-sync, with a failure latch.
- **`service.ts`** wires them in.
- **Rollout:** a GHCR workflow, a per-tenant `roles/ob1`, the ob1m stack pinned by digest, and operator-gated recovery.

**Tech Stack:** Node 20 (image) and TypeScript via tsx; matrix-js-sdk 36.2.0 with Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`, already installed); fake-indexeddb 6; util-linux `flock`; `node:test` and `node:http` for a fake homeserver; GitHub Actions; Ansible; Docker Swarm through Dokploy.

**Spec:** `docs/superpowers/specs/2026-10-21-matrix-capture-crypto-store-design.md`. Section numbers (§, G1–G8) refer to it. "Codex #n" and "Codex 2 #n" refer to the two review passes folded into it.

## Global Constraints

- Work in `~/src/OB1` on branch `matrix-capture-crypto-store`, which is cut from the deployed commit `5825a13`. Code lives in `integrations/matrix-capture/`.
- No new npm dependencies. Tests use `node:test` via `node --import tsx --test`. Importing the already-installed `@matrix-org/matrix-sdk-crypto-wasm` and matrix-js-sdk internals is allowed.
- The existing v8 snapshot format stays readable (`edf0b65`). The snapshot path default stays `/data/indexeddb/crypto-idb-snapshot.json`, and the writer lock is `<MATRIX_INDEXEDDB_PATH>/.writer.lock`.
- **Escalation and shutdown:** saves escalate to `error` after 3 consecutive failures, and the process exits non-zero after `600_000` ms of continuous failure. The shutdown timeout is `20_000` ms, and the stack's `stop_grace_period` is `30s`.
- **Exact message prefixes:**
  - `refusing to start: G1 device-key mismatch for <userId>/<deviceId>`, ending `see RUNBOOK "Matrix device reauth"`;
  - `refusing to start: G1 could not verify device keys`;
  - `refusing to start: G2 restore failed`;
  - `refusing to start: G4 another writer holds <path>` (entrypoint, exit code 75);
  - `refusing to start: G4 not running under the writer lock`;
  - `incoming crypto processing failed`.
- Snapshot and temp files are 0600 from creation; temp files are created with `wx`. Never log secrets, snapshot contents or key values. The existing key-upload diagnostics stay behind `MATRIX_CRYPTO_DEBUG`.
- Keep the third-party attribution headers. OB1 commits are signed off (`-s`), and all commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Image:** `ghcr.io/evangineer/ob1-matrix-capture`, `linux/arm64` only.
  - CI derives the tag as `<version>-<sha7>`, refuses existing tags, and uses one `concurrency` group per tag.
  - Stacks pin `tag@sha256:digest`.
  - The Dockerfile uses `npm ci` with `package-lock.json`, and starts through `entrypoint.sh`.
- **Nothing touches ob1s's capture bot:** not its stack, its env files, its rooms, its volume, or Sofia's device.
  - `roles/ob1` acts only on `ob1_matrix_capture_managed_tenants: [ob1m]`, and every rollout command uses `--tags ob1`.
  - A full `site.yml` run still updates ob1s's Supabase backend and MCP wiring through other roles, as today (spec G8 scope).
- Pushes, deploys, applies and the rotation each need the operator's go-ahead.
- `.writer.lock` is never deleted or replaced by anything.
- `MATRIX_CRYPTO_DB_PREFIX` stays unwired, and is documented as inert.

## Review Focus

1. **The 3 May legacy `.lock/` directories.** Expected: removed with a warning once the writer lock is held. Test in Task 3.
2. **A second container started on the same volume** (a manual `docker run`, or Swarm overlap). Expected: the entrypoint exits 75 with the G4 message, and the first writer is unaffected. Test in Task 3.
3. **A leftover `.tmp`, including one with mode 0644.** Expected: restore ignores it, and the next save deletes it and creates a fresh 0600 file. Test in Task 2.
4. **`/keys/query` unreachable or 5xx.** Expected: `refusing to start: G1 could not verify device keys`, with nothing published or saved. Tests in Tasks 4 and 7.
5. **The snapshot directory is unwritable.** Expected: saves report failure, escalate and exit; publishes stay blocked. Tests in Tasks 1 and 5.

---

### Task 1: Test harness, typed results, and a restore that can't hang

**Files:**
- Modify: `integrations/matrix-capture/idb-persistence.ts`
  - `restoreIndexedDatabases` `:185-240` and `restoreIdbFromDisk` `:242-264`: results, rejecting on `abort`/`error`/`blocked`, closing in `finally`;
  - `persistIdbToDisk` `:266-288`: results.
- Modify: `package.json`, adding `"test": "node --import tsx --test *.test.ts"`; `tsconfig.json`, setting `"include": ["*.ts", "test-fixtures/*.ts"]`
- Create: `integrations/matrix-capture/idb-persistence.test.ts`

**Interfaces:**
- Produces, exported from `idb-persistence.ts`:
  - `type RestoreResult = { status: "absent" } | { status: "restored"; databases: number } | { status: "failed"; error: unknown }`
  - `type PersistResult = { ok: true; databases: number } | { ok: false; error: unknown }`
  - `type PersistenceOptions = { factory?: IDBFactory; log?: Pick<Console, "warn">; beforeRename?: () => void }`. `factory` defaults to fake-indexeddb's `indexedDB`; `beforeRename` is a test-only fault hook used in Task 2.
  - `restoreIdbFromDisk(snapshotPath: string, opts?: PersistenceOptions): Promise<RestoreResult>`
  - `persistIdbToDisk(params: { snapshotPath: string; databasePrefix?: string } & PersistenceOptions): Promise<PersistResult>`
- Remove `withSnapshotLock`, because the kernel writer lock replaces it (Task 3). Removing legacy `.lock/` directories also belongs to Task 3.

- [ ] **Step 1: Write failing tests.** Each uses its own `mkdtempSync` directory and a `new IDBFactory()` passed as `factory`.
  - `restore distinguishes absent, restored and failed`:
    - missing file → `absent`;
    - a snapshot persisted from one database with one record → `{ status: "restored", databases: 1 }`;
    - the bytes `garbage` → `failed`.
  - `restore fails instead of hanging when insertion aborts`: a hand-built v8 snapshot with a unique index and two records sharing that key gives `failed` within 2 s.
  - `restore fails when the open is blocked`: hold an open connection at a lower version on the same factory, without a `versionchange` handler that closes it. Expected: `failed` within 2 s.
  - `restore fails on a transaction error`: a record whose key violates the store's `keyPath` gives `failed` within 2 s.
  - `persist reports failure when the directory is unwritable`: the snapshot path sits under a regular file → `{ ok: false }`, with no throw.
- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd integrations/matrix-capture && npm test`
  Expected: failures from the return shape, plus the abort, blocked and error tests timing out.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: typed snapshot results; restore cannot hang"`

### Task 2: Atomic exclusive-0600 writes and a consistent dump

**Files:**
- Modify: `idb-persistence.ts`, the dump `:137-182` and the write
- Test: `idb-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's results and options.
- The temp file is `<snapshotPath>.tmp`.

- [ ] **Step 1: Write failing tests:**
  - `a failure before rename leaves the old snapshot byte-identical`.
  - `temp and final files are 0600, even over a leftover 0644 temp` (Review Focus 3, Codex 2 #6).
    - Pre-create `<snap>.tmp` with mode 0644 and content `stale`.
    - `beforeRename` asserts the temp file is 0600 and doesn't contain `stale`.
    - After the persist, the final file is 0600.
  - `restore ignores a leftover temp file`.
  - `a two-store write is never torn`:
    - wrap the factory so that, when the dump requests store `a`'s records, its `success` handler first starts a `readwrite` transaction over `["a","b"]`;
    - restore into a fresh factory, and assert `a` and `b` agree;
    - **run it against the unmodified dump first and record the failure**. If it passes there, fix the test.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.**
  - **Dump:** one `db.transaction([...db.objectStoreNames], "readonly")` per database.
  - **Write:** `rmSync(tmp, { force: true })`, then `openSync(tmp, "wx", 0o600)`, write, `fsyncSync`, close, `beforeRename?.()`, `renameSync`, and fsync the directory.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: atomic exclusive-0600 snapshot writes; single-transaction dumps"`

### Task 3: Kernel writer lock: `entrypoint.sh` and `writer-lock.ts` (G4)

**Files:**
- Create: `integrations/matrix-capture/entrypoint.sh`, `writer-lock.ts`, `writer-lock.test.ts`, `test-fixtures/hold-lock.ts`, `test-fixtures/wipe-store.sh`
  - `wipe-store.sh <dir> <backup.tgz>`: tar `<dir>` to the backup, and only if that succeeds, `find <dir> -mindepth 1 ! -name .writer.lock -exec rm -rf {} +`. It runs under BusyBox sh and POSIX sh.

**Interfaces:**
- **`entrypoint.sh`** (POSIX sh, `set -eu`):
  - `dir="${MATRIX_INDEXEDDB_PATH:-/data/indexeddb}"; mkdir -p "$dir"; exec 9>>"$dir/.writer.lock"`;
  - `flock -n 9 || { echo "refusing to start: G4 another writer holds $dir/.writer.lock" >&2; exit 75; }`;
  - `exec "$@"`. The Dockerfile passes `node --import tsx service.ts`; tests pass a fixture.
- `writer-lock.ts` produces:
  - `assertRunningUnderWriterLock(lockPath: string, fd: number = 9): void` (Codex 3 #1):
    1. **fd open:** `fstatSync(fd)` succeeds;
    2. **same file:** its `dev` and `ino` equal `statSync(lockPath)`'s;
    3. **we hold it:** `spawnSync("flock", ["-n", String(fd)], { stdio: [ "ignore", "ignore", "pipe", …(fd − 3) × "ignore", fd ] })` exits 0. That passes **our** fd to the child as the same number.
    - A failure of 1 or 2, or exit 1 in 3, throws `refusing to start: G4 not running under the writer lock`.
    - Any other status, or `flock` missing, throws `refusing to start: G4 cannot check writer lock: <detail>`.
  - `removeLegacyLockDirs(snapshotPath: string, log: Pick<Console,"warn">): void`: removes `<snapshotPath>.lock/` when it is a directory, warning with `legacy snapshot lock` and its mtime.
- **`test-fixtures/hold-lock.ts`:** calls `assertRunningUnderWriterLock`, prints `HELD`, then sleeps until killed.

- [ ] **Step 1: Write failing tests** (`writer-lock.test.ts`):
  - `second writer refuses while the first holds the lock` (Review Focus 2):
    - spawn `sh entrypoint.sh node --import tsx test-fixtures/hold-lock.ts` with `MATRIX_INDEXEDDB_PATH=<tmp>` and wait for `HELD`;
    - spawn a second one → exit code 75, and stderr contains `refusing to start: G4 another writer holds`.
  - `lock is released when the holder is SIGKILLed`: kill the first with `SIGKILL`; a new start prints `HELD`.
  - `node without the entrypoint refuses when unlocked`: run `hold-lock.ts` directly with no holder → `G4 not running under the writer lock`.
  - `node without the entrypoint refuses while another writer holds the lock` (Codex 3 #1): with the first holder running, run `hold-lock.ts` directly → `G4 not running under the writer lock`. **This test must fail against the contention-only probe.**
  - `a wrong fd 9 refuses`: start node with fd 9 open on a different file (`sh -c 'exec 9>other; exec node …'`) → `G4 not running under the writer lock`.
  - `a wipe under the lock keeps the lock inode` (Codex 3 #2):
    - Hold `flock -n <dir>/.writer.lock` from a shell running the same wipe command as Task 9, which keeps `.writer.lock` and deletes all other entries.
    - During the wipe, an entrypoint start exits 75.
    - Afterwards, `.writer.lock` has the same inode, and the directory contains only `.writer.lock`.
    - The wipe command lives in `test-fixtures/wipe-store.sh`, and Task 9 copies it verbatim.
  - `legacy lock dir is removed with a warning` (Review Focus 1): a `<snap>.lock/` directory, backdated to 2026-05-03, is gone afterwards, and a warn was logged.
- [ ] **Step 2: Run them and watch them fail** (`npm test`; the files are missing).
- [ ] **Step 3: Implement** `entrypoint.sh` (mode 0755) and `writer-lock.ts`.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: kernel writer lock via entrypoint flock"`

### Task 4: One-time-key round-trip regression test, plus `crypto-guard.ts` (G1, G2, startup gate)

**Files:**
- Create: `test-fixtures/otk-roundtrip.ts`, `otk-roundtrip.test.ts`, `crypto-guard.ts`, `crypto-guard.test.ts`

**Interfaces:**
- **The fixture:** `node --import tsx test-fixtures/otk-roundtrip.ts <generate|restore> <snapshotPath>`.
  - It runs `initAsync()`, then `OlmMachine.initialize(new UserId("@t:example.org"), new DeviceId("TESTDEV"), "ob1-test")` on fake-indexeddb.
  - It prints the sorted `one_time_keys` of the first `KeysUploadRequest`.
  - `generate` persists afterwards; `restore` restores first.
- `crypto-guard.ts` produces:
  - `type Verdict = { ok: true; note?: string } | { ok: false; reason: string }`
  - `decideStartup(restore: RestoreResult): Verdict`
    - `restored` → ok;
    - `absent` → ok with `note: "no snapshot; starting with an empty crypto store"`;
    - `failed` → `refusing to start: G2 restore failed: <message>`.
  - `checkDeviceIdentity(p: { userId; deviceId; local: { ed25519: string; curve25519: string }; server: Record<string,string> | undefined }): Verdict`
    - `undefined` → ok with a note containing `new device`;
    - both keys equal → ok;
    - else → the G1 mismatch message, which contains no key values.
  - `fetchServerDeviceKeys(p: { homeserverUrl; accessToken; userId; deviceId; fetchImpl?: typeof fetch }): Promise<Record<string,string> | undefined>`
    - Sends a raw `POST /_matrix/client/v3/keys/query` with `{ device_keys: { [userId]: [deviceId] } }`.
    - Throws `refusing to start: G1 could not verify device keys: <status|error>`.
  - `class StartupGate`: `wait(): Promise<void>`, which resolves only after `open()`; `open(): void`; and `get isOpen(): boolean`.

- [ ] **Step 1: Write the tests:**
  - **The round-trip:** `generate` and `restore` print deep-equal, non-empty key sets. Codex already observed this with the real WASM library, so it's a regression guard, and passing first time is expected. If it ever fails, stop.
  - **Guard tests:** one per verdict branch; `fetchServerDeviceKeys` against 200 with keys, 200 without the device, 502 and a network rejection (Review Focus 4); `StartupGate.wait()` stays pending until `open()`.
- [ ] **Step 2: Run them.** The guard tests fail (module missing); the round-trip test passes. Record both.
- [ ] **Step 3: Implement** `crypto-guard.ts`.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: startup decision, device-key check, startup gate"`

### Task 5: `snapshot-scheduler.ts`: saves, escalation, and the SDK durability hooks (G5, G6)

**Files:**
- Create: `snapshot-scheduler.ts`, `snapshot-scheduler.test.ts`, `sync-durability.test.ts`, `test-fixtures/fake-homeserver.ts`

**Interfaces:**
- Consumes: `PersistResult` (Task 1) and `StartupGate` (Task 4).
- Produces:
  - `class SnapshotScheduler`, constructed with `{ persist: () => Promise<PersistResult>; gate: Pick<StartupGate, "wait">; onFatal: (reason: string) => void; now?: () => number; log?: Pick<Console,"log"|"warn"|"error">; errorAfter?: number; fatalAfterMs?: number }`
    - `save(reason: string): Promise<PersistResult>`
      - awaits `gate.wait()` first;
      - **serialised:** a call made while a save runs waits for it, then runs its own;
      - **coalesced:** calls made while a save is queued share it;
      - logs `Persisted Matrix IndexedDB snapshot (<reason>)` only on ok;
      - on failure: `warn`, then `error` from the 3rd; `onFatal("snapshot saves failing for <n>s")` once the streak is ≥ 600 s.
    - `saveUntilOk(reason: string): Promise<void>`: backoff doubling from 1 s up to 30 s; escalation still applies.
  - `installPublishDurability(proto, opts: { gate: Pick<StartupGate,"wait">; isPublishing: (msg: unknown) => boolean; beforePublish: () => Promise<void> }): void`
    - Idempotent (`__ob1DurablePatched`).
    - Every request awaits `gate.wait()`. Publishing ones then await `beforePublish()`, which throws when the save isn't ok, before the original is called.
  - `installSyncDurability(proto, opts: { save: () => Promise<void>; onIncomingFailure: (reason: string) => void }): void`
    - Idempotent.
    - **`preprocessToDeviceMessages`:** a non-empty `events` marks the instance dirty; a rejection latches `failed`.
    - **`onSyncCompleted`:** awaits the original. If `failed` is latched, it calls `onIncomingFailure("incoming crypto processing failed")` and does **not** save. Else, if dirty, it awaits `save()`.
  - `latchIncomingFailure(client, proto)`: `ClientEvent.SyncUnexpectedError` sets the same latch. It fires before `onSyncCompleted` (`sync.js:769` vs `:788`).
  - `isPublishingRequest(msg: unknown): boolean`: `instanceof` against `KeysUploadRequest`, `SignatureUploadRequest`, `UploadSigningKeysRequest`, `ToDeviceRequest`, `KeysBackupRequest` and `PutDehydratedDeviceRequest`.
  - `test-fixtures/fake-homeserver.ts`: `startFakeHomeserver(handlers): Promise<{ url; requests: { method; path }[]; close() }>`, built on `node:http`.
    - It serves valid responses for `/versions`, `/account/whoami`, `POST /user/*/filter` (`{filter_id:"1"}`), `/pushrules/` (`{global:{}}`), `/capabilities` (`{capabilities:{}}`), `/keys/query`, `/keys/upload`, `/room_keys/version` (404 unless overridden) and `/sync`.
    - `/sync` serves a queue: each call **waits** for the next queued response, so the test controls timing. Everything else gets `{}`.

- [ ] **Step 1: Write failing tests:**
  - **`snapshot-scheduler.test.ts`:**
    - serialised and coalesced saves (3 calls during one in-flight save give 2 persists);
    - the gate blocks saves;
    - escalation (warn, warn, error; `onFatal` at 600 s, not 599 s; a success resets the streak);
    - publish ordering is `["gate","save","send"]`; a non-publishing request gives `["gate","send"]`; a throwing `beforePublish` sends nothing;
    - **the classifier (Codex 2 #6):** construct each of the six classes directly from `@matrix-org/matrix-sdk-crypto-wasm` where it exports a constructor, after `initAsync()`; otherwise take it from an `OlmMachine`'s `outgoingRequests()`. All six give true. `KeysQueryRequest` (from `updateTrackedUsers` then `outgoingRequests()`) and `KeysClaimRequest` give false.
  - **`sync-durability.test.ts`, against the real `SyncApi`:**
    - **Setup:** `createClient` points at the fake homeserver with `deviceId` set, then `initRustCrypto({ useIndexedDB: false })`, then `installSyncDurability(RustCrypto.prototype, …)`, then `startClient()`.
    - **Barrier:** queue `/sync` #1 with a `to_device` `m.dummy` event. `save` signals when it is **entered**, then stays pending. After it is entered, the fake has seen exactly one `/sync`. Resolve it, and `/sync` #2 is requested.
    - **Failure latch:** patch `RustCrypto.prototype.receiveSyncChanges` to reject. `onIncomingFailure` is called with `incoming crypto processing failed`, and `save` is never entered. Once `onIncomingFailure` is called (it stops the client in the test), no second `/sync` arrives.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: gated, serialised saves and sync/publish durability hooks"`

### Task 6: `startup.ts` (gate ordering) and `shutdown.ts`

**Files:**
- Create: `startup.ts`, `startup.test.ts`, `shutdown.ts`, `shutdown.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4 and 5.
- Produces:
  - `runStartup(deps: { assertWriterLock: () => void; removeLegacyLocks: () => void; restore: () => Promise<RestoreResult>; installHooks: (gate: StartupGate) => void; initCrypto: () => Promise<void>; ownDeviceKeys: () => Promise<{ ed25519: string; curve25519: string }>; serverDeviceKeys: () => Promise<Record<string,string> | undefined>; ids: { userId: string; deviceId: string }; log: Pick<Console,"log"|"warn"> }): Promise<{ gate: StartupGate }>`
    - **Order:** `assertWriterLock` → `removeLegacyLocks` → restore → `decideStartup` → create the gate and `installHooks(gate)` → `initCrypto` → `checkDeviceIdentity` → `gate.open()`.
    - Any refusal throws its reason with the gate still closed.
  - `runShutdown(steps: () => Promise<PersistResult | void>, timeoutMs: number): Promise<{ outcome: "done" | "timeout" | "save-failed"; exitCode: 0 | 1 }>`

- [ ] **Step 1: Write failing tests:**
  - **`startup.test.ts` (Codex 2 #4):**
    - `installHooks` installs the real `installPublishDurability` on a real `OutgoingRequestProcessor` whose HTTP layer records calls.
    - The fake `initCrypto` fires `processor.makeOutgoingRequest(<a real KeysBackupRequest>)` without awaiting it, then resolves.
    - **Cases:**
      - G1 mismatch → `runStartup` rejects with the G1 message, and the recorded HTTP calls are empty, even after a flush;
      - G1 match → the backup request is recorded only after `gate.open()`;
      - restore failed → rejects with G2, and neither `initCrypto` nor `installHooks` is called.
  - **`shutdown.test.ts`:** done → 0; never-resolving → timeout → 1; `{ok:false}` → save-failed → 1.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: gated startup sequence and bounded shutdown"`

### Task 7: Wire it into `service.ts`; logging, Dockerfile, README (G1–G7)

**Files:**
- Modify: `service.ts`. That means `:133-189` (persist, schedule, restore and `loadMatrixSdk`), `:622-720` (`main`), `:691-697` (failed decryption) and `:803-814` (shutdown).
- Modify: `decrypt-bridge.ts:236` ("Giving up…" becomes `console.warn`), `Dockerfile`, `README.md`
- Create: `.dockerignore` (excludes `*.test.ts`, `test-fixtures/`, `node_modules`), `service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.

**Wiring:**
- `main()` calls `runStartup` with the real dependencies. Its parts:
  - **`assertWriterLock`:** `assertRunningUnderWriterLock`. It applies only when `MATRIX_USE_INDEXEDDB`; otherwise there is no store, so no lock check.
  - **`installHooks`:** installs both durability hooks, plus `latchIncomingFailure` after `createClient`. `onIncomingFailure` logs and calls `process.exit(1)` without saving. `scheduler.onFatal` logs and calls `process.exit(1)`.
  - **`ownDeviceKeys`:** `await crypto.getOwnDeviceKeys()`.
  - **`serverDeviceKeys`:** `fetchServerDeviceKeys`.
- **After `runStartup`:** the `scheduler.save("post-init")` save, the 60 s interval, then `bootstrapCrossSigning` and the rest, unchanged.
- **Failed decryptions:** `emitFailedDecryption` logs `console.warn("Matrix decryption failed", { eventId, roomId, sender })`.
- **Shutdown:** `runShutdown` with the existing steps plus the final save, then `process.exit(exitCode)`. Guard it against running twice.
- **Dockerfile:**
  - `COPY package.json package-lock.json ./` and `RUN npm ci`;
  - `COPY *.ts entrypoint.sh ./`;
  - `ENTRYPOINT ["/app/entrypoint.sh"]` and `CMD ["node", "--import", "tsx", "service.ts"]`;
  - verify the base image has `flock`, via a build-time `RUN command -v flock`.
- **README:**
  - correct the atomic-write claim (:260, :283) and the snapshot filename (`.json`);
  - mark `MATRIX_CRYPTO_DB_PREFIX` as inert;
  - add "Failure modes", listing every refusal and fatal message;
  - note that `flock` needs a local volume, not NFS.

- [ ] **Step 1: Write failing tests** in `service.test.ts`. Each spawns `sh entrypoint.sh node --import tsx service.ts` with `MATRIX_USE_INDEXEDDB=true`, `MATRIX_INDEXEDDB_PATH=<tmp>`, `MATRIX_DEVICE_ID=TESTDEV`, dummy Supabase and OpenRouter env, and the fake homeserver URL.
  - `refuses on a corrupt snapshot (G2)`: exit 1; the first `refusing to start` line starts `refusing to start: G2 restore failed`; the snapshot bytes are unchanged; no `.tmp` is left.
  - `refuses on a device-key mismatch without publishing or saving (G1)`: an empty store, and `/keys/query` returns different keys for `TESTDEV`. Expected: exit 1 with the G1 line; no publish-class request recorded by the fake; no snapshot file.
  - `refuses when /keys/query fails (Review Focus 4)`: 502 → `G1 could not verify device keys`, and nothing published.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement the wiring.**
- [ ] **Step 4: Run all tests and typecheck.**
  Run: `npm test && npm run typecheck`
  Expected: all green.
- [ ] **Step 5: Check the image builds.**
  Run: `docker build -t ob1-matrix-capture:test integrations/matrix-capture`
  Expected: success, including the `flock` check. An amd64 build is acceptable locally.
- [ ] **Step 6: Commit**: `git commit -s -m "matrix-capture: fail closed on mismatched crypto state; durable saves wired in"`

### Task 8: CI image workflow (G8)

**Files:**
- Create: `.github/workflows/matrix-capture-image.yml`

**Interfaces:**
- Produces: `ghcr.io/evangineer/ob1-matrix-capture:<version>-<sha7>`. The job summary prints the tag and digest, which Task 10 consumes.

- [ ] **Step 1: Write the workflow:**
  - `workflow_dispatch` with a `version` input, checked against `^[0-9]+\.[0-9]+\.[0-9]+$`;
  - `permissions: { contents: read, packages: write }`;
  - `concurrency: { group: matrix-capture-image-${{ inputs.version }}-${{ github.sha }}, cancel-in-progress: false }`;
  - `runs-on: ubuntu-24.04-arm`.
  - **Steps:**
    1. checkout;
    2. derive `TAG=<version>-$(git rev-parse --short=7 HEAD)`;
    3. log in to GHCR;
    4. **existence check:** `docker manifest inspect` → exit 0 fails the job ("tag exists"). An output matching `manifest unknown` continues. Any other error fails the job;
    5. `npm ci && npm test` in `integrations/matrix-capture`;
    6. `docker/build-push-action@v6` with `platforms: linux/arm64` and `push: true`;
    7. write the tag and digest to `$GITHUB_STEP_SUMMARY`.
- [ ] **Step 2: Validate.**
  Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/matrix-capture-image.yml'))"`, plus `actionlint` if it's installed.
  Expected: no errors.
- [ ] **Step 3: Commit**: `git commit -s -m "matrix-capture: CI image build to GHCR with derived immutable tags"`

### Task 9: Per-tenant `roles/ob1`, guarded on-node build, safe reauth, RUNBOOK (dokploy-playbooks)

**Workspace:**
- `~/src/dokploy-playbooks` is on branch `operately`, which has unpushed commits and paused Operately tasks. **Do this task in a separate git worktree** (superpowers:using-git-worktrees), so the operator's `--tags operately` applies keep running from the right branch.
- `RUNBOOK.md` and `group_vars/all/vars.yml` are edited on both branches. Decide the merge order before starting; most likely Operately merges first, and this branch rebases onto it.

**Files** (in that worktree, new branch `ob1-crypto-store`):
- Modify: `group_vars/all/vars.yml`. Add `ob1_matrix_capture_managed_tenants: [ob1m]` and `ob1_matrix_capture_build_on_node: false`, with comments pointing at the spec.
- Modify: `roles/ob1/tasks/main.yml` (Codex 2 #2):
  - **Reset first** (Codex 3 #5): at the top of the role, reset `ob1_matrix_capture_users_resolved`, the room mappings and the per-tenant dicts to empty.
  - **Filter the users first.** Right after "Define OB1 Matrix capture users" (`:113`), filter `ob1_matrix_capture_users` to managed tenants. Everything downstream uses the filtered list: room alias resolution and creation (`:142-205`), the Matrix env files (`:207`) and the MCP env files (`:245`).
  - **Map services by name.**
    - Replace the positional `services[0]`/`[1]` (`:28-38`) with a per-tenant lookup using the anchored regex `^ob1-<tenant>-.*_matrix-capture$`.
    - Assert exactly one match per managed tenant.
    - Remove the "two services" assertion (`:22-26`).
  - **Registered-result shapes** (Codex 3): env results are keyed by `result.item.key`; room-create results by `item.item.key`; webhook results by `item.key`. Use `default` / `selectattr('skipped','undefined')` before reading `status` or `stdout`.
  - **Per-tenant redeploys.** Change detection becomes a per-tenant dict built from the per-item results of both env tasks. Webhooks, rollover checks (`:268-370`) and force-updates (`:371`) loop over managed tenants and check that tenant's flag.
  - **Guard the on-node build.** Tasks `:40-102` and force-update get `when: ob1_matrix_capture_build_on_node | bool`.
- Modify: `reauth-ob1-matrix.yml` (Codex 2 #5):
  - assert at the top that `tenant in ob1_matrix_capture_managed_tenants`;
  - after scaling the service to 0, wait (up to 90 s) until `docker ps -q -f name=<service>.` is empty, and fail on timeout;
  - replace the `rm -rf && mkdir` wipe (`:115`) with one alpine `docker run`, which runs `flock -n /data/indexeddb/.writer.lock sh /wipe-store.sh /data/indexeddb /backup/<tenant>-crypto-<ts>.tgz`.
    - `wipe-store.sh` is Task 3's fixture copied verbatim into `files/`, and mounted read-only.
    - `/var/backups/ob1` is mounted (directory 0700); the archive is chmodded 0600 afterwards.
    - A held lock or a failed backup fails the play. `.writer.lock` is never removed (Codex 3 #2).
- Modify: `RUNBOOK.md`:
  - an incident note (3 May stale lock, found 2026-10-21);
  - "Capture bot refuses to start", listing each message and its fix, and noting that a persistent G4 conflict means a restart every 5 s;
  - full `site.yml` runs still update ob1s's Supabase backend and MCP wiring; use `--tags ob1` for capture work;
  - the reauth section's backup step, lock and managed-tenants rule;
  - a pointer to the spec.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Verify.**
  Run: `ansible-playbook site.yml --syntax-check && ansible-playbook reauth-ob1-matrix.yml --syntax-check`
  Expected: no errors.
  **[OPERATOR]** `ansible-playbook site.yml --tags ob1 --check --diff`. Expected:
  - no task item mentions ob1s, `olasofia` or ob1s's service, webhook or env paths;
  - the service-mapping assert passes;
  - the build tasks are skipped.
  **[OPERATOR]** `ansible-playbook reauth-ob1-matrix.yml -e tenant=ob1s --check`. Expected: it fails at the managed-tenants assert.
- [ ] **Step 3: Commit**: `git commit -m "Scope OB1 capture role per tenant; guard on-node build; lock and back up before reauth wipe"`, with the attribution line.

### Task 10: [OPERATOR-GATED] Roll out to ob1m and rotate its device (§7.1–7.4)

Every bullet that changes production needs the operator's go-ahead first.

- [ ] **Step 1: Back up ob1m's volume.** Tar it read-only to `/var/backups/ob1/ob1m-crypto-pre-fix-<ts>.tgz` (mode 0600).
  Expected: the archive lists the snapshot dated 2026-05-03.
- [ ] **Step 2: Merge and apply Task 9** (dokploy-playbooks).
  Expected: nothing changes for ob1s, and ob1s's task ID is unchanged.
- [ ] **Step 3: Publish the image.** (Order revised after the final review: GitHub only dispatches workflows whose file exists on the default branch.)
  - Push the OB1 branch.
  - Land `.github/workflows/matrix-capture-image.yml` on the fork's default branch (`main`) first, for example via a small PR containing only that file.
  - Dispatch on the feature branch: `gh workflow run matrix-capture-image.yml --ref matrix-capture-crypto-store -f version=0.2.0`. The tag's sha7 is then the branch head.
  - If the first run fails at the existence check with `denied` (the package doesn't exist yet), stop and decide with the operator (ruling R18). Don't loosen the check.
  - Make the package public.
  Expected: the summary shows the tag and an arm64 digest.
- [ ] **Step 4: Pin ob1m's stack.** In `~/src/dokploy-stacks/ob1-ob1m/docker-compose.yml`:
  - `image: ghcr.io/evangineer/ob1-matrix-capture:<tag>@sha256:<digest>`;
  - `stop_grace_period: 30s`;
  - `init: true`.
  - `stop_grace_period: 30s` and `init: true` are **hard prerequisites**, not optional extras. Without `init`, node is PID 1 and handles signals only through its own handlers.
  Commit it. Pushing to `main` redeploys via Dokploy.
  - Verify: `docker service inspect <svc> --format '{{.Spec.TaskTemplate.ContainerSpec.Init}} {{.Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'` shows `true 30000000000`.
  - **Expected:**
    - the logs show `legacy snapshot lock` removed and a successful restore;
    - then `refusing to start: G1 device-key mismatch for @evangineer…/OB1M05`;
    - no publish-class requests from OB1M05 in the Synapse log since the deploy;
    - ob1s unchanged.
- [ ] **Step 5: Preflight on a scratch session.**
  - Log in with the vaulted ob1m password. Expected: 200.
  - **Identical re-upload test:** `POST /keys/upload` twice, with a byte-identical, well-formed body: `{"one_time_keys":{"signed_curve25519:AAAAAAAAAAA":{"key":"<base64>","signatures":{"<scratch user>":{"ed25519:<scratch device>":"<base64>"}}}}}`. Synapse doesn't verify one-time-key signatures. Expected: 200 both times.
    - **A 400 on the first POST** means the probe itself is malformed: fix it and retry. It says nothing about G5.
    - **Only a 400 on the second POST**, with `already exists`, means G5's crash-replay assumption is false. Stop.
  - Log out. Expected: 200, and the scratch device and its keys are gone.
- [ ] **Step 6: Rotate.** Run `ansible-playbook reauth-ob1-matrix.yml -e tenant=ob1m`.
  - Verify the new device (RUNBOOK :1064-1112).
  - Sign out `OB1M05`.
  - Update the vault token, then re-run `--tags ob1`. Expected: only ob1m redeploys.
  - Update the RUNBOOK device record (:2550) and commit it.
- [ ] **Step 7: Validate (§7.4).**
  - Two forced restarts of ob1m give no `already exists` 400s for the new device.
  - The snapshot mtime advances after each restart.
  - A message from a MindRoom agent in an ob1m capture room is captured.
  - A planted `crypto-idb-snapshot.json.lock/` directory is removed with a warning on restart.
  - A second container started by hand on the volume exits 75 with the G4 message.
  - 24 hours later: zero `keys/upload` 400s for the new device.

Ledger every result. ob1s (§7.5) is out of this plan until Sofia agrees. Once Step 7 passes, turn off ob1m's debug flags through the scoped role.
