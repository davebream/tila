import { readFile } from "node:fs/promises";
import { QueueExecutor, TilaApiError, createTila } from "tila-sdk";
import { ProcessAdapter } from "./process-adapter.mjs";

// Configuration is an explicit file. Secrets are read from the environment.
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const tila = await createTila(config.project, process.env.TILA_API_TOKEN, {
  participantId: config.participant_id,
});
const executor = new QueueExecutor(tila, new ProcessAdapter(config.process), {
  principalId: config.principal_id,
  participantId: config.participant_id,
  capabilities: config.capabilities ?? [],
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const existing = await executor.recoverable();
  let ids = existing.map((attempt) => attempt.id);
  if (ids.length === 0) {
    const claim = await executor.claim({
      idempotency_key: crypto.randomUUID(),
    });
    if (claim.kind === "granted") ids = [claim.attempt.id];
    else console.log(JSON.stringify(claim));
  }
  while (ids.length && !controller.signal.aborted) {
    const pending = [];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const result = await executor.step(id, controller.signal);
          console.log(JSON.stringify(result));
          if (!["terminal", "uncertain"].includes(result.attempt.state))
            pending.push(id);
        } catch (error) {
          if (
            error instanceof TilaApiError &&
            error.code === "queue-precondition"
          ) {
            pending.push(id); // Concurrent intent changed: inspect again on the next poll.
          } else throw error;
        }
      }),
    );
    ids = pending;
    if (ids.length) await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  tila.close();
}
