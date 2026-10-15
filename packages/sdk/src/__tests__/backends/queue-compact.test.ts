import { describe, expect, it, vi } from "vitest";
import { RemoteQueueBackend } from "../../backends/queue";
import type { TilaClient } from "../../client";

const entry = {
  id: "entry-1",
  task_id: "task-1",
  state: "queued",
  priority: 0,
  enqueue_order: 1,
  required_capabilities: [],
  target_principal: null,
  retry_policy: {
    retry_safe: false,
    max_attempts: 3,
    initial_backoff_ms: 5_000,
    max_backoff_ms: 300_000,
  },
  revision: 1,
  available_at: 0,
  created_at: 0,
  updated_at: 0,
  enrolled_by_principal: null,
  enrolled_by_participant: null,
};
const inspection = (task: unknown) => ({
  policy: {
    enabled: true,
    paused: false,
    execution_limit: 1,
    wip_limit: null,
    lease_ms: 60_000,
    revision: 1,
  },
  counts: {
    backlog: 1,
    active: 0,
    suspended: 0,
    uncertain: 0,
    terminal: 0,
    execution: 0,
    wip: 0,
    oldest_waiting_age_ms: 0,
  },
  entries: [{ entry, task, attempt: null, block_reasons: [] }],
  total: 1,
  limit: 100,
  offset: 0,
  effective_capabilities: [],
});
function backend(result: unknown) {
  const get = vi.fn(async () => ({ result }));
  const client = { get } as unknown as TilaClient;
  return { get, queue: new RemoteQueueBackend(client, "project one") };
}
const path = "/projects/project%20one/queue";

describe("RemoteQueueBackend.inspect compact", () => {
  it("sends compact only when the caller set it, as the literal true or false", async () => {
    const { get, queue } = backend(inspection(null));
    await queue.inspect({ limit: 10 });
    await queue.inspect({ compact: true });
    await queue.inspect({ compact: false, state: "backlog" });
    expect(get.mock.calls).toEqual([
      [path, { query: { limit: "10" } }],
      [path, { query: { compact: "true" } }],
      [path, { query: { compact: "false", state: "backlog" } }],
    ]);
  });

  it("parses a compact response strictly, keeping exactly {id, type, data}", async () => {
    const task = {
      id: "task-1",
      type: "issue",
      data: { phase: "todo", title: "Work" },
    };
    const { queue } = backend(inspection(task));
    const parsed = await queue.inspect({ compact: true });
    expect(parsed.entries[0].task).toEqual(task);
    // Nothing was stripped, so the server's shape is the declared one.
    expect(parsed).toEqual(inspection(task));
  });

  it("accepts a compact task whose title and state fields are absent", async () => {
    const task = { id: "task-1", type: "issue", data: {} };
    const { queue } = backend(inspection(task));
    expect((await queue.inspect({ compact: true })).entries[0].task).toEqual(
      task,
    );
  });

  it("still rejects a task without its data object", async () => {
    const { queue } = backend(inspection({ id: "task-1", type: "issue" }));
    await expect(queue.inspect({ compact: true })).rejects.toThrow();
  });
});
