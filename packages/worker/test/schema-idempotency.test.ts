import { DEFINITION_REQUEST_MAX_BYTES } from "@tila/schemas";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createIdempotencyMiddleware } from "../src/middleware/idempotency";
import { schemaBodyLimit } from "../src/routes/schema";
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

it("rejects an oversize schema request before the idempotency middleware hashes it", async () => {
  const hashed = vi.fn();
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("/projects/p/schema", schemaBodyLimit);
  app.use("/projects/p/schema/*", schemaBodyLimit);
  app.use("*", async (c, next) => {
    c.set("projectId", "p");
    c.set("principalId", "principal");
    c.set("participantId", "participant");
    await next();
  });
  app.use("*", createIdempotencyMiddleware());
  app.post("/projects/p/schema/preview", (c) => {
    hashed(c.get("idempotencyHash"));
    return c.json({ ok: true });
  });
  const body = JSON.stringify({
    definition: "x".repeat(DEFINITION_REQUEST_MAX_BYTES),
  });
  const response = await app.request("/projects/p/schema/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
      "Idempotency-Key": "big",
    },
    body,
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({
    error: { code: "payload-too-large" },
  });
  expect(hashed).not.toHaveBeenCalled();
});
