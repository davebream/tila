import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReentryResponseSchema } from "@tila/schemas";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  Lifecycle,
  processAlive,
  processIdentity,
  reentryContext,
} from "../src/index";
import { harness } from "./helpers";

let root: string;
let h: ReturnType<typeof harness>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tila-lifecycle-"));
  h = harness(root);
});
afterEach(() => {
  h.close();
  rmSync(root, { recursive: true, force: true });
});
const event = (id: string) => ({
  session_id: id,
  cwd: process.cwd(),
  hook_event_name: "SessionStart" as const,
});
const start = (id = "one") =>
  h.lifecycle.start("codex", event(id), processIdentity(process.pid), {
    client_name: "codex",
  });
async function finish(key: string, generation: string) {
  for (let i = 0; i < 10; i++)
    if (!(await h.lifecycle.tick(key, generation, true))) return;
  throw new Error("Cleanup did not finish");
}

it("isolates concurrent sessions and makes duplicate starts and ends idempotent", async () => {
  const [one, duplicate, two] = await Promise.all([
    start(),
    start(),
    start("two"),
  ]);
  expect(one.state.participantId).toBe(duplicate.state.participantId);
  expect(one.state.participantId).not.toBe(two.state.participantId);
  const api = await h.facade(one.state);
  await api.claims.acquire("task:one", "exclusive", 60_000);
  await api.claims.acquire("task:owned", "owner", 60_000);
  await h.lifecycle.end(one.state.key);
  const intent = h.store.read(one.state.key)?.pendingHandoff;
  await h.lifecycle.end(one.state.key);
  expect(h.store.read(one.state.key)?.pendingHandoff).toEqual(intent);
  await finish(one.state.key, one.state.generation);
  expect((await api.handoffs.list()).handoffs).toHaveLength(1);
  expect((await api.claims.get("task:one")).claim).toBeNull();
  expect((await api.claims.get("task:owned")).claim?.mode).toBe("owner");
  expect(h.store.read(two.state.key)?.phase).toBe("active");
  const resumed = await start();
  expect(resumed.state.participantId).toBe(one.state.participantId);
  expect(resumed.state.generation).not.toBe(one.state.generation);
  expect(
    await h.lifecycle.tick(one.state.key, one.state.generation, false),
  ).toBe(false);
  expect(h.store.read(one.state.key)?.phase).toBe("active");
});

it("retries an ambiguous handoff response with the same immutable request", async () => {
  const { state } = await start();
  const api = await h.facade(state);
  let loseResponse = true;
  const requests: unknown[] = [];
  const lifecycle = new Lifecycle(h.store, "test", async () => ({
    ...api,
    handoffs: {
      ...api.handoffs,
      create: async (input) => {
        requests.push(structuredClone(input));
        const saved = await api.handoffs.create(input);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("connection lost after commit");
        }
        return saved;
      },
    },
  }));
  await lifecycle.end(state.key);
  await lifecycle.tick(state.key, state.generation, true);
  expect(h.store.read(state.key)?.degraded).toContain("Shutdown incomplete");
  expect((await api.journal.getCursor()).cursor.seq).toBe(0);
  await lifecycle.tick(state.key, state.generation, true);
  expect(requests[1]).toEqual(requests[0]);
  await finish(state.key, state.generation);
  expect((await api.handoffs.list()).handoffs).toHaveLength(1);
});

it("does not release a successor claim when cleanup resumes with a stale fence", async () => {
  const one = await start();
  const two = await start("two");
  const a = await h.facade(one.state);
  const b = await h.facade(two.state);
  const original = await a.claims.acquire("task:shared", "exclusive", 60_000);
  await h.lifecycle.end(one.state.key);
  await h.lifecycle.tick(one.state.key, one.state.generation, true); // save snapshot
  await a.claims.release("task:shared", original.fence);
  const successor = await b.claims.acquire("task:shared", "exclusive", 60_000);
  await finish(one.state.key, one.state.generation);
  expect((await b.claims.get("task:shared")).claim?.fence).toBe(
    successor.fence,
  );
});

it("acknowledges only context confirmed by a later hook", async () => {
  const first = await start();
  const api = await h.facade(first.state);
  await api.claims.acquire("task:context", "exclusive", 60_000);
  const offered = await start();
  expect(offered.state.offeredSeq).toBeGreaterThan(0);
  expect(offered.state.observedSeq).toBe(0);
  await h.lifecycle.observe(offered.state.key);
  await h.lifecycle.end(offered.state.key);
  await finish(offered.state.key, offered.state.generation);
  expect((await api.journal.getCursor()).cursor.seq).toBe(
    offered.state.offeredSeq,
  );
  const response = ReentryResponseSchema.parse(
    await api.reentry({ after_seq: 0 }),
  );
  response.changes.events[0].payload = { large: "x".repeat(9000) };
  expect(reentryContext(response, 0, offered.state.participantId).seq).toBe(0);
});

it("keeps offline starts usable and exposes degraded state without secrets", async () => {
  const lifecycle = new Lifecycle(h.store, "test", async () => {
    throw new Error("secret-token");
  });
  const result = await lifecycle.start("codex", event("offline"), null, {});
  expect(result.text).toContain("degraded");
  expect(result.text).not.toContain("secret-token");
  expect(h.store.read(result.state.key)?.phase).toBe("active");
});

it("runs two client processes and expires a killed client's lease without fake cleanup", async () => {
  // Child processes own session identity; the monitor survives their termination.
  const launch = async (id: string) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./fixtures/client.ts", import.meta.url).pathname,
        root,
        id,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const [message] = await once(child, "message");
    return { child, state: JSON.parse(String(message)) };
  };
  const [one, two] = await Promise.all([
    launch("process-one"),
    launch("process-two"),
  ]);
  try {
    expect(one.state.participantId).not.toBe(two.state.participantId);
    const a = await h.facade(one.state);
    const b = await h.facade(two.state);
    await a.claims.acquire("task:crash", "exclusive", 100);
    await b.claims.acquire("task:live", "exclusive", 60_000);
    await h.lifecycle.tick(one.state.key, one.state.generation, true);
    const exited = once(one.child, "exit");
    one.child.kill("SIGKILL");
    await exited;
    await h.lifecycle.tick(
      one.state.key,
      one.state.generation,
      processAlive(one.state.owner),
    );
    await h.lifecycle.tick(
      two.state.key,
      two.state.generation,
      processAlive(two.state.owner),
    );
    expect(h.store.read(one.state.key)?.phase).toBe("crashed");
    expect(h.store.read(two.state.key)?.lastHeartbeat).toBeTypeOf("number");
    expect((await a.handoffs.list()).handoffs).toHaveLength(0);
    expect((await a.journal.getCursor()).cursor.seq).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await a.claims.get("task:crash")).claim).toBeNull();
    expect((await b.claims.get("task:live")).claim?.participant_id).toBe(
      two.state.participantId,
    );
    await h.lifecycle.end(two.state.key);
    await finish(two.state.key, two.state.generation);
    expect((await b.handoffs.list()).handoffs).toHaveLength(1);
  } finally {
    for (const { child } of [one, two])
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
  }
}, 15_000);

it("does not mistake successful presence for recovered re-entry context", async () => {
  const { state } = await start();
  const api = await h.facade(state);
  const lifecycle = new Lifecycle(h.store, "test", async () => ({
    ...api,
    reentry: async () => {
      throw new Error("archive unavailable");
    },
  }));
  const failed = await lifecycle.start(
    "codex",
    event("one"),
    processIdentity(process.pid),
    {},
  );
  expect(failed.state.reentryPending).toBe(true);
  await lifecycle.tick(state.key, state.generation, true);
  expect(h.store.read(state.key)?.degraded).toContain("re-entry is pending");
  expect(h.store.read(state.key)?.reentryPending).toBe(true);
  expect((await start()).state.reentryPending).toBe(false);
});

it("honors a clean end event that arrives just after the liveness monitor", async () => {
  const { state } = await start();
  await h.lifecycle.tick(state.key, state.generation, false);
  await h.lifecycle.end(state.key);
  expect(h.store.read(state.key)?.phase).toBe("closing");
  await finish(state.key, state.generation);
  expect(h.store.read(state.key)?.phase).toBe("closed");
});
