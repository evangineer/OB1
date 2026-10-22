# Matrix Capture

> Capture messages from encrypted or unencrypted Matrix rooms into Open Brain using a long-running `matrix-js-sdk` service.

## Third-Party Notice

This directory carries a local third-party notice for any code copied from or materially adapted from OpenClaw's Matrix extension. See [`THIRD_PARTY_NOTICE.md`](./THIRD_PARTY_NOTICE.md).

## What It Does

This integration runs a persistent Matrix client, enables Rust crypto through `matrix-js-sdk`, listens for room timeline events, and writes captured messages into the `thoughts` table with embeddings and extracted metadata.

This is the correct architecture if encrypted rooms matter. The Matrix SDK documentation says `initRustCrypto()` normally uses IndexedDB and that outside the browser you otherwise fall back to `useIndexedDB: false`, which is an ephemeral in-memory store. That makes short-lived Edge Functions a poor fit for E2EE device state. This integration therefore uses a long-running capture service instead of making E2EE claims on top of a stateless function.

For Node/container deployments, this service now provides its own persistent IndexedDB runtime using `fake-indexeddb` plus an on-disk snapshot under `/data`. That gives the Matrix device durable crypto state across restart without depending on `indexeddbshim`.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Matrix homeserver you control or can administer
- A Matrix bot user with access to the rooms you want to capture
- Node.js 20 (the reference runtime, `node:20-bookworm-slim`; newer releases fail the tests, see [Tests](#tests))
- OpenRouter API key for embeddings and metadata extraction
- If you want to unlock encrypted history and backups on first startup, your Matrix secret storage recovery material

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
MATRIX CAPTURE -- CREDENTIAL TRACKER
------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Project URL:           ____________
  Service role key:      ____________
  OpenRouter API key:    ____________

MATRIX INFO
  Homeserver URL:        ____________
  Bot user ID:           ____________
  Room IDs to monitor:
    - ____________
    - ____________
    - ____________

GENERATED DURING SETUP
  Bot access token:      ____________
  Crypto store password: ____________
  Secret storage key or passphrase: ____________

------------------------------------
```

## Steps

![Step 1](https://img.shields.io/badge/Step_1-Create_a_Matrix_Bot_User-00897B?style=for-the-badge)

Create or register a dedicated Matrix user for capture traffic on your homeserver. Join that user to the room or rooms you want Open Brain to monitor.

> [!IMPORTANT]
> This integration is built for E2EE, but the bot device still needs to be trusted in your Matrix account the same way any other encrypted client does. If the bot has never been verified or never received the room keys, encrypted timeline events will not decrypt.

`✅ **Done when:**` the bot account can see messages in your target rooms.

![Step 2](https://img.shields.io/badge/Step_2-Choose_Your_Event_Flow-00897B?style=for-the-badge)

This integration uses a long-running service model: one Matrix client, one device identity, and optional local crypto persistence when the runtime supports it.

`✅ **Done when:**` you are planning to run exactly one long-lived capture process per Matrix device.

![Step 3](https://img.shields.io/badge/Step_3-Install_the_Capture_Service-00897B?style=for-the-badge)

Install the service from this folder in the repo where you manage deployments.

**1. Install dependencies:**
```bash
npm ci
```

**2. Start the service:**
```bash
sh entrypoint.sh node --import tsx service.ts
```

With `MATRIX_USE_INDEXEDDB=true` the service must run under [`entrypoint.sh`](./entrypoint.sh): it takes the writer lock on `<MATRIX_INDEXEDDB_PATH>/.writer.lock` and then `exec`s node, and node refuses to start without that lock (see [Failure Modes](#failure-modes)). `npm run start` (plain `tsx service.ts`) only works with `MATRIX_USE_INDEXEDDB=false`.

The main runtime file is [`service.ts`](./service.ts). The older [`index.ts`](./index.ts) remains as a stateless polling example for unencrypted rooms, but it is not the E2EE path.

`✅ **Done when:**` your deployment repo runs `service.ts` as a long-lived process and can decrypt messages for the trusted Matrix device you configured.

![Step 3.1](https://img.shields.io/badge/3.1-Docker_Compose-555?style=for-the-badge&labelColor=00897B)

If Docker Compose is your standard target, this folder now includes:

- [`Dockerfile`](./Dockerfile)
- [`docker-compose.yml`](./docker-compose.yml)
- [`env.matrix-capture.example`](./env.matrix-capture.example)

The Dockerfile uses `node:20-bookworm-slim`, installs dependencies with `npm ci` from `package-lock.json`, and runs `entrypoint.sh` as the `ENTRYPOINT` with `node --import tsx service.ts` as the command, so node (not npm) receives SIGTERM. The container mounts `/data` as a named volume, and the recommended default is `MATRIX_USE_INDEXEDDB=true` so the service can persist a fake IndexedDB snapshot for Matrix Rust crypto under that volume.

- The writer lock uses `flock`, which is only reliable on a **local** volume. Do not put `/data` on NFS or another network filesystem.
- Run exactly one container per volume. A second one refuses with the G4 message and exits 75.
- Shutdown is bounded at 20 s. Give the container a longer stop window (`stop_grace_period: 30s`) so Docker does not SIGKILL it mid-save.

**1. Copy the example env file:**
```bash
cp env.matrix-capture.example .env.matrix-capture
```

**2. Fill in your real values.**

**3. Build and start the service:**
```bash
docker compose up -d --build
```

**4. Follow logs during first sync:**
```bash
docker compose logs -f matrix-capture
```

`✅ **Done when:**` the `matrix-capture` container is running and the trusted Matrix device can decrypt monitored room traffic.

## Acceptance Criteria

Use this checklist before calling the deployment good:

- The image builds successfully from the provided [`Dockerfile`](./Dockerfile) with `docker compose up -d --build`
- The container starts without `npm install` errors or module resolution failures
- Service logs show `Matrix client prepared`
- Service logs do not show Rust crypto initialization failures
- If `MATRIX_USE_INDEXEDDB=true`, the container can write to both `MATRIX_INDEXEDDB_PATH` and `MATRIX_INDEXEDDB_SNAPSHOT_PATH`
- restarting the container preserves Matrix device crypto state and does not force one-time-key re-registration for the same device
- If `MATRIX_USE_INDEXEDDB=false`, crypto state is in memory only: each start creates a new device account, so a restart on a device the homeserver already knows refuses with the G1 mismatch. Use it only for throwaway devices.
- A newly sent message in a monitored encrypted room is decrypted and logged as `Captured <event_id>`
- The corresponding row appears in `thoughts` with `metadata.matrix_event_id`
- Re-sending the same event through restart/re-sync does not produce a duplicate row

## Verification Commands

These are the practical checks for the Compose path:

**1. Build and start:**
```bash
docker compose up -d --build
```

**2. Follow logs:**
```bash
docker compose logs -f matrix-capture
```

Look for `Matrix client prepared` and absence of Rust crypto startup errors.

**3. Confirm the crypto store path exists in the container if IndexedDB is enabled:**
```bash
docker compose exec matrix-capture ls -la /data/indexeddb
```

**4. Restart and verify persistence:**
```bash
docker compose restart matrix-capture
docker compose logs -f matrix-capture
```

The service should come back without behaving like an untrusted Matrix device.

**5. Validate capture in Open Brain:**
Check your `thoughts` table for a new row whose metadata includes `matrix_event_id`, `matrix_room_id`, and `matrix_encrypted: true`.

**6. Validate deduplication:**
Restart the service again or let it resync, then confirm no duplicate row was inserted for the same `matrix_event_id`.

## Supabase Types

This package includes a checked-in placeholder [`database.types.ts`](./database.types.ts) so the Matrix capture code can type its `thoughts` queries without falling back to `any`.

When you have access to the target self-hosted Supabase/PostgREST database, replace that placeholder with generated types from the CLI. For a self-hosted deployment, the relevant pattern is:

```bash
npx supabase gen types typescript \
  --db-url 'postgres://postgres.[POOLER_TENANT_ID]:[POSTGRES_PASSWORD]@[your-domain-or-ip]:5432/postgres' \
  --schema public \
  > integrations/matrix-capture/database.types.ts
```

If your `thoughts` table is exposed through a different schema name on the target API surface, change `--schema` accordingly before overwriting the file.

![Step 4](https://img.shields.io/badge/Step_4-Configure_Secrets-00897B?style=for-the-badge)

Set the environment variables your service needs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `SUPABASE_SCHEMA` if the target API surface exposes `thoughts` outside `public`
- `OPENROUTER_API_KEY`
- `MATRIX_HOMESERVER_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_ROOM_IDS` as a comma-separated allowlist
- `MATRIX_USE_INDEXEDDB` to enable the snapshot-backed IndexedDB Rust crypto path
- `MATRIX_CRYPTO_STORE_PASSWORD`, `MATRIX_INDEXEDDB_PATH`, and optionally `MATRIX_INDEXEDDB_SNAPSHOT_PATH` (default `<MATRIX_INDEXEDDB_PATH>/crypto-idb-snapshot.json`) if `MATRIX_USE_INDEXEDDB=true`
- `MATRIX_CRYPTO_DB_PREFIX` is **inert**: it is read but not used. Wiring it in would rename the IndexedDB databases and orphan existing stores, so it stays unused.
- One of:
  `MATRIX_SECRET_STORAGE_KEY_BASE64`, `MATRIX_SECRET_STORAGE_KEY`, or `MATRIX_SECRET_STORAGE_PASSPHRASE`
- Optional:
  `MATRIX_AUTOJOIN_INVITES`, `MATRIX_MAX_EVENT_AGE_MS`, `OPENROUTER_BASE`, `EMBEDDING_MODEL`, `CHAT_MODEL`

Example:

```bash
export SUPABASE_URL=https://YOUR_PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
export SUPABASE_SCHEMA=public
export OPENROUTER_API_KEY=your-openrouter-key
export MATRIX_HOMESERVER_URL=https://matrix.example.com
export MATRIX_ACCESS_TOKEN=your-matrix-access-token
export MATRIX_USER_ID=@ob1-bot:example.com
export MATRIX_ROOM_IDS='!roomA:example.com,!roomB:example.com'
export MATRIX_USE_INDEXEDDB=true
export MATRIX_CRYPTO_DB_PREFIX=ob1-matrix-capture
export MATRIX_CRYPTO_STORE_PASSWORD=choose-a-local-store-password
export MATRIX_INDEXEDDB_PATH=/data/indexeddb
export MATRIX_INDEXEDDB_SNAPSHOT_PATH=/data/indexeddb/crypto-idb-snapshot.json
export MATRIX_SECRET_STORAGE_PASSPHRASE='your secret storage passphrase'
```

`✅ **Done when:**` the process environment contains the values your deployment expects.

![Step 5](https://img.shields.io/badge/Step_5-Verify_E2EE_and_Capture-00897B?style=for-the-badge)

Start the service, trust the bot device if needed, and send a test message in an encrypted room.

**1. Start the service and wait for `Matrix client prepared`.**

**2. If this is a new device, verify it from one of your trusted Matrix clients and make sure it receives the room keys.**

**3. Send a test message in one monitored encrypted room.**

**4. Check the service logs for `Captured <event_id>`.**

`✅ **Done when:**` a test Matrix message appears in `thoughts` with Matrix metadata attached.

## Expected Outcome

When your Matrix credentials, crypto state, and room allowlist are correct, a message sent in one of your chosen rooms appears as a new thought in Open Brain. The row should include metadata similar to:

- `source: "matrix"`
- `matrix_room_id`
- `matrix_room_name`
- `matrix_sender`
- `matrix_sender_display`
- `matrix_event_id`
- `matrix_homeserver`
- `matrix_origin_server_ts`
- `matrix_encrypted`

Duplicate inserts are avoided because deduplication happens on `metadata.matrix_event_id`.

## Troubleshooting

**Issue: Snapshot-backed IndexedDB startup fails in Node**
Solution: Find the first `refusing to start:` line in the logs; it names the failed check (see [Failure Modes](#failure-modes)). Do not fall back to `MATRIX_USE_INDEXEDDB=false` on an existing device: a fresh in-memory store does not match the device keys the homeserver holds, so G1 refuses it too. Recover by restoring the snapshot or rotating to a new device.

**Issue: Snapshot file permissions or writes fail**
Solution: Confirm the container can write to `MATRIX_INDEXEDDB_PATH` and `MATRIX_INDEXEDDB_SNAPSHOT_PATH` on the mounted `/data` volume. Each save writes a new `<snapshot>.tmp` exclusively with mode 0600, fsyncs it, renames it over the snapshot and fsyncs the directory, so a crash leaves either the old snapshot or the new one. A failed save is logged as `Matrix IndexedDB snapshot save failed (...)`; "Persisted Matrix IndexedDB snapshot" is logged only on success.

**Issue: The service sees encrypted events but never captures them**
Solution: Verify the bot device from a trusted Matrix client and confirm it has actually received the Megolm session keys for that room. Without device trust and room keys, the SDK cannot decrypt the message payload.

**Issue: The service starts but cannot unlock secret storage**
Solution: Provide one of `MATRIX_SECRET_STORAGE_KEY_BASE64`, `MATRIX_SECRET_STORAGE_KEY`, or `MATRIX_SECRET_STORAGE_PASSPHRASE`. The passphrase path depends on the secret-storage key metadata returned by the homeserver.

**Issue: Inserts fail after decryption succeeds**
Solution: Check `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, and your `thoughts` table permissions. Decryption and database writes are separate stages.

## Runtime Notes

- [`service.ts`](./service.ts) is the E2EE-capable path. It initializes Rust crypto through `initRustCrypto(...)`.
- In the Docker Compose path, [`service.ts`](./service.ts) now defaults to the snapshot-backed IndexedDB path in Node. If `MATRIX_USE_INDEXEDDB=true`, it bootstraps `fake-indexeddb`, restores the snapshot under `MATRIX_INDEXEDDB_SNAPSHOT_PATH`, and then initializes Rust crypto against that restored runtime.
- [`index.ts`](./index.ts) is still useful as a stateless polling example for unencrypted rooms, but it should not be used as the primary design when encrypted capture matters.

## Persistence Model

The current implementation follows the OpenClaw-style Node persistence model that replaced the earlier `indexeddbshim` experiment.

- `service.ts` now provides IndexedDB in Node via `fake-indexeddb`
- the snapshot is a v8-serialised dump of every IndexedDB database (each dumped in one read-only transaction), stored at `crypto-idb-snapshot.json` despite the `.json` name
- on startup it restores the snapshot before `initRustCrypto(...)`; a snapshot that exists but cannot be restored stops the service (G2), and no snapshot is written before a successful restore or a confirmed fresh start
- after crypto init, the local device keys are compared with a raw `POST /keys/query`; until that check passes, every outgoing crypto request and every save waits at a startup gate (G1)
- the snapshot is saved before any request that publishes crypto state (`/keys/upload`, signature and signing-key uploads, `sendToDevice`, key-backup uploads) and, after a sync that delivered to-device events, before the next `/sync`; a 60 s interval save and a final save at shutdown back this up (G5)
- each save is atomic: exclusive 0600 temp file, fsync, rename, directory fsync (G3)
- Matrix secret storage and key backup are still used for bootstrap and historical recovery; the snapshot is only for device continuity

Reference material:

- OpenClaw Matrix docs: <https://docs.openclaw.ai/channels/matrix>
- OpenClaw Matrix package: <https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/matrix/package.json>

### Acceptance criteria

- `MATRIX_USE_INDEXEDDB=true` starts without the old `TransactionInactiveError`
- restarting the container does not trigger repeated `/keys/upload` collisions for the same device
- a dedicated capture device can complete self-verification successfully
- encrypted room traffic remains decryptable after restart without re-issuing a new device token
- the snapshot file is stored only on the persistent volume and is treated as sensitive local state

## Failure Modes

The service stops rather than run on crypto state it cannot trust. The first error line names the check. Restarts on failure repeat the same line until the cause is fixed.

| Line | Exit | Meaning and fix |
| --- | --- | --- |
| `refusing to start: G4 another writer holds <MATRIX_INDEXEDDB_PATH>/.writer.lock` | 75 | Printed by `entrypoint.sh`. Another process holds the store's writer lock. Stop the other container; never run two writers on one volume. |
| `refusing to start: G4 not running under the writer lock` | 1 | Node was started without `entrypoint.sh` (or with a different lock), so it does not hold the lock itself. Start through the entrypoint. |
| `refusing to start: G4 cannot check writer lock: <detail>` | 1 | The lock check itself failed, e.g. `flock` is missing. |
| `refusing to start: G2 restore failed: <error>` | 1 | A snapshot exists but could not be restored. The snapshot is left untouched; restore it from backup or rotate the device. |
| `refusing to start: G1 device-key mismatch for <user>/<device>; local crypto store does not match the homeserver; see RUNBOOK "Matrix device reauth"` | 1 | The local store's device keys differ from what the homeserver holds. Nothing has been published or saved. Rotate to a new device (RUNBOOK "Matrix device reauth"). |
| `refusing to start: G1 could not verify device keys: <cause>` | 1 | The check could not run: `/keys/query` returned a non-2xx status, failed on the network (`fetch failed (<code>)`), took longer than 30 s (`timeout after 30000ms`), or returned a response that does not list the bot user (`response missing user`) or lists the device without both its keys (`response missing device keys`). Nothing has been published or saved. A `401` means the access token is no longer valid: rotate the device with the reauth playbook. A `403` means the account is refused: check it in the Synapse admin API. For anything else, check homeserver reachability and Synapse health, then restart, and do **not** rotate the device: this is not a mismatch. |
| `Matrix capture stopping: incoming crypto processing failed` | 1 | Processing a sync's crypto data failed. Saves are disabled (`snapshot saves disabled: incoming crypto processing failed`), no further `/sync` is sent, and the service exits without a final save. The unacknowledged to-device messages are redelivered after the restart. |
| `Matrix sync held: snapshot save failed: <error>` then `Matrix capture stopping: snapshot save failed: <error>` | 1 | The save after a to-device sync failed for good; the next `/sync` is never sent. |
| `Matrix IndexedDB snapshot save failed (<reason>; <n> consecutive): <error>` | — | A save failed. Logged at `warn`, and at `error` from the 3rd consecutive failure. A publish waiting on that save stays unsent and the SDK retries it. |
| `Matrix capture stopping: snapshot saves failing for <seconds>s` | 1 | Saves have failed continuously for 10 minutes. Restarting from the last durable snapshot is safe. |
| `Matrix capture shutdown timeout; exiting 1` / `Matrix capture shutdown save-failed; exiting 1` | 1 | Shutdown did not finish within 20 s, or its final save failed. |
| `received SIGTERM during startup; exiting` (or `SIGINT`) | 1 | A stop signal arrived before startup finished, for example while `/keys/query` was stalled. The startup gate was still closed, so nothing had been published or saved. |
| `Matrix capture stopping: event loop drained before shutdown (a startup step never completed)` | 1 | A startup step waited on something that can never arrive (for example a crypto request held at the startup gate), so nothing was left to run. Without this line node would exit 0 and not be restarted. |

Startup also logs `no snapshot; starting with an empty crypto store` (warn) when there is no snapshot file, and `device not known to homeserver; new device` when the homeserver has no keys for the device yet; neither is an error.

Decryption problems are always logged, independent of `MATRIX_TIMELINE_DEBUG`: `Matrix decryption failed { eventId, roomId, sender }` (warn, once per event) and `Giving up decryption retry for <event> in <room> after <n> attempts` (warn).

## Tests

Node 20 is required for the tests (the reference runtime is `node:20-bookworm-slim`). matrix-js-sdk and its WASM crypto are imported as ESM, and those imports fail under tsx on newer Node releases. Run the suite in a Node 20 container from this folder after `npm ci`:

```bash
docker run --rm -v "$PWD":/app:ro -w /app -e HOME=/tmp node:20-bookworm-slim node --import tsx --test *.test.ts
```

`npm run typecheck` runs locally on any Node version.

## Multi-User Note

This long-running E2EE service should be treated as single-tenant.

- One Matrix user or bot identity should have one dedicated service instance
- Each service instance should have its own environment variables, crypto store, and persistent volume
- If two people on the same host both want Matrix capture, run two separate Compose services or two separate Compose projects

Do not point multiple Matrix users at the same long-running service instance. The correct isolation boundary for encrypted capture is one persistent Matrix client/device per user.

## Tool Surface Area

This integration captures content into Open Brain but does not add MCP tools on its own. If you extend it with custom tools later, review the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md).
