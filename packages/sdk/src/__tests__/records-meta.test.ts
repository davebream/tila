import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordMetaResponse } from "@tila/schemas";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import { TilaApiError, TilaClient } from "../client";
import { buildLocalResources, createTilaLocal } from "../local/index";
import type { TilaLocal } from "../local/index";
import { namespacedRecordMethods } from "../namespace";
import { createRecordMethods } from "../records";

function mockResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const META = {
  type: "pipeline_config",
  key: "env/prod/db",
  revision: 4,
  fence: 4,
  value_sha256: "b".repeat(64),
  updated_at: 1700000000000,
  archived: 0,
};

describe("records.meta (remote)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues GET <key path>?meta=1 with per-segment encoding and no body", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, meta: META }));
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.meta("pipeline_config", "env/prod/db");

    const [url, init] = mockFetch.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe(
      "/projects/proj-1/records/pipeline_config/env/prod/db",
    );
    expect(parsed.search).toBe("?meta=1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ ok: true, meta: META });
  });

  it("types the response as RecordMetaResponse, without a value or tags", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true, meta: META }));
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const result = await records.meta("pipeline_config", "env/prod/db");

    expectTypeOf(result).toEqualTypeOf<RecordMetaResponse>();
    expectTypeOf(result.meta.fence).toBeNumber();
    expectTypeOf(result.meta.revision).toBeNumber();
    expectTypeOf(result.meta.value_sha256).toBeString();
    expectTypeOf(result.meta.archived).toBeNumber();
    expectTypeOf(result.meta.updated_at).toBeNumber();
    expectTypeOf(result.meta).not.toHaveProperty("value");
    expectTypeOf(result.meta).not.toHaveProperty("tags");
  });

  it("leaves records.get on the plain path, with no query", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, record: { type: "t", key: "k" }, fence: 1 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });

    await createRecordMethods(client, "proj-1").get("config", "env/prod");

    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url as string).pathname).toBe(
      "/projects/proj-1/records/config/env/prod",
    );
    expect(new URL(url as string).search).toBe("");
  });

  it("surfaces a missing record as the ordinary 404 api error", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        {
          ok: false,
          error: {
            code: "not-found",
            message: "Record config/absent not found",
            retryable: false,
          },
        },
        404,
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = createRecordMethods(client, "proj-1");

    const error = await records.meta("config", "absent").catch((e) => e);

    expect(error).toBeInstanceOf(TilaApiError);
    expect(error).toMatchObject({ status: 404, code: "not-found" });
  });
});

describe("namespacedRecordMethods.meta", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes the type on the wire and strips it from meta.type", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        meta: { ...META, type: "cp_config", key: "db" },
      }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    const records = namespacedRecordMethods(client, "proj-1", "cp");

    const result = await records.meta("config", "db");

    const [url] = mockFetch.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.pathname).toBe("/projects/proj-1/records/cp_config/db");
    expect(parsed.search).toBe("?meta=1");
    expect(result.meta.type).toBe("config");
    expect(result.meta).toMatchObject({
      key: "db",
      revision: 4,
      fence: 4,
      value_sha256: META.value_sha256,
    });
  });
});

describe("records.meta (local)", () => {
  let dir: string;
  let local: TilaLocal;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tila-record-meta-"));
    local = await createTilaLocal({
      dbPath: join(dir, "project.db"),
      artifactsPath: join(dir, "artifacts"),
      org: "test-org",
      project: "test-project",
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    local.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the same metadata the full read carries, without the value", async () => {
    const records = buildLocalResources(local.project, local.artifacts).records;
    await records.put("note", "cfg/deep/main", {
      value: { body: "LOCAL-VALUE-SECRET" },
      tags: ["local-tag-secret"],
    });

    const full = await records.get("note", "cfg/deep/main");
    const result = await records.meta("note", "cfg/deep/main");

    expect(result).toEqual({
      ok: true,
      meta: {
        type: "note",
        key: "cfg/deep/main",
        revision: full.record.revision,
        fence: full.fence,
        value_sha256: full.record.value_sha256,
        updated_at: full.record.updated_at,
        archived: full.record.archived,
      },
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("LOCAL-VALUE-SECRET");
    expect(text).not.toContain("local-tag-secret");
  });

  it("follows a replace, an archive and an unarchive", async () => {
    const records = buildLocalResources(local.project, local.artifacts).records;
    const created = await records.create("note", {
      key: "k1",
      value: { v: 1 },
    });

    const replaced = await records.set("note", "k1", {
      value: { v: 2 },
      fence: created.fence,
    });
    expect((await records.meta("note", "k1")).meta).toMatchObject({
      revision: 2,
      fence: replaced.fence,
      archived: 0,
    });

    const archived = await records.archive("note", "k1", {
      fence: replaced.fence,
    });
    expect((await records.meta("note", "k1")).meta).toMatchObject({
      revision: 3,
      fence: archived.fence,
      archived: 1,
    });

    const restored = await records.unarchive("note", "k1", {
      fence: archived.fence,
    });
    expect((await records.meta("note", "k1")).meta).toMatchObject({
      revision: 4,
      fence: restored.fence,
      archived: 0,
    });
  });

  it("fails for a missing record like records.get does", async () => {
    const records = buildLocalResources(local.project, local.artifacts).records;

    await expect(records.get("note", "absent")).rejects.toThrow(
      "Record not found: note/absent",
    );
    await expect(records.meta("note", "absent")).rejects.toThrow(
      "Record not found: note/absent",
    );
  });

  it("leaves the record full read unchanged", async () => {
    const records = buildLocalResources(local.project, local.artifacts).records;
    await records.create("note", { key: "k1", value: { v: 1 }, tags: ["x"] });

    const full = await records.get("note", "k1");

    expect(Object.keys(full).sort()).toEqual(["fence", "ok", "record"]);
    expect(Object.keys(full.record).sort()).toEqual([
      "archived",
      "created_at",
      "key",
      "revision",
      "schema_version",
      "tags",
      "type",
      "updated_at",
      "updated_by",
      "value",
      "value_sha256",
    ]);
    expect(full.record.tags).toEqual(["x"]);
  });
});
