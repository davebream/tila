import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createIdempotencyMiddleware } from "../src/middleware/idempotency";
import type { Env, HonoVariables } from "../src/types";

it("schema replay reaches current authorization even when a D1 response cache is available", async () => {
  const makeStore = vi.fn(() => {
    throw new Error("Schema commands must not use D1 response replay");
  });
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  let allowed = true;
  app.use("*", async (c, next) => {
    c.set("projectId", "p");
    c.set("principalId", "principal");
    c.set("participantId", "participant");
    await next();
  });
  app.use("*", createIdempotencyMiddleware({ makeStore }));
  app.post("/projects/p/schema", (c) =>
    allowed
      ? c.json({ key: c.get("idempotencyKey"), hash: c.get("idempotencyHash") })
      : c.json({ error: "permission-denied" }, 403),
  );
  const request = () =>
    app.request("/projects/p/schema", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "same",
      },
      body: JSON.stringify({ definition: "schema_version = 1" }),
    });
  const first = await request();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    key: expect.stringContaining(":same"),
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  allowed = false;
  expect((await request()).status).toBe(403);
  expect(makeStore).not.toHaveBeenCalled();
});
