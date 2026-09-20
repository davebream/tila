import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestIdentityMiddleware } from "../middleware/request-identity";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { signals } from "./signals";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createApp(tokenResult: UnifiedTokenResult) {
  const forwarded: Request[] = [];
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      forwarded.push(request);
      return Response.json({ ok: true, signals: [], groups: [] });
    }),
  } as unknown as DurableObjectStub;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    c.set("projectId", "project-1");
    c.set("doStub", stub);
    c.set("source", "worker-test");
    c.set("sourceVersion", "1.0.0");
    await next();
  });
  app.use("*", requestIdentityMiddleware());
  app.route("/signals", signals);
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const request = (path: string, init?: RequestInit) =>
    app.fetch(
      new Request(`http://localhost${path}`, init),
      mockEnv,
      executionCtx,
    );
  return { forwarded, request, stub };
}

const fullToken: UnifiedTokenResult = {
  kind: "d1-token",
  projectId: "project-1",
  name: "Build token",
  scopes: "full",
  tokenId: "tid-1",
};
const mockEnv = {
  ANALYTICS: { writeDataPoint: vi.fn() },
} as unknown as Env;

describe("signal Worker identity and authorization", () => {
  it("stamps canonical sender identity and display-only metadata", async () => {
    const { forwarded, request } = createApp(fullToken);
    const response = await request("/signals/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "participant-1",
        "X-Tila-Machine": "builder-1",
      },
      body: JSON.stringify({
        target: {
          type: "participant",
          principal_id: "principal-b",
          participant_id: "participant-b",
        },
        kind: "request",
        sender: {
          principal_id: "spoofed",
          participant_id: "spoofed",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await forwarded[0].json()) as {
      sender: Record<string, unknown>;
    };
    expect(body.sender).toEqual({
      principal_id: "token:tid-1",
      participant_id: "participant-1",
      display_name: "Build token",
      environment: {
        machine: "builder-1",
        client_name: "worker-test",
        client_version: "1.0.0",
      },
    });
  });

  it("rejects legacy string targets with an upgrade message", async () => {
    const { request, stub } = createApp(fullToken);
    const response = await request("/signals/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "participant-1",
      },
      body: JSON.stringify({ target: "old-display-name", kind: "info" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "validation-error",
        message: expect.stringContaining("upgrade"),
      },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("requires a participant ID for inboxes before forwarding", async () => {
    const { request, stub } = createApp(fullToken);
    const response = await request("/signals");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "participant-required" },
    });
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("allows group reads but reserves history and mutations for admins", async () => {
    const viewer: UnifiedTokenResult = {
      kind: "cookie-session",
      projectId: "project-1",
      name: "Viewer",
      scopes: "read",
      tokenId: "",
      sessionHash: "session",
      expiresAt: Date.now() + 60_000,
      permission: "read",
      principalId: "github:example.com:42",
    };
    const { request } = createApp(viewer);

    expect((await request("/signals/groups")).status).toBe(200);
    expect((await request("/signals/history")).status).toBe(403);
    expect(
      (
        await request("/signals/groups/reviewers", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Tila-Participant-Id": "participant-1",
          },
          body: JSON.stringify({ name: "Reviewers", principal_ids: [] }),
        })
      ).status,
    ).toBe(403);
  });
});
