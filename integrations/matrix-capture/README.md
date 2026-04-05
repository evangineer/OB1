# Matrix Capture

> Capture messages from encrypted or unencrypted Matrix rooms into Open Brain using a long-running `matrix-js-sdk` service.

## What It Does

This integration runs a persistent Matrix client, enables Rust crypto through `matrix-js-sdk`, listens for room timeline events, and writes captured messages into the `thoughts` table with embeddings and extracted metadata.

This is the correct architecture if encrypted rooms matter. The Matrix SDK documentation says `initRustCrypto()` normally uses IndexedDB and that outside the browser you otherwise fall back to `useIndexedDB: false`, which is an ephemeral in-memory store. That makes short-lived Edge Functions a poor fit for E2EE device state. This integration therefore uses a long-running capture service instead of making E2EE claims on top of a stateless function.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- A Matrix homeserver you control or can administer
- A Matrix bot user with access to the rooms you want to capture
- A deployment runtime that provides persistent `indexedDB` storage to the service process
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

This integration uses a long-running service model: one Matrix client, one persistent crypto store, one device identity. That aligns with the SDK's thread-safety and storage requirements for Rust crypto.

`✅ **Done when:**` you are planning to run exactly one long-lived capture process per Matrix device/crypto database.

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

`✅ **Done when:**` your deployment repo runs `service.ts` as a long-lived process and preserves its local crypto database across restarts.

![Step 3.1](https://img.shields.io/badge/3.1-Docker_Compose-555?style=for-the-badge&labelColor=00897B)

If Docker Compose is your standard target, this folder now includes:

- [`Dockerfile`](./Dockerfile)
- [`docker-compose.yml`](./docker-compose.yml)
- [`env.matrix-capture.example`](./env.matrix-capture.example)

The Dockerfile now defaults to the GitGuardian Wolfi Node image (`ghcr.io/gitguardian/wolfi/node`). The container mounts `/data` as a named volume. The service uses `indexeddbshim` to provide persistent IndexedDB-backed crypto storage at `/data/indexeddb`, which is what makes the long-lived E2EE client model workable in a Node container.

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

`✅ **Done when:**` the `matrix-capture` container is running and the named volume persists the crypto store across restarts.

## Acceptance Criteria

Use this checklist before calling the deployment good:

- The image builds successfully from the Wolfi-based [`Dockerfile`](./Dockerfile) with `docker compose up -d --build`
- The container starts without `npm install` errors or module resolution failures
- Service logs show `Matrix client prepared`
- Service logs do not show IndexedDB initialization failures
- The container can write to `MATRIX_INDEXEDDB_PATH` and `/data/indexeddb` persists across restart
- Restarting the container does not create a fresh Matrix device or lose crypto continuity
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

Look for `Matrix client prepared` and absence of IndexedDB startup errors.

**3. Confirm the crypto store path exists in the container:**
```bash
docker compose exec matrix-capture ls -la /data/indexeddb
```

**4. Restart and verify persistence:**
```bash
docker compose restart matrix-capture
docker compose logs -f matrix-capture
```

The service should come back without behaving like a brand-new Matrix device.

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
- `MATRIX_CRYPTO_DB_PREFIX` to name the IndexedDB crypto store
- `MATRIX_CRYPTO_STORE_PASSWORD` to encrypt the local IndexedDB crypto store
- `MATRIX_INDEXEDDB_PATH` for the persistent IndexedDB storage path inside the container or host
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

**Issue: The process exits with an IndexedDB error**
Solution: Confirm the container has write access to `/data/indexeddb` and that the named volume is mounted. This Compose setup uses `indexeddbshim` to back IndexedDB with persistent on-disk storage inside the container.

**Issue: The Wolfi image builds but the container fails during `npm install`**
Solution: Inspect the build output from `docker compose up --build`. The acceptance test for the Wolfi switch is simply that dependency installation and container startup succeed in your environment. If a native dependency in the `indexeddbshim` path fails under Wolfi, adjust the image or dependency path in your deployment repo before relying on it for encrypted capture.

**Issue: The service sees encrypted events but never captures them**
Solution: Verify the bot device from a trusted Matrix client and confirm it has actually received the Megolm session keys for that room. Without device trust and room keys, the SDK cannot decrypt the message payload.

**Issue: The service starts but cannot unlock secret storage**
Solution: Provide one of `MATRIX_SECRET_STORAGE_KEY_BASE64`, `MATRIX_SECRET_STORAGE_KEY`, or `MATRIX_SECRET_STORAGE_PASSPHRASE`. The passphrase path depends on the secret-storage key metadata returned by the homeserver.

**Issue: Inserts fail after decryption succeeds**
Solution: Check `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, and your `thoughts` table permissions. Decryption and database writes are separate stages.

## Runtime Notes

- [`service.ts`](./service.ts) is the E2EE-capable path. It initializes Rust crypto with `initRustCrypto({ useIndexedDB: true, ... })`, which matches the Matrix SDK guidance for persistent crypto state.
- In the Docker Compose path, [`service.ts`](./service.ts) bootstraps `indexeddbshim` when native `indexedDB` is unavailable, storing the crypto DB under `MATRIX_INDEXEDDB_PATH`.
- [`index.ts`](./index.ts) is still useful as a stateless polling example for unencrypted rooms, but it should not be used as the primary design when encrypted capture matters.

## Multi-User Note

This long-running E2EE service should be treated as single-tenant.

- One Matrix user or bot identity should have one dedicated service instance
- Each service instance should have its own environment variables, crypto store, and persistent volume
- If two people on the same host both want Matrix capture, run two separate Compose services or two separate Compose projects

Do not point multiple Matrix users at the same long-running service instance. The correct isolation boundary for encrypted capture is one persistent Matrix client/device per user.

## Tool Surface Area

This integration captures content into Open Brain but does not add MCP tools on its own. If you extend it with custom tools later, review the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md).
