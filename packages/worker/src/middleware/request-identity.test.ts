import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import {
  identityPayload,
  principalIdFor,
  requestIdentityMiddleware,
} from "./request-identity";

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

describe("identity forwarded to the project for revision authorship", () => {
  // The DO stores `principal_id` and `actor_token_id` on every record revision,
  // so what the Worker sends here is what history later reports.
  async function payload(tokenResult: UnifiedTokenResult) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("tokenResult", tokenResult);
      await next();
    });
    app.use("*", requestIdentityMiddleware());
    app.post("/write", (c) => c.json(identityPayload(c)));
    const response = await app.request("/write", {
      method: "POST",
      headers: { "X-Tila-Participant-Id": "participant-1" },
    });
    expect(response.status).toBe(200);
    return response.json<{
      principal_id: string;
      actor_token_id: string | null;
    }>();
  }

  const expiresAt = Date.now() + 60_000;

  it("sends a project credential's own token ID with its principal", async () => {
    const forwarded = await payload({
      kind: "d1-token",
      projectId: "project-1",
      name: "deploy-bot",
      scopes: "full",
      tokenId: "token-1",
      principalId: "service:deploy",
    });
    expect(forwarded).toMatchObject({
      principal_id: "service:deploy",
      actor_token_id: "token-1",
    });
  });

  it("sends the same principal with a different token ID after rotation", async () => {
    const credential = {
      kind: "d1-token" as const,
      projectId: "project-1",
      name: "deploy-bot",
      scopes: "full",
      principalId: "service:deploy",
    };
    const before = await payload({ ...credential, tokenId: "token-1" });
    const after = await payload({ ...credential, tokenId: "token-2" });
    expect(after.principal_id).toBe(before.principal_id);
    expect(after.actor_token_id).not.toBe(before.actor_token_id);
  });

  it.each([
    [
      "cookie session",
      {
        kind: "cookie-session",
        projectId: "project-1",
        name: "Alice",
        scopes: "full",
        tokenId: "",
        sessionHash: "hash",
        expiresAt,
        permission: "write",
        principalId: "user:alice",
      },
      "user:alice",
    ],
    [
      "workspace session",
      {
        kind: "workspace-session",
        projectId: "project-1",
        name: "alice",
        scopes: "full",
        tokenId: "",
        sessionHash: "hash",
        githubLogin: "alice",
        expiresAt,
        principalId: "user:alice",
      },
      "user:alice",
    ],
    [
      "OIDC session",
      {
        kind: "oidc-session",
        projectId: "project-1",
        name: "workflow",
        scopes: "write",
        tokenId: "",
        permission: "write",
        expiresAt,
        oidcIssuer: "https://issuer.example",
        oidcSubject: "subject-1",
      },
      "oidc:https://issuer.example:subject-1",
    ],
  ] as const)(
    "sends a %s's principal with no token ID",
    async (_label, session, principalId) => {
      const forwarded = await payload(session as UnifiedTokenResult);
      expect(forwarded).toMatchObject({
        principal_id: principalId,
        actor_token_id: null,
      });
    },
  );
});
