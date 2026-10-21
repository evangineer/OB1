# Matrix-capture Crypto-store Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The capture bot refuses to run on crypto state that doesn't match its Matrix device, and never silently loses crypto state. It ships as a CI-built image pinned per tenant by digest, and ob1m is rotated to a fresh device.

**Architecture:**
- `idb-persistence.ts` gains typed results, a restore that can't hang, a consistent single-transaction dump and atomic 0600 writes.
- New modules:
  - `snapshot-lease.ts`: a lifetime single-writer lease;
  - `crypto-guard.ts`: the startup decision, the device-key check and the startup gate;
  - `snapshot-scheduler.ts`: serialised saves, escalation, and the SDK hooks for durable-before-publish and save-before-next-sync, with a failure latch.
- `service.ts` wires them in.
- Rollout covers a GHCR workflow, `roles/ob1` scoped per tenant with the on-node build guarded, the ob1m stack pinned by digest, and operator-gated recovery.

**Tech Stack:** Node 20 (image) and TypeScript via tsx; matrix-js-sdk 36.2.0 with Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`, already installed); fake-indexeddb 6; `node:test` and `node:http` for a fake homeserver; GitHub Actions; Ansible; Docker Swarm through Dokploy.

**Spec:** `docs/superpowers/specs/2026-10-21-matrix-capture-crypto-store-design.md`. Section numbers (§, G1–G8) refer to it. "Codex #n" refers to the review findings folded into it.

## Global Constraints

- Work in `~/src/OB1` on branch `matrix-capture-crypto-store`, which is cut from the deployed commit `5825a13`. Code lives in `integrations/matrix-capture/`.
- No new npm dependencies. Tests use `node:test` via `node --import tsx --test`. Importing the already-installed `@matrix-org/matrix-sdk-crypto-wasm` and matrix-js-sdk internals is allowed.
- The existing v8 snapshot format stays readable (`edf0b65`). The snapshot path default stays `/data/indexeddb/crypto-idb-snapshot.json`, and the lock is `<snapshot>.lock/owner.json`.
- **Lease timings:** refresh every `10_000` ms; stale after `60_000` ms without a refresh, or when dated more than `60_000` ms in the future.
- **Escalation and shutdown:** saves escalate to `error` after 3 consecutive failures, and the process exits non-zero after `600_000` ms of continuous failure. The shutdown timeout is `20_000` ms, and the stack's `stop_grace_period` is `30s`.
- **Exact message prefixes:**
  - `refusing to start: G1 device-key mismatch for <userId>/<deviceId>`, ending `see RUNBOOK "Matrix device reauth"`;
  - `refusing to start: G1 could not verify device keys`;
  - `refusing to start: G2 restore failed`;
  - `refusing to start: G4 snapshot lease held by <hostname>/<pid>`;
  - `G4 lease lost`;
  - `incoming crypto processing failed`.
- Snapshot and temp files are mode 0600 from creation. Never log secrets, snapshot contents or key values. The existing key-upload diagnostics stay behind `MATRIX_CRYPTO_DEBUG`.
- Keep the third-party attribution headers. OB1 commits are signed off (`-s`), and all commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Image:** `ghcr.io/evangineer/ob1-matrix-capture`, `linux/arm64` only. CI derives the tag as `<version>-<sha7>` and refuses existing tags. Stacks pin `tag@sha256:digest`. The Dockerfile uses `npm ci` with `package-lock.json`.
- Nothing touches ob1s: not its stack, its env file, its volume, or Sofia's device. `roles/ob1` acts only on `ob1_matrix_capture_managed_tenants: [ob1m]`. Pushes, deploys, applies and the rotation each need the operator's go-ahead.
- `MATRIX_CRYPTO_DB_PREFIX` stays unwired, and is documented as inert.

## Review Focus

1. **The 3 May locks have no `owner.json`.** Expected: judged by the lock directory's mtime and taken over. Test in Task 3.
2. **A lease dated in the future** (clock skew, restored volume). Expected: stale once more than 60 s ahead. Test in Task 3.
3. **A leftover `.tmp` from a crashed write.** Expected: restore reads only the real path, and the next save replaces the temp file. Test in Task 2.
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
- Locking moves to Task 3. In this task, remove `withSnapshotLock` from both functions; Task 7 calls the lease instead.

- [ ] **Step 1: Write failing tests.** Each uses its own `mkdtempSync` directory and a `new IDBFactory()` passed as `factory`.
  - `restore distinguishes absent, restored and failed`:
    - missing file → `absent`;
    - a snapshot persisted from one database with one record → `{ status: "restored", databases: 1 }`;
    - the bytes `garbage` → `failed`.
  - `restore fails instead of hanging when insertion aborts`: build a v8 snapshot by hand, with a unique index and two records sharing that key. Within 2 s, `restoreIdbFromDisk` gives `failed`.
  - `persist reports failure when the directory is unwritable`: the snapshot path sits under a regular file → `{ ok: false }`, with no throw.
- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd integrations/matrix-capture && npm test`
  Expected: failures from the return shape, plus the abort test timing out.
- [ ] **Step 3: Implement** the results, the abort/error/blocked rejection, `finally` closes, and the `factory` option.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: typed snapshot results; restore cannot hang"`

### Task 2: Atomic 0600 writes and a consistent dump

**Files:**
- Modify: `idb-persistence.ts`, the dump `:137-182` and the write
- Test: `idb-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's results and options.
- The temp file is `<snapshotPath>.tmp`.

- [ ] **Step 1: Write failing tests:**
  - `a failure before rename leaves the old snapshot byte-identical`: persist; read the bytes; add a record; persist with `beforeRename` throwing → `{ ok: false }`, and the bytes are unchanged.
  - `snapshot and temp files are 0600 from creation`: make `beforeRename` assert `statSync(tmp).mode & 0o777 === 0o600`. After a successful persist the final file is also 0600.
  - `restore ignores a leftover temp file` (Review Focus 3).
  - `a two-store write is never torn` (Codex #5): the test must queue the write **deterministically between the two store reads**.
    - Wrap the factory passed in so that, when the dump requests store `a`'s records, its `success` handler first starts a `readwrite` transaction over `["a","b"]` that puts `{k:1}` into each.
    - Restore into a **fresh** `IDBFactory` via `factory`, and assert `a` and `b` agree.
    - **Run this test against the unmodified dump first and record the failure.** If it passes against the old code, the test is wrong; fix it before going on.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.**
  - **Dump:** one `db.transaction([...db.objectStoreNames], "readonly")` per database.
  - **Write:** `openSync(tmp, "w", 0o600)`, then write, `fsyncSync`, close, `beforeRename?.()`, `renameSync`, then fsync the directory.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: atomic 0600 snapshot writes; single-transaction dumps"`

### Task 3: `snapshot-lease.ts`, the lifetime single-writer lease (G4)

**Files:**
- Create: `integrations/matrix-capture/snapshot-lease.ts`, `snapshot-lease.test.ts`

**Interfaces:**
- Produces:
  - `class SnapshotLease`
    - `static acquire(params: { snapshotPath: string; now?: () => number; staleMs?: number; log?: Pick<Console, "warn">; hostname?: string; pid?: number }): SnapshotLease`
      - Throws `Error` with the message `refusing to start: G4 snapshot lease held by <hostname>/<pid>` when a live lease exists.
      - Takes over a stale lease with a warning that includes `stale`, the previous owner (or `unknown owner`) and the age in seconds.
    - `refresh(): void`: updates `owner.json`'s mtime. It throws `G4 lease lost` if the token no longer matches.
    - `assertHeld(): void`: throws `G4 lease lost` if `owner.json` is missing or holds another token.
    - `startHeartbeat(intervalMs?: number /* 10_000 */): void` and `stopHeartbeat(): void`. A heartbeat failure calls the `onLost` callback given to `startHeartbeat(intervalMs, onLost)`.
    - `release(): void`: removes the lock only if the token matches. It never throws.
  - **Lock layout:** `<snapshotPath>.lock/owner.json` = `{ pid, hostname, token, acquiredAt }`, where `token` = `crypto.randomUUID()`. Staleness is judged by `owner.json`'s mtime, or by the lock dir's mtime when there is no owner file.

- [ ] **Step 1: Write failing tests**, with injected `now` and `utimesSync`:
  - `takes over an ownerless lock older than 60s` (Review Focus 1);
  - `takes over a lock dated more than 60s in the future` (Review Focus 2);
  - `refuses a live lease and leaves it intact`: a lease refreshed 5 s ago gives the exact refusal message, and `owner.json` is unchanged;
  - `release never removes another owner's lease`: A acquires; the test overwrites `owner.json` with another token; `A.release()` leaves it there;
  - `assertHeld throws after takeover`: A acquires; B takes over after A's file is backdated; `A.assertHeld()` throws `G4 lease lost`.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: lifetime single-writer snapshot lease"`

### Task 4: One-time-key round-trip regression test, plus `crypto-guard.ts` (G1, G2, startup gate)

**Files:**
- Create: `test-fixtures/otk-roundtrip.ts`, `otk-roundtrip.test.ts`, `crypto-guard.ts`, `crypto-guard.test.ts`

**Interfaces:**
- **The fixture:** `node --import tsx test-fixtures/otk-roundtrip.ts <generate|restore> <snapshotPath>`.
  - It runs `initAsync()`, then `OlmMachine.initialize(new UserId("@t:example.org"), new DeviceId("TESTDEV"), "ob1-test")` on fake-indexeddb.
  - It prints the sorted `one_time_keys` of the first `KeysUploadRequest` as JSON.
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
  - **The round-trip:** `generate` and `restore` print deep-equal, non-empty key sets.
    - Codex already observed this with the real WASM library, so it is a **regression guard**, and passing first time is expected.
    - If it ever fails, stop: the G5 reasoning is broken.
  - **Guard tests:** one per verdict branch; `fetchServerDeviceKeys` against 200 with keys, 200 without the device, 502 and a network rejection (Review Focus 4); `StartupGate.wait()` stays pending until `open()`.
- [ ] **Step 2: Run them.** The guard tests fail because the module is missing; the round-trip test passes. Record both.
- [ ] **Step 3: Implement** `crypto-guard.ts`.
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: startup decision, device-key check, startup gate"`

### Task 5: `snapshot-scheduler.ts`: saves, escalation, and the SDK durability hooks (G5, G6)

**Files:**
- Create: `snapshot-scheduler.ts`, `snapshot-scheduler.test.ts`, `sync-durability.test.ts`, `test-fixtures/fake-homeserver.ts`

**Interfaces:**
- Consumes: `PersistResult` (Task 1), `SnapshotLease` (Task 3), `StartupGate` (Task 4).
- Produces:
  - `class SnapshotScheduler`, constructed with `{ persist: () => Promise<PersistResult>; lease: Pick<SnapshotLease, "assertHeld">; gate: Pick<StartupGate, "wait">; onFatal: (reason: string) => void; now?: () => number; log?: Pick<Console,"log"|"warn"|"error">; errorAfter?: number; fatalAfterMs?: number }`
    - `save(reason: string): Promise<PersistResult>`
      - First awaits `gate.wait()`, then calls `lease.assertHeld()` (a throw means `onFatal("G4 lease lost")` and the call returns `{ok:false}`).
      - **Serialised:** a call made while a save is running waits for it, then runs its own.
      - **Coalesced:** calls made while a save is queued share it.
      - `Persisted Matrix IndexedDB snapshot (<reason>)` is logged only on ok.
      - Failures: `warn`, then `error` from the 3rd; `onFatal("snapshot saves failing for <n>s")` once the streak is ≥ 600 s.
    - `saveUntilOk(reason: string): Promise<void>`: backoff doubling from 1 s up to 30 s; escalation still applies.
  - `installPublishDurability(proto, opts: { gate: Pick<StartupGate,"wait">; isPublishing: (msg: unknown) => boolean; beforePublish: () => Promise<void> }): void`
    - Idempotent (`__ob1DurablePatched`).
    - **Every** request first awaits `gate.wait()`. Publishing requests then await `beforePublish()`, which throws when the save isn't ok, before the original is called.
  - `installSyncDurability(proto, opts: { save: () => Promise<void>; onIncomingFailure: (reason: string) => never | void }): void`
    - Idempotent.
    - Wraps `preprocessToDeviceMessages`: non-empty `events` mark the instance dirty, and a rejection latches `failed`.
    - Wraps `onSyncCompleted`: awaits the original. If `failed` is latched, it calls `onIncomingFailure("incoming crypto processing failed")` and does **not** save. Else, if dirty, it awaits `save()` and clears the flag.
    - `latchIncomingFailure(client)` subscribes to `ClientEvent.SyncUnexpectedError` and sets the same latch.
  - `isPublishingRequest(msg: unknown): boolean`: `instanceof` against `KeysUploadRequest`, `SignatureUploadRequest`, `UploadSigningKeysRequest`, `ToDeviceRequest`, `KeysBackupRequest` and `PutDehydratedDeviceRequest`.
  - `test-fixtures/fake-homeserver.ts`: `startFakeHomeserver(handlers): Promise<{ url: string; requests: { method: string; path: string }[]; close(): Promise<void> }>`, built on `node:http`. It serves `/versions`, `/sync` (queued responses), `/keys/query`, `/keys/upload`, `/room_keys/version` and a catch-all `{}`.

- [ ] **Step 1: Write failing tests:**
  - **`snapshot-scheduler.test.ts`:**
    - **Serialised and coalesced saves:** a gated persist; 3 calls during one in-flight save give 2 persists.
    - **The gate blocks saves:** no persist until `open()`.
    - **Lease lost:** `assertHeld` throws → `onFatal("G4 lease lost")` and no persist.
    - **Escalation:** with a fake clock, warn, warn, then error; no `onFatal` at 599 s and one at 600 s; a success resets the streak.
    - **Publish ordering:** the order is `["gate","save","send"]`; a non-publishing request records `["gate","send"]`; a throwing `beforePublish` means no `"send"` and a rejected call.
    - **The real classifier (Codex #6):** after `initAsync()`, an `OlmMachine` in memory yields a `KeysUploadRequest` from `outgoingRequests()`, and `isPublishingRequest` is true. A `KeysQueryRequest` from `OlmMachine.updateTrackedUsers` plus `outgoingRequests()` is false.
  - **`sync-durability.test.ts`, against the real `SyncApi` (Codex #6, #1):**
    - **Setup:** `createClient` points at the fake homeserver, then `initRustCrypto({ useIndexedDB: false })`, then `installSyncDurability(RustCrypto.prototype, …)`, then `startClient()`.
    - **Barrier:** queue `/sync` #1 carrying a `to_device` event of type `m.dummy`, and give `save` a pending deferred. After 500 ms, the fake has seen exactly one `/sync`. Resolve the deferred, and a second `/sync` arrives.
    - **Failure latch:** patch `RustCrypto.prototype.receiveSyncChanges` to reject. `onIncomingFailure` is called with `incoming crypto processing failed`, `save` is never called, and after 500 ms only one `/sync` has been seen. `onIncomingFailure` in the test records the call and stops the client, so it doesn't exit.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass**, then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: gated, serialised saves and sync/publish durability hooks"`

### Task 6: Shutdown helper

**Files:**
- Create: `shutdown.ts`, `shutdown.test.ts`

**Interfaces:**
- Produces: `runShutdown(steps: () => Promise<PersistResult | void>, timeoutMs: number): Promise<{ outcome: "done" | "timeout" | "save-failed"; exitCode: 0 | 1 }>`. `"save-failed"` applies when the steps resolve with `{ ok: false }` (Codex #9).

- [ ] **Step 1: Write failing tests**, one per outcome, with fake timers: done → 0; never-resolving → timeout → 1; `{ok:false}` → save-failed → 1.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and watch them pass.**
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: bounded shutdown that reports save failure"`

### Task 7: Wire it into `service.ts`; logging, Dockerfile, README (G1–G7)

**Files:**
- Modify: `service.ts`. That means `:133-189` (persist, schedule, restore and `loadMatrixSdk`), `:622-720` (`main`), `:691-697` (failed decryption) and `:803-814` (shutdown).
- Modify: `decrypt-bridge.ts:236` ("Giving up…" becomes `console.warn`), `Dockerfile`, `.dockerignore` (new; excludes `*.test.ts`, `test-fixtures/` and `node_modules`), `README.md`
- Create: `service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6.

**Wiring order in `main()` when `MATRIX_USE_INDEXEDDB`:**
1. `SnapshotLease.acquire`. A throw reaches `main().catch`, which prints the message and exits 1.
2. `restoreIdbFromDisk`, then `decideStartup`; refuse on failure.
3. Create the gate and scheduler. Install `installPublishDurability(OutgoingRequestProcessor.prototype, { gate, isPublishing: isPublishingRequest, beforePublish })` **and** `installSyncDurability(RustCrypto.prototype, { save: () => scheduler.saveUntilOk("sync"), onIncomingFailure })`. `onIncomingFailure` logs and exits 1.
4. `createClient`, then `latchIncomingFailure(client)`, then `initRustCrypto`.
5. `checkDeviceIdentity(crypto.getOwnDeviceKeys(), await fetchServerDeviceKeys(...))`. If it refuses: throw, with the gate still closed.
6. `gate.open()`, `lease.startHeartbeat(10_000, onLost)`, the `scheduler.save("post-init")` save, and the 60 s interval via `scheduler.save("interval")`.
7. `bootstrapCrossSigning` and the rest, unchanged.

**Other changes:**
- **Failed decryptions:** `emitFailedDecryption` logs `console.warn("Matrix decryption failed", { eventId, roomId, sender })`.
- **Shutdown:** `runShutdown` with the existing steps plus the final save, then `lease.release()`, then `process.exit(exitCode)`. Guard it against running twice.
- **Dockerfile:**
  - `COPY package.json package-lock.json ./` and `RUN npm ci`;
  - `COPY *.ts ./`;
  - `CMD ["node", "--import", "tsx", "service.ts"]`.
- **README:**
  - correct the atomic-write claim (:260, :283) and the snapshot filename (`.json`);
  - mark `MATRIX_CRYPTO_DB_PREFIX` as inert;
  - add "Failure modes", listing every refusal and fatal message.

- [ ] **Step 1: Write failing tests** in `service.test.ts`. Each spawns `node --import tsx service.ts` with `MATRIX_USE_INDEXEDDB=true`, `MATRIX_INDEXEDDB_PATH=<tmp>`, dummy Supabase and OpenRouter env, and `MATRIX_HOMESERVER_URL` pointing at the fake homeserver.
  - **`refuses on a corrupt snapshot (G2)`:** exit 1; the first `refusing to start` line starts `refusing to start: G2 restore failed`; the snapshot bytes are unchanged; no `.tmp` is left.
  - **`refuses on a live lease (G4)`:** acquire a lease in the test process first; the service exits 1 with the G4 message.
  - **`refuses on a device-key mismatch without publishing or saving (G1, gate)`:**
    - Empty store; the fake's `/keys/query` returns different keys for the device; it also answers `GET /room_keys/version` with a backup version.
    - Expected: exit 1 with the G1 mismatch line. The fake recorded **no** `POST /keys/upload`, `/keys/signatures/upload`, `/keys/device_signing/upload`, `PUT /room_keys/keys` or `PUT /sendToDevice`. No snapshot file exists.
  - **`refuses when /keys/query fails (Review Focus 4)`:** the fake returns 502 → exit 1 with `G1 could not verify device keys`, and nothing published.
- [ ] **Step 2: Run them and watch them fail** (`npm test`). Today's service ignores all of this.
- [ ] **Step 3: Implement the wiring** above.
- [ ] **Step 4: Run all tests and typecheck.**
  Run: `npm test && npm run typecheck`
  Expected: all green.
- [ ] **Step 5: Check the image builds.**
  Run: `docker build -t ob1-matrix-capture:test integrations/matrix-capture`
  Expected: success. An amd64 build is acceptable locally.
- [ ] **Step 6: Commit**: `git commit -s -m "matrix-capture: fail closed on mismatched crypto state; durable saves wired in"`

### Task 8: CI image workflow (G8)

**Files:**
- Create: `.github/workflows/matrix-capture-image.yml`

**Interfaces:**
- Produces: `ghcr.io/evangineer/ob1-matrix-capture:<version>-<sha7>`. The job summary prints the tag and digest, which Task 10 consumes.

- [ ] **Step 1: Write the workflow:**
  - `workflow_dispatch` with a `version` input, checked against `^[0-9]+\.[0-9]+\.[0-9]+$`;
  - `permissions: { contents: read, packages: write }`;
  - `runs-on: ubuntu-24.04-arm`.
  - **Steps:**
    1. checkout;
    2. derive `TAG=<version>-$(git rev-parse --short=7 HEAD)`;
    3. log in to GHCR;
    4. **fail if `docker manifest inspect ghcr.io/evangineer/ob1-matrix-capture:$TAG` succeeds**, because the tag already exists;
    5. `npm ci && npm test` in `integrations/matrix-capture`;
    6. `docker/build-push-action@v6` with `platforms: linux/arm64` and `push: true`;
    7. write the tag and `steps.build.outputs.digest` to `$GITHUB_STEP_SUMMARY`.
- [ ] **Step 2: Validate.**
  Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/matrix-capture-image.yml'))"`, plus `actionlint` if it's installed.
  Expected: no errors.
- [ ] **Step 3: Commit**: `git commit -s -m "matrix-capture: CI image build to GHCR with derived immutable tags"`

### Task 9: Per-tenant `roles/ob1`, guarded on-node build, reauth backup, RUNBOOK (dokploy-playbooks)

**Files** (in `~/src/dokploy-playbooks`, new branch `ob1-crypto-store` from `main`):
- Modify: `group_vars/all/vars.yml`. Add `ob1_matrix_capture_managed_tenants: [ob1m]` and `ob1_matrix_capture_build_on_node: false`, with comments pointing at the spec.
- Modify: `roles/ob1/tasks/main.yml`:
  - **`ob1_matrix_capture_deployments`** (`:28-38`): filter it to managed tenants. Every task looping over it inherits the filter: the env files (`:207`), change detection (`:268`), webhooks (`:290-344`) and rollover checks (`:345`).
  - **Change detection** becomes per tenant: one flag per tenant, from the per-item results of the env-file task.
  - **Force-update** (`:371`) loops only over managed tenants' services.
  - **On-node build tasks** (`:40-102`) and force-update get `when: ob1_matrix_capture_build_on_node | bool`.
- Modify: `reauth-ob1-matrix.yml`:
  - before "Clear crypto store" (`:108`), back up the volume read-only into `/var/backups/ob1/` (directory 0700, file 0600);
  - assert at the top that `tenant in ob1_matrix_capture_managed_tenants`.
- Modify: `RUNBOOK.md`:
  - an incident note (3 May stale lock, found 2026-10-21);
  - "Capture bot refuses to start", listing each message and its fix;
  - the reauth section's backup step and the managed-tenants rule;
  - a pointer to the spec.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Verify.**
  Run: `ansible-playbook site.yml --syntax-check && ansible-playbook reauth-ob1-matrix.yml --syntax-check`
  Expected: no errors.
  **[OPERATOR]** `ansible-playbook site.yml --tags ob1 --check --diff`. Expected:
  - no task references ob1s's env file, service or webhook;
  - the build tasks are skipped;
  - nothing else changes.
  **[OPERATOR]** `ansible-playbook reauth-ob1-matrix.yml -e tenant=ob1s --check`. Expected: it fails at the managed-tenants assert.
- [ ] **Step 3: Commit**: `git commit -m "Scope OB1 capture role per tenant; guard on-node build; back up before reauth"`, with the attribution line.

### Task 10: [OPERATOR-GATED] Roll out to ob1m and rotate its device (§7.1–7.4)

Every bullet that changes production needs the operator's go-ahead first.

- [ ] **Step 1: Back up ob1m's volume.** Tar it read-only to `/var/backups/ob1/ob1m-crypto-pre-fix-<ts>.tgz` (mode 0600).
  Expected: the archive lists the snapshot dated 2026-05-03.
- [ ] **Step 2: Merge and apply Task 9** (dokploy-playbooks).
  Expected: the role run changes nothing for ob1s, and ob1s's task ID is unchanged.
- [ ] **Step 3: Publish the image.**
  - Push the OB1 branch.
  - Dispatch the workflow with `version=0.2.0`.
  - Make the package public.
  Expected: the summary shows the tag and an arm64 digest.
- [ ] **Step 4: Pin ob1m's stack.** In `~/src/dokploy-stacks/ob1-ob1m/docker-compose.yml`:
  - `image: ghcr.io/evangineer/ob1-matrix-capture:<tag>@sha256:<digest>`;
  - `stop_grace_period: 30s`;
  - `init: true`.
  Commit it. Pushing to `main` redeploys through Dokploy.
  - **Expected:**
    - the logs show the stale-lease takeover warning and a successful restore;
    - then `refusing to start: G1 device-key mismatch for @evangineer…/OB1M05`;
    - no publishing requests from OB1M05 in the Synapse log since the deploy;
    - ob1s unchanged.
- [ ] **Step 5: Preflight the login.** Log in with the vaulted ob1m password, then log that test session out at once.
  Expected: 200, then 200. If not, stop.
- [ ] **Step 6: Rotate.** Run `ansible-playbook reauth-ob1-matrix.yml -e tenant=ob1m`.
  - Verify the new device (RUNBOOK :1064-1112).
  - Sign out `OB1M05`.
  - Update the vault token, then re-run `--tags ob1`. Expected: only ob1m redeploys.
  - Update the RUNBOOK device record (:2550) and commit it.
- [ ] **Step 7: Validate (§7.4).**
  - Two forced restarts of ob1m only give no `already exists` 400s for the new device. That is the live check that Synapse accepts an identical one-time-key re-upload.
  - The snapshot mtime advances after each restart.
  - A message from a MindRoom agent in an ob1m capture room is captured.
  - A planted lock directory with `touch -d '-5 min'` and no owner file, followed by a restart, is taken over with a warning.
  - 24 hours later: zero `keys/upload` 400s for the new device.

Ledger every result. ob1s (§7.5) is out of this plan until Sofia agrees.

**Debug flags:** turning off `ob1_matrix_crypto_debug` and `ob1_matrix_timeline_debug` (§7.2) can now be done per tenant through the scoped role. Do it for ob1m after Step 7 passes.
