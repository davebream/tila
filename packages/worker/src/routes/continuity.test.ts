import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createCacheMiddleware } from "../middleware/cache";
import { requestIdentityMiddleware } from "../middleware/request-identity";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { continuity } from "./continuity";

const token: UnifiedTokenResult = {
  kind: "d1-token",
  projectId: "p",
  name: "test",
  scopes: "full",
  tokenId: "token",
};
function setup(
  response: unknown = { ok: true },
  scopes = "full",
  env: Partial<Env> = {},
) {
  const forwarded: Request[] = [];
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", { ...token, scopes } as UnifiedTokenResult);
    c.set("projectId", "p");
    c.set("doStub", {
      fetch: vi.fn(async (request: Request) => {
        forwarded.push(request);
        return Response.json(response);
      }),
    } as unknown as DurableObjectStub);
    c.set("source", "test");
    await next();
  });
  app.use("*", requestIdentityMiddleware());
  app.use("*", createCacheMiddleware());
  app.route("/projects/p", continuity);
  app.get("/projects/p/summary", (c) => c.json({ ok: true }));
  const request = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`http://localhost/projects/p${path}`, {
        ...init,
        headers: { "X-Tila-Participant-Id": "session", ...init.headers },
      }),
      env as Env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );
  return { request, forwarded, app };
}
describe("continuity authorization and forwarding", () => {
  it("forwards shutdown classification without changing the handoff request", async () => {
    const { request, forwarded } = setup();
    const handoff = {
      id: crypto.randomUUID(),
      kind: "shutdown",
      summary: "Session ended",
      based_on_seq: 0,
    };
    const response = await request("/handoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(handoff),
    });
    expect(response.status).toBe(200);
    expect(await forwarded[0].json()).toMatchObject({ input: handoff });
  });

  it("uses authenticated identity, never query-supplied identity, and disables caching", async () => {
    const { request, forwarded } = setup({
      ok: true,
      cursor: { seq: 0, updated_at: null },
    });
    const response = await request(
      "/journal/cursor?principal_id=attacker&participant_id=other",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const url = new URL(forwarded[0].url);
    expect(url.searchParams.get("principal_id")).toBe("token:token");
    expect(url.searchParams.get("participant_id")).toBe("session");
  });
  it("requires a participant only on the new continuity routes", async () => {
    const { app } = setup();
    expect((await app.request("/projects/p/reentry")).status).toBe(400);
    expect((await app.request("/projects/p/summary")).status).toBe(200);
  });
  it("forbids read-only callers from acknowledging or creating handoffs", async () => {
    const { request, forwarded } = setup({}, "read");
    for (const [path, method] of [
      ["/journal/cursor", "PUT"],
      ["/handoffs", "POST"],
    ]) {
      const response = await request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq: 1 }),
      });
      expect(response.status).toBe(403);
    }
    expect(forwarded).toHaveLength(0);
  });
  it("validates selectors and sequences before forwarding", async () => {
    const { request, forwarded } = setup();
    expect(
      (
        await request(
          `/reentry?handoff_id=${crypto.randomUUID()}&resource=task:x`,
        )
      ).status,
    ).toBe(400);
    expect((await request("/journal/replay?after_seq=-1")).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
  it("returns replay pagination and fails closed when archived rows are unavailable", async () => {
    const snapshot = {
      after_seq: 0,
      through_seq: 0,
      page_through_seq: 0,
      archived_through_seq: 0,
      events: [],
    };
    const good = setup(snapshot);
    expect(
      await (await good.request("/journal/replay?after_seq=0")).json(),
    ).toEqual({
      ok: true,
      events: [],
      next_after_seq: 0,
      through_seq: 0,
      has_more: false,
    });
    const bad = setup({
      ...snapshot,
      through_seq: 1,
      page_through_seq: 1,
      archived_through_seq: 1,
    });
    const response = await bad.request("/journal/replay?after_seq=0");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "journal-history-unavailable" },
    });
  });
  describe("filtered replay", () => {
    const archived = (skip?: number) =>
      Array.from({ length: 1000 }, (_, index) => index + 1)
        .filter((seq) => seq !== skip)
        .map((seq) =>
          JSON.stringify({
            seq,
            t: seq,
            kind: seq === 700 ? "custom.reported" : "task.created",
            resource: "project",
            actor: "actor",
            data: seq === 700 ? { event_name: "pipeline.old" } : {},
          }),
        )
        .join("\n");
    const scan = {
      after_seq: 0,
      through_seq: 1500,
      page_through_seq: 1000,
      archived_through_seq: 1000,
      events: [],
      filter: { event_name: "pipeline.old", limit: 10 },
    };
    const bucket = (body: string) => {
      const list = vi.fn(async () => ({
        objects: [
          {
            key: "journal-archive/p/2025/01.part-1000-from-1.jsonl",
            customMetadata: { first_seq: "1", last_seq: "1000" },
          },
        ],
        truncated: false,
      }));
      const get = vi.fn(async () => ({ body: new Response(body).body }));
      return { list, get, ARTIFACTS: { list, get } as unknown as R2Bucket };
    };

    it("forwards the filters and reads the archive once for the whole scan", async () => {
      const { list, get, ARTIFACTS } = bucket(archived());
      const { request, forwarded } = setup(scan, "full", { ARTIFACTS });
      const response = await request(
        "/journal/replay?after_seq=0&through_seq=1500&limit=10&event_name=pipeline.old",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        events: [{ seq: 700, kind: "custom.reported" }],
        next_after_seq: 1000,
        through_seq: 1500,
        has_more: true,
      });
      expect(forwarded).toHaveLength(1);
      expect(new URL(forwarded[0].url).searchParams.get("event_name")).toBe(
        "pipeline.old",
      );
      expect(list).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("fails closed on a missing sequence even when the filter matches nothing", async () => {
      const { ARTIFACTS } = bucket(archived(500));
      const { request } = setup(
        { ...scan, filter: { event_name: "no.such_event", limit: 10 } },
        "full",
        { ARTIFACTS },
      );
      const response = await request(
        "/journal/replay?after_seq=0&through_seq=1500&event_name=no.such_event",
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "journal-history-unavailable", retryable: true },
      });
    });

    it("rejects malformed selectors before reaching the Durable Object", async () => {
      const { request, forwarded } = setup();
      for (const query of ["event_name=Bad%20Name", "correlation_id="])
        expect(
          (await request(`/journal/replay?after_seq=0&${query}`)).status,
        ).toBe(400);
      expect(forwarded).toHaveLength(0);
    });
  });
});
