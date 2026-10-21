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

// Network-failure detail for a refusal: the error's message plus its cause's code (or message).
// Never includes request headers, so the access token cannot leak.
function fetchErrorDetail(err: unknown): string {
  const message = errMessage(err);
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return message;
  const code = (cause as { code?: unknown }).code;
  const detail = typeof code === "string" && code ? code : errMessage(cause);
  return detail && detail !== message ? `${message} (${detail})` : message;
}

export async function fetchServerDeviceKeys(p: {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId: string;
  fetchImpl?: typeof fetch;
  /** Bounds the whole request, body included; a stalled homeserver must not hang startup. */
  timeoutMs?: number;
}): Promise<Record<string, string> | undefined> {
  const prefix = "refusing to start: G1 could not verify device keys";
  const doFetch = p.fetchImpl ?? fetch;
  const timeoutMs = p.timeoutMs ?? 30_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const fail = (err: unknown): Error =>
    new Error(`${prefix}: ${signal.aborted ? `timeout after ${timeoutMs}ms` : fetchErrorDetail(err)}`);
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
      signal,
    });
  } catch (err) {
    throw fail(err);
  }
  if (!res.ok) {
    throw new Error(`${prefix}: ${res.status}`);
  }
  let body: { device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>> };
  try {
    body = await res.json();
  } catch (err) {
    throw fail(err);
  }
  // Fail closed: a response that does not list the user proves nothing about the device.
  const devices = body?.device_keys?.[p.userId];
  if (!devices || typeof devices !== "object") {
    throw new Error(`${prefix}: response missing user`);
  }
  // Synapse omits devices that have not uploaded keys: that is a new device (the reauth path).
  const device = devices[p.deviceId];
  if (device === undefined) return undefined;
  const keys = device?.keys;
  if (
    !keys ||
    typeof keys[`ed25519:${p.deviceId}`] !== "string" ||
    typeof keys[`curve25519:${p.deviceId}`] !== "string"
  ) {
    throw new Error(`${prefix}: response missing device keys`);
  }
  return { ...keys };
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
