import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables } from "../types";

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

const listAllIncludingArchivedMock = vi.fn();
vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn().mockImplementation(
    class {
      listAllIncludingArchived = listAllIncludingArchivedMock;
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

const { infra } = await import("./infra");

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
    deleteManyMock.mockReset().mockResolvedValue({ deleted: 0, failed: [] });
    deleteByPrefixMock
      .mockReset()
      .mockResolvedValue({ deleted: 0, failed: [] });
    headMock.mockReset().mockResolvedValue(null);
  });

  it("returns 404 when INFRA_DESTROY_TOKEN is not configured", async () => {
    const app = createApp();
    const env = makeEnv(); // no INFRA_DESTROY_TOKEN

    const res = await destroyReq(app, "proj-target", env, {
      Authorization: "Bearer anything",
    });

    expect(res.status).toBe(404);
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token is missing", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_DESTROY_TOKEN: "s3cret-infra-token" });

    const res = await destroyReq(app, "proj-target", env); // no Authorization

    expect(res.status).toBe(403);
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  it("returns 403 when the bearer token does not match", async () => {
    const app = createApp();
    const env = makeEnv({ INFRA_DESTROY_TOKEN: "s3cret-infra-token" });

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
    const env = makeEnv({ INFRA_DESTROY_TOKEN: "s3cret-infra-token" });
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
    const env = makeEnv({ INFRA_DESTROY_TOKEN: "s3cret-infra-token" });

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
    const env = makeEnv({ INFRA_DESTROY_TOKEN: "s3cret-infra-token" });

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
      INFRA_DESTROY_TOKEN: "s3cret-infra-token",
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
      INFRA_DESTROY_TOKEN: "s3cret-infra-token",
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
