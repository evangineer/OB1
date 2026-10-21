# Matrix-capture Crypto-store Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The capture bot refuses to run on crypto state that doesn't match its Matrix device, and never silently loses crypto state. It ships as a CI-built image pinned per tenant, and ob1m is rotated to a fresh device.

**Architecture:**
- `idb-persistence.ts` gains typed results, stale-lock recovery, a consistent single-transaction dump and atomic writes.
- Two new pure modules hold the policy:
  - `crypto-guard.ts`: the startup decision and the device-key check;
  - `snapshot-scheduler.ts`: serialised saves, failure escalation, and the SDK hooks for durable-before-publish and save-before-next-sync.
- `service.ts` wires them in.
- Rollout covers a GHCR workflow, a guarded `roles/ob1`, the ob1m stack pin, and operator-gated recovery.

**Tech Stack:** Node 20 (image) and TypeScript via tsx; matrix-js-sdk 36.2.0 with Rust crypto (`@matrix-org/matrix-sdk-crypto-wasm`, already installed); fake-indexeddb 6; `node:test`; GitHub Actions; Ansible; Docker Swarm through Dokploy.

**Spec:** `docs/superpowers/specs/2026-10-21-matrix-capture-crypto-store-design.md`. Section numbers (§, G1–G8) refer to it.

## Global Constraints

- Work in `~/src/OB1` on branch `matrix-capture-crypto-store`, which is cut from the deployed commit `5825a13`. Code lives in `integrations/matrix-capture/`.
- No new npm dependencies. Tests use `node:test` via `node --import tsx --test`. Importing the already-installed `@matrix-org/matrix-sdk-crypto-wasm` is allowed.
- The existing v8 snapshot format stays readable (`edf0b65`). The snapshot path default stays `/data/indexeddb/crypto-idb-snapshot.json`.
- The stale-lock threshold is `60_000` ms. Saves escalate to `error` after 3 consecutive failures, and the process exits non-zero after 10 minutes (`600_000` ms) of continuous failure. The shutdown timeout is `20_000` ms, and the stack's `stop_grace_period` is `30s`.
- Refusal messages begin `refusing to start: G1 …` or `refusing to start: G2 …`. G1 refusals end with `see RUNBOOK "Matrix device reauth"`.
- Never log secrets, snapshot contents or private keys. The existing key-upload diagnostics stay behind `MATRIX_CRYPTO_DEBUG`.
- Keep the third-party attribution headers. Commits are signed off (`-s`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The image is `ghcr.io/evangineer/ob1-matrix-capture` with immutable tags `0.2.0-<sha7>`, built for `linux/arm64` only, because `dokploy-main-12bl5` is aarch64.
- Nothing touches ob1s: not its stack, its volume, or Sofia's device. Pushes, deploys, playbook applies and the rotation each need the operator's go-ahead.
- `MATRIX_CRYPTO_DB_PREFIX` stays unwired, and is documented as inert.

## Review Focus

1. **A legacy lock with no owner file.** The real 3 May locks have no `owner.json`. Expected: one older than 60 s is removed like any other stale lock. Test in Task 1.
2. **A lock mtime in the future.** This can come from clock skew or a restored volume. Expected: an mtime more than 60 s ahead of now counts as stale, never "fresh forever". Test in Task 1.
3. **A leftover temp file from a crashed write.** Expected: restore reads only the real snapshot path, and the next save replaces the temp file. Test in Task 2.
4. **`/keys/query` unreachable or 5xx at startup.** Expected: G1 fails closed with `refusing to start: G1 could not verify device keys`, and the restart loop retries. Test in Task 4.
5. **The snapshot directory is unwritable.** Expected: saves report failure, escalate, and eventually exit, and outgoing publishes stay blocked. Tests in Tasks 1 and 5.

---

### Task 1: Test harness, typed persistence results, stale-lock recovery

**Files:**
- Modify: `integrations/matrix-capture/idb-persistence.ts:30-57` (lock), `:242-288` (restore and persist)
- Modify: `integrations/matrix-capture/package.json` (add `"test": "node --import tsx --test *.test.ts"`), `tsconfig.json` (`"include": ["*.ts"]`)
- Create: `integrations/matrix-capture/idb-persistence.test.ts`

**Interfaces:**
- Produces, all exported from `idb-persistence.ts`:
  - `type RestoreResult = { status: "absent" } | { status: "restored"; databases: number } | { status: "failed"; error: unknown }`
  - `type PersistResult = { ok: true; databases: number } | { ok: false; error: unknown }`
  - `type PersistenceOptions = { staleLockMs?: number; lockTimeoutMs?: number; log?: Pick<Console, "warn"> }`
  - `const SNAPSHOT_LOCK_STALE_MS = 60_000`
  - `restoreIdbFromDisk(snapshotPath: string, opts?: PersistenceOptions): Promise<RestoreResult>`
  - `persistIdbToDisk(params: { snapshotPath: string; databasePrefix?: string } & PersistenceOptions): Promise<PersistResult>`
- Locks: the lock dir contains `owner.json` with `{ pid, hostname, acquiredAt }`. Callers within one process are serialised by a module-level promise-chain mutex before the filesystem lock is attempted.

- [ ] **Step 1: Write failing tests** in `idb-persistence.test.ts`. Each test uses its own `fs.mkdtempSync` directory and a `log` spy.
  - `removes a stale lock older than the threshold`: create `<snap>.lock/` with mtime now−120 s and no owner file. `persistIdbToDisk` returns `{ ok: true }`, the lock dir is gone afterwards, and a warn was logged that contains `stale` and the age.
  - `treats a lock dated in the future as stale`: mtime now+120 s → `{ ok: true }`.
  - `respects a fresh lock`: mtime now−1 s with `lockTimeoutMs: 300` → `{ ok: false }`, and the lock dir still exists.
  - `reports failure instead of throwing when the directory is unwritable`: snapshot path under a regular file, so mkdir fails → `{ ok: false }`.
  - `restore distinguishes absent, restored and failed`:
    - missing file → `{ status: "absent" }`;
    - a file written by a successful persist after opening one fake-IDB database with one record → `{ status: "restored", databases: 1 }`;
    - a file containing `garbage` → `{ status: "failed" }`.
- [ ] **Step 2: Run them and watch them fail.**
  Run: `cd integrations/matrix-capture && npm test`
  Expected: the failures are about stale locks, return shapes or timeouts, not about syntax.
- [ ] **Step 3: Implement.**
  - **Staleness:** compute `|now − mtime| > staleLockMs` from `fs.statSync(lockPath).mtimeMs`. Remove the lock with `fs.rmSync(lockPath, { recursive: true, force: true })`, warn once with the owner (when readable) and the age, then retry acquiring.
  - **Results:** restore and persist return results instead of swallowing errors.
- [ ] **Step 4: Run the tests and watch them pass**, then run `npm run typecheck`.
  Expected: all Task 1 tests pass; typecheck exits 0.
- [ ] **Step 5: Commit**: `git add integrations/matrix-capture/{idb-persistence.ts,idb-persistence.test.ts,package.json,tsconfig.json} && git commit -s -m "matrix-capture: typed snapshot results and stale-lock recovery"`

### Task 2: Atomic writes and a consistent dump

**Files:**
- Modify: `integrations/matrix-capture/idb-persistence.ts` (`dumpIndexedDatabases` `:137-182`, and the write in `persistIdbToDisk`)
- Test: `integrations/matrix-capture/idb-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's `persistIdbToDisk` and `PersistenceOptions`.
- Produces: `PersistenceOptions` gains `beforeRename?: () => void`, a test-only fault-injection hook. The temp file is named `<snapshotPath>.tmp`.

- [ ] **Step 1: Write failing tests:**
  - `a failure before rename leaves the old snapshot byte-identical`: persist once; read the bytes; add a record; persist with `beforeRename: () => { throw new Error("boom") }` → `{ ok: false }`, and the file bytes equal the earlier bytes.
  - `restore ignores a leftover temp file`: write `garbage` to `<snap>.tmp` next to a valid snapshot → restore gives `{ status: "restored" }`. The next persist succeeds and leaves no `.tmp`.
  - `a write spanning two stores is never torn`:
    - open a database with stores `a` and `b`;
    - start `persistIdbToDisk` without awaiting it, then immediately commit one `readwrite` transaction over `["a","b"]` putting `{k:1}` in each;
    - await both, restore the snapshot into a fresh `IDBFactory`, and assert that `a` and `b` either both contain `k:1` or neither does.
    - Repeat 20 times. Under the current per-store transactions this must fail at least once; if it doesn't, raise the record count until it does.
- [ ] **Step 2: Run them and watch them fail.**
  Run: `npm test`
  Expected: the torn-dump and rename tests fail.
- [ ] **Step 3: Implement.**
  - **Dump:** one `db.transaction([...db.objectStoreNames], "readonly")` per database.
  - **Write:** `writeFileSync(tmp)`, then `fsyncSync`, then `beforeRename?.()`, then `renameSync(tmp, snapshotPath)`, then fsync the directory (open it `"r"`, `fsyncSync`, close).
- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: atomic snapshot writes and single-transaction dumps"`

### Task 3: Prove the G5 assumption (one-time keys survive a snapshot round-trip)

**Files:**
- Create: `integrations/matrix-capture/test-fixtures/otk-roundtrip.ts`, a child-process script
- Create: `integrations/matrix-capture/otk-roundtrip.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 `persistIdbToDisk` and `restoreIdbFromDisk`.
- **The fixture:** `node --import tsx test-fixtures/otk-roundtrip.ts <generate|restore> <snapshotPath>`
  - It imports `fake-indexeddb/auto`, runs `initAsync()` from `@matrix-org/matrix-sdk-crypto-wasm`, and calls `OlmMachine.initialize(new UserId("@t:example.org"), new DeviceId("TESTDEV"), "ob1-test")`.
  - It takes the first `KeysUploadRequest` from `outgoingRequests()` and prints the sorted `one_time_keys` map as JSON on stdout.
  - In `generate` mode it then persists. In `restore` mode it restores first.

- [ ] **Step 1: Write the test** `one-time keys from a persisted snapshot match after restore`. It runs `generate`, then `restore` against the same temp path, and asserts the two stdout JSON objects are deep-equal and non-empty.
- [ ] **Step 2: Run it.**
  Run: `npm test`
  - **Expected PASS.** This test checks an assumption rather than new code, so passing first time is the expected result. Record it in the ledger.
  - **If it fails** (different keys after restore): **stop and bring it back.** The spec's G5 reasoning would be wrong, and the design must change before Task 5.
- [ ] **Step 3: Commit**: `git commit -s -m "matrix-capture: prove one-time keys survive snapshot round-trip"`

### Task 4: `crypto-guard.ts`: the startup decision and device-key check (G1, G2)

**Files:**
- Create: `integrations/matrix-capture/crypto-guard.ts`, `crypto-guard.test.ts`

**Interfaces:**
- Consumes: Task 1's `RestoreResult`.
- Produces:
  - `type Verdict = { ok: true; note?: string } | { ok: false; reason: string }`
  - `decideStartup(restore: RestoreResult): Verdict`
    - `restored` → ok;
    - `absent` → ok with `note: "no snapshot; starting with an empty crypto store"`;
    - `failed` → `reason` starting `refusing to start: G2 restore failed:`.
  - `checkDeviceIdentity(params: { userId: string; deviceId: string; local: { ed25519: string; curve25519: string }; server: Record<string, string> | undefined }): Verdict`
    - `server` is the `keys` map for this device from `/keys/query`, or `undefined`.
    - `undefined` → ok with `note` containing `new device`.
    - Both `ed25519:<deviceId>` and `curve25519:<deviceId>` equal → ok.
    - Otherwise → `reason` starting `refusing to start: G1 device-key mismatch for <userId>/<deviceId>` and ending `see RUNBOOK "Matrix device reauth"`.
  - `fetchServerDeviceKeys(params: { homeserverUrl: string; accessToken: string; userId: string; deviceId: string; fetchImpl?: typeof fetch }): Promise<Record<string, string> | undefined>`
    - Sends `POST /_matrix/client/v3/keys/query` with body `{ device_keys: { [userId]: [deviceId] } }` and returns `device_keys[userId][deviceId]?.keys`.
    - Throws `Error("refusing to start: G1 could not verify device keys: <status>")` on a non-2xx response or a network error.

- [ ] **Step 1: Write failing tests**, one per verdict branch above:
  - restored, absent and failed;
  - match, server undefined, ed25519 mismatch and curve25519 mismatch;
  - `fetchServerDeviceKeys` with a fake `fetchImpl` returning 200 and keys, 200 without the device, 502, and a rejected promise.
  - The mismatch test asserts the exact prefix and suffix from the Global Constraints. It also asserts that neither key value appears in `reason`.
- [ ] **Step 2: Run them and watch them fail** (`npm test`; the module is missing).
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: startup decision and device-key identity check"`

### Task 5: `snapshot-scheduler.ts`: serialised saves, escalation, SDK durability hooks (G5, G6)

**Files:**
- Create: `integrations/matrix-capture/snapshot-scheduler.ts`, `snapshot-scheduler.test.ts`

**Interfaces:**
- Consumes: Task 1's `PersistResult`.
- Produces:
  - `class SnapshotScheduler`, constructed with `{ persist: () => Promise<PersistResult>; now?: () => number; log?: Pick<Console, "log" | "warn" | "error">; onFatal: (reason: string) => void; errorAfter?: number /* 3 */; fatalAfterMs?: number /* 600_000 */ }`
    - `save(reason: string): Promise<PersistResult>`
      - **Serialised:** a call made while a save is running waits for it, then runs its own save.
      - **Coalesced:** calls made while one save is *queued* share that queued save.
      - Logs `Persisted Matrix IndexedDB snapshot (<reason>)` only on `ok`.
      - On failure: `warn` while consecutive failures are under 3, `error` from the 3rd. `onFatal("snapshot saves failing for <n>s")` fires once the first failure in the current streak is ≥ `fatalAfterMs` old. A success resets the streak.
    - `saveUntilOk(reason: string, backoffMs?: [number, number] /* [1000, 30000] */): Promise<void>` retries with doubling backoff until ok. Escalation and `onFatal` still apply.
  - `installPublishDurability(proto: { makeOutgoingRequest(msg: unknown, uia?: unknown): Promise<void> }, opts: { isPublishing: (msg: unknown) => boolean; beforePublish: () => Promise<void> }): void`
    - Idempotent (flag `__ob1DurablePatched`).
    - For publishing messages it awaits `beforePublish()` before calling the original. If that throws, the original is never called and the error propagates.
  - `installSyncDurability(proto: { preprocessToDeviceMessages(events: unknown[]): Promise<unknown>; onSyncCompleted(state: unknown): Promise<void> }, save: () => Promise<void>): void`
    - Idempotent.
    - A non-empty `events` passed to `preprocessToDeviceMessages` marks the instance dirty.
    - `onSyncCompleted` awaits the original, then, if dirty, awaits `save()` and clears the flag.
  - `isPublishingRequest(msg: unknown): boolean`: `instanceof` against `KeysUploadRequest`, `SignatureUploadRequest`, `UploadSigningKeysRequest`, `ToDeviceRequest`, `KeysBackupRequest` and `PutDehydratedDeviceRequest` from `@matrix-org/matrix-sdk-crypto-wasm`.

- [ ] **Step 1: Write failing tests:**
  - **Serialised:** a persist that resolves only after a deferred releases it. Call `save` twice. The second persist starts only after the first resolves.
  - **Coalesced:** three calls during one in-flight save give 2 persists in total.
  - **Escalation:** a fake clock and a persist that always fails. Calls 1–2 warn and call 3 errors. `onFatal` is not called at t=599 s and is called once at t=600 s. A success then resets the streak.
  - **Publish ordering:** a fake proto whose original records `"send"`, and a `beforePublish` that records `"save"` after a tick. Order is `["save","send"]`. With `isPublishing` false there is no save. A throwing `beforePublish` means no `"send"` and a rejected call.
  - **Sync ordering:** with to-device events, the order is `["original","save"]`, and `onSyncCompleted`'s promise resolves only after the save. With an empty events array there is no save.
  - **Unwritable directory (Review Focus 5):** `saveUntilOk` with an always-failing persist and fake timers keeps retrying, and calls `onFatal` at 600 s.
- [ ] **Step 2: Run them and watch them fail** (`npm test`).
- [ ] **Step 3: Implement.** No test covers `isPublishingRequest`'s wasm `instanceof` checks directly; Task 6's typecheck and the live check (Task 9) cover them.
- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm run typecheck`.
- [ ] **Step 5: Commit**: `git commit -s -m "matrix-capture: serialised snapshot saves and durability hooks"`

### Task 6: Wire it into `service.ts`; shutdown, logging, Dockerfile, README (G1–G7)

**Files:**
- Modify: `integrations/matrix-capture/service.ts`. That means `:133-176` (persist, schedule and restore), `:178-189` (`loadMatrixSdk`), `:622-720` (`main`), `:691-697` (failed decryption) and `:803-814` (shutdown).
- Modify: `decrypt-bridge.ts:236` ("Giving up…" becomes `console.warn`), `Dockerfile`, `README.md`
- Create: `integrations/matrix-capture/shutdown.ts`, `service.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4 and 5.
- Produces: `runShutdown(steps: () => Promise<void>, timeoutMs: number): Promise<"done" | "timeout">`, exported from `shutdown.ts`.

**Wiring (in this order inside `main`):**
1. `loadMatrixSdk` stores the `RestoreResult`. `decideStartup` runs on it; a failure throws its `reason`.
2. `installPublishDurability` and `installSyncDurability` are installed **unconditionally** when `MATRIX_USE_INDEXEDDB`. They target `OutgoingRequestProcessor.prototype` and `RustCrypto.prototype`, using `isPublishingRequest`, `() => scheduler.save("publish")` that throws when not ok, and `() => scheduler.saveUntilOk("sync")`. They go in before `initRustCrypto`.
3. `initRustCrypto`, then `checkDeviceIdentity(crypto.getOwnDeviceKeys(), await fetchServerDeviceKeys(...))`. A failure throws its `reason`.
4. Only then: the "post-init" save via `scheduler`, then the 60 s interval via `scheduler.save("interval")`.
5. Then `bootstrapCrossSigning` and the rest, unchanged.

**Other changes:**
- **Exit codes:** `onFatal` logs the reason and calls `process.exit(1)`. The existing `main().catch` already exits 1, so the first error line it prints is the `reason`.
- **Failed decryptions:** `emitFailedDecryption` always logs `console.warn("Matrix decryption failed", { eventId, roomId, sender })`, and nothing else from the event.
- **Shutdown:** wrap the existing shutdown body in `runShutdown(…, 20_000)`, then exit 0 for `"done"` or 1 for `"timeout"`. Guard it against running twice.
- **Dockerfile:** `CMD ["node", "--import", "tsx", "service.ts"]`, and `COPY *.ts ./` (excluding `*.test.ts` via `.dockerignore`).
- **README:**
  - correct the atomic-write claim (:260, :283) and the snapshot filename (`.json`);
  - mark `MATRIX_CRYPTO_DB_PREFIX` as inert;
  - add a "Failure modes" section listing the G1, G2 and save-failure messages.

- [ ] **Step 1: Write failing tests:**
  - `shutdown.ts`: `runShutdown` returns `"done"` for fast steps and `"timeout"` at the deadline for a never-resolving step, with fake timers.
  - `service.test.ts`, which spawns `node --import tsx service.ts` with:
    - `MATRIX_USE_INDEXEDDB=true`;
    - `MATRIX_INDEXEDDB_PATH` set to a temp dir containing a `garbage` snapshot;
    - the other required env set to dummies.
  - Assert: exit code 1; the first stderr line matching `/refusing to start/` starts `refusing to start: G2 restore failed`; the snapshot bytes are unchanged; no `.tmp` file is left.
- [ ] **Step 2: Run them and watch them fail** (`npm test`). Today the service ignores a failed restore, so it fails differently (on the dummy homeserver).
- [ ] **Step 3: Implement the wiring** above.
- [ ] **Step 4: Run all tests and typecheck.**
  Run: `npm test && npm run typecheck`
  Expected: all green.
- [ ] **Step 5: Check the image builds locally.**
  Run: `docker build -t ob1-matrix-capture:test integrations/matrix-capture`
  Expected: success. If the dev machine can't build arm64, an amd64 build is enough here.
- [ ] **Step 6: Commit**: `git commit -s -m "matrix-capture: fail closed on mismatched crypto state; durable saves wired in"`

### Task 7: CI image workflow (G8)

**Files:**
- Create: `.github/workflows/matrix-capture-image.yml`

**Interfaces:**
- Produces: the image `ghcr.io/evangineer/ob1-matrix-capture:<tag>`, consumed by Task 9's stack pin.

- [ ] **Step 1: Write the workflow.** Model it on `~/src/operately/.github/workflows/bpcs-image.yml`, simplified to a single job:
  - `on: workflow_dispatch` with a required `tag` input;
  - `permissions: { contents: read, packages: write }`;
  - `runs-on: ubuntu-24.04-arm`;
  - checkout, `docker/setup-buildx-action@v3`, then `docker/login-action@v3` (ghcr.io, `github.actor`, `GITHUB_TOKEN`);
  - `docker/build-push-action@v6` with `context: integrations/matrix-capture`, `platforms: linux/arm64`, `push: true`, `tags: ghcr.io/evangineer/ob1-matrix-capture:${{ inputs.tag }}`;
  - before building, a step that runs `npm ci && npm test` in the context directory.
  - Add a guard step that fails if the tag doesn't match `^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{7}$`.
- [ ] **Step 2: Validate.**
  Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/matrix-capture-image.yml'))"`, plus `actionlint` if it's installed.
  Expected: no errors.
- [ ] **Step 3: Commit**: `git commit -s -m "matrix-capture: CI image build to GHCR"`

### Task 8: Guard the on-node build; add a backup to reauth; RUNBOOK (dokploy-playbooks)

**Files** (in `~/src/dokploy-playbooks`, new branch `ob1-crypto-store` from `main`):
- Modify: `roles/ob1/tasks/main.yml`. Add `when: ob1_matrix_capture_build_on_node | bool` to the tasks from "Inspect currently deployed matrix-capture source commit" (`:40`) through "Build matrix-capture image" (`:95`), and to "Force-update OB1 matrix-capture services" (`:371`).
- Modify: `group_vars/all/vars.yml`. Add `ob1_matrix_capture_build_on_node: false` with a comment pointing to the spec.
- Modify: `reauth-ob1-matrix.yml:108`. Before "Clear crypto store from volume", add "Back up crypto store before wipe": `docker run --rm -v {{ crypto_volume }}:/data:ro -v /var/backups/ob1:/backup alpine tar czf /backup/{{ tenant }}-crypto-<ts>.tgz -C /data indexeddb`, then `chmod 600` the file. `/var/backups/ob1` is created 0700 root.
- Modify: `RUNBOOK.md`:
  - an incident note (3 May stale lock, discovered 2026-10-21);
  - a "Capture bot refuses to start (G1/G2)" entry with its fixes;
  - "Matrix device reauth" mentions the backup;
  - a note not to change the ob1 env file until ob1s is off `:current` (an env change triggers both webhooks, `:268-321`);
  - the device record at `:2550`, updated in Task 9 after the rotation.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Verify.**
  Run: `ansible-playbook site.yml --syntax-check && ansible-playbook reauth-ob1-matrix.yml --syntax-check`
  Expected: no errors.
  **[OPERATOR]** Then run `ansible-playbook site.yml --tags ob1 --check --diff`. Expected: the guarded tasks are skipped, and no force-update or webhook task is changed.
- [ ] **Step 3: Commit**: `git commit -m "Guard on-node OB1 capture build; back up crypto store before reauth wipe"`, with the attribution line, referencing the spec path.

### Task 9: [OPERATOR-GATED] Roll out to ob1m and rotate its device (§7.1–7.4)

Every bullet that changes production needs the operator's go-ahead first.

- [ ] **Step 1: Back up ob1m's volume.** As root on `dokploy-main-12bl5`, tar `ob1-ob1m-1hzbi8_matrix_capture_data` read-only to `/var/backups/ob1/ob1m-crypto-pre-fix-<ts>.tgz` with mode 0600.
  Expected: the archive lists `indexeddb/crypto-idb-snapshot.json` dated 2026-05-03.
- [ ] **Step 2: Publish the image.**
  - Push the OB1 branch.
  - Dispatch `matrix-capture-image` with `tag=0.2.0-<sha7>` of HEAD.
  - Make the package **public** in GitHub's package settings.
  Expected: `docker manifest inspect ghcr.io/evangineer/ob1-matrix-capture:0.2.0-<sha7>` shows `arm64`.
- [ ] **Step 3: Pin ob1m's stack.** In `~/src/dokploy-stacks/ob1-ob1m/docker-compose.yml`:
  - `image: ghcr.io/evangineer/ob1-matrix-capture:0.2.0-<sha7>`;
  - `stop_grace_period: 30s`;
  - `init: true`.
  Commit it. Pushing to `main` redeploys via Dokploy (watchPaths), so the push needs the operator's OK.
  Expected: the ob1m task fails and keeps failing; its first refusal line is `refusing to start: G1 device-key mismatch for @evangineer…/OB1M05`; the logs show the stale-lock warning and a successful restore. ob1s is unaffected: same task ID, same image.
- [ ] **Step 4: Preflight the login.** Log in with the vaulted ob1m password, then log that test session out immediately.
  Expected: 200, then 200. If it fails, stop.
- [ ] **Step 5: Rotate the device** with `ansible-playbook reauth-ob1-matrix.yml -e tenant=ob1m`.
  - Verify the new device (RUNBOOK :1064-1112).
  - Sign out `OB1M05`.
  - Update the RUNBOOK device record (:2550) and commit it.
- [ ] **Step 6: Validate (§7.4).**
  - Two `docker service update --force` restarts of ob1m only give no `already exists` lines for the new device in Synapse's log.
  - The snapshot mtime advances after each restart.
  - A message from a MindRoom agent in an ob1m capture room is captured.
  - Planting a lock dir with `touch -d '-5 min'` and restarting clears it, with a warn line.
  - 24 hours later, there are zero `keys/upload` 400s for the new device.

Ledger every result. ob1s (§7.5) is out of this plan until Sofia agrees.

**Debug flags:** turning off `ob1_matrix_crypto_debug` and `ob1_matrix_timeline_debug` (§7.2) is an ob1 env change, which redeploys **both** tenants (`roles/ob1/tasks/main.yml:268-321`). It therefore waits until ob1s is off `:current`. That is a ruling against the spec's "turn off after §7.4", and it goes in the ledger.
