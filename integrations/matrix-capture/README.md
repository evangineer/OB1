# Matrix Capture

> Capture messages from encrypted or unencrypted Matrix rooms into Open Brain using a long-running `matrix-js-sdk` service.

## What It Does

This integration runs a persistent Matrix client, enables Rust crypto through `matrix-js-sdk`, listens for room timeline events, and writes captured messages into the `thoughts` table with embeddings and extracted metadata.

This is the correct architecture if encrypted rooms matter. The Matrix SDK documentation says `initRustCrypto()` normally uses IndexedDB and that outside the browser you otherwise fall back to `useIndexedDB: false`, which is an ephemeral in-memory store. That makes short-lived Edge Functions a poor fit for E2EE device state. This integration therefore uses a long-running capture service instead of making E2EE claims on top of a stateless function.

In practice, generic Node/container deployments should default to `MATRIX_USE_INDEXEDDB=false`. Only enable IndexedDB if you have validated a persistent IndexedDB runtime that works reliably with the Matrix SDK Rust crypto path. Without IndexedDB, restarts should recover crypto state from Matrix secret storage and key backup rather than from a local crypto database.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Matrix homeserver you control or can administer
- A Matrix bot user with access to the rooms you want to capture
- Node.js 20+ or another runtime compatible with this service wrapper
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
npm install
```

**2. Start the service:**
```bash
npm run start
```

The main runtime file is [`service.ts`](./service.ts). The older [`index.ts`](./index.ts) remains as a stateless polling example for unencrypted rooms, but it is not the E2EE path.

`✅ **Done when:**` your deployment repo runs `service.ts` as a long-lived process and can decrypt messages for the trusted Matrix device you configured.

![Step 3.1](https://img.shields.io/badge/3.1-Docker_Compose-555?style=for-the-badge&labelColor=00897B)

If Docker Compose is your standard target, this folder now includes:

- [`Dockerfile`](./Dockerfile)
- [`docker-compose.yml`](./docker-compose.yml)
- [`env.matrix-capture.example`](./env.matrix-capture.example)

The Dockerfile now defaults to a Debian-based Node image. The container still mounts `/data` as a named volume, but the recommended default for generic Node/container deployments is `MATRIX_USE_INDEXEDDB=false`. Only enable IndexedDB storage if you have validated that your runtime supports the Matrix SDK Rust crypto IndexedDB path reliably.

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
- If `MATRIX_USE_INDEXEDDB=true`, the container can write to `MATRIX_INDEXEDDB_PATH` and `/data/indexeddb` persists across restart
- If `MATRIX_USE_INDEXEDDB=false`, restarts rely on Matrix secret storage / key backup rather than local IndexedDB continuity
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

![Step 4](https://img.shields.io/badge/Step_4-Configure_Secrets-00897B?style=for-the-badge)

Set the environment variables your service needs:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `MATRIX_HOMESERVER_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_ROOM_IDS` as a comma-separated allowlist
- `MATRIX_USE_INDEXEDDB` to opt into the IndexedDB-backed Rust crypto path
- `MATRIX_CRYPTO_DB_PREFIX`, `MATRIX_CRYPTO_STORE_PASSWORD`, and `MATRIX_INDEXEDDB_PATH` only if `MATRIX_USE_INDEXEDDB=true`
- One of:
  `MATRIX_SECRET_STORAGE_KEY_BASE64`, `MATRIX_SECRET_STORAGE_KEY`, or `MATRIX_SECRET_STORAGE_PASSPHRASE`
- Optional:
  `MATRIX_AUTOJOIN_INVITES`, `MATRIX_MAX_EVENT_AGE_MS`, `OPENROUTER_BASE`, `EMBEDDING_MODEL`, `CHAT_MODEL`

Example:

```bash
export SUPABASE_URL=https://YOUR_PROJECT.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
export OPENROUTER_API_KEY=your-openrouter-key
export MATRIX_HOMESERVER_URL=https://matrix.example.com
export MATRIX_ACCESS_TOKEN=your-matrix-access-token
export MATRIX_USER_ID=@ob1-bot:example.com
export MATRIX_ROOM_IDS='!roomA:example.com,!roomB:example.com'
export MATRIX_USE_INDEXEDDB=false
export MATRIX_CRYPTO_DB_PREFIX=ob1-matrix-capture
export MATRIX_CRYPTO_STORE_PASSWORD=choose-a-local-store-password
export MATRIX_INDEXEDDB_PATH=/data/indexeddb
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

**Issue: Rust crypto fails during IndexedDB startup in Node**
Solution: Set `MATRIX_USE_INDEXEDDB=false` and restart the service. The Matrix SDK's Node-safe fallback is the in-memory Rust crypto path. Only re-enable IndexedDB after validating that your runtime supports it reliably.

**Issue: Native dependencies fail to build under the container base image**
Solution: Inspect the build output from `docker compose up --build`. If a native dependency in the optional `indexeddbshim` path fails, keep `MATRIX_USE_INDEXEDDB=false` and fix the image or dependency path before relying on IndexedDB-backed crypto continuity.

**Issue: The service sees encrypted events but never captures them**
Solution: Verify the bot device from a trusted Matrix client and confirm it has actually received the Megolm session keys for that room. Without device trust and room keys, the SDK cannot decrypt the message payload.

**Issue: The service starts but cannot unlock secret storage**
Solution: Provide one of `MATRIX_SECRET_STORAGE_KEY_BASE64`, `MATRIX_SECRET_STORAGE_KEY`, or `MATRIX_SECRET_STORAGE_PASSPHRASE`. The passphrase path depends on the secret-storage key metadata returned by the homeserver.

**Issue: Inserts fail after decryption succeeds**
Solution: Check `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, and your `thoughts` table permissions. Decryption and database writes are separate stages.

## Runtime Notes

- [`service.ts`](./service.ts) is the E2EE-capable path. It initializes Rust crypto through `initRustCrypto(...)`.
- In the Docker Compose path, [`service.ts`](./service.ts) defaults to the Node-safe `useIndexedDB: false` path. If `MATRIX_USE_INDEXEDDB=true`, it bootstraps `indexeddbshim` when native `indexedDB` is unavailable and stores the crypto DB under `MATRIX_INDEXEDDB_PATH`.
- [`index.ts`](./index.ts) is still useful as a stateless polling example for unencrypted rooms, but it should not be used as the primary design when encrypted capture matters.

## Persistence Handoff

The current `indexeddbshim`-based persistence path is not reliable in this project. In deployment, enabling `MATRIX_USE_INDEXEDDB=true` caused Rust crypto store startup to fail with `TransactionInactiveError`, while `MATRIX_USE_INDEXEDDB=false` ran successfully but left the device on an ephemeral in-memory crypto store. That ephemeral mode is not durable enough for stable self-verification, one-time-key reuse, or restart-safe E2EE continuity.

The recommended next approach is to replace the current `indexeddbshim` path with the same general persistence model used by OpenClaw's Matrix extension rather than jumping straight to a full Rust rewrite.

### Why this is the preferred next step

- The container already has a persistent volume at `/data`, so the missing piece is not Docker volume persistence.
- The failure is specifically in the Node IndexedDB runtime used by the Matrix SDK Rust crypto path.
- OpenClaw documents a working Node persistence pattern for Matrix E2EE:
  - use `matrix-js-sdk`
  - provide IndexedDB in Node via `fake-indexeddb`
  - restore a persisted IndexedDB snapshot before `initRustCrypto()`
  - save the updated IndexedDB snapshot back to disk during runtime
- This is a smaller and more defensible change than rewriting Matrix capture in Rust immediately.

Reference material:

- OpenClaw Matrix docs: <https://docs.openclaw.ai/channels/matrix>
- OpenClaw Matrix package: <https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/matrix/package.json>

### Proposed implementation outline

1. Remove the current `indexeddbshim`-specific persistence path from [`service.ts`](./service.ts).
2. Add `fake-indexeddb` as the Node-side IndexedDB provider for the Matrix SDK crypto runtime.
3. Introduce a snapshot file under `/data`, for example:
   - `/data/crypto-idb-snapshot.json`
4. On startup, before calling `initRustCrypto(...)`:
   - initialize the fake IndexedDB runtime
   - restore the persisted IndexedDB snapshot into that runtime if the snapshot file exists
5. After crypto initialization and during runtime:
   - persist the updated IndexedDB contents back to the snapshot file
   - write atomically and with restrictive file permissions
6. Keep the existing Matrix secret-storage and backup recovery logic:
   - it still matters for first bootstrap and historical recovery
   - the snapshot is for device continuity, not a replacement for Matrix recovery material
7. Re-test the existing deployment flow with one fresh dedicated Matrix device:
   - verify that restart no longer causes one-time-key collisions
   - verify that SAS verification completes cleanly
   - verify that a newly sent encrypted message is captured after restart

### Acceptance criteria for this approach

- `MATRIX_USE_INDEXEDDB=true` no longer crashes during Rust crypto store startup
- restarting the container does not trigger repeated `/keys/upload` collisions for the same device
- a dedicated capture device can complete self-verification successfully
- encrypted room traffic remains decryptable after restart without re-issuing a new device token
- the snapshot file is stored only on the persistent volume and is treated as sensitive local state

### What not to do next

- Do not spend more time on `indexeddbshim` unless there is a concrete fix for the exact startup failure.
- Do not assume Docker volumes alone solve the problem; volume persistence already exists.
- Do not jump to a Rust rewrite first unless the OpenClaw-style Node persistence model fails in this codebase too.

## Multi-User Note

This long-running E2EE service should be treated as single-tenant.

- One Matrix user or bot identity should have one dedicated service instance
- Each service instance should have its own environment variables, crypto store, and persistent volume
- If two people on the same host both want Matrix capture, run two separate Compose services or two separate Compose projects

Do not point multiple Matrix users at the same long-running service instance. The correct isolation boundary for encrypted capture is one persistent Matrix client/device per user.

## Tool Surface Area

This integration captures content into Open Brain but does not add MCP tools on its own. If you extend it with custom tools later, review the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md).
