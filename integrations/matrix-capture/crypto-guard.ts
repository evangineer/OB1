import type { RestoreResult } from "./idb-persistence.js";

export type Verdict = { ok: true; note?: string } | { ok: false; reason: string };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function decideStartup(restore: RestoreResult): Verdict {
  switch (restore.status) {
    case "restored":
      return { ok: true };
    case "absent":
      return { ok: true, note: "no snapshot; starting with an empty crypto store" };
    case "failed":
      return { ok: false, reason: `refusing to start: G2 restore failed: ${errMessage(restore.error)}` };
  }
}

export function checkDeviceIdentity(p: {
  userId: string;
  deviceId: string;
  local: { ed25519: string; curve25519: string };
  server: Record<string, string> | undefined;
}): Verdict {
  if (!p.server) {
    return { ok: true, note: "device not known to homeserver; new device" };
  }
  if (
    p.server[`ed25519:${p.deviceId}`] === p.local.ed25519 &&
    p.server[`curve25519:${p.deviceId}`] === p.local.curve25519
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `refusing to start: G1 device-key mismatch for ${p.userId}/${p.deviceId}; local crypto store does not match the homeserver; see RUNBOOK "Matrix device reauth"`,
  };
}

export async function fetchServerDeviceKeys(p: {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, string> | undefined> {
  const prefix = "refusing to start: G1 could not verify device keys";
  const doFetch = p.fetchImpl ?? fetch;
  const url = `${p.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/keys/query`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_keys: { [p.userId]: [p.deviceId] } }),
    });
  } catch (err) {
    throw new Error(`${prefix}: ${errMessage(err)}`);
  }
  if (!res.ok) {
    throw new Error(`${prefix}: ${res.status}`);
  }
  let body: { device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>> };
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`${prefix}: ${errMessage(err)}`);
  }
  const keys = body.device_keys?.[p.userId]?.[p.deviceId]?.keys;
  return keys ? { ...keys } : undefined;
}

export class StartupGate {
  #open = false;
  #waiters: Array<() => void> = [];

  get isOpen(): boolean {
    return this.#open;
  }

  wait(): Promise<void> {
    if (this.#open) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  open(): void {
    this.#open = true;
    for (const w of this.#waiters.splice(0)) w();
  }
}
