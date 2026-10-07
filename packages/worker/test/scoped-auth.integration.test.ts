import { CAPABILITIES, type CredentialPolicy } from "@tila/schemas";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialFixture } from "../../backend-d1/test/helpers/credential-fixture";
import { generateToken, hashToken } from "../src/lib/hash";
import { exchangeScopedWorkload } from "../src/lib/workload-credential";
import {
  _resetMiddlewareStateForTest,
  createAuthMiddleware,
} from "../src/middleware/auth";
import { createCacheMiddleware } from "../src/middleware/cache";
import { capabilityMiddleware } from "../src/middleware/capability";
import { createIdempotencyMiddleware } from "../src/middleware/idempotency";
import { projectMembershipMiddleware } from "../src/middleware/membership";
import { projectMiddleware } from "../src/middleware/project";
import { protectedOperationMiddleware } from "../src/middleware/protected-operation";
import { requestIdentityMiddleware } from "../src/middleware/request-identity";
import { authSessionExchange } from "../src/routes/auth-session";
import { backup } from "../src/routes/backup";
import { serviceAccountRoutes } from "../src/routes/service-accounts";
import { tokens } from "../src/routes/tokens";
import type { Env, HonoVariables } from "../src/types";

describe("scoped HTTP authentication with authoritative D1 persistence", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  let env: Env;
  let bootstrap: string;
  const actor = { principalId: "bootstrap:test" };
  const policy: CredentialPolicy = {
    role: "participant",
    capabilities: ["records:read", "records:write"],
  };
  const effects = vi.fn();
  function app() {
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    app.route("/auth/session", authSessionExchange);
    app.post("/exchange", (c) =>
      exchangeScopedWorkload(c, {
        projectId: "p",
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "runner",
        assertionId: c.req.header("assertion") ?? "one",
        expiresAt: Math.floor(Date.now() / 1000) + 1000,
      }).then((response) => response ?? c.json({ legacy: true })),
    );
    app.use("*", createAuthMiddleware());
    app.route("/api/tokens", tokens);
    const project = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    project.use(
      "*",
      requestIdentityMiddleware(),
      projectMiddleware,
      projectMembershipMiddleware(),
      capabilityMiddleware(),
      protectedOperationMiddleware(),
      createIdempotencyMiddleware(),
      createCacheMiddleware(),
    );
    project.route("/service-accounts", serviceAccountRoutes);
    project.route("/admin/backup", backup);
    project.all("*", (c) => {
      effects();
      return c.json({
        ok: true,
        principal: c.get("principalId"),
        policy: c.get("credentialPolicy"),
      });
    });
    app.route("/projects/:projectId", project);
    return app;
  }
  function request(
    server: ReturnType<typeof app>,
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return server.request(
      path,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tila-Participant-Id": "11111111-1111-4111-8111-111111111111",
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    );
  }
  async function issue(grant = policy, jkt?: string) {
    const service = await f.store.createService(
      "p",
      {
        name: `svc-${crypto.randomUUID()}`,
        display_name: "Runner",
        role: grant.role,
      },
      actor,
    );
    const plaintext = await generateToken();
    const result = await f.store.issue(
      {
        projectId: "p",
        principalId: service.principal_id,
        name: `key-${crypto.randomUUID()}`,
        policy: grant,
        tokenHash: await hashToken(plaintext, "pepper"),
        cnfJkt: jkt,
      },
      actor,
    );
    return { plaintext, ...result };
  }
  beforeEach(async () => {
    f = createCredentialFixture();
    effects.mockClear();
    _resetMiddlewareStateForTest();
    env = {
      DB: f.db,
      HASH_PEPPER: "pepper",
      PROJECT: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: () => new Response("{}") }),
      },
      ANALYTICS: { writeDataPoint: () => {} },
    } as unknown as Env;
    bootstrap = await generateToken();
    await f.legacy.issue({
      projectId: "p",
      name: "bootstrap",
      tokenHash: await hashToken(bootstrap, "pepper"),
      createdBy: "bootstrap",
      createdAt: 1,
    });
  });
  afterEach(() => f.sqlite.close());

  it("authorizes every continuity aggregate component and denies restricted snapshots", async () => {
    const server = app();
    for (const missing of [
      "journal:read",
      "tasks:read",
      "records:read",
      "artifacts:read",
      "claims:read",
      "summary:read",
      "signals:read",
    ] as const) {
      const key = await issue({
        role: "owner",
        capabilities: CAPABILITIES.filter((cap) => cap !== missing),
      });
      expect(
        (await request(server, "/projects/p/reentry", key.plaintext)).status,
      ).toBe(403);
      if (missing !== "summary:read" && missing !== "signals:read") {
        expect(
          (await request(server, "/projects/p/handoffs", key.plaintext)).status,
        ).toBe(403);
        expect(
          (
            await request(
              server,
              "/projects/p/handoffs",
              key.plaintext,
              "POST",
              {},
            )
          ).status,
        ).toBe(403);
      }
    }
    const restricted = await issue({
      role: "owner",
      capabilities: [...CAPABILITIES],
      restrictions: { task_types: ["task"] },
    });
    for (const path of [
      "reentry",
      "handoffs",
      "handoffs/one",
      "journal/replay",
      "journal/cursor",
    ]) {
      expect(
        (await request(server, `/projects/p/${path}`, restricted.plaintext))
          .status,
      ).toBe(403);
    }
    const viewer = await issue({
      role: "viewer",
      capabilities: ["journal:read"],
    });
    expect(
      (
        await request(
          server,
          "/projects/p/journal/cursor",
          viewer.plaintext,
          "PUT",
          { seq: 1 },
        )
      ).status,
    ).toBe(403);
    expect(effects).not.toHaveBeenCalled();
  });
  it("requires both read and write for artifact restore, and denies restricted keys", async () => {
    const server = app();
    for (const capabilities of [
      ["artifacts:read"],
      ["artifacts:write"],
    ] as const) {
      const key = await issue({
        role: "participant",
        capabilities: [...capabilities],
      });
      expect(
        (
          await request(
            server,
            "/projects/p/artifacts/~/restore/produced/task/blob.txt",
            key.plaintext,
            "POST",
            {},
          )
        ).status,
      ).toBe(403);
    }
    const restricted = await issue({
      role: "participant",
      capabilities: ["artifacts:read", "artifacts:write"],
      restrictions: { task_types: ["task"] },
    });
    expect(
      (
        await request(
          server,
          "/projects/p/artifacts/~/restore/produced/task/blob.txt",
          restricted.plaintext,
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    expect(effects).not.toHaveBeenCalled();
    const writer = await issue({
      role: "participant",
      capabilities: ["artifacts:read", "artifacts:write"],
    });
    expect(
      (
        await request(
          server,
          "/projects/p/artifacts/~/restore/produced/task/blob.txt",
          writer.plaintext,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
  });
  it("allows explicit capabilities, denies deletion/governance and cross-project access", async () => {
    const key = await issue();
    const server = app();
    expect(
      (await request(server, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(200);
    expect(
      (
        await request(
          server,
          "/projects/p/records/config",
          key.plaintext,
          "POST",
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          server,
          "/projects/p/records/config/~/archive/a",
          key.plaintext,
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          server,
          "/projects/p/admin/destroy",
          key.plaintext,
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (await request(server, "/projects/other/records/config", key.plaintext))
        .status,
    ).toBe(403);
    expect((await request(server, "/api/tokens", key.plaintext)).status).toBe(
      403,
    );
    expect(effects).toHaveBeenCalledTimes(2);
  });
  it("denies cached/replayed access after revocation across independent middleware instances", async () => {
    const key = await issue();
    const first = app();
    const other = app();
    expect(
      (
        await request(
          first,
          "/projects/p/records/config",
          key.plaintext,
          "POST",
          {},
          { "Idempotency-Key": "retry" },
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(other, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(200);
    expect(
      (await request(first, `/api/tokens/${key.name}`, bootstrap, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await request(other, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(401);
    expect(
      (
        await request(
          first,
          "/projects/p/records/config",
          key.plaintext,
          "POST",
          {},
          { "Idempotency-Key": "retry" },
        )
      ).status,
    ).toBe(401);
    expect(effects).toHaveBeenCalledTimes(2);
  });
  it("checks membership before retry replay and never serves a broader policy's stored response", async () => {
    const key = await issue();
    const server = app();
    const path = "/projects/p/records/config";
    expect(
      (
        await request(
          server,
          path,
          key.plaintext,
          "POST",
          {},
          { "Idempotency-Key": "retry" },
        )
      ).status,
    ).toBe(200);
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET role = 'viewer' WHERE principal_id = ?",
      )
      .run(key.principal_id);
    expect(
      (
        await request(
          server,
          path,
          key.plaintext,
          "POST",
          {},
          { "Idempotency-Key": "retry" },
        )
      ).status,
    ).toBe(403);
    expect(effects).toHaveBeenCalledTimes(1);
  });
  it("caps cookie authority at the source credential and rejects it after rotation", async () => {
    const key = await issue();
    const server = app();
    const exchange = await request(server, "/auth/session", "", "POST", {
      token: key.plaintext,
      project_id: "p",
    });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get("Set-Cookie")?.split(";")[0];
    expect(
      (
        await request(
          server,
          "/projects/p/records/config",
          "",
          "GET",
          undefined,
          { Cookie: cookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          server,
          "/projects/p/admin/destroy",
          "",
          "POST",
          {},
          { Cookie: cookie },
        )
      ).status,
    ).toBe(403);
    await f.store.rotate("p", key.name, key.token_id, "replacement", 0, actor);
    expect(
      (
        await request(
          app(),
          "/projects/p/records/config",
          "",
          "GET",
          undefined,
          { Cookie: cookie },
        )
      ).status,
    ).toBe(401);
  });
  it("prevents DPoP downgrade through cookie exchange and requires proof on direct requests", async () => {
    const key = await issue(policy, "a".repeat(43));
    const server = app();
    expect(
      (await request(server, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(401);
    expect(
      (
        await request(server, "/auth/session", "", "POST", {
          token: key.plaintext,
          project_id: "p",
        })
      ).status,
    ).toBe(403);
  });
  it("lets an owner create, rotate, list and revoke a scoped credential without revealing hashes", async () => {
    const owner = await issue({
      role: "owner",
      capabilities: [...CAPABILITIES],
    });
    const server = app();
    const create = await request(
      server,
      "/api/tokens",
      owner.plaintext,
      "POST",
      { name: "integration", principal_id: owner.principal_id, policy },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      token_id: string;
      token: string;
    };
    const rotate = await request(
      server,
      "/api/tokens/integration/rotate",
      owner.plaintext,
      "POST",
      { expected_token_id: created.token_id },
    );
    expect(rotate.status).toBe(201);
    expect(
      (await request(server, "/projects/p/records/config", created.token))
        .status,
    ).toBe(401);
    const list = await request(server, "/api/tokens", owner.plaintext);
    const text = await list.text();
    expect(text).not.toContain(created.token);
    expect(text).not.toContain("token_hash");
    expect(
      (
        await request(
          server,
          "/api/tokens/integration",
          owner.plaintext,
          "DELETE",
        )
      ).status,
    ).toBe(200);
  });
  it("cannot mint a broader grant or fall back to legacy full issuance", async () => {
    const owner = await issue({
      role: "owner",
      capabilities: ["tokens:issue", "records:read"],
    });
    const server = app();
    expect(
      (
        await request(server, "/api/tokens", owner.plaintext, "POST", {
          name: "elevated",
          principal_id: owner.principal_id,
          policy,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server, "/api/tokens", owner.plaintext, "POST", {
          name: "legacy",
        })
      ).status,
    ).toBe(403);
  });
  it("issues short-lived workload keys and revokes both exchange and issued access", async () => {
    const key = await issue();
    const binding = await f.store.createBinding(
      "p",
      key.principal_id,
      {
        name: "ci",
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "runner",
        policy,
      },
      actor,
    );
    const server = app();
    const exchange = await request(server, "/exchange", "", "POST", {});
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as {
      expires_at: number;
      session_token: string;
    };
    expect(body.expires_at).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 900,
    );
    expect(
      (await request(server, "/projects/p/records/config", body.session_token))
        .status,
    ).toBe(200);
    expect((await request(server, "/exchange", "", "POST", {})).status).toBe(
      409,
    );
    await f.store.revokeBinding(
      "p",
      key.principal_id,
      binding.binding_id,
      actor,
    );
    expect(
      (await request(server, "/projects/p/records/config", body.session_token))
        .status,
    ).toBe(401);
    expect(
      (await request(server, "/exchange", "", "POST", {}, { assertion: "two" }))
        .status,
    ).toBe(403);
  });
  it("denies warm cached access when authoritative lookup fails or stored policy is invalid", async () => {
    const key = await issue();
    const server = app();
    expect(
      (await request(server, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(200);
    const lookup = vi.spyOn(f.db, "prepare").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    expect(
      (await request(server, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(503);
    lookup.mockRestore();
    f.sqlite
      .prepare(
        "UPDATE _credentials SET policy_json = ? WHERE credential_id = ?",
      )
      .run(
        JSON.stringify({ role: "owner", capabilities: ["*"] }),
        key.credential_id,
      );
    expect(
      (await request(server, "/projects/p/records/config", key.plaintext))
        .status,
    ).toBe(503);
    expect(effects).toHaveBeenCalledTimes(1);
  });
  it("prevents scoped imports from minting full keys or restoring broader workload policies", async () => {
    const key = await issue({
      role: "owner",
      capabilities: ["project:import"],
    });
    const server = app();
    const path = "/projects/p/admin/backup/d1/restore";
    const headers = { "X-Confirm-Slug": "p" };
    expect(
      (
        await request(
          server,
          path,
          key.plaintext,
          "POST",
          { sections: {}, createBootstrapToken: true },
          headers,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          server,
          path,
          key.plaintext,
          "POST",
          {
            sections: {
              _workload_bindings: [
                {
                  policy_json: JSON.stringify({
                    role: "owner",
                    capabilities: ["tokens:issue"],
                  }),
                },
              ],
            },
          },
          headers,
        )
      ).status,
    ).toBe(403);
  });
  it("rejects record namespaces before any Worker-side snapshot write", async () => {
    const key = await issue({
      ...policy,
      restrictions: { records: [{ type: "config", key_prefixes: ["team/a"] }] },
    });
    expect(
      (
        await request(
          app(),
          "/projects/p/records/config",
          key.plaintext,
          "POST",
          { key: "team/ab", value: {} },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          app(),
          "/projects/p/records/config/~/put/team%2Fab",
          key.plaintext,
          "POST",
          { value: {} },
        )
      ).status,
    ).toBe(403);
    expect(effects).not.toHaveBeenCalled();
  });
});
