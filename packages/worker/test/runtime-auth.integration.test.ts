import { ProjectMembershipStore, RuntimeStore } from "@tila/backend-d1";
import { CREDENTIAL_PRESETS, accessTokenHash } from "@tila/schemas";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialFixture } from "../../backend-d1/test/helpers/credential-fixture";
import {
  generateRuntimeKey,
  runtimeBinding,
} from "../../client-lifecycle/src/runtime-proof";
import { TilaClient } from "../../sdk/src/client";
import { RuntimeClient, exchangeRuntimeWorkload } from "../../sdk/src/runtime";
import { generateToken, hashToken } from "../src/lib/hash";
import { exchangeScopedWorkload } from "../src/lib/workload-credential";
import {
  _resetMiddlewareStateForTest,
  createAuthMiddleware,
} from "../src/middleware/auth";
import { capabilityMiddleware } from "../src/middleware/capability";
import { createIdempotencyMiddleware } from "../src/middleware/idempotency";
import { projectMembershipMiddleware } from "../src/middleware/membership";
import { projectMiddleware } from "../src/middleware/project";
import { protectedOperationMiddleware } from "../src/middleware/protected-operation";
import { requestIdentityMiddleware } from "../src/middleware/request-identity";
import { authSessionExchange } from "../src/routes/auth-session";
import { runtimeRoutes } from "../src/routes/runtime";
import type { Env, HonoVariables } from "../src/types";

describe("runtime HTTP authority and SDK wire contracts", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  let env: Env;
  let transport: typeof fetch;
  let owner: RuntimeClient;
  let effects: number;
  beforeEach(async () => {
    _resetMiddlewareStateForTest();
    f = createCredentialFixture();
    effects = 0;
    const token = await generateToken();
    await f.legacy.issue({
      tokenHash: await hashToken(token, "pepper"),
      projectId: "p",
      name: "owner",
      createdBy: "test",
      createdAt: 0,
    });
    env = {
      DB: f.db,
      HASH_PEPPER: "pepper",
      PROJECT: { idFromName: () => "p", get: () => ({}) },
      ANALYTICS: { writeDataPoint() {} },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    app.route("/auth/session", authSessionExchange);
    app.route("/", runtimeRoutes);
    const project = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    project.use(
      "*",
      createAuthMiddleware(),
      requestIdentityMiddleware(),
      projectMiddleware,
      projectMembershipMiddleware(),
      capabilityMiddleware(),
      protectedOperationMiddleware(),
      createIdempotencyMiddleware(),
    );
    project.all("*", (c) => {
      effects++;
      return c.json({ ok: true, participant: c.get("participantId") });
    });
    app.route("/projects/:projectId", project);
    transport = (async (url, init) =>
      app.request(String(url), init, env, {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext)) as typeof fetch;
    owner = new RuntimeClient(
      { baseUrl: "https://tila.test", token, fetch: transport },
      "p",
    );
  });
  afterEach(() => f.sqlite.close());
  async function runtime() {
    const invite = await owner.authorize("CI");
    const parentKey = await runtimeBinding(
      await generateRuntimeKey(),
      "https://tila.test",
      () => true,
    );
    const setup = {
      operation_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(),
      name: "CI",
      jkt: parentKey.jkt,
    };
    const parent = await owner.enroll(setup, parentKey, invite.invitation);
    const enrollment = new RuntimeClient(
      {
        baseUrl: "https://tila.test",
        token: async () => ({ token: parent.token, dpop: parentKey }),
        fetch: transport,
      },
      "p",
    );
    const key = await runtimeBinding(
      await generateRuntimeKey(),
      "https://tila.test",
      () => true,
    );
    const run = await enrollment.start({
      operation_id: crypto.randomUUID(),
      jkt: key.jkt,
    });
    const options = {
      baseUrl: "https://tila.test",
      token: async () => ({ token: run.token, dpop: key }),
      participantId: required(run.context.participant_id),
      fetch: transport,
    };
    return {
      parent,
      parentKey,
      enrollment,
      run,
      key,
      options,
      client: new TilaClient(options),
    };
  }
  it("enrolls a participant personally without general service administration and revalidates the sponsor", async () => {
    await new ProjectMembershipStore(f.db).grant({
      projectId: "p",
      principal: { provider: "github", host: "github.com", user_id: 17 },
      subjectKind: "human",
      role: "participant",
      actorPrincipalId: "bootstrap:fixture",
    });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    env.GITHUB_SESSION_HMAC_KEY = Buffer.from(secret).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const token = `tila_s.${await new SignJWT({ sub_type: "github", authorization_version: 2, project_id: "p", permission: "write", role: "participant", issued_at: now, expires_at: now + 3600, github_host: "github.com", github_repo_id: 99, github_user_id: 17, github_login: "member", jti: crypto.randomUUID() }).setProtectedHeader({ alg: "HS256" }).setIssuer("tila").setAudience("tila").sign(secret)}`;
    const human = new RuntimeClient(
      { baseUrl: "https://tila.test", token, fetch: transport },
      "p",
    );
    const key = await runtimeBinding(
      await generateRuntimeKey(),
      "https://tila.test",
      () => true,
    );
    const input = {
      operation_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(),
      name: "Personal",
      jkt: key.jkt,
    };
    const enrollment = await human.enroll(input, key);
    expect(enrollment.context.policy.role).toBe("participant");
    const recovered = await human.enroll(input, key);
    expect(recovered.context.enrollment_id).toBe(
      enrollment.context.enrollment_id,
    );
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM _service_accounts").get(),
    ).toEqual({ n: 1 });
    await expect(human.authorize("Shared")).rejects.toThrow();
    await expect(
      new TilaClient({
        baseUrl: "https://tila.test",
        token,
        fetch: transport,
      }).post("/projects/p/service-accounts", {}),
    ).rejects.toThrow();
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET revoked_at=1 WHERE principal_id='github:github.com:17'",
      )
      .run();
    await expect(
      new RuntimeStore(f.db).context(recovered.context.token_id),
    ).rejects.toMatchObject({ code: "enrollment-revoked" });
  });
  it("enrolls through single-use invitation and assigns a participant server-side", async () => {
    const r = await runtime();
    expect((await r.enrollment.context()).purpose).toBe("enrollment");
    expect(
      (await new RuntimeClient(r.options, "p").context()).policy,
    ).toMatchObject(CREDENTIAL_PRESETS.worker);
    expect(await r.client.get("/projects/p/tasks")).toEqual({
      ok: true,
      participant: r.run.context.participant_id,
    });
    expect(effects).toBe(1);
  });
  it("blocks project crossing, participant spoofing, administration and token-session exchange", async () => {
    const r = await runtime();
    await expect(r.client.get("/projects/other/tasks")).rejects.toThrow();
    await expect(
      new TilaClient({ ...r.options, participantId: "spoof" }).get(
        "/projects/p/tasks",
      ),
    ).rejects.toThrow();
    await expect(
      r.client.post("/projects/p/service-accounts", {}),
    ).rejects.toThrow();
    await expect(
      new RuntimeClient(r.options, "p").start({
        operation_id: crypto.randomUUID(),
        jkt: r.key.jkt,
      }),
    ).rejects.toThrow();
    const session = await transport("https://tila.test/auth/session", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${r.run.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(session.status).toBeGreaterThanOrEqual(400);
    const parent = new TilaClient({
      ...r.options,
      token: async () => ({ token: r.parent.token, dpop: r.parentKey }),
    });
    await expect(parent.get("/projects/p/tasks")).rejects.toThrow();
    expect(effects).toBe(0);
  });
  it("denies revoked authority before idempotency replay and leaves sibling runs alive", async () => {
    const r = await runtime();
    await r.client.post(
      "/projects/p/tasks",
      {},
      { idempotencyKey: "write-one" },
    );
    const sibling = await runtime();
    await owner.revokeEnrollment(required(r.parent.context.enrollment_id));
    await expect(
      r.client.post("/projects/p/tasks", {}, { idempotencyKey: "write-one" }),
    ).rejects.toThrow();
    await expect(
      r.enrollment.renew(
        required(r.run.context.run_id),
        r.run.context.token_id,
      ),
    ).rejects.toThrow();
    await expect(
      sibling.client.get("/projects/p/tasks"),
    ).resolves.toBeDefined();
    expect(effects).toBe(2);
  });
  it("renews OIDC runs only with fresh assertions and their original workload and proof key", async () => {
    const actor = { principalId: "bootstrap:fixture" };
    const service = await f.store.createService(
      "p",
      { name: "ci", display_name: "CI", role: "participant" },
      actor,
    );
    const workload = await f.store.createBinding(
      "p",
      service.principal_id,
      {
        name: "job",
        provider: "oidc",
        issuer: "https://issuer.test",
        subject: "job",
        policy: CREDENTIAL_PRESETS.worker,
      },
      actor,
    );
    const exchangeApp = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    exchangeApp.post("/api/auth/oidc/exchange", async (c) => {
      const body = await c.req.json();
      // Provider signature/audience verification has dedicated route tests. This
      // boundary supplies verified claims to the real D1 exchange implementation.
      return (
        (await exchangeScopedWorkload(c, {
          projectId: "p",
          provider: "oidc",
          issuer: "https://issuer.test",
          subject: "job",
          assertionId: body.oidc_token,
          assertion: body.oidc_token,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
          jkt: body.jkt,
          runtime: body.runtime,
        })) ?? c.json({}, 500)
      );
    });
    const exchangeFetch = (async (url, init) =>
      exchangeApp.request(String(url), init, env)) as typeof fetch;
    const key = await runtimeBinding(
      await generateRuntimeKey(),
      "https://tila.test",
      () => true,
    );
    const options = {
      baseUrl: "https://tila.test",
      projectId: "p",
      operationId: crypto.randomUUID(),
      binding: key,
      fetch: exchangeFetch,
    };
    const first = await exchangeRuntimeWorkload({
      ...options,
      assertion: "assertion-one",
    });
    const second = await exchangeRuntimeWorkload({
      ...options,
      assertion: "assertion-two",
    });
    expect(second.context.run_id).toBe(first.context.run_id);
    expect(second.context.participant_id).toBe(first.context.participant_id);
    expect(second.context.token_id).not.toBe(first.context.token_id);
    await expect(
      exchangeRuntimeWorkload({ ...options, assertion: "assertion-two" }),
    ).rejects.toThrow();
    const otherKey = await runtimeBinding(
      await generateRuntimeKey(),
      "https://tila.test",
      () => true,
    );
    await expect(
      exchangeRuntimeWorkload({
        ...options,
        binding: otherKey,
        assertion: "assertion-three",
      }),
    ).rejects.toMatchObject({ code: "runtime-binding-mismatch" });
    f.sqlite
      .prepare("UPDATE _workload_bindings SET revoked_at=1 WHERE binding_id=?")
      .run(workload.binding_id);
    await expect(
      exchangeRuntimeWorkload({ ...options, assertion: "assertion-four" }),
    ).rejects.toThrow();
    await expect(
      new RuntimeStore(f.db).context(second.context.token_id),
    ).rejects.toThrow();
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM _runtime_runs").get(),
    ).toEqual({ n: 1 });
  });
  it("rejects replay of an already accepted proof", async () => {
    const r = await runtime();
    const url = "https://tila.test/projects/p/tasks";
    const proof = await r.key.signProof({
      htm: "GET",
      htu: url,
      accessToken: r.run.token,
      ath: await accessTokenHash(r.run.token),
      signal: new AbortController().signal,
    });
    const init = {
      headers: { Authorization: `Bearer ${r.run.token}`, DPoP: proof },
    };
    expect((await transport(url, init)).status).toBe(200);
    const replay = await transport(url, init);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      error: { code: "runtime-proof-replayed" },
    });
    expect(effects).toBe(1);
  });
  it("rejects plain bearer use and authorization-store outages", async () => {
    const r = await runtime();
    await expect(
      new TilaClient({ ...r.options, token: r.run.token }).get(
        "/projects/p/tasks",
      ),
    ).rejects.toThrow();
    f.sqlite.exec("DROP TABLE _runtime_enrollments");
    await expect(r.client.get("/projects/p/tasks")).rejects.toThrow();
    expect(effects).toBe(0);
  });
  it("allows an enrolled parent to close its run immediately", async () => {
    const r = await runtime();
    const replacement = await r.enrollment.renew(
      required(r.run.context.run_id),
      r.run.context.token_id,
    );
    expect(replacement.context.participant_id).toBe(
      r.run.context.participant_id,
    );
    await r.enrollment.close(required(r.run.context.run_id));
    await expect(r.client.get("/projects/p/tasks")).rejects.toThrow();
    await expect(
      new RuntimeStore(f.db).context(replacement.context.token_id),
    ).rejects.toMatchObject({ code: "run-closed" });
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected fixture value");
  return value;
}
