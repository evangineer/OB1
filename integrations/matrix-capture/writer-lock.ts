import { spawnSync, type StdioOptions } from "node:child_process";
import fs from "node:fs";

const NOT_HELD = "refusing to start: G4 not running under the writer lock";
const CANNOT_CHECK = "refusing to start: G4 cannot check writer lock: ";

/**
 * G4: proves this process holds the writer lock through its own inherited fd
 * (taken by entrypoint.sh), not merely that somebody holds it.
 */
export function assertRunningUnderWriterLock(lockPath: string, fd: number = 9): void {
  if (!Number.isInteger(fd) || fd < 3) {
    throw new Error(`${CANNOT_CHECK}invalid fd ${fd}`);
  }

  // 1. fd open
  let held: fs.Stats;
  try {
    held = fs.fstatSync(fd);
  } catch {
    throw new Error(NOT_HELD);
  }

  // 2. same file
  let onDisk: fs.Stats;
  try {
    onDisk = fs.statSync(lockPath);
  } catch {
    throw new Error(NOT_HELD);
  }
  if (held.dev !== onDisk.dev || held.ino !== onDisk.ino) {
    throw new Error(NOT_HELD);
  }

  // 3. we hold it: flock on our own open file description, passed as the same fd number.
  // It succeeds if our description holds LOCK_EX and fails (1) if another description does.
  const stdio: StdioOptions = ["ignore", "ignore", "pipe", ...Array<"ignore">(fd - 3).fill("ignore"), fd];
  const r = spawnSync("flock", ["-n", String(fd)], { stdio, encoding: "utf8", timeout: 10_000 });
  if (r.error) {
    throw new Error(`${CANNOT_CHECK}${r.error.message}`);
  }
  if (r.status === 0) return;
  if (r.status === 1) throw new Error(NOT_HELD);
  const detail = r.signal ? `flock killed by ${r.signal}` : `flock exited ${r.status}`;
  const stderr = (r.stderr ?? "").trim();
  throw new Error(`${CANNOT_CHECK}${detail}${stderr ? `: ${stderr}` : ""}`);
}

/** Removes the pre-G4 mkdir-style `<snapshotPath>.lock/` directory, if present. */
export function removeLegacyLockDirs(snapshotPath: string, log: Pick<Console, "warn">): void {
  const legacy = `${snapshotPath}.lock`;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(legacy);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!st.isDirectory()) return;
  log.warn(`removing legacy snapshot lock ${legacy} (mtime ${st.mtime.toISOString()})`);
  fs.rmSync(legacy, { recursive: true, force: true });
}
