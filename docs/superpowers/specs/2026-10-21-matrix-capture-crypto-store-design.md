# Design: matrix-capture crypto-store integrity

Status: approved 2026-10-21. Revised the same day after three Codex (GPT-6.1-Sol) reviews; changes are marked "Codex review #n" (first pass), "Codex review 2, #n" (second) or "Codex review 3, #n" (focused check of the lock and role). Implementation plan follows (superpowers:writing-plans); built test-first.
Nothing touches production until the rollout steps (§7), and each step there is operator-gated.

The spec spans three repos:
- the **OB1 fork**: code, CI workflow and README;
- **dokploy-playbooks**: `roles/ob1`, `reauth-ob1-matrix.yml` and the RUNBOOK;
- **dokploy-stacks**: the `ob1-ob1m` stack file.

This OB1 copy is canonical; the other repos' commits and RUNBOOK entries link to it.

## Context

Both OB1 capture bots have been running with crypto state that doesn't match their Matrix devices. They are ob1m (`@evangineer`, device `OB1M05`) and ob1s (`@olasofia`, device `NWJINCDPQS`).

**Evidence (read-only, 2026-10-21):**
- **A lock left behind on 3 May.** Each volume has a leftover lock directory `/data/indexeddb/crypto-idb-snapshot.json.lock`:
  - ob1s: dated 2026-05-03 07:11 UTC;
  - ob1m: dated 2026-05-03 08:01 UTC.
  Each snapshot file was last written about a minute earlier. Something probably killed both containers mid-save.
- **Every save since then has failed.**
  - `withSnapshotLock` (`integrations/matrix-capture/idb-persistence.ts:32-57`) has no way to detect a stale lock.
  - `persistIdbToDisk` swallows the error (`:285`).
  - `service.ts:141` still logs "Persisted Matrix IndexedDB snapshot".
- **Every restart since has started from an empty store.**
  - `restoreIdbFromDisk` turns the lock timeout into `false` (`:242-264`), and `service.ts:164-166` ignores that result.
  - `initRustCrypto` then creates a brand-new Olm account under the existing device ID.
  - Both bots' startup logs from 12 days ago show "Failed to restore…", then "Creating an empty cross signing identity stub".
- **Results:**
  - About 11k rejected `/keys/upload` calls in 30 hours ("One time key … already exists").
  - Messages from the MindRoom agents fail to decrypt. These failures are invisible unless `MATRIX_TIMELINE_DEBUG=true` (`service.ts:691-697`).

**Further defects found:**
- The snapshot write isn't atomic: a plain `writeFileSync` (`:278`), although README:260 and :283 claim it is.
- A crash up to 60 s after a crypto change loses that change. The store is snapshotted every 60 s (`service.ts:57`), but the SDK publishes keys immediately, so after a restart the bot re-generates one-time keys under IDs that are already published. This is the same collision the stale lock caused, reached by a different route.
- The post-init persist (`service.ts:656`) would overwrite a good snapshot with a fresh empty store if a restore had failed. Ironically, the stale lock prevented exactly that, which means the 3 May snapshots still exist.
- npm is PID 1 (`CMD npm run start`). The deployed stacks set no `stop_grace_period`, so Docker sends SIGKILL after 10 s, which can land mid-shutdown.
- There are no tests (`package.json` has only `start` and `typecheck`).

**Server-side state (read-only check, after the builder review):**
- Synapse replaced the device keys of both bots on **2026-10-09**: OB1M05 at 15:25 UTC and NWJINCDPQS at 11:08 UTC. That is each bot's last restart.
- So every fresh-account restart has overwritten the device keys on the server, even though the one-time-key half of the same upload was then rejected.
- **What the server holds now:**
  - **Device keys:** the current in-memory account's. They have never been saved to disk.
  - **One-time keys:** a mix left behind by earlier accounts. OB1M05 has 93 and NWJINCDPQS has 21.
  - Peers that claim those stale one-time keys build Olm sessions the bot can't open. That is why room keys never arrive.
- **Consequences:**
  - The 3 May snapshots no longer match the server, so they can't be used to keep the old devices.
  - Rotating to a new device is required. Keep the 3 May snapshots in the backup for forensics only.

## 1. Intent

The capture bot must **never operate on crypto state that differs from what the homeserver believes about its device**, and must **never silently lose crypto state**. When it can't guarantee that, it stops and says why, clearly enough that the RUNBOOK fix is obvious. Losing some captures while stopped is acceptable. Running wrong or broken quietly is not.

## 2. Goals

- **G1. Refuse to run on a mismatched store.**
  - After crypto init, compare the local device's Ed25519 and Curve25519 keys with what `/keys/query` returns for our own user and device.
  - If the server has keys for this device and they differ, **exit non-zero** with one clear error line naming the device and pointing to the RUNBOOK's device-reauth section.
  - If the server has no keys for this device (a brand-new device), continue.
  - This invariant catches every route to the bug, not just the lock.
  - **The server's keys must come from a raw `POST /keys/query`.** Compare them with `crypto.getOwnDeviceKeys()`. Don't use the SDK's device APIs: Rust crypto seeds its device store with our own device from the local account, so the comparison would always pass.
  - **When:** right after `initRustCrypto` and before `bootstrapCrossSigning()` (`service.ts:704`), because that call already sends requests. `getOwnDeviceKeys()` returns a promise and must be awaited.
  - **Startup gate (Codex review #3):**
    - The `RustCrypto` constructor already starts `checkKeyBackupAndEnable()` (`rust-crypto.js:119`). A trusted backup can therefore start uploading during `initRustCrypto`, before G1 has given its verdict.
    - A closed gate is installed **before** `initRustCrypto`. Until G1 passes, every outgoing crypto request (G5's hook) and every snapshot save waits at the gate.
    - G1 passing opens the gate. G1 refusing exits with the gate still closed, so a refused bot has published and saved nothing.
    - G1's own `/keys/query` is a raw `fetch`, outside the gate.
  - **Every refusal names its check:** for example `refusing to start: G1 device-key mismatch` versus `G2 restore failed`. The logs then show which check stopped the bot.
- **G2. A failed restore is fatal when a snapshot exists.**
  - Snapshot present but not restorable (lock, parse or IDB error) → exit non-zero. Never fall back to an empty store.
  - No snapshot file → start empty and log a warning. G1 still applies.
  - Nothing may write a snapshot before a successful restore or a confirmed fresh start, so a good snapshot is never overwritten.
  - **A restore can't hang (Codex review #7).** Restore rejects on transaction `abort` or `error` and on a `blocked` open, and closes connections in `finally`. Any such failure is a G2 refusal, never a hung start.
- **G3. Saves are consistent, atomic and durable.**
  - **Consistent:** each database is dumped in **one** read-only transaction covering all its object stores. Today `dumpIndexedDatabases` opens one transaction per store (`idb-persistence.ts:150`), so a multi-store Rust write can land between two reads and tear the snapshot.
  - Write to a temp file in the same directory: delete any leftover `.tmp`, then create a new one **exclusively** (`wx`) with mode 0600 before writing any data. Then fsync it, rename it over the snapshot, and fsync the directory. Reusing a leftover file could keep looser permissions (Codex review 2, #6).
  - A crash at any point leaves either the old snapshot or the new one, never a torn file.
- **G4. One writer per store, enforced by a kernel lock (revised after both Codex reviews).**
  - **Why not a file lock with a lease:** no lock made of files and timestamps can tell a paused process from a dead one. A paused writer can resume after a takeover and rename a stale snapshot over the new one (Codex review 2, Critical 1). Separate processes also each hold their own in-memory store, so two writers on one volume are wrong whatever the locking.
  - **The lock:** the container entrypoint (`entrypoint.sh`) does these three things, in order:
    1. opens `<MATRIX_INDEXEDDB_PATH>/.writer.lock` on file descriptor 9;
    2. takes `flock -n 9` (non-blocking);
    3. `exec`s node, so node is the same process and inherits the lock.
  - **Why this holds:**
    - The kernel releases the lock only when the process exits, including on SIGKILL. A live process can never lose it, and a dead one never leaves it behind.
    - It works across containers on the same host sharing a local volume. That is our case: the stack is pinned to `dokploy-main-12bl5`.
    - `flock` is unreliable on network filesystems, which these volumes are not.
  - **If the lock is held:** the entrypoint prints `refusing to start: G4 another writer holds <path>` and exits 75.
  - **Node proves it holds the lock (revised after Codex review 3, #1).** Contention alone proves nothing: a node started directly while the real bot runs would see the lock as held. So at startup node checks three things:
    1. fd 9 is open;
    2. `fstat(9)` has the same device and inode as `stat(<path>)`;
    3. a child process given **fd 9 itself** (passed explicitly through `stdio`) succeeds at `flock -n 9`.

    A lock attempt on the same open file description succeeds only if we hold the lock, or nobody does; in that second case the child's success leaves the lock held on our description. A lock held through any other description makes it fail.
    - Any failure gives `refusing to start: G4 not running under the writer lock`.
    - Node's own child processes don't inherit fd 9 (Node opens it close-on-exec), so the lock never outlives node.
  - **Legacy lock directories:** under the kernel lock, any `<snapshot>.lock/` directory (the 3 May ones) is stale by definition. It is removed with a warning.
  - Within the process, saves are serialised by an in-process mutex.
  - **Other writers take the same lock:** the reauth playbook wipes the volume only while holding it (§7.3).
  - **The lock file is never deleted or replaced.** Deleting it would let a new process lock a new inode while the old holder still runs (Codex review 3, #2).
  - **Persistent conflict:** with `restart_policy: on-failure`, a persistent conflict means a restart every 5 s, with the G4 message each time. That is loud and harmless, and the RUNBOOK says so.
- **G5. Durable before publish.**
  - **Outgoing:** the crypto store snapshot must be on disk before any outgoing request that publishes or commits crypto state is sent: `/keys/upload`, `/keys/signatures/upload`, `/keys/device_signing/upload`, `sendToDevice`, and room-key backup uploads.
  - **Where to hook:** every one of these goes through `OutgoingRequestProcessor.prototype.makeOutgoingRequest` (`node_modules/matrix-js-sdk/lib/rust-crypto/OutgoingRequestProcessor.js:51-90`).
    - The requests that bypass it (keys/query, in-room verification messages, backup reads) don't publish state.
    - Wrap it **unconditionally**. Today's diagnostics patch is only installed under `MATRIX_CRYPTO_DEBUG`.
  - **A failed save blocks the send.** If the save throws, the request stays unsent; the SDK logs it and retries.
  - **Saves wait, not skip:** the existing `snapshotPersistInFlight` (`service.ts:134`) skips a save that overlaps another. It must wait for it instead.
  - **Incoming (*my call*, from the intent "never silently lose state"):** after a sync whose response carried to-device events, the snapshot is saved before the next `/sync` request goes out. Otherwise room keys and Olm sessions received just before a crash are lost, because the server has already discarded them.
    - One-time-key count changes are not a trigger: they lead to outgoing uploads, which the outgoing hook already covers.
    - **The seam exists.** `SyncApi.doSync` awaits `cryptoCallbacks.onSyncCompleted(...)` (`node_modules/matrix-js-sdk/lib/sync.js:788`) before the loop issues the next `doSyncRequest` (`:733`). Wrapping the Rust crypto's `onSyncCompleted` so the save runs after it resolves therefore holds back the next sync.
    - **Residual window:** none on this path. If an SDK upgrade stops awaiting that callback, the ordering test (§6.8) fails. That test drives the real `SyncApi.doSync` (Codex review #6).
    - **Failed incoming processing stops the bot (Codex review #1).**
      - The SDK saves the new sync token *before* processing (`sync.js:747`). It catches processing errors and carries on (`:762`), so `onSyncCompleted` still runs and the next `/sync` would acknowledge to-device messages that were never processed.
      - So: if `preprocessToDeviceMessages` throws, or `processSyncResponse` raises `SyncUnexpectedError`, latch it. The wrapped `onSyncCompleted` then **does not save** and exits non-zero with `incoming crypto processing failed`, before the next `/sync` can go out.
      - Recovery is safe: the client keeps no sync token across restarts, so after the restart Synapse redelivers every to-device message that wasn't acknowledged.
  - **Effect:** a crash can't leave the server holding keys the bot has forgotten, or leave the bot having acknowledged keys it never saved.
  - The 60 s interval stays as a backstop.
  - **Assumption to prove with a test, not trust:** the Rust store commits newly generated one-time keys before `outgoingRequests()` hands back the upload.
    - Codex reproduced this with the real WASM library: 50 one-time keys restored identically from a snapshot taken before the upload, even after the later `markRequestAsSent` state was discarded. Losing that state replays the same keys rather than generating new ones.
    - Synapse accepting an identical re-upload is **not yet verified**. It is checked live in §7.4.
- **G6. Honest logging.**
  - **Saves:** `persistIdbToDisk` reports success or failure to its caller, and "Persisted…" is logged only on success.
  - **Failed saves:** consecutive failures escalate to `error` after 3, and the process exits non-zero after 10 minutes of continuous failure.
  - *My call on that exit:* restarting from the last durable snapshot is safe, because of G5.
  - **Shutdown (Codex review #9):** shutdown exits non-zero if its final save fails.
  - **Decryption failures:** each one logs a `warn` line with the event ID, room and sender, and nothing else. When retries give up, that is also a `warn`. Neither depends on `MATRIX_TIMELINE_DEBUG`.
- **G7. Clean shutdown fits the stop window.**
  - The real fix is two parts: an overall shutdown timeout under the grace period (*my call*: 20 s), and `stop_grace_period: 30s` in the deployed stacks.
  - Also make SIGTERM reach node reliably: for example, `init: true` or tini, and node started via `node --import tsx service.ts` rather than through npm. tsx's CLI forks a child process, so `npx tsx` doesn't help.

- **G8. The image is built in CI and pinned per tenant.** The user decided CI, `ghcr.io/evangineer` and that this belongs in this spec. Keeping ob1s on `:current` until Sofia agrees is *my call*.
  - **Why:** building on the node got the service running but is now a liability. It means mutable local tags, and one rebuild force-restarts both tenants.
  - **Build:** a new `.github/workflows/` workflow in the OB1 fork, modeled on the Operately fork's `bpcs-image.yml`:
    - `workflow_dispatch` with a `version` input;
    - **linux/arm64 only**, because `dokploy-main-12bl5` is aarch64;
    - published as `ghcr.io/evangineer/ob1-matrix-capture`;
    - logs in with `GITHUB_TOKEN` and `packages: write`.
  - **Tags (Codex review #8):** the workflow derives the tag itself as `<version>-<sha7 of the checked-out commit>`, and fails if that tag already exists. No `latest`.
  - **CI and the image install the same dependencies:** the Dockerfile copies `package-lock.json` and runs `npm ci`, as the CI test step does.
  - **Each tenant pins its own image by digest:** `dokploy-stacks/ob1-ob1m/docker-compose.yml` references `ghcr.io/evangineer/ob1-matrix-capture:<tag>@sha256:<digest>`. Each tenant deploys independently through Dokploy.
  - **Role scoping (Codex reviews 1 #2 and 2 #2):** `roles/ob1` acts only on the tenants listed in `ob1_matrix_capture_managed_tenants`, set to `[ob1m]` until Sofia agrees.
    - The users list is filtered **first**, so room creation, the Matrix env files and the MCP env files all skip ob1s.
    - Services are mapped by tenant name rather than list position, with an assertion of exactly one service per managed tenant.
    - Change detection, redeploy webhooks, rollover checks and force-updates are all per tenant.
    - A `--tags ob1` role run or a reauth follow-up can then never redeploy or rewrite **ob1s's capture bot**.
    - Services are matched with an anchored regex (`^ob1-<tenant>-.*_matrix-capture$`), and the old "exactly two services" assertion is removed.
    - Accumulated facts (resolved users, room mappings, per-tenant flags) are reset at the start of each run.
  - **Scope of the ob1s guarantee (Codex review 3, #3):** it covers ob1s's capture bot: its stack, env files, rooms, volume and Matrix device.
    - Other roles (`supabase_ob1`, `openclaw`) still update ob1s's Supabase backend and MCP wiring on a full `site.yml` run, as they do today. That doesn't touch the capture bot's crypto.
    - Every rollout command in this work uses `--tags ob1`.
    - Isolating tenants across all roles is a separate piece of work.
  - **CI publication:** one workflow `concurrency` group per tag, and a registry error is a failure, not "tag absent".
  - **ob1s:** its stack file stays on `ob1-matrix-capture:current` until Sofia agrees. Nothing re-tags `:current`.
  - **Remove the on-node build from `dokploy-playbooks/roles/ob1`:** the source sync, `docker build` (`main.yml:97`) and the `docker service update --force` fan-out (`:373`). Do this only after ob1s has also moved off `:current`; until then those tasks are guarded off, so a role run can't rebuild or restart either tenant.
  - **Package visibility (*my call*):** **public**. The source is public, and the image holds no secrets because they arrive via `env_file`. Nodes then pull without registry credentials. If it must be private, Dokploy needs a GHCR registry credential instead.

## 3. Non-goals

- Fixing the unused `MATRIX_CRYPTO_DB_PREFIX`. Wiring it in would rename the IndexedDB databases and orphan existing stores. Document it as inert instead.
- Replacing fake-indexeddb with a real on-disk store such as SQLite.
- Recovering messages that already failed to decrypt. Key backup may recover some history, but that is not a target here.
- Automatic device rotation. Rotation stays a deliberate, operator-run step via `reauth-ob1-matrix.yml`.

## 4. Anti-goals: what counts as a failure even if tests pass

- Any code path that starts crypto on an empty or partial store while a snapshot file exists.
- Any code path that overwrites the snapshot before a successful restore.
- Two processes writing the same store, or a writer that keeps writing after another has started.
- Acknowledging (via the next `/sync`) to-device messages whose processing failed.
- Any publish or save before G1 has passed.
- Logging secrets. That includes snapshot contents, keys and recovery-key material. Keep the existing `no_log`-style discipline, and keep the key-upload diagnostics behind `MATRIX_CRYPTO_DEBUG`.
- A crash loop that hides its reason. The first error line must name the cause.

## 5. Constraints

- **Repo:** `~/src/OB1`, branch `matrix-capture`, HEAD `5825a13`, clean.
  - The runbook says a rebased branch was deployed on 04-18, so first check the deployed source commit recorded by `roles/ob1` on the main node and branch from that commit.
- **Runtime:** Node 20 (`node:20-bookworm-slim`), tsx, matrix-js-sdk Rust crypto, and fake-indexeddb snapshots serialised with v8.
- **The snapshot format must stay readable:** the existing v8 format, `edf0b65`.
- **Tests:** no new dependencies. Use `node:test` via `npx tsx --test`, and add a `test` script to `package.json`.
- **Deployment:** image `ob1-matrix-capture:current`, built on `dokploy-main-12bl5` by `dokploy-playbooks/roles/ob1`; stacks in `dokploy-stacks/ob1-ob1m`, `ob1-ob1s`.
- Third-party attribution headers stay intact (`THIRD_PARTY_NOTICE.md`).
- **Sofia's account:** nothing touches ob1s's capture bot, its volume or her device without her consent (scope as in G8).

## 6. Tests required (written first, watched failing)

`idb-persistence.test.ts`, run against temp directories:
1. **Writer lock (two processes):**
   - With one process holding the lock through the entrypoint, a second start exits 75 with the G4 message.
   - After the first is SIGKILLed, a new start succeeds.
   - Node started without the entrypoint refuses with `G4 not running under the writer lock`, **both** when nobody holds the lock **and** while another writer holds it.
   - A reauth-style wipe under the lock leaves `.writer.lock` with the same inode, and a writer started during the wipe refuses.
   - A legacy `.lock/` directory is removed with a warning.
2. **Atomic write:**
   - A simulated failure between the temp write and the rename leaves the old snapshot byte-identical.
   - The temp file and the final file are 0600, including when a 0644 `.tmp` was left behind.
3. **Failure reporting:** the persist result reports failure, so the caller can't log success.
4. **Restore outcomes:**
   - Restore returns distinct results for "no snapshot", "restored" and "failed".
   - A well-formed snapshot that fails during insertion returns "failed", not a hang. So do a `blocked` open and a transaction `error`.
5. **Consistent dump:** the conflicting write is queued deterministically between the reads of the two stores. The restore goes into a fresh, injected factory. The test must fail against the old per-store dump.

A new module (name left to the builder) holds the startup and publish logic as pure functions, with tests:

6. **Startup decision:**
   - snapshot present and restore failed → refuse;
   - no snapshot → start empty with a warning;
   - restored → start.
7. **Device identity check (G1):**
   - matching keys → OK;
   - server has no keys → OK, as a new device;
   - mismatch → refuse with the RUNBOOK pointer.
8. **Durable before publish (G5):**
   - With a fake persist and a fake sender, publish-class requests are sent only after the persist resolves.
   - A failed persist blocks the send and surfaces the error.
   - A save requested while one is in flight waits for it, never skips.
   - The incoming rule, tested against the **real `SyncApi`** with a fake HTTP layer: while the save is pending, no second `/sync` is sent.
   - The same harness: a rejecting `preprocessToDeviceMessages` means no save, exit non-zero, and no second `/sync`.
   - **Startup gate (Codex review 2, #4):**
     - The startup sequence lives in its own module, which takes its dependencies as parameters.
     - A fake `initRustCrypto` fires a real backup upload request through the real outgoing-request path during init.
     - That request waits at the gate. It is never sent if G1 refuses, and is sent once G1 passes.
     - **Limit:** crypto migration from a legacy store would deadlock behind the gate, because it awaits a request during init. The service never configures a legacy store, so this doesn't arise.
   - The real WASM request classifier recognises each publishing request class. Where the library exposes a constructor, each class is built directly; otherwise it comes from `outgoingRequests()`.
   - One test against the real SDK and fake-indexeddb: after an OTK upload request is produced and a snapshot is taken, restoring that snapshot into a fresh process yields the same one-time keys.
9. **Save-failure escalation (G6):** the warn → error → exit thresholds. Shutdown exits non-zero when its final save fails.

Plus `npm run typecheck`, with `tsconfig.json` extended so the new modules and tests are type-checked.

## 7. Rollout and recovery (operator-gated, ob1m first)

1. **Back up ob1m's volume** before any change, using a read-only tar to `/var/backups/ob1/` (root-only, 0600). The 3 May snapshot is the only copy of the original device state.
   - **ob1s's volume holds Sofia's Olm private keys.** Copying it is copying her credentials, so the ob1s backup is part of the consent request in step 5. Until she agrees, the only copy of her 3 May snapshot is the one on the node, which nothing touches.
2. **Publish the fixed image from CI (G8), then switch ob1m's stack to that tag and deploy it through Dokploy.**
   - First guard off the on-node build and restart tasks in `roles/ob1`, and scope the role to `[ob1m]`, so no role run can touch ob1s.
   - **Expected:** G4 removes the legacy lock directory and G2 restores the 3 May snapshot. Then G1 refuses with `G1 device-key mismatch`, because the server holds the 9 Oct keys. That confirms both checks live.
   - **Debug flags:** `ob1_matrix_crypto_debug` and `ob1_matrix_timeline_debug` are on in production (`group_vars/all/vars.yml`). *My call:* leave them on until §7.4 passes, then turn them off. They only log public key material, but they're noisy.
3. **Rotate ob1m to a new device** with `reauth-ob1-matrix.yml -e tenant=ob1m`.
   - **The login path still exists.** Synapse has `password_config.enabled: true` (`roles/synapse/templates/homeserver.yaml.j2:116`), and the playbook logs in with `m.login.password` (`reauth-ob1-matrix.yml:86-98`), which creates a fresh device ID.
   - **Preflight:** confirm the vaulted password still logs in. If it fails, stop and come back.
     - The scratch session then uploads one one-time key twice with an identical body and expects 200 both times. This directly verifies that Synapse accepts an identical re-upload.
     - Then log out, which deletes the scratch device and its keys.
   - **Stop barrier (Codex review 2, #5):** after scaling the service to 0, wait until its container has exited, and fail on timeout.
   - **Then, holding `flock -n` on `.writer.lock`,** which proves no bot is running:
     - back up the store;
     - **only if the backup succeeded,** delete every entry in `/data/indexeddb` except `.writer.lock`, including hidden entries.
     - The directory and the lock file stay in place (Codex review 3, #2).
   - Then verify the new device (RUNBOOK :1064-1112).
   - Then sign out `OB1M05`.
   - Change: the playbook's store wipe gets a backup step before `rm -rf`.
4. **Validate ob1m:**
   - two restarts give no "already exists" in the Synapse log. This is also the live check that Synapse accepts an identical one-time-key re-upload;
   - the snapshot mtime advances after each restart;
   - an encrypted test message from a MindRoom agent is captured;
   - a planted legacy `.lock/` directory is removed with a warning on restart;
   - a second container started by hand on the same volume refuses with the G4 message.
5. **ob1s:** the same steps, only after Sofia agrees.
   - Until then its stack stays on the local `:current` image and keeps capturing partially, with nothing touching it.
   - The risk it already carries remains: any unplanned restart repeats the empty-store start.
   - Once ob1s is on GHCR, add it to `ob1_matrix_capture_managed_tenants` and delete the on-node build tasks from `roles/ob1` for good.
6. **Docs:**
   - **OB1 README:** fix the atomic-write claim, the `.bin`/`.json` snapshot name and the inert prefix, and add the failure modes.
   - **dokploy-playbooks RUNBOOK:** add an incident note and a "capture bot refuses to start" entry, and update the device record at :2550.

## 8. Left to the builder

- How to wrap outgoing requests for G5, as long as the ordering is guaranteed and tested.
- Module and file names.
- How exactly to wrap `onSyncCompleted` (G5): instance patch or subclass, as long as the ordering is tested.

## Verification

- `npm test` and `npm run typecheck` are green in `integrations/matrix-capture`.
- Every test in §6 was seen failing before its fix.
- The live checks in §7.4 pass for ob1m.
- The Synapse log has zero `keys/upload` 400s for the ob1m device for 24 hours after the rotation.
