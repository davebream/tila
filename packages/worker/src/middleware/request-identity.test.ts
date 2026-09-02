import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { principalIdFor, requestIdentityMiddleware } from "./request-identity";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function createApp(tokenResult: UnifiedTokenResult) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    c.set("source", "cli");
    c.set("sourceVersion", "1.2.3");
    await next();
  });
  app.use("*", requestIdentityMiddleware());
  app.post("/write", (c) =>
    c.json({
      principal_id: c.get("principalId"),
      participant_id: c.get("participantId"),
      environment: c.get("environment"),
    }),
  );
  app.get("/read", (c) =>
    c.json({
      principal_id: c.get("principalId"),
      participant_id: c.get("participantId") ?? null,
    }),
  );
  return app;
}

const projectToken: UnifiedTokenResult = {
  kind: "d1-token",
  projectId: "project-1",
  name: "legacy-credential-name",
  scopes: "full",
  tokenId: "18fc3f08-a0b4-4fe5-90e6-c2f177789f39",
};

describe("request identity middleware", () => {
  it("requires a valid participant ID for mutations", async () => {
    const app = createApp(projectToken);
    const missing = await app.request("/write", { method: "POST" });
    const invalid = await app.request("/write", {
      method: "POST",
      headers: { "X-Tila-Participant-Id": "" },
    });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "participant-required" },
    });
    expect(invalid.status).toBe(400);
  });

  it("derives the principal from auth and keeps environment untrusted", async () => {
    const app = createApp(projectToken);
    const response = await app.request("/write", {
      method: "POST",
      headers: {
        "X-Tila-Participant-Id": "participant-1",
        "X-Tila-Principal-Id": "spoofed-principal",
        "X-Tila-Machine": "developer-laptop",
        "X-Tila-Repository": "https://example.test/repo.git",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal_id: `token:${projectToken.tokenId}`,
      participant_id: "participant-1",
      environment: {
        machine: "developer-laptop",
        repository: "https://example.test/repo.git",
        client_name: "cli",
        client_version: "1.2.3",
      },
    });
  });

  it("allows reads without a participant ID", async () => {
    const response = await createApp(projectToken).request("/read");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principal_id: `token:${projectToken.tokenId}`,
      participant_id: null,
    });
  });

  it("canonicalizes GitHub and OIDC principals", () => {
    expect(
      principalIdFor({
        kind: "session",
        projectId: "project-1",
        name: "User",
        scopes: "full",
        tokenId: "session-token",
        githubRepoId: 1,
        githubLogin: "User",
        githubUserId: 42,
        githubHost: "GitHub.COM",
        permission: "write",
        expiresAt: Date.now() + 1000,
      }),
    ).toBe("github:github.com:42");
    expect(
      principalIdFor({
        kind: "oidc-session",
        projectId: "project-1",
        name: "workflow",
        scopes: "write",
        tokenId: "",
        permission: "write",
        expiresAt: Date.now() + 1000,
        oidcIssuer: "HTTPS://TOKEN.ACTIONS.GITHUBUSERCONTENT.COM/",
        oidcSubject: "repo:org/repo:ref:refs/heads/main",
      }),
    ).toBe(
      "oidc:https://token.actions.githubusercontent.com:repo:org/repo:ref:refs/heads/main",
    );
  });
});
