// Runs in a worker thread (plain Node type stripping, not Vitest) to claim from a shared DB file.
import { parentPort, workerData } from "node:worker_threads";
import { openCoreDatabase } from "./db/database.ts";
import { claim } from "./queue.ts";

const { path, workerId, barrier, parties } = workerData as {
  path: string;
  workerId: string;
  barrier: SharedArrayBuffer;
  parties: number;
};
// Start barrier: without it the first worker drains the queue before the others exist.
// Opening after the barrier also exercises concurrent open + migrate.
const ready = new Int32Array(barrier);
Atomics.add(ready, 0, 1);
Atomics.notify(ready, 0);
for (let n = Atomics.load(ready, 0); n < parties; n = Atomics.load(ready, 0)) {
  Atomics.wait(ready, 0, n, 1000);
}
const db = openCoreDatabase(path);

// Simulated work between claims; a tight loop starves the others in SQLite's busy back-off.
const work = new Int32Array(new SharedArrayBuffer(4));
const claimed: string[] = [];
for (;;) {
  const task = claim(db, { workerId, leaseMs: 60_000 });
  if (!task) break;
  claimed.push(task.id);
  Atomics.wait(work, 0, 0, 2);
}
db.close();
parentPort?.postMessage(claimed);
