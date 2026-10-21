// G1/G2/G7: the gated startup sequence. Everything is injected so the ordering is testable:
// no crypto request may reach the network before the device-key check passes.
import { checkDeviceIdentity, decideStartup, StartupGate } from "./crypto-guard.js";
import type { RestoreResult } from "./idb-persistence.js";

export type StartupDeps = {
  assertWriterLock: () => void;
  removeLegacyLocks: () => void;
  restore: () => Promise<RestoreResult>;
  installHooks: (gate: StartupGate) => void;
  initCrypto: () => Promise<void>;
  ownDeviceKeys: () => Promise<{ ed25519: string; curve25519: string }>;
  serverDeviceKeys: () => Promise<Record<string, string> | undefined>;
  ids: { userId: string; deviceId: string };
  log: Pick<Console, "log" | "warn">;
};

export async function runStartup(deps: StartupDeps): Promise<{ gate: StartupGate }> {
  deps.assertWriterLock();
  deps.removeLegacyLocks();

  const restored = await deps.restore();
  const decision = decideStartup(restored);
  if (!decision.ok) throw new Error(decision.reason);
  if (decision.note) deps.log.warn(decision.note);

  // The gate stays closed (and the hooks hold every crypto request) until G1 passes.
  const gate = new StartupGate();
  deps.installHooks(gate);
  await deps.initCrypto();

  const local = await deps.ownDeviceKeys();
  const server = await deps.serverDeviceKeys();
  const identity = checkDeviceIdentity({ ...deps.ids, local, server });
  if (!identity.ok) throw new Error(identity.reason);
  if (identity.note) deps.log.log(identity.note);

  gate.open();
  return { gate };
}
