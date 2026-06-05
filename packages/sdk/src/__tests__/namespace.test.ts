import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import {
  createNamespace,
  namespacedArtifactMethods,
  namespacedRecordMethods,
  namespacedTaskMethods,
  namespacedTemplateMethods,
} from "../namespace";

function mockResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NS = "cp";
const PROJECT_ID = "proj-1";

// ---------------------------------------------------------------------------
// Task adapter
// ---------------------------------------------------------------------------

describe("namespacedTaskMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("create sends prefixed type on the wire", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "t1",
        type: "cp_task",
        status: "active",
        data: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        fence: 1,
        tags: [],
      },
      fence: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    const result = await tasks.create("t1", "task", {});

    // Wire body must have cp_task
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.type).toBe("cp_task");

    // Returned entity.type must be stripped back to "task"
    expect(result.entity.type).toBe("task");
  });

  it("get strips entity.type from response", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "t1",
        type: "cp_task",
        status: "active",
        data: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        fence: 1,
        tags: [],
        relationships: [],
        artifact_refs: [],
      },
      fence: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    const result = await tasks.get("t1");
    expect(result.entity.type).toBe("task");
  });

  it("update strips entity.type from response", async () => {
    const responseBody = {
      ok: true,
      entity: {
        id: "t1",
        type: "cp_task",
        status: "active",
        data: { x: 1 },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 2,
        fence: 2,
        tags: [],
      },
      fence: 2,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    const result = await tasks.update("t1", { x: 1 }, 1);
    expect(result.entity.type).toBe("task");
  });

  it("list sends prefixed type query param and strips entities[].type", async () => {
    const responseBody = {
      ok: true,
      entities: [
        {
          id: "t1",
          type: "cp_task",
          status: "active",
          data: {},
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          revision: 1,
          fence: 1,
          tags: [],
        },
      ],
      meta: { total: 1, limit: 100 },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    const result = await tasks.list({ type: "task" });

    // Wire URL must have cp_task in the query
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("type=cp_task");

    // Returned entities[].type must be stripped
    expect(result.entities[0].type).toBe("task");
  });

  it("list without type arg does not send type query param", async () => {
    const responseBody = {
      ok: true,
      entities: [],
      meta: { total: 0, limit: 100 },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    await tasks.list();
    const [url] = mockFetch.mock.calls[0];
    expect(url).not.toContain("cp_undefined");
    expect(url).not.toContain("type=cp_");
  });

  it("addRelationship does NOT prefix the relationship type (decoy guard)", async () => {
    const responseBody = {
      ok: true,
      relationship: { from_id: "a", to_id: "b", type: "blocks" },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    await tasks.addRelationship("a", "b", "blocks");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    // relationship type must NOT be prefixed
    expect(body.type).toBe("blocks");
    expect(body.type).not.toContain("cp_");
  });

  it("archive returns ok:true without stripping (no entity in response)", async () => {
    const responseBody = { ok: true };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const tasks = namespacedTaskMethods(client, PROJECT_ID, NS);

    const result = await tasks.archive("t1", 1);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Record adapter
// ---------------------------------------------------------------------------

describe("namespacedRecordMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function baseRecord(type = "cp_config") {
    return {
      type,
      key: "db",
      value: { host: "x" },
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      revision: 1,
      tags: [],
    };
  }

  it("create hits /records/cp_config and strips record.type", async () => {
    const responseBody = {
      ok: true,
      record: baseRecord(),
      fence: 1,
      revision: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.create("config", {
      key: "db",
      value: { host: "x" },
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain(`/projects/${PROJECT_ID}/records/cp_config`);
    expect(result.record.type).toBe("config");
  });

  it("get hits /records/cp_config/k and strips record.type", async () => {
    const responseBody = { ok: true, record: baseRecord(), fence: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.get("config", "db");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/records/cp_config/db");
    expect(result.record.type).toBe("config");
  });

  it("archive hits /records/cp_config/~/archive/k (~ sentinel unprefixed)", async () => {
    const responseBody = {
      ok: true,
      record: { ...baseRecord(), status: "archived" },
      fence: 2,
      revision: 2,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    await records.archive("config", "db", { fence: 1 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/records/cp_config/~/archive/db");
    expect(url).not.toContain("cp_~");
  });

  it("list prefixes type arg and strips items[].type", async () => {
    const responseBody = {
      ok: true,
      items: [
        {
          type: "cp_config",
          key: "db",
          revision: 1,
          updated_at: 1000,
          updated_by: "agent",
          archived: 0,
          tags: [],
        },
      ],
      meta: { total: 1, limit: 200, next_cursor: null },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.list("config");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/records/cp_config");
    expect(result.items[0].type).toBe("config");
  });

  it("history prefixes type arg and strips items[].type", async () => {
    const responseBody = {
      ok: true,
      items: [
        {
          type: "cp_config",
          key: "db",
          revision: 1,
          operation: "created",
          schema_version: 1,
          value_sha256: "abc",
          canonical_artifact_key: null,
          source_artifact_key: null,
          actor: "agent",
          created_at: 1000,
          message: null,
        },
      ],
      meta: { total: 1, limit: 10, next_cursor: null },
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.history("config", "db");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/records/cp_config/~/history/db");
    expect(result.items[0].type).toBe("config");
  });

  it("types() strips each entry (tolerant — mixed namespaces)", async () => {
    const responseBody = {
      ok: true,
      types: ["cp_a", "other_b"],
      declared_types: ["cp_a"],
      in_use_types: ["cp_a", "other_b"],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.types();
    // cp_a stripped to "a", other_b left unchanged (no cp_ prefix)
    expect(result.types).toEqual(["a", "other_b"]);
  });

  it("typesInUse() strips own types and leaves foreign ones", async () => {
    const responseBody = {
      ok: true,
      types: ["cp_a", "other_b"],
      in_use_types: ["cp_a", "other_b"],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, PROJECT_ID, NS);

    const result = await records.typesInUse();
    expect(result.types).toEqual(["a", "other_b"]);
  });
});

// ---------------------------------------------------------------------------
// Artifact adapter
// ---------------------------------------------------------------------------

describe("namespacedArtifactMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function basePointer(kind = "cp_report") {
    return {
      r2_key: "proj-1/sha.txt",
      resource: null,
      kind,
      sha256: "abc",
      bytes: 10,
      fence: null,
      mime_type: "text/plain",
      produced_at: 1000,
      produced_by: "agent",
      expires_at: null,
      tombstoned: 0,
    };
  }

  it("writeText sends prefixed kind in body (no kind in response)", async () => {
    const responseBody = {
      ok: true,
      key: "proj-1/sha.txt",
      bytes: 10,
      deduplicated: false,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const result = await artifacts.writeText("hello", { kind: "report" });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.kind).toBe("cp_report");
    // Response has no kind — just verify no crash and key is present
    expect(result.key).toBe("proj-1/sha.txt");
  });

  it("upload sends prefixed kind in FormData and does NOT prefix resource", async () => {
    const responseBody = {
      ok: true,
      key: "proj-1/sha.bin",
      bytes: 4,
      deduplicated: false,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const blob = new Blob(["data"], { type: "text/plain" });
    await artifacts.upload(blob, {
      kind: "report",
      resource: "file:/x",
      mimeType: "text/plain",
    });

    const [, init] = mockFetch.mock.calls[0];
    const formData = init.body as FormData;
    expect(formData.get("kind")).toBe("cp_report");
    expect(formData.get("resource")).toBe("file:/x"); // NOT prefixed
  });

  it("list sends prefixed kind query and strips pointers[].kind", async () => {
    const responseBody = {
      ok: true,
      pointers: [basePointer("cp_report")],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const result = await artifacts.list({ kind: "report" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("kind=cp_report");
    expect(result.pointers[0].kind).toBe("report");
  });

  it("search sends prefixed kind and strips results[].kind", async () => {
    const responseBody = {
      ok: true,
      results: [
        {
          r2_key: "k",
          kind: "cp_report",
          resource: null,
          mime_type: "text/plain",
          produced_at: 1000,
          title: null,
          snippet: null,
          indexed_at: 1000,
        },
      ],
      total: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const result = await artifacts.search("hello", { kind: "report" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("kind=cp_report");
    expect(result.results[0].kind).toBe("report");
  });

  it("getLatest sends prefixed kind and strips bare pointer.kind", async () => {
    const responseBody = { ok: true, pointer: basePointer("cp_report") };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const result = await artifacts.getLatest("report", "res://x");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("kind=cp_report");
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("report");
  });

  it("getLatest returns null on 404 without throwing (null guard)", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    const result = await artifacts.getLatest("report", "res://missing");
    expect(result).toBeNull();
  });

  it("addRelationship does NOT prefix the relationship type (decoy guard)", async () => {
    const responseBody = { ok: true };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const artifacts = namespacedArtifactMethods(client, PROJECT_ID, NS);

    await artifacts.addRelationship("from-key", "to-key", "references");

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.type).toBe("references"); // NOT prefixed
    expect(body.type).not.toContain("cp_");
  });
});

// ---------------------------------------------------------------------------
// Template adapter
// ---------------------------------------------------------------------------

describe("namespacedTemplateMethods", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("instantiate sends prefixed template_name (not root_id)", async () => {
    const responseBody = { ok: true, ids: ["t1"], fence: 1 };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const templates = namespacedTemplateMethods(client, PROJECT_ID, NS);

    await templates.instantiate({
      template_name: "deploy",
      root_id: "r",
      vars: {},
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.template_name).toBe("cp_deploy"); // prefixed
    expect(body.root_id).toBe("r"); // NOT prefixed
  });

  it("list strips templates[].name AND templates[].type", async () => {
    const responseBody = {
      ok: true,
      templates: [
        {
          name: "cp_deploy",
          type: "cp_task",
          description: null,
          variables: [],
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const templates = namespacedTemplateMethods(client, PROJECT_ID, NS);

    const result = await templates.list();

    expect(result.templates[0].name).toBe("deploy");
    expect(result.templates[0].type).toBe("task");
  });
});

// ---------------------------------------------------------------------------
// createNamespace aggregator
// ---------------------------------------------------------------------------

describe("createNamespace", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws TypeError for invalid namespace (eager validate)", () => {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    expect(() => createNamespace(client, PROJECT_ID, "Bad!")).toThrow(
      TypeError,
    );
    expect(() => createNamespace(client, PROJECT_ID, "")).toThrow(TypeError);
    expect(() => createNamespace(client, PROJECT_ID, "1invalid")).toThrow(
      TypeError,
    );
  });

  it("returns object with tasks, records, artifacts, templates", () => {
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const ns = createNamespace(client, PROJECT_ID, NS);
    expect(ns).toHaveProperty("tasks");
    expect(ns).toHaveProperty("records");
    expect(ns).toHaveProperty("artifacts");
    expect(ns).toHaveProperty("templates");
  });

  it("end-to-end round trip through ns.records", async () => {
    const responseBody = {
      ok: true,
      record: {
        type: "cp_config",
        key: "db",
        value: { host: "x" },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        tags: [],
      },
      fence: 1,
      revision: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const ns = createNamespace(client, PROJECT_ID, NS);

    const result = await ns.records.create("config", {
      key: "db",
      value: { host: "x" },
    });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/records/cp_config");
    expect(result.record.type).toBe("config");
  });

  it("validate:true interplay — prefixed wire value passes then strips on return", async () => {
    // The client with validate:true runs Zod safeParse before the adapter strips.
    // The prefixed value "cp_config" satisfies z.string() and RecordTypeSchema,
    // so validation passes, then the adapter strips it back to "config".
    const responseBody = {
      ok: true,
      record: {
        type: "cp_config",
        key: "db",
        value: { host: "x" },
        status: "active",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        revision: 1,
        tags: [],
      },
      fence: 1,
      revision: 1,
    };
    mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

    // validate:true is passed to TilaClient but does not affect our adapters
    // (they call inner.create, which calls client.post without validate option)
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
      validate: true,
    });
    const ns = createNamespace(client, PROJECT_ID, NS);

    const result = await ns.records.create("config", {
      key: "db",
      value: { host: "x" },
    });

    // Wire value was cp_config (valid), stripped to config on return
    expect(result.record.type).toBe("config");
  });
});
