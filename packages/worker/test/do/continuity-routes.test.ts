import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContinuityRoutes } from "../../src/do/routes/continuity-routes";
import { installProjectErrorHandlers } from "../../src/do/routes/errors";
import type { RouterDeps } from "../../src/do/routes/types";
import { type TestDb, createTestDb } from "./helpers/create-test-db";

const identity = {
  principal_id: "principal",
  participant_id: "participant",
  environment: {},
};
let fixture: TestDb;
let app: Hono;
beforeEach(() => {
  fixture = createTestDb();
  app = new Hono();
  installProjectErrorHandlers(app);
  app.route(
    "/",
    createContinuityRoutes({
      db: fixture.db as RouterDeps["db"],
      ctx: {} as DurableObjectState,
      enrichOpts: vi.fn(),
    }),
  );
});
afterEach(() => fixture.sqlite.close());
const send = (path: string, method: string, input: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity, input }),
  });
describe("DO continuity routes", () => {
  it("creates once, acknowledges, and reads a coherent re-entry snapshot", async () => {
    const input = {
      id: crypto.randomUUID(),
      summary: "Ready for another runtime",
      based_on_seq: 0,
    };
    const created = await send("/handoffs", "POST", input);
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(await (await send("/handoffs", "POST", input)).json()).toEqual(body);
    expect(
      await (await send("/journal/cursor", "PUT", { seq: 1 })).json(),
    ).toMatchObject({ cursor: { seq: 1 } });
    const response = await app.request(
      "/reentry?principal_id=principal&participant_id=participant",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      handoff: { id: input.id },
      replay: { after_seq: 1, through_seq: 1, events: [] },
      active_claims: [],
      pending_signals: [],
    });
  });
  it("snapshots a whole scan budget for filtered replay and one page otherwise", async () => {
    const insert = fixture.sqlite.prepare(
      "INSERT INTO journal (t, kind, resource, actor, data) VALUES (?, ?, ?, 'actor', ?)",
    );
    insert.run(1, "task.created", "task:a", "{}");
    insert.run(
      2,
      "custom.reported",
      "project",
      JSON.stringify({ event_name: "pipeline.done", correlation_id: "run-1" }),
    );
    insert.run(3, "task.created", "task:b", "{}");
    const unfiltered = await (
      await app.request("/journal/replay?after_seq=0&limit=2")
    ).json();
    expect(unfiltered).toMatchObject({ page_through_seq: 2, through_seq: 3 });
    expect(unfiltered).not.toHaveProperty("filter");

    const filtered = await (
      await app.request(
        "/journal/replay?after_seq=0&limit=2&event_name=pipeline.done&correlation_id=run-1",
      )
    ).json();
    expect(filtered).toMatchObject({
      page_through_seq: 3,
      filter: {
        event_name: "pipeline.done",
        correlation_id: "run-1",
        limit: 2,
      },
    });
    expect(filtered.events).toHaveLength(3);

    for (const query of ["event_name=Not%20A%20Name", "correlation_id="]) {
      const response = await app.request(
        `/journal/replay?after_seq=0&${query}`,
      );
      expect(response.status).toBe(400);
    }
  });
  it("reports immutable conflicts, future cursors, and missing handoffs", async () => {
    const input = {
      id: crypto.randomUUID(),
      summary: "First",
      based_on_seq: 0,
    };
    await send("/handoffs", "POST", input);
    expect(
      (await send("/handoffs", "POST", { ...input, summary: "Changed" }))
        .status,
    ).toBe(409);
    expect((await send("/journal/cursor", "PUT", { seq: 99 })).status).toBe(
      400,
    );
    expect((await app.request(`/handoffs/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
  });
  it("preserves marked shutdown snapshots over HTTP while selecting authored context", async () => {
    const work = {
      id: crypto.randomUUID(),
      summary: "Next step",
      based_on_seq: 0,
    };
    const shutdown = { ...work, id: crypto.randomUUID(), kind: "shutdown" };
    expect((await send("/handoffs", "POST", work)).status).toBe(200);
    const saved = await send("/handoffs", "POST", shutdown);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ handoff: shutdown });
    expect(await (await send("/handoffs", "POST", shutdown)).json()).toEqual(
      body,
    );
    const base = "/reentry?principal_id=principal&participant_id=participant";
    expect(await (await app.request(base)).json()).toMatchObject({
      handoff: { id: work.id },
    });
    expect(
      await (await app.request(`${base}&handoff_id=${shutdown.id}`)).json(),
    ).toMatchObject({ handoff: shutdown });
    expect(
      (await send("/handoffs", "POST", { ...shutdown, kind: "invalid" }))
        .status,
    ).toBe(400);
  });
});
