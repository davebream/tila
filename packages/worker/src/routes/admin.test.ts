import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

const forwardToDOMock = vi.fn();

vi.mock("../lib/do-forward", () => ({
  forwardToDO: (...args: unknown[]) => forwardToDOMock(...args),
}));

// Mock D1ProjectRegistry + D1RevokedJtiStore
const listAllIncludingArchivedMock = vi.fn();
const mockRevokedJtiRevoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tila/backend-d1", () => ({
  D1ProjectRegistry: vi.fn().mockImplementation(
    class {
      listAllIncludingArchived = listAllIncludingArchivedMock;
    } as unknown as () => unknown,
  ),
  D1RevokedJtiStore: vi.fn().mockImplementation(
    class {
      revoke = mockRevokedJtiRevoke;
      isRevoked = vi.fn().mockResolvedValue(false);
    } as unknown as () => unknown,
  ),
}));

// Mock revokeJtiInCache from auth middleware (side-effect call in admin route)
const mockRevokeJtiInCache = vi.fn();
vi.mock("../middleware/auth", () => ({
  revokeJtiInCache: (...args: unknown[]) => mockRevokeJtiInCache(...args),
  requireD1Token: vi
    .fn()
    .mockImplementation((_c: unknown, next: () => Promise<void>) => next()),
}));

// Mock R2ArtifactBackend
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

const { admin } = await import("./admin");

type AppEnv = { Bindings: Env; Variables: HonoVariables };

/** Creates a stub DurableObjectNamespace whose .get() returns a new empty stub */
function makeDONamespace(): DurableObjectNamespace {
  return {
    idFromName: () => ({ toString: () => "id" }) as DurableObjectId,
    get: () => ({}) as DurableObjectStub,
    idFromString: () => ({ toString: () => "id" }) as DurableObjectId,
    newUniqueId: () => ({ toString: () => "id" }) as DurableObjectId,
    jurisdiction: () => ({}) as DurableObjectNamespace,
  } as unknown as DurableObjectNamespace;
}

const mockEnv: Partial<Env> = {
  DB: {} as D1Database,
  PROJECT: makeDONamespace(),
  ARTIFACTS: {} as R2Bucket,
};

function makeTokenResult(
  tokenKind: UnifiedTokenResult["kind"],
  scopes: string,
): UnifiedTokenResult {
  if (tokenKind === "session") {
    return {
      kind: "session",
      projectId: "proj-target",
      name: "user",
      scopes,
      tokenId: "tid_session",
      githubRepoId: 1,
      githubLogin: "user",
      permission: "admin",
      expiresAt: Date.now() + 3600000,
    };
  }
  return {
    kind: "d1-token",
    projectId: "proj-target",
    name: "admin-agent",
    scopes,
    tokenId: "tid_test",
  };
}

function createApp(
  scopes: string,
  tokenKind: UnifiedTokenResult["kind"] = "d1-token",
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("doStub", {} as DurableObjectStub);
    c.set("projectId", "proj-target");
    c.set("tokenResult", makeTokenResult(tokenKind, scopes));
    await next();
  });
  app.route("/admin", admin);
  return app;
}

/** Make a request, injecting mockEnv via Hono's 3rd fetch argument */
function req(
  app: Hono<AppEnv>,
  path: string,
  method = "GET",
  env: Partial<Env> = mockEnv,
) {
  return app.request(path, { method }, env as Env);
}

describe("project admin routes", () => {
  beforeEach(() => {
    forwardToDOMock.mockReset();
    listAllIncludingArchivedMock.mockReset();
    deleteManyMock.mockReset();
    deleteByPrefixMock.mockReset();
    headMock.mockReset();

    // Default: DO responds ok
    forwardToDOMock.mockResolvedValue(Response.json({ ok: true }));
    // Default: no other projects
    listAllIncludingArchivedMock.mockResolvedValue([]);
    // Default: deleteMany / deleteByPrefix succeed
    deleteManyMock.mockResolvedValue({ deleted: 0, failed: [] });
    deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });
    // Default: head returns null (object not found)
    headMock.mockResolvedValue(null);
  });

  it("forwards restart to the project DO for full-scope tokens", async () => {
    const app = createApp("full");

    const res = await req(app, "/admin/restart", "POST");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(forwardToDOMock).toHaveBeenCalledWith(
      expect.anything(),
      "/admin/restart",
      "POST",
    );
  });

  it("blocks restart for non-admin tokens", async () => {
    const app = createApp("read");

    const res = await req(app, "/admin/restart", "POST");

    expect(res.status).toBe(403);
    expect(forwardToDOMock).not.toHaveBeenCalled();
  });

  describe("GET /admin/store-counts", () => {
    it("forwards to DO for full-scope d1-token and returns counts", async () => {
      const counts = {
        domain: { entities: 0, fences: 0 },
        schemaHistory: 0,
      };
      forwardToDOMock.mockResolvedValueOnce(Response.json({ counts }));

      const app = createApp("full", "d1-token");
      const res = await req(app, "/admin/store-counts", "GET");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ counts });
      expect(forwardToDOMock).toHaveBeenCalledWith(
        expect.anything(),
        "/admin/store-counts",
        "GET",
      );
    });

    it("returns 403 for admin session token (non-d1-token)", async () => {
      const app = createApp("full", "session");
      const res = await req(app, "/admin/store-counts", "GET");

      expect(res.status).toBe(403);
      expect(forwardToDOMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /admin/destroy", () => {
    /**
     * Set up the forwardToDO mock for a full destroy cycle.
     * Call order:
     *   1. GET /admin/pointer-keys → target keys
     *   2. (per peer project) GET /admin/pointer-keys → peer keys
     *   3. POST /admin/destroy → ok (abort severs connection — treat as success)
     *   4. GET /admin/store-counts → all-zero counts (post-reconstruct)
     */
    function setupDestroyMocks({
      targetKeys = [] as string[],
      peerKeysList = [] as string[][],
      destroyResponse = Response.json({ ok: true }),
      storeCountsResponse = Response.json({
        counts: {
          domain: {
            entities: 0,
            fences: 0,
            claims: 0,
            records: 0,
            artifact_pointers: 0,
            entity_relationships: 0,
            journal: 0,
            gates: 0,
            signals: 0,
            presence: 0,
            entity_artifact_references: 0,
            artifact_relationships: 0,
            _journal_archive_watermark: 0,
            record_tags: 0,
            record_revisions: 0,
            artifact_search_docs: 0,
            entity_search_docs: 0,
            record_search_docs: 0,
          },
          schemaHistory: 1,
        },
      }),
    } = {}) {
      let peerCallCount = 0;
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, method: string) => {
          if (path === "/admin/pointer-keys" && method === "GET") {
            const isFirstCall = peerCallCount === 0;
            peerCallCount++;
            if (isFirstCall) {
              // First call = target project keys
              return Promise.resolve(Response.json({ keys: targetKeys }));
            }
            // Subsequent = peer project keys
            const peerIdx = peerCallCount - 2;
            return Promise.resolve(
              Response.json({ keys: peerKeysList[peerIdx] ?? [] }),
            );
          }
          if (path === "/admin/destroy" && method === "POST") {
            return Promise.resolve(destroyResponse);
          }
          if (path === "/admin/store-counts" && method === "GET") {
            return Promise.resolve(storeCountsResponse);
          }
          return Promise.resolve(Response.json({ ok: true }));
        },
      );
    }

    it("returns 403 for admin session token (non-d1-token)", async () => {
      const app = createApp("full", "session");
      const res = await req(app, "/admin/destroy", "POST");
      expect(res.status).toBe(403);
      expect(forwardToDOMock).not.toHaveBeenCalled();
    });

    it("(a) keeps shared blob referenced by another live project", async () => {
      const sharedKey = "sources/abc123.bin";
      const targetOnlyKey = "produced/T-1/abc.bin";

      setupDestroyMocks({
        targetKeys: [sharedKey, targetOnlyKey],
        peerKeysList: [[sharedKey]],
      });
      listAllIncludingArchivedMock.mockResolvedValue([
        { projectId: "proj-peer-live" },
        { projectId: "proj-target" }, // target itself — filtered out
      ]);
      // head confirms the target-only key still exists
      headMock.mockResolvedValue({ key: targetOnlyKey, size: 100 });
      deleteManyMock.mockResolvedValue({ deleted: 1, failed: [] });
      deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });

      const app = createApp("full");
      const res = await req(app, "/admin/destroy", "POST");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        r2Deleted: number;
        r2Kept: number;
        ok: boolean;
      };
      expect(body.ok).toBe(true);
      // Only targetOnlyKey deleted; sharedKey kept
      expect(body.r2Deleted).toBe(1);
      expect(body.r2Kept).toBe(1);
      expect(deleteManyMock).toHaveBeenCalledWith([targetOnlyKey]);
    });

    it("(b) keeps shared blob referenced only by an archived project", async () => {
      const sharedKey = "sources/archived-shared.bin";
      const targetOnlyKey = "produced/T-2/xyz.bin";

      setupDestroyMocks({
        targetKeys: [sharedKey, targetOnlyKey],
        peerKeysList: [[sharedKey]], // archived project references the blob
      });
      // The peer project is ARCHIVED — listAllIncludingArchived returns it
      listAllIncludingArchivedMock.mockResolvedValue([
        { projectId: "proj-peer-archived" }, // archived but not yet destroyed
        { projectId: "proj-target" },
      ]);
      headMock.mockResolvedValue({ key: targetOnlyKey, size: 50 });
      deleteManyMock.mockResolvedValue({ deleted: 1, failed: [] });
      deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });

      const app = createApp("full");
      const res = await req(app, "/admin/destroy", "POST");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        r2Deleted: number;
        r2Kept: number;
        ok: boolean;
      };
      expect(body.ok).toBe(true);
      // sharedKey must be kept — archived project still holds a pointer to it
      expect(body.r2Kept).toBe(1);
      expect(deleteManyMock).toHaveBeenCalledWith([targetOnlyKey]);
    });

    it("(c) deletes blob referenced only by the target project", async () => {
      const targetOnlyKey = "produced/T-3/only-here.bin";

      setupDestroyMocks({
        targetKeys: [targetOnlyKey],
        peerKeysList: [], // no peers
      });
      listAllIncludingArchivedMock.mockResolvedValue([
        { projectId: "proj-target" },
      ]);
      headMock.mockResolvedValue({ key: targetOnlyKey, size: 200 });
      deleteManyMock.mockResolvedValue({ deleted: 1, failed: [] });
      deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });

      const app = createApp("full");
      const res = await req(app, "/admin/destroy", "POST");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { r2Deleted: number; ok: boolean };
      expect(body.ok).toBe(true);
      expect(body.r2Deleted).toBe(1);
      expect(deleteManyMock).toHaveBeenCalledWith([targetOnlyKey]);
    });

    it("(d) sets r2GcSkipped when subrequest counter exceeds ceiling, but DO wipe + journal delete still run", async () => {
      // Create enough peer projects that iterating all of them would exceed the
      // subrequest ceiling (~800). Each peer DO fetch = 1 subrequest.
      const MANY_PEERS = 900;
      const peerProjects = Array.from({ length: MANY_PEERS }, (_, i) => ({
        projectId: `proj-peer-${i}`,
      }));
      listAllIncludingArchivedMock.mockResolvedValue([
        ...peerProjects,
        { projectId: "proj-target" },
      ]);

      setupDestroyMocks({
        targetKeys: ["sources/some.bin"],
        peerKeysList: peerProjects.map(() => ["sources/shared.bin"]),
      });
      deleteByPrefixMock.mockResolvedValue({ deleted: 5, failed: [] });

      const app = createApp("full");
      const res = await req(app, "/admin/destroy", "POST");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        r2GcSkipped: boolean;
        doWiped: boolean;
        journalDeleted: number;
        ok: boolean;
      };
      expect(body.r2GcSkipped).toBe(true);
      // DO wipe must still happen
      expect(body.doWiped).toBe(true);
      // Journal delete must still happen
      expect(deleteByPrefixMock).toHaveBeenCalledWith(
        "journal-archive/proj-target/",
      );
    });

    it("(e) returns 502 and skips R2 deletion when a peer DO pointer-key fetch fails (fail-closed)", async () => {
      // Target has a pointer key; one other project exists whose DO returns 500.
      // The handler must NOT call deleteMany — under-counting the union risks
      // deleting blobs the failing peer still needs (data corruption).
      const targetKey = "produced/T-peer-fail/blob.bin";

      listAllIncludingArchivedMock.mockResolvedValue([
        { projectId: "proj-target" },
        { projectId: "proj-peer-bad" },
      ]);

      let peerCallCount = 0;
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, method: string) => {
          if (path === "/admin/pointer-keys" && method === "GET") {
            const isFirst = peerCallCount === 0;
            peerCallCount++;
            if (isFirst) {
              // First call = target project keys
              return Promise.resolve(Response.json({ keys: [targetKey] }));
            }
            // Peer DO returns a non-ok response
            return Promise.resolve(
              new Response(JSON.stringify({ ok: false }), { status: 500 }),
            );
          }
          return Promise.resolve(Response.json({ ok: true }));
        },
      );
      deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });

      const app = createApp("full", "d1-token");
      const res = await req(app, "/admin/destroy", "POST");

      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("PEER_POINTER_KEYS_FETCH_FAILED");
      // deleteMany must NOT be called — corrupting shared blobs is not acceptable
      expect(deleteManyMock).not.toHaveBeenCalled();
    });

    it("(g) surfaces failure when DO destroy returns a non-ok body", async () => {
      setupDestroyMocks({
        targetKeys: [],
        peerKeysList: [],
        destroyResponse: Response.json(
          { ok: false, error: { code: "DESTROY_FAILED" } },
          { status: 500 },
        ),
      });
      listAllIncludingArchivedMock.mockResolvedValue([
        { projectId: "proj-target" },
      ]);
      deleteByPrefixMock.mockResolvedValue({ deleted: 0, failed: [] });

      const app = createApp("full");
      const res = await req(app, "/admin/destroy", "POST");

      // A non-ok DO response is a real failure — not silent success
      expect(res.status).toBe(502);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // RC-2 — archive/journal route (characterization, pre-extraction)
  //
  // The route is a 4-step orchestration:
  //   1. forwardToDO("/journal/archive")  → DO ArchiveResponse { ok, events, throughSeq, count }
  //   2. count === 0 → early-return { ok:true, archived:0 } (no R2, no confirm)
  //   3. ARTIFACTS.put(...) per year/month group; throw → 502 R2_ERROR
  //   4. forwardToDO("/journal/archive/confirm") non-ok → 502 CONFIRM_ERROR;
  //      ok → { ok:true, archived:<count>, throughSeq, watermark }
  //
  // NOTE: the DO returns `count`; the route RENAMES it to `archived`. The mocks
  // below return the DO ArchiveResponse shape (with `count`), never `archived`.
  // The R2 write uses c.env.ARTIFACTS.put directly, so each test injects an
  // ARTIFACTS binding with a put() mock.
  // ---------------------------------------------------------------------------
  describe("POST /admin/archive/journal", () => {
    const baseEvent = {
      seq: 1,
      t: Date.parse("2026-03-15T10:00:00Z"),
      kind: "entity.created",
      resource: "task:T-1",
      actor: "agent",
      token_id: "tid",
      fence: 1,
      data: {},
      source: null,
      source_version: null,
    };

    /** Build an env whose ARTIFACTS.put is the supplied mock. */
    function envWithR2Put(put: ReturnType<typeof vi.fn>): Partial<Env> {
      return { ...mockEnv, ARTIFACTS: { put } as unknown as R2Bucket };
    }

    it("returns 403 for admin session token (non-d1-token)", async () => {
      const putMock = vi.fn();
      const app = createApp("full", "session");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(403);
      // No DO forward, no R2 write — rejected before orchestration
      expect(forwardToDOMock).not.toHaveBeenCalled();
      expect(putMock).not.toHaveBeenCalled();
    });

    it("accepts a full-scope d1-token", async () => {
      const putMock = vi.fn().mockResolvedValue(undefined);
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, _method: string) => {
          if (path === "/journal/archive") {
            return Promise.resolve(
              Response.json({
                ok: true,
                events: [],
                throughSeq: 0,
                count: 0,
              }),
            );
          }
          return Promise.resolve(Response.json({ ok: true, watermark: null }));
        },
      );

      const app = createApp("full", "d1-token");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(200);
    });

    it("(1) early-returns archived:0 without writing R2 or confirming when count is 0", async () => {
      const putMock = vi.fn();
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, _method: string) => {
          if (path === "/journal/archive") {
            return Promise.resolve(
              Response.json({
                ok: true,
                events: [],
                throughSeq: 0,
                count: 0,
              }),
            );
          }
          // confirm should never be reached in this branch
          return Promise.resolve(Response.json({ ok: true, watermark: null }));
        },
      );

      const app = createApp("full");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, archived: 0 });
      // No R2 write, no confirm forward
      expect(putMock).not.toHaveBeenCalled();
      expect(forwardToDOMock).toHaveBeenCalledTimes(1);
      expect(forwardToDOMock).toHaveBeenCalledWith(
        expect.anything(),
        "/journal/archive",
        "POST",
      );
    });

    it("(2) returns 502 R2_ERROR when the R2 write throws (count > 0)", async () => {
      const putMock = vi.fn().mockRejectedValue(new Error("R2 down"));
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, _method: string) => {
          if (path === "/journal/archive") {
            return Promise.resolve(
              Response.json({
                ok: true,
                events: [baseEvent],
                throughSeq: 1,
                count: 1,
              }),
            );
          }
          return Promise.resolve(Response.json({ ok: true, watermark: null }));
        },
      );

      const app = createApp("full");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("R2_ERROR");
      // R2 put was attempted; confirm was never reached
      expect(putMock).toHaveBeenCalled();
      expect(forwardToDOMock).not.toHaveBeenCalledWith(
        expect.anything(),
        "/journal/archive/confirm",
        "POST",
        expect.anything(),
      );
    });

    it("(3) returns 502 CONFIRM_ERROR when R2 write succeeds but confirm is non-ok", async () => {
      const putMock = vi.fn().mockResolvedValue(undefined);
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, _method: string) => {
          if (path === "/journal/archive") {
            return Promise.resolve(
              Response.json({
                ok: true,
                events: [baseEvent],
                throughSeq: 1,
                count: 1,
              }),
            );
          }
          if (path === "/journal/archive/confirm") {
            return Promise.resolve(
              new Response(JSON.stringify({ ok: false }), { status: 500 }),
            );
          }
          return Promise.resolve(Response.json({ ok: true }));
        },
      );

      const app = createApp("full");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as {
        ok: boolean;
        error: { code: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CONFIRM_ERROR");
      // R2 write succeeded before confirm failed
      expect(putMock).toHaveBeenCalled();
    });

    it("(4) returns archived === DO count with throughSeq + watermark on success", async () => {
      const putMock = vi.fn().mockResolvedValue(undefined);
      const watermark = { lastArchivedSeq: 2, archivedAt: 1_700_000_000_000 };
      // Two events in different months → two R2 groups (two put calls).
      const events = [
        { ...baseEvent, seq: 1, t: Date.parse("2026-03-15T10:00:00Z") },
        { ...baseEvent, seq: 2, t: Date.parse("2026-04-01T10:00:00Z") },
      ];
      forwardToDOMock.mockImplementation(
        (_stub: unknown, path: string, _method: string) => {
          if (path === "/journal/archive") {
            return Promise.resolve(
              Response.json({
                ok: true,
                events,
                throughSeq: 2,
                count: 2,
              }),
            );
          }
          if (path === "/journal/archive/confirm") {
            return Promise.resolve(Response.json({ ok: true, watermark }));
          }
          return Promise.resolve(Response.json({ ok: true }));
        },
      );

      const app = createApp("full");
      const res = await req(
        app,
        "/admin/archive/journal",
        "POST",
        envWithR2Put(putMock),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        archived: 2,
        throughSeq: 2,
        watermark,
      });
      // archived mirrors the DO's `count` (2), not an `archived` field on the DO response
      // Two distinct year/month groups → two R2 puts
      expect(putMock).toHaveBeenCalledTimes(2);
      expect(putMock).toHaveBeenCalledWith(
        "journal-archive/proj-target/2026/03.jsonl",
        expect.any(String),
      );
      expect(putMock).toHaveBeenCalledWith(
        "journal-archive/proj-target/2026/04.jsonl",
        expect.any(String),
      );
      // confirm was forwarded with throughSeq
      expect(forwardToDOMock).toHaveBeenCalledWith(
        expect.anything(),
        "/journal/archive/confirm",
        "POST",
        { throughSeq: 2 },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // C9 — admin session revoke route
  // ---------------------------------------------------------------------------
  describe("POST /admin/sessions/revoke", () => {
    const validJti = "123e4567-e89b-12d3-a456-426614174000";

    beforeEach(() => {
      mockRevokedJtiRevoke.mockReset().mockResolvedValue(undefined);
      mockRevokeJtiInCache.mockReset();
    });

    it("returns 403 when caller does not have admin permission", async () => {
      const app = createApp("read");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: validJti }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(403);
    });

    it("returns 403 for admin session token (non-d1-token)", async () => {
      const app = createApp("full", "session");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: validJti }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(403);
      // Rejected before the global jti kill-switch fires
      expect(mockRevokedJtiRevoke).not.toHaveBeenCalled();
      expect(mockRevokeJtiInCache).not.toHaveBeenCalled();
    });

    it("accepts a full-scope d1-token", async () => {
      const app = createApp("full", "d1-token");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: validJti }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(200);
      expect(mockRevokedJtiRevoke).toHaveBeenCalledWith(
        validJti,
        "proj-target",
      );
    });

    it("returns 400 on missing jti field", async () => {
      const app = createApp("full");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 on invalid JSON body", async () => {
      const app = createApp("full");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("revokes jti in D1 and cache, returns 200", async () => {
      const app = createApp("full");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: validJti }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; jti: string };
      expect(body.ok).toBe(true);
      expect(body.jti).toBe(validJti);

      // D1 store revoke was called
      expect(mockRevokedJtiRevoke).toHaveBeenCalledWith(
        validJti,
        "proj-target",
      );
      // In-isolate cache was immediately invalidated
      expect(mockRevokeJtiInCache).toHaveBeenCalledWith(validJti);
    });

    it("returns 400 when jti is not a UUID", async () => {
      const app = createApp("full");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: "not-a-uuid" }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(400);
    });

    it("requires admin permission (write scope is insufficient)", async () => {
      const app = createApp("write");
      const res = await app.request(
        "/admin/sessions/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jti: validJti }),
        },
        mockEnv as Env,
      );
      expect(res.status).toBe(403);
    });
  });
});
