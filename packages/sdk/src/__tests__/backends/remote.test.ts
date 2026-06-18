import { beforeEach, describe, expect, it, vi } from "vitest";
import { TilaApiError, type TilaClient } from "../../client";

// Build a mock TilaClient. We only mock the methods RemoteBackend calls.
function createMockClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
    request: vi.fn(),
    requestRaw: vi.fn(),
    postFormData: vi.fn(),
  };
}

type MockClient = ReturnType<typeof createMockClient>;

// Lazy imports so test modules load after any necessary setup
async function createBackend(client: MockClient) {
  const { RemoteBackend } = await import("../../backends/remote");
  return new RemoteBackend(client as unknown as TilaClient, "proj-test");
}

async function createArtifactBackend(client: MockClient) {
  const { RemoteArtifactBackend } = await import("../../backends/remote");
  return new RemoteArtifactBackend(
    client as unknown as TilaClient,
    "proj-test",
  );
}

async function createRecordBackend(client: MockClient) {
  const { RemoteRecordBackend } = await import("../../backends/remote");
  return new RemoteRecordBackend(client as unknown as TilaClient, "proj-test");
}

/** A wire RecordItem (no fence) for record get/mutate response envelopes. */
function recordItem(over: Record<string, unknown> = {}) {
  return {
    type: "service",
    key: "api",
    schema_version: 1,
    value: { host: "localhost" },
    value_sha256: "abc",
    revision: 1,
    archived: 0,
    created_at: 1000,
    updated_at: 1000,
    updated_by: "cli",
    tags: [],
    ...over,
  };
}

describe("RemoteBackend", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  describe("EntityBackend", () => {
    it("create() unwraps entity from envelope", async () => {
      const entity = {
        id: "T-1",
        type: "task",
        schema_version: 1,
        data: { title: "Test" },
        archived: 0,
        created_at: 1000,
        updated_at: 1000,
        created_by: "cli",
      };
      client.post.mockResolvedValue({ ok: true, entity });

      const backend = await createBackend(client);
      const result = await backend.create({
        id: "T-1",
        type: "task",
        data: { title: "Test" },
        created_by: "cli",
      });

      expect(result).toEqual(entity);
      expect(client.post).toHaveBeenCalledWith(
        "/projects/proj-test/tasks",
        { id: "T-1", type: "task", data: { title: "Test" }, created_by: "cli" },
        expect.anything(),
      );
    });

    it("get() returns null on 404", async () => {
      client.get.mockRejectedValue(
        new TilaApiError(404, "not-found", "Not found", false),
      );

      const backend = await createBackend(client);
      const result = await backend.get("T-missing");

      expect(result).toBeNull();
    });

    it("get() throws non-404 errors", async () => {
      client.get.mockRejectedValue(
        new TilaApiError(500, "internal", "Server error", false),
      );

      const backend = await createBackend(client);
      await expect(backend.get("T-1")).rejects.toThrow("Server error");
    });

    it("list() flattens dataFilter keys to query params", async () => {
      client.get.mockResolvedValue({
        ok: true,
        entities: [],
        total: 0,
        limit: null,
        offset: 0,
        has_more: false,
      });

      const backend = await createBackend(client);
      await backend.list({
        type: "task",
        dataFilter: { status: "open" },
      });

      expect(client.get).toHaveBeenCalledWith(
        "/projects/proj-test/tasks",
        expect.objectContaining({
          query: { type: "task", status: "open" },
        }),
      );
    });

    it("list() translates the parent_id data-field key to the Worker's `parent` query param", async () => {
      // REGRESSION GUARD: EntityBackend.list dataFilter keys are DATA-FIELD
      // names (parent_id). The Worker list route only reads `parent` (the DO
      // maps it back to dataFilter.parent_id). Sending `parent_id` verbatim
      // would be silently ignored -> ALL tasks returned. Assert the outgoing
      // query carries `parent`, NOT `parent_id`.
      client.get.mockResolvedValue({
        ok: true,
        entities: [],
        total: 0,
        limit: null,
        offset: 0,
        has_more: false,
      });

      const backend = await createBackend(client);
      await backend.list({
        type: "task",
        dataFilter: { parent_id: "P-1" },
      });

      const [, opts] = client.get.mock.calls[0];
      const query = (opts as { query: Record<string, string> }).query;
      expect(query.parent).toBe("P-1");
      expect(query).not.toHaveProperty("parent_id");
    });

    it("list() serializes sort, order, limit, offset to query params", async () => {
      client.get.mockResolvedValue({
        ok: true,
        entities: [],
        total: 0,
        limit: 10,
        offset: 20,
        has_more: false,
      });

      const backend = await createBackend(client);
      await backend.list({
        type: "task",
        sort: "created_at",
        order: "desc",
        limit: 10,
        offset: 20,
      });

      expect(client.get).toHaveBeenCalledWith(
        "/projects/proj-test/tasks",
        expect.objectContaining({
          query: {
            type: "task",
            sort: "created_at",
            order: "desc",
            limit: "10",
            offset: "20",
          },
        }),
      );
    });

    it("list() omits sort/order/limit/offset when not provided", async () => {
      client.get.mockResolvedValue({
        ok: true,
        entities: [],
        total: 0,
        limit: null,
        offset: 0,
        has_more: false,
      });

      const backend = await createBackend(client);
      await backend.list({ type: "task" });

      const callArgs = client.get.mock.calls[0][1] as {
        query: Record<string, unknown>;
      };
      expect(callArgs.query).not.toHaveProperty("sort");
      expect(callArgs.query).not.toHaveProperty("order");
      expect(callArgs.query).not.toHaveProperty("limit");
      expect(callArgs.query).not.toHaveProperty("offset");
    });

    it("list() returns entities array from paginated response", async () => {
      const entity = {
        id: "T-1",
        type: "task",
        schema_version: 1,
        data: { title: "Test", status: "open" },
        archived: 0,
        created_at: 1000,
        updated_at: 1000,
        created_by: "cli",
      };
      client.get.mockResolvedValue({
        ok: true,
        entities: [entity],
        total: 1,
        limit: null,
        offset: 0,
        has_more: false,
      });

      const backend = await createBackend(client);
      const result = await backend.list({ type: "task" });

      expect(result).toEqual([entity]);
    });

    it("update() unwraps entity from envelope", async () => {
      const entity = {
        id: "T-1",
        type: "task",
        schema_version: 1,
        data: { title: "Updated" },
        archived: 0,
        created_at: 1000,
        updated_at: 2000,
        created_by: "cli",
      };
      // update() auto-acquires a fence before patching, then releases after.
      // Mock post to return acquire response first, then release response.
      client.post
        .mockResolvedValueOnce({ ok: true, fence: 10, expires_at: 9999 }) // acquire
        .mockResolvedValueOnce({ ok: true }); // release
      client.patch.mockResolvedValue({ ok: true, entity });

      const backend = await createBackend(client);
      const result = await backend.update("T-1", { title: "Updated" });

      expect(result).toEqual(entity);
    });

    it("archive() calls correct endpoint", async () => {
      // archive() auto-acquires a fence before archiving
      client.post
        .mockResolvedValueOnce({ ok: true, fence: 10, expires_at: 9999 }) // acquire
        .mockResolvedValueOnce({ ok: true }); // archive

      const backend = await createBackend(client);
      await backend.archive("T-1");

      expect(client.post).toHaveBeenCalledWith(
        "/projects/proj-test/tasks/T-1/archive",
        { fence: 10 },
        expect.anything(),
      );
    });
  });

  describe("CoordinationBackend", () => {
    it("acquire() maps response to AcquireResult", async () => {
      client.post.mockResolvedValue({
        ok: true,
        fence: 42,
        expires_at: 9999,
      });

      const backend = await createBackend(client);
      const result = await backend.acquire(
        "task:T-1",
        "agent-1",
        "agent-1",
        "exclusive",
        300_000,
      );

      expect(result).toEqual({
        acquired: true,
        fence: 42,
        expires_at: 9999,
      });
    });

    it("renew() returns {renewed:true, expires_at} on success", async () => {
      client.post.mockResolvedValue({ ok: true, expires_at: 9999 });

      const backend = await createBackend(client);
      const result = await backend.renew(
        "task:T-1",
        "agent-1",
        "agent-1",
        42,
        300_000,
      );

      // Returns the REAL stored expires_at from the response, not a recompute.
      expect(result).toEqual({ renewed: true, expires_at: 9999 });
      // machine/user are NOT forwarded to the Worker endpoint
      expect(client.post).toHaveBeenCalledWith(
        "/projects/proj-test/claims/renew",
        { resource: "task:T-1", fence: 42, ttl_ms: 300_000 },
        expect.anything(),
      );
    });

    it("state() returns null when unclaimed", async () => {
      client.get.mockResolvedValue({ ok: true, claim: null });

      const backend = await createBackend(client);
      const result = await backend.state("task:T-1");

      expect(result).toBeNull();
    });

    it("listPresence() strips active field", async () => {
      client.get.mockResolvedValue({
        ok: true,
        machines: [
          {
            machine: "host-1",
            last_seen: 1000,
            info: {},
            active: true,
          },
        ],
      });

      const backend = await createBackend(client);
      const result = await backend.listPresence();

      expect(result).toEqual([
        { machine: "host-1", last_seen: 1000, info: {} },
      ]);
      // active field should NOT be in the result
      expect(result[0]).not.toHaveProperty("active");
    });
  });
});

describe("RemoteArtifactBackend", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  describe("ArtifactBackend", () => {
    it("put() calls postFormData and returns key + bytes + deduplicated", async () => {
      client.postFormData.mockResolvedValue({
        ok: true,
        key: "produced/T-1/abc123.md",
        bytes: 42,
        deduplicated: false,
      });

      const backend = await createArtifactBackend(client);
      const result = await backend.put({
        key: "placeholder",
        body: "file content",
        sha256: "",
        metadata: {},
        contentType: "text/markdown",
        kind: "document",
        resource: "T-1",
        fence: 5,
      });

      expect(result).toEqual({
        key: "produced/T-1/abc123.md",
        bytes: 42,
        deduplicated: false,
      });
      expect(client.postFormData).toHaveBeenCalledWith(
        "/projects/proj-test/artifacts",
        expect.any(FormData),
        expect.objectContaining({ validate: true }),
      );

      // Verify FormData contains routing fields
      const formData = client.postFormData.mock.calls[0][1] as FormData;
      expect(formData.get("kind")).toBe("document");
      expect(formData.get("resource")).toBe("T-1");
      expect(formData.get("fence")).toBe("5");
    });

    it("get() returns body, contentType, metadata on 200", async () => {
      const mockBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("file content"));
          controller.close();
        },
      });
      client.requestRaw.mockResolvedValue(
        new Response(mockBody, {
          status: 200,
          headers: { "Content-Type": "text/markdown" },
        }),
      );

      const backend = await createArtifactBackend(client);
      const result = await backend.get("produced/T-1/abc123.md");

      expect(result).not.toBeNull();
      expect(result?.contentType).toBe("text/markdown");
      expect(result?.metadata).toEqual({});

      // Verify body is readable
      const text = await new Response(result?.body).text();
      expect(text).toBe("file content");

      expect(client.requestRaw).toHaveBeenCalledWith(
        "GET",
        "/projects/proj-test/artifacts/produced%2FT-1%2Fabc123.md",
      );
    });

    it("get() returns null on 404", async () => {
      client.requestRaw.mockResolvedValue(new Response(null, { status: 404 }));

      const backend = await createArtifactBackend(client);
      const result = await backend.get("missing/key");

      expect(result).toBeNull();
    });

    it("list() maps pointers to key+size", async () => {
      client.get.mockResolvedValue({
        ok: true,
        pointers: [{ r2_key: "foo/bar.md", bytes: 512 }],
      });

      const backend = await createArtifactBackend(client);
      const result = await backend.list("foo/");

      expect(result).toEqual([{ key: "foo/bar.md", size: 512 }]);
      expect(client.get).toHaveBeenCalledWith(
        "/projects/proj-test/artifacts",
        expect.objectContaining({
          query: { resource: "foo/" },
        }),
      );
    });

    it("delete() calls correct endpoint", async () => {
      client.delete.mockResolvedValue({ ok: true });

      const backend = await createArtifactBackend(client);
      await backend.delete("foo/bar.md");

      expect(client.delete).toHaveBeenCalledWith(
        "/projects/proj-test/artifacts/foo%2Fbar.md",
        expect.anything(),
      );
    });

    it("delete() accepts response with r2_orphaned field", async () => {
      client.delete.mockResolvedValue({ ok: true, r2_orphaned: true });

      const backend = await createArtifactBackend(client);
      // Should not throw even with the extra field
      await expect(backend.delete("foo/bar.md")).resolves.toBeUndefined();
    });
  });

  describe("EntityBackend relationships", () => {
    it("addRelationship() posts to /tasks/relationships and returns created", async () => {
      client.post.mockResolvedValue({ ok: true, created: true });

      const backend = await createBackend(client);
      const result = await backend.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });

      expect(result).toEqual({ created: true });
      expect(client.post).toHaveBeenCalledWith(
        "/projects/proj-test/tasks/relationships",
        { from_id: "A", to_id: "B", type: "blocks" },
        expect.anything(),
      );
    });

    it("addRelationship() defaults created to true when the response omits it", async () => {
      client.post.mockResolvedValue({ ok: true });

      const backend = await createBackend(client);
      const result = await backend.addRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });

      expect(result).toEqual({ created: true });
    });

    it("listRelationships() sends only defined query keys and returns the array", async () => {
      const rels = [
        {
          from_id: "A",
          to_id: "B",
          type: "blocks",
          schema_version: 1,
          created_at: 1,
        },
      ];
      client.get.mockResolvedValue({ ok: true, relationships: rels });

      const backend = await createBackend(client);
      const result = await backend.listRelationships({ from_id: "A" });

      expect(result).toEqual(rels);
      // Only the defined key (from_id) is forwarded — never to_id/type=undefined.
      expect(client.get).toHaveBeenCalledWith(
        "/projects/proj-test/tasks/relationships",
        expect.objectContaining({ query: { from_id: "A" } }),
      );
    });

    it("removeRelationship() issues a DELETE with the composite key in the query string (no body)", async () => {
      client.delete.mockResolvedValue({ ok: true, removed: true });

      const backend = await createBackend(client);
      const result = await backend.removeRelationship({
        from_id: "A",
        to_id: "B",
        type: "blocks",
      });

      expect(result).toEqual({ removed: true });
      const [path, opts] = client.delete.mock.calls[0];
      expect(path).toContain("/projects/proj-test/tasks/relationships?");
      expect(path).toContain("from_id=A");
      expect(path).toContain("to_id=B");
      expect(path).toContain("type=blocks");
      // No request body is passed to delete (the SDK delete has no body param).
      expect(opts).toEqual(expect.objectContaining({ validate: true }));
    });
  });
});

describe("RemoteRecordBackend", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("createRecord() POSTs to /records/:type and merges fence into RecordRow", async () => {
    client.post.mockResolvedValue({
      ok: true,
      record: recordItem(),
      fence: 7,
      revision: 1,
    });

    const backend = await createRecordBackend(client);
    const row = await backend.createRecord({
      type: "service",
      key: "api",
      value: { host: "localhost" },
    });

    expect(client.post).toHaveBeenCalledWith(
      "/projects/proj-test/records/service",
      expect.objectContaining({ key: "api", value: { host: "localhost" } }),
      expect.anything(),
    );
    expect(row.fence).toBe(7);
    expect(row.value).toEqual({ host: "localhost" });
  });

  it("setRecord() PUTs to /records/:type/:key with fence", async () => {
    client.put.mockResolvedValue({
      ok: true,
      record: recordItem(),
      fence: 8,
      revision: 2,
    });

    const backend = await createRecordBackend(client);
    await backend.setRecord({
      type: "service",
      key: "api",
      value: { host: "h" },
      fence: 5,
    });

    expect(client.put).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/api",
      expect.objectContaining({ value: { host: "h" }, fence: 5 }),
      expect.anything(),
    );
  });

  it("setRecord() encodes multi-segment keys per-segment", async () => {
    client.put.mockResolvedValue({
      ok: true,
      record: recordItem({ key: "api/staging" }),
      fence: 1,
      revision: 1,
    });

    const backend = await createRecordBackend(client);
    await backend.setRecord({
      type: "service",
      key: "api/staging",
      value: {},
      fence: 1,
    });

    expect(client.put).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/api/staging",
      expect.anything(),
      expect.anything(),
    );
  });

  it("getRecord() returns null on 404", async () => {
    client.get.mockRejectedValue(
      new TilaApiError(404, "not-found", "missing", false),
    );

    const backend = await createRecordBackend(client);
    expect(await backend.getRecord("service", "api")).toBeNull();
  });

  it("patchRecord() PATCHes /records/:type/:key", async () => {
    client.patch.mockResolvedValue({
      ok: true,
      record: recordItem(),
      fence: 3,
      revision: 3,
    });

    const backend = await createRecordBackend(client);
    await backend.patchRecord({
      type: "service",
      key: "api",
      patch: { x: 1 },
      fence: 2,
    });

    expect(client.patch).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/api",
      expect.objectContaining({ patch: { x: 1 }, fence: 2 }),
      expect.anything(),
    );
  });

  it("archiveRecord() POSTs to /records/:type/~/archive/:key", async () => {
    client.post.mockResolvedValue({
      ok: true,
      record: recordItem({ archived: 1 }),
      fence: 4,
      revision: 4,
    });

    const backend = await createRecordBackend(client);
    await backend.archiveRecord({ type: "service", key: "api", fence: 3 });

    expect(client.post).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/~/archive/api",
      { fence: 3 },
      expect.anything(),
    );
  });

  it("unarchiveRecord() POSTs to /records/:type/~/unarchive/:key", async () => {
    client.post.mockResolvedValue({
      ok: true,
      record: recordItem(),
      fence: 5,
      revision: 5,
    });

    const backend = await createRecordBackend(client);
    await backend.unarchiveRecord({ type: "service", key: "api", fence: 4 });

    expect(client.post).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/~/unarchive/api",
      { fence: 4 },
      expect.anything(),
    );
  });

  it("listRecords() GETs /records/:type and flattens meta into a RecordPage", async () => {
    client.get.mockResolvedValue({
      ok: true,
      items: [
        {
          type: "service",
          key: "api",
          revision: 1,
          updated_at: 1000,
          updated_by: "cli",
          archived: 0,
          tags: [],
        },
      ],
      meta: { total: 1, limit: 200, next_cursor: null },
    });

    const backend = await createRecordBackend(client);
    const page = await backend.listRecords({
      type: "service",
      tag: "x",
      includeArchived: true,
    });

    expect(client.get).toHaveBeenCalledWith(
      "/projects/proj-test/records/service",
      expect.objectContaining({
        query: expect.objectContaining({
          tag: "x",
          "include-archived": "true",
        }),
      }),
    );
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });

  it("listRecordHistory() GETs /records/:type/~/history/:key with values flag", async () => {
    client.get.mockResolvedValue({
      ok: true,
      items: [],
      meta: { total: 0, limit: 20, next_cursor: null },
    });

    const backend = await createRecordBackend(client);
    await backend.listRecordHistory("service", "api", {
      limit: 5,
      includeValues: true,
    });

    expect(client.get).toHaveBeenCalledWith(
      "/projects/proj-test/records/service/~/history/api",
      expect.objectContaining({
        query: { limit: "5", values: "true" },
      }),
    );
  });

  it("listRecordTypesInUse() GETs /records/_types and returns in_use_types", async () => {
    client.get.mockResolvedValue({
      ok: true,
      types: ["service", "pipeline_config"],
      in_use_types: ["service"],
    });

    const backend = await createRecordBackend(client);
    expect(await backend.listRecordTypesInUse()).toEqual(["service"]);
    expect(client.get).toHaveBeenCalledWith(
      "/projects/proj-test/records/_types",
      expect.anything(),
    );
  });
});
