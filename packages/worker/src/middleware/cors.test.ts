import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env, HonoVariables } from "../types";
import { createCorsMiddleware } from "./cors";

describe("corsMiddleware", () => {
  it("allows every custom header the dashboard sends in a preflight", async () => {
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    app.use("*", createCorsMiddleware());
    app.get("/projects/p/rooms", (c) => c.json({ ok: true }));
    const requested = [
      "authorization",
      "content-type",
      "x-tila-participant-id",
      "x-tila-client-name",
      "x-tila-conversation-protocol",
    ];
    const res = await app.request(
      "http://worker/projects/p/rooms",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": requested.join(","),
        },
      },
      { CORS_ALLOWED_ORIGINS: "http://localhost:5173" } as Env,
    );
    const allowed = (res.headers.get("Access-Control-Allow-Headers") ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim());
    for (const header of requested) expect(allowed).toContain(header);
  });
});
