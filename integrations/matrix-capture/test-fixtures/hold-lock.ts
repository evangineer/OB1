// Test fixture: asserts it runs under the writer lock, prints HELD, then idles until killed.
import path from "node:path";
import { assertRunningUnderWriterLock } from "../writer-lock.js";

const dir = process.env.MATRIX_INDEXEDDB_PATH || "/data/indexeddb";
try {
  assertRunningUnderWriterLock(path.join(dir, ".writer.lock"));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
console.log("HELD");
setInterval(() => {}, 1 << 30);
