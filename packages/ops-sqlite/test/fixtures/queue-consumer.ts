import { existsSync } from "node:fs";
import {
  type EmbeddedDb,
  EmbeddedProject,
} from "../../../backend-embedded/src/index";
import * as schema from "../../src/schema";

const [file, barrier, participant] = process.argv.slice(2);
const isBun = "Bun" in globalThis;
const raw = isBun
  ? new (await import("bun:sqlite")).Database(file)
  : new (await import("better-sqlite3")).default(file);
raw.exec("PRAGMA busy_timeout = 10");
const db = isBun
  ? (await import("drizzle-orm/bun-sqlite")).drizzle(raw as never, { schema })
  : (await import("drizzle-orm/better-sqlite3")).drizzle(raw as never, {
      schema,
    });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const project = new EmbeddedProject({
  db: db as unknown as EmbeddedDb,
  org: "fixture",
  project: "fixture",
  identity: {
    principal_id: participant,
    participant_id: participant,
    environment: {},
  },
  sleepSync: (ms) => {
    Atomics.wait(sleeper, 0, 0, ms);
  },
  close: () => raw.close(),
});
process.stdout.write("ready\n");
while (!existsSync(barrier)) Atomics.wait(sleeper, 0, 0, 2);
const grants: string[] = [];
for (let i = 0; i < 50; i++) {
  const result = await project.queue.claimNext({
    idempotency_key: `${participant}-${i}`,
  });
  if (result.kind === "granted") grants.push(result.attempt.id);
}
project.close();
process.stdout.write(`${JSON.stringify({ grants })}\n`);
