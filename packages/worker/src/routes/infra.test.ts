import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

const listAllIncludingArchivedMock = vi.fn();
const getMock = vi.fn();
const getIncludingArchivedMock = vi.fn();
vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn().mockImplementation(
    class {
      listAllIncludingArchived = listAllIncludingArchivedMock;
      get = getMock;
      getIncludingArchived = getIncludingArchivedMock;
    } as unknown as () => unknown,
  ),
}));

const deleteManyMock = vi.fn();
const deleteByPrefixMock = vi.fn();
const headMock = vi.fn();
vi.mock("@tila/backend-r2", () => ({
  R2ArtifactBackend: vi.fn().mockImplementation(
    class {
      deleteMany = deleteManyMock;
      deleteByPrefix = deleteByPrefixMock;
      head = headMock;
    } as unknown as () => unknown,
  ),
}));

const { infra, requireInfraPrincipal, resolveTargetProject } = await import(
  "./infra"
);

type AppEnv = { Bindings: Env; Variables: HonoVariables };

function makeDONamespace(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => "id" }) as DurableObjectId,
    get: () => ({}) as DurableObjectStub,
    idFromString: () => ({ toString: () => "id" }) as DurableObjectId,
    newUniqueId: () => ({ toString: () => "id" }) as DurableObjectId,
    jurisdiction: () => ({}) as DurableObjectNamespace,
  } as unknown as DurableObjectNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Partial<Env> {
  return {
    DB: {} as D1Database,
    PROJECT: makeDONamespace(),
    ARTIFACTS: {} as R2Bucket,
    ...overrides,
  };
}

function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/_internal", infra);
  return app;
}

function destroyReq(
  app: Hono<AppEnv>,
  projectId: string,
  env: Partial<Env>,
  headers: Record<string, string> = {},
) {
  return app.request(
    `/_internal/projects/${projectId}/destroy`,
    { method: "POST", headers },
    env as Env,
  );
}

describe("infra destroy route", () => {
  beforeEach(() => {
    forwardToDOMock
      .mockReset()
      .mockResolvedValue(Response.json({ ok: true, keys: [] }));
    listAllIncludingArchivedMock.mockReset().mockResolvedValue([]);
    getMock
      .mockReset()
      .mockResolvedValue({ displayName: "Target", cloudflareAccountId: "acc" });
    getIncludingArchivedMock
      .mockReset()
      .mockResolvedValue({ displayName: "Target", cloudflareAccountId: "acc" });
    deleteManyMock.mockReset().mockResolvedValue({ deleted: 0, failed: [] });
    deleteByPrefixMock
      .mockReset()
      .mockResolvedValue({ deleted: 0, failed: [] });
    headMock.mockReset().mockResolvedValue(null);
  });

  it("returns 404 when INFRA_ADMIN_TOKEN is not configured", async () => {
    const app = createApp();
    const env = makeEnv(); // no INFRA_ADMIN_TOKEN

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer anything",
    });

    expect(res.status).toBe(404);
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token is missing", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await destroyReq(app, "proj-target", env); // no Authorization

    expect(res.status).toBe(403);
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token does not match", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer wrong-token",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("runs the destroy orchestration and returns 200 when the bearer matches", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });
    // Only this project exists, with one project-only blob.
    listAllIncludingArchivedMock.mockResolvedValue([
      { projectId: "proj-target" },
    ]);
    let call = 0;
    forwardToDOMock.mockImplementation(
      (_stub: unknown, path: string, method: string) => {
        if (path === "/admin/pointer-keys" && method === "GET") {
          call++;
          return Promise.resolve(
            Response.json({ keys: call === 1 ? ["produced/T-1/a.bin"] : [] }),
          );
        }
        if (path === "/admin/destroy" && method === "POST") {
          return Promise.resolve(Response.json({ ok: true }));
        }
        if (path === "/admin/store-counts" && method === "GET") {
          return Promise.resolve(
            Response.json({
              counts: { domain: { entities: 0 }, schemaHistory: 1 },
            }),
          );
        }
        return Promise.resolve(Response.json({ ok: true }));
      },
    );
    headMock.mockResolvedValue({ key: "produced/T-1/a.bin", size: 10 });
    deleteManyMock.mockResolvedValue({ deleted: 1, failed: [] });

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer s3cret-infra-token",
      "X-Confirm-Slug": "proj-target",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; doWiped: boolean };
    expect(body.ok).toBe(true);
    expect(body.doWiped).toBe(true);
    // The DO wipe must target the slug from the URL.
    expect(forwardToDOMock).toHaveBeenCalledWith(
      expect.anything(),
      "/admin/destroy",
      "POST",
    );
  });

  it("returns 400 without touching the DO when X-Confirm-Slug is missing", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer s3cret-infra-token",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIRM_SLUG_MISMATCH");
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("returns 400 without touching the DO when X-Confirm-Slug does not match the URL slug", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer s3cret-infra-token",
      "X-Confirm-Slug": "proj-WRONG",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIRM_SLUG_MISMATCH");
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("writes an audit datapoint tagged infra_destroy on a successful destroy", async () => {
    const writeDataPoint = vi.fn();
    const app = createApp();
    const env = makeEnv({
      INFRA_ADMIN_TOKEN: "s3cret-infra-token",
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });
    listAllIncludingArchivedMock.mockResolvedValue([
      { projectId: "proj-target" },
    ]);

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer s3cret-infra-token",
      "X-Confirm-Slug": "proj-target",
    });

    expect(res.status).toBe(200);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0][0] as {
      blobs: string[];
      doubles: number[];
    };
    expect(arg.blobs).toContain("infra_destroy");
    expect(arg.blobs).toContain("proj-target");
    expect(arg.doubles).toContain(200);
  });

  it("writes an audit datapoint when a bearer is rejected", async () => {
    const writeDataPoint = vi.fn();
    const app = createApp();
    const env = makeEnv({
      INFRA_ADMIN_TOKEN: "s3cret-infra-token",
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer wrong-token",
    });

    expect(res.status).toBe(403);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0][0] as { blobs: string[] };
    expect(arg.blobs).toContain("infra_destroy");
  });
});

describe("requireInfraPrincipal middleware", () => {
  // A minimal 2-route app guarded by the middleware. If the middleware passes,
  // the handlers respond 200 with a marker so we can prove the guard let through.
  function guardedApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("/guarded/*", requireInfraPrincipal);
    app.get("/guarded/one", (c) => c.json({ ok: true, route: "one" }));
    app.get("/guarded/two", (c) => c.json({ ok: true, route: "two" }));
    return app;
  }

  it("returns 404 when INFRA_ADMIN_TOKEN is unset (endpoint invisible)", async () => {
    const app = guardedApp();
    const env = makeEnv(); // no INFRA_ADMIN_TOKEN

    const res = await app.request(
      "/guarded/one",
      { method: "GET", headers: { Authorization: "Bearer anything" } },
      env as Env,
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 on a missing bearer", async () => {
    const app = guardedApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/guarded/one",
      { method: "GET" },
      env as Env,
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 403 on a wrong bearer", async () => {
    const app = guardedApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/guarded/two",
      { method: "GET", headers: { Authorization: "Bearer wrong-token" } },
      env as Env,
    );

    expect(res.status).toBe(403);
  });

  it("emits an auth-failure analytics datapoint on rejection", async () => {
    const writeDataPoint = vi.fn();
    const app = guardedApp();
    const env = makeEnv({
      INFRA_ADMIN_TOKEN: "s3cret-infra-token",
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    const res = await app.request(
      "/guarded/one",
      { method: "GET", headers: { Authorization: "Bearer wrong-token" } },
      env as Env,
    );

    expect(res.status).toBe(403);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0][0] as { blobs: string[] };
    expect(arg.blobs).toContain("infra_destroy");
  });

  it("calls next() (handler runs) when the bearer matches", async () => {
    const app = guardedApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/guarded/two",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string };
    expect(body.route).toBe("two");
  });
});

describe("resolveTargetProject middleware", () => {
  // A DO namespace whose idFromName is a spy, so the existence guard can be
  // proven to short-circuit BEFORE any DO is materialized.
  function makeSpyDONamespace(idFromName: ReturnType<typeof vi.fn>) {
    return {
      idFromName,
      get: () => ({}) as DurableObjectStub,
      idFromString: () => ({ toString: () => "id" }) as DurableObjectId,
      newUniqueId: () => ({ toString: () => "id" }) as DurableObjectId,
      jurisdiction: () => ({}) as DurableObjectNamespace,
    } as unknown as DurableObjectNamespace;
  }

  // A 2-route app: auth (requireInfraPrincipal) then existence (resolveTargetProject).
  // On pass-through, the handler echoes the resolved projectId so we can prove next() ran.
  function guardedApp(includeArchived?: boolean): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("/p/:projectId/*", requireInfraPrincipal);
    app.use(
      "/p/:projectId/*",
      resolveTargetProject(
        includeArchived ? { includeArchived: true } : undefined,
      ),
    );
    app.get("/p/:projectId/one", (c) =>
      c.json({ ok: true, route: "one", projectId: c.get("projectId") }),
    );
    app.get("/p/:projectId/two", (c) =>
      c.json({ ok: true, route: "two", projectId: c.get("projectId") }),
    );
    return app;
  }

  beforeEach(() => {
    forwardToDOMock.mockReset();
    getMock
      .mockReset()
      .mockResolvedValue({ displayName: "Target", cloudflareAccountId: "acc" });
    getIncludingArchivedMock
      .mockReset()
      .mockResolvedValue({ displayName: "Target", cloudflareAccountId: "acc" });
  });

  it("returns 404 PROJECT_NOT_FOUND without touching the DO when the slug is unknown", async () => {
    getMock.mockResolvedValue(null);
    const idFromName = vi.fn(
      () => ({ toString: () => "id" }) as DurableObjectId,
    );
    const app = guardedApp();
    const env = makeEnv({
      INFRA_ADMIN_TOKEN: "s3cret-infra-token",
      PROJECT: makeSpyDONamespace(idFromName),
    });

    const res = await app.request(
      "/p/proj-ghost/one",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
    expect(idFromName).not.toHaveBeenCalled();
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("emits a project-not-found analytics datapoint on an unknown slug", async () => {
    getMock.mockResolvedValue(null);
    const writeDataPoint = vi.fn();
    const app = guardedApp();
    const env = makeEnv({
      INFRA_ADMIN_TOKEN: "s3cret-infra-token",
      ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    });

    const res = await app.request(
      "/p/proj-ghost/one",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(404);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0][0] as {
      blobs: string[];
      doubles: number[];
    };
    expect(arg.blobs).toContain("project-not-found");
    expect(arg.doubles).toContain(404);
  });

  it("calls next() (handler runs) when the slug is known", async () => {
    const app = guardedApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/p/proj-target/two",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string; projectId: string };
    expect(body.route).toBe("two");
    expect(body.projectId).toBe("proj-target");
    expect(getMock).toHaveBeenCalledWith("proj-target");
  });

  it("returns 404 for an archived slug under the default (archived-excluding) guard", async () => {
    // Default guard uses get(), which filters archived → null.
    getMock.mockResolvedValue(null);
    const app = guardedApp();
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/p/proj-archived/one",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("reaches an archived slug when { includeArchived: true } is set", async () => {
    // get() would filter archived (null), but getIncludingArchived() finds it.
    getMock.mockResolvedValue(null);
    getIncludingArchivedMock.mockResolvedValue({
      displayName: "Archived",
      cloudflareAccountId: "acc",
    });
    const app = guardedApp(true);
    const env = makeEnv({ INFRA_ADMIN_TOKEN: "s3cret-infra-token" });

    const res = await app.request(
      "/p/proj-archived/two",
      {
        method: "GET",
        headers: { Authorization: "Bearer s3cret-infra-token" },
      },
      env as Env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { route: string; projectId: string };
    expect(body.route).toBe("two");
    expect(getIncludingArchivedMock).toHaveBeenCalledWith("proj-archived");
    expect(getMock).not.toHaveBeenCalled();
  });
});
