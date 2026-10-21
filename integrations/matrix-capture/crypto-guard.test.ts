import assert from "node:assert/strict";
import test from "node:test";
import {
  StartupGate,
  checkDeviceIdentity,
  decideStartup,
  fetchServerDeviceKeys,
} from "./crypto-guard.js";

const userId = "@u:example.org";
const deviceId = "DEV";
const local = { ed25519: "LOCALED", curve25519: "LOCALCURVE" };

test("decideStartup", () => {
  assert.deepEqual(decideStartup({ status: "restored", databases: 1 }), { ok: true });
  assert.deepEqual(decideStartup({ status: "absent" }), {
    ok: true,
    note: "no snapshot; starting with an empty crypto store",
  });
  const v = decideStartup({ status: "failed", error: new Error("boom") });
  assert.deepEqual(v, { ok: false, reason: "refusing to start: G2 restore failed: boom" });
});

test("checkDeviceIdentity", () => {
  const absent = checkDeviceIdentity({ userId, deviceId, local, server: undefined });
  assert.equal(absent.ok, true);
  assert.match((absent as { note?: string }).note ?? "", /new device/);
  assert.deepEqual(
    checkDeviceIdentity({
      userId,
      deviceId,
      local,
      server: { "ed25519:DEV": "LOCALED", "curve25519:DEV": "LOCALCURVE" },
    }),
    { ok: true },
  );
  const bad = checkDeviceIdentity({
    userId,
    deviceId,
    local,
    server: { "ed25519:DEV": "SRVED", "curve25519:DEV": "LOCALCURVE" },
  });
  assert.deepEqual(bad, {
    ok: false,
    reason: `refusing to start: G1 device-key mismatch for ${userId}/${deviceId}; local crypto store does not match the homeserver; see RUNBOOK "Matrix device reauth"`,
  });
  assert.ok(!JSON.stringify(bad).includes("SRVED") && !JSON.stringify(bad).includes("LOCALED"));
});

const base = { homeserverUrl: "https://hs.example", accessToken: "SECRETTOKEN", userId, deviceId };

test("fetchServerDeviceKeys returns keys and sends the right request", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({ device_keys: { [userId]: { [deviceId]: { keys: { "ed25519:DEV": "a", "curve25519:DEV": "b" } } } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const keys = await fetchServerDeviceKeys({ ...base, fetchImpl });
  assert.deepEqual(keys, { "ed25519:DEV": "a", "curve25519:DEV": "b" });
  assert.equal(seen?.url, "https://hs.example/_matrix/client/v3/keys/query");
  assert.equal(seen?.init.method, "POST");
  assert.deepEqual(JSON.parse(seen?.init.body as string), { device_keys: { [userId]: [deviceId] } });
  assert.equal((seen?.init.headers as Record<string, string>).Authorization, "Bearer SECRETTOKEN");
});

test("fetchServerDeviceKeys returns undefined when device is absent", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ device_keys: { [userId]: {} } }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchServerDeviceKeys({ ...base, fetchImpl }), undefined);
});

test("fetchServerDeviceKeys throws on non-2xx without leaking the token", async () => {
  const fetchImpl = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchServerDeviceKeys({ ...base, fetchImpl }),
    (e: Error) =>
      e.message === "refusing to start: G1 could not verify device keys: 502" &&
      !e.message.includes("SECRETTOKEN"),
  );
});

test("fetchServerDeviceKeys throws on network failure", async () => {
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  await assert.rejects(
    fetchServerDeviceKeys({ ...base, fetchImpl }),
    /^Error: refusing to start: G1 could not verify device keys: ECONNREFUSED$/,
  );
});

test("StartupGate.wait stays pending until open", async () => {
  const gate = new StartupGate();
  let resolved = false;
  const p = gate.wait().then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);
  assert.equal(gate.isOpen, false);
  gate.open();
  await p;
  assert.equal(resolved, true);
  assert.equal(gate.isOpen, true);
  await gate.wait();
});
