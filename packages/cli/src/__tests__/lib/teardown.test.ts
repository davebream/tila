import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnSync = vi.fn();
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

const mockMintAppJwt = vi.fn();
vi.mock("../../lib/github-app-setup", () => ({
  mintAppJwt: (...args: unknown[]) => mockMintAppJwt(...args),
}));

function makeSpawnResult(opts: {
  status: number;
  stdout?: string;
  stderr?: string;
}) {
  return {
    status: opts.status,
    stdout: Buffer.from(opts.stdout ?? ""),
    stderr: Buffer.from(opts.stderr ?? ""),
  };
}

// --- SDK mock helpers ---

type Cloudflare = import("../../lib/cloudflare-client").Cloudflare;

function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length)
            return { value: items[i++], done: false as const };
          return { value: undefined as unknown as T, done: true as const };
        },
      };
    },
  };
}

function makeMockClient(overrides?: Record<string, unknown>) {
  return {
    d1: {
      database: {
        list: vi.fn(),
        create: vi.fn(),
        query: vi.fn(),
      },
    },
    ...overrides,
  } as unknown as Cloudflare;
}

let tempDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  tempDir = join(
    process.env.TMPDIR ?? "/tmp",
    `tila-test-teardown-${Date.now()}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deleteWorker", () => {
  it("returns ok on successful SDK delete", async () => {
    const client = makeMockClient({
      workers: { scripts: { delete: vi.fn().mockResolvedValue({}) } },
    });
    const { deleteWorker } = await import("../../lib/teardown");
    const result = await deleteWorker(client, "acct-1", "my-worker");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("my-worker");
  });

  it("returns failure on SDK error", async () => {
    const client = makeMockClient({
      workers: {
        scripts: {
          delete: vi.fn().mockRejectedValue(new Error("Not found")),
        },
      },
    });
    const { deleteWorker } = await import("../../lib/teardown");
    const result = await deleteWorker(client, "acct-1", "my-worker");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not found");
  });
});

describe("deleteR2Bucket", () => {
  it("returns ok on successful SDK delete", async () => {
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: vi.fn().mockResolvedValue({}),
          objects: {
            list: vi.fn().mockReturnValue(makeAsyncIterable([])),
            delete: vi.fn(),
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "my-bucket");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("my-bucket");
    expect(client.r2.buckets.delete).toHaveBeenCalledWith("my-bucket", {
      account_id: "acct-1",
    });
  });

  it("returns failure on SDK error", async () => {
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: vi.fn().mockRejectedValue(new Error("Not found")),
          objects: {
            list: vi.fn().mockReturnValue(makeAsyncIterable([])),
            delete: vi.fn(),
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "my-bucket");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Not found");
  });

  it("drains objects before deleting bucket", async () => {
    const objectsDelete = vi.fn().mockResolvedValue({});
    const bucketDelete = vi.fn().mockResolvedValue({});
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: bucketDelete,
          objects: {
            list: vi
              .fn()
              .mockReturnValue(
                makeAsyncIterable([{ key: "file-a" }, { key: "file-b" }]),
              ),
            delete: objectsDelete,
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "my-bucket");
    expect(result.ok).toBe(true);
    expect(objectsDelete).toHaveBeenCalledWith("my-bucket", "file-a", {
      account_id: "acct-1",
    });
    expect(objectsDelete).toHaveBeenCalledWith("my-bucket", "file-b", {
      account_id: "acct-1",
    });
    expect(bucketDelete).toHaveBeenCalled();
  });

  it("skips drain when bucket is empty", async () => {
    const objectsDelete = vi.fn();
    const bucketDelete = vi.fn().mockResolvedValue({});
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: bucketDelete,
          objects: {
            list: vi.fn().mockReturnValue(makeAsyncIterable([])),
            delete: objectsDelete,
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "empty-bucket");
    expect(result.ok).toBe(true);
    expect(objectsDelete).not.toHaveBeenCalled();
    expect(bucketDelete).toHaveBeenCalledWith("empty-bucket", {
      account_id: "acct-1",
    });
  });

  it("continues deleting remaining objects after per-key failure", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const objectsDelete = vi
      .fn()
      .mockRejectedValueOnce(new Error("access denied"))
      .mockResolvedValueOnce({});
    const bucketDelete = vi.fn().mockResolvedValue({});
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: bucketDelete,
          objects: {
            list: vi
              .fn()
              .mockReturnValue(
                makeAsyncIterable([{ key: "key-1" }, { key: "key-2" }]),
              ),
            delete: objectsDelete,
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "my-bucket");
    expect(result.ok).toBe(true);
    expect(objectsDelete).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    expect(bucketDelete).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("deletes all objects across paginated results", async () => {
    const objectsDelete = vi.fn().mockResolvedValue({});
    const bucketDelete = vi.fn().mockResolvedValue({});
    const manyObjects = Array.from({ length: 5 }, (_, i) => ({
      key: `obj-${i}`,
    }));
    const client = makeMockClient({
      r2: {
        buckets: {
          delete: bucketDelete,
          objects: {
            list: vi.fn().mockReturnValue(makeAsyncIterable(manyObjects)),
            delete: objectsDelete,
          },
        },
      },
    });
    const { deleteR2Bucket } = await import("../../lib/teardown");
    const result = await deleteR2Bucket(client, "acct-1", "my-bucket");
    expect(result.ok).toBe(true);
    expect(objectsDelete).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 5; i++) {
      expect(objectsDelete).toHaveBeenCalledWith("my-bucket", `obj-${i}`, {
        account_id: "acct-1",
      });
    }
  });
});

describe("deleteGitHubApp", () => {
  const creds = {
    app_id: 123,
    slug: "tila-test",
    client_id: "c",
    client_secret: "s",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
    webhook_secret: "",
  };

  it("removes installations and returns settings URL", async () => {
    mockMintAppJwt.mockResolvedValue("fake-jwt");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: "my-app" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 1 }, { id: 2 }],
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { deleteGitHubApp } = await import("../../lib/teardown");
    const result = await deleteGitHubApp(creds);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("github.com/settings/apps/my-app");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("succeeds even when no installations exist", async () => {
    mockMintAppJwt.mockResolvedValue("fake-jwt");
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ slug: "my-app" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as unknown as typeof fetch;

    const { deleteGitHubApp } = await import("../../lib/teardown");
    const result = await deleteGitHubApp(creds);
    expect(result.ok).toBe(true);
  });
});

describe("cleanD1ProjectRecords", () => {
  it("executes parameterized queries via SDK", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { cleanD1ProjectRecords } = await import("../../lib/teardown");
    const result = await cleanD1ProjectRecords(
      client,
      "acct-1",
      "db-uuid",
      "my-project",
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain("D1 project records cleaned");

    // Six queries: one per project-scoped table
    expect(client.d1.database.query).toHaveBeenCalledTimes(6);

    // _tokens is the LAST query (after store verification — retry-authentication safety)
    const lastCall = (client.d1.database.query as ReturnType<typeof vi.fn>).mock
      .calls[5];
    expect(lastCall[0]).toBe("db-uuid");
    expect(lastCall[1].sql).toContain("_tokens");
    expect(lastCall[1].params).toEqual(["my-project"]);
  });

  it("deletes from all six project-scoped tables", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { cleanD1ProjectRecords } = await import("../../lib/teardown");
    const result = await cleanD1ProjectRecords(client, "acc", "db", "slug");
    expect(result.ok).toBe(true);
    const calls = (client.d1.database.query as ReturnType<typeof vi.fn>).mock
      .calls;
    const tables = calls.map((c: unknown[]) => {
      const sql = (c[1] as { sql: string }).sql;
      const match = sql.match(/FROM (\w+)/);
      return match?.[1];
    });
    expect(tables).toContain("_tokens");
    expect(tables).toContain("_projects");
    expect(tables).toContain("_project_repos");
    expect(tables).toContain("_sessions");
    expect(tables).toContain("_github_app_config");
    expect(tables).toContain("_idempotency");
  });

  it("returns failure on SDK error", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("D1 query failed"),
    );

    const { cleanD1ProjectRecords } = await import("../../lib/teardown");
    const result = await cleanD1ProjectRecords(
      client,
      "acct-1",
      "db-uuid",
      "my-project",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("D1 query failed");
  });
});

describe("cleanLocalFiles", () => {
  it("removes .tila/ when config.toml exists", async () => {
    const tilaDir = join(tempDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    writeFileSync(join(tilaDir, "config.toml"), "project_id = 'test'");
    writeFileSync(join(tilaDir, ".env"), "TILA_API_TOKEN=abc");

    const { cleanLocalFiles } = await import("../../lib/teardown");
    const result = cleanLocalFiles(tilaDir);
    expect(result.ok).toBe(true);
  });

  it("refuses when config.toml missing (safety check)", async () => {
    const tilaDir = join(tempDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });

    const { cleanLocalFiles } = await import("../../lib/teardown");
    const result = cleanLocalFiles(tilaDir);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Safety check");
  });
});

// --- wipeProjectViaWorker tests ---

describe("wipeProjectViaWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed result on 200 success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        doWiped: true,
        journalDeleted: 5,
        r2Deleted: 3,
        r2Kept: 1,
        r2Failed: 0,
        r2GcSkipped: false,
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaWorker } = await import("../../lib/teardown");
    const result = await wipeProjectViaWorker(
      "https://worker.example.com",
      "secret-token",
      "my-project",
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.doWiped).toBe(true);
      expect(result.r2Deleted).toBe(3);
    }
    // Verify correct URL and method
    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/projects/my-project/admin/destroy",
      expect.objectContaining({ method: "POST" }),
    );
    // Verify Authorization header present and token not logged in any output
    const callArgs = mockFetch.mock.calls[0][1] as RequestInit;
    const authHeader = (callArgs.headers as Record<string, string>)
      .Authorization;
    expect(authHeader).toBe("Bearer secret-token");
  });

  it("does not include the token in error messages (non-2xx)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, error: { code: "destroy-failed" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaWorker } = await import("../../lib/teardown");
    const result = await wipeProjectViaWorker(
      "https://worker.example.com",
      "super-secret-token",
      "my-project",
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // Error message must not contain the raw token
      expect(result.errorMessage).not.toContain("super-secret-token");
      expect(result.errorClass).toBe("non-2xx");
      expect(result.status).toBe(500);
    }
  });

  it("distinguishes 403 as insufficient-scope error class", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ ok: false, error: { code: "forbidden" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaWorker } = await import("../../lib/teardown");
    const result = await wipeProjectViaWorker(
      "https://worker.example.com",
      "token-xyz",
      "my-project",
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorClass).toBe("insufficient-scope");
      expect(result.errorMessage).not.toContain("token-xyz");
    }
  });

  it("distinguishes network errors as network-error class", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaWorker } = await import("../../lib/teardown");
    const result = await wipeProjectViaWorker(
      "https://worker.example.com",
      "my-token",
      "my-project",
    );

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorClass).toBe("network-error");
      expect(result.errorMessage).not.toContain("my-token");
    }
  });

  it("surfaces r2GcSkipped from response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        doWiped: true,
        journalDeleted: 0,
        r2Deleted: 0,
        r2Kept: 10,
        r2Failed: 0,
        r2GcSkipped: true,
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaWorker } = await import("../../lib/teardown");
    const result = await wipeProjectViaWorker(
      "https://worker.example.com",
      "token",
      "my-project",
    );

    expect(result.ok).toBe(true);
    if (result.ok === true) {
      expect(result.r2GcSkipped).toBe(true);
    }
  });
});

// --- verifyStoresEmpty tests ---

describe("verifyStoresEmpty", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok when all D1 tables zero and store-counts all zero", async () => {
    const client = makeMockClient();
    // D1 counts: all 5 non-token tables return 0
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ cnt: 0 }],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        counts: {
          domain: {
            entities: 0,
            entity_relationships: 0,
            artifact_pointers: 0,
            entity_artifact_references: 0,
            artifact_relationships: 0,
            journal: 0,
            _journal_archive_watermark: 0,
            claims: 0,
            fences: 0,
            presence: 0,
            gates: 0,
            signals: 0,
            records: 0,
            record_tags: 0,
            record_revisions: 0,
            artifact_search_docs: 0,
            entity_search_docs: 0,
            record_search_docs: 0,
          },
          schemaHistory: 1,
        },
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { verifyStoresEmpty } = await import("../../lib/teardown");
    const result = await verifyStoresEmpty({
      cf: client,
      accountId: "acct-1",
      databaseId: "db-id",
      slug: "my-project",
      workerUrl: "https://worker.example.com",
      token: "tok",
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("flags non-zero domain store count as failure", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ cnt: 0 }],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        counts: {
          domain: {
            entities: 3, // non-zero!
            entity_relationships: 0,
            artifact_pointers: 0,
            entity_artifact_references: 0,
            artifact_relationships: 0,
            journal: 0,
            _journal_archive_watermark: 0,
            claims: 0,
            fences: 0,
            presence: 0,
            gates: 0,
            signals: 0,
            records: 0,
            record_tags: 0,
            record_revisions: 0,
            artifact_search_docs: 0,
            entity_search_docs: 0,
            record_search_docs: 0,
          },
          schemaHistory: 1,
        },
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { verifyStoresEmpty } = await import("../../lib/teardown");
    const result = await verifyStoresEmpty({
      cf: client,
      accountId: "acct-1",
      databaseId: "db-id",
      slug: "my-project",
      workerUrl: "https://worker.example.com",
      token: "tok",
    });

    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("entities"))).toBe(true);
  });

  it("does NOT require _schema_history to be zero", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ cnt: 0 }],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        counts: {
          domain: Object.fromEntries(
            [
              "entities",
              "entity_relationships",
              "artifact_pointers",
              "entity_artifact_references",
              "artifact_relationships",
              "journal",
              "_journal_archive_watermark",
              "claims",
              "fences",
              "presence",
              "gates",
              "signals",
              "records",
              "record_tags",
              "record_revisions",
              "artifact_search_docs",
              "entity_search_docs",
              "record_search_docs",
            ].map((k) => [k, 0]),
          ),
          schemaHistory: 5, // non-zero but should not fail
        },
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { verifyStoresEmpty } = await import("../../lib/teardown");
    const result = await verifyStoresEmpty({
      cf: client,
      accountId: "acct-1",
      databaseId: "db-id",
      slug: "my-project",
      workerUrl: "https://worker.example.com",
      token: "tok",
    });

    // schemaHistory non-zero does not cause failure
    expect(result.ok).toBe(true);
  });

  it("flags non-zero D1 table count as failure", async () => {
    const client = makeMockClient();
    // Return non-zero for first query (_project_repos)
    (client.d1.database.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ results: [{ cnt: 2 }] }) // non-zero
      .mockResolvedValue({ results: [{ cnt: 0 }] });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        counts: {
          domain: Object.fromEntries(
            [
              "entities",
              "entity_relationships",
              "artifact_pointers",
              "entity_artifact_references",
              "artifact_relationships",
              "journal",
              "_journal_archive_watermark",
              "claims",
              "fences",
              "presence",
              "gates",
              "signals",
              "records",
              "record_tags",
              "record_revisions",
              "artifact_search_docs",
              "entity_search_docs",
              "record_search_docs",
            ].map((k) => [k, 0]),
          ),
          schemaHistory: 0,
        },
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { verifyStoresEmpty } = await import("../../lib/teardown");
    const result = await verifyStoresEmpty({
      cf: client,
      accountId: "acct-1",
      databaseId: "db-id",
      slug: "my-project",
      workerUrl: "https://worker.example.com",
      token: "tok",
    });

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

describe("wipeProjectViaInfraToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to the infra endpoint with Bearer token + X-Confirm-Slug and parses success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        doWiped: true,
        journalDeleted: 2,
        r2Deleted: 3,
        r2Kept: 1,
        r2Failed: 0,
        r2GcSkipped: false,
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaInfraToken } = await import("../../lib/teardown");
    const result = await wipeProjectViaInfraToken(
      "https://worker.example.com",
      "infra-secret",
      "my-project",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doWiped).toBe(true);
      expect(result.r2Deleted).toBe(3);
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://worker.example.com/_internal/projects/my-project/destroy",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer infra-secret");
    expect(init.headers["X-Confirm-Slug"]).toBe("my-project");
  });

  it("returns insufficient-scope on HTTP 403", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "FORBIDDEN" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const { wipeProjectViaInfraToken } = await import("../../lib/teardown");
    const result = await wipeProjectViaInfraToken(
      "https://worker.example.com",
      "wrong-secret",
      "my-project",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorClass).toBe("insufficient-scope");
      expect(result.status).toBe(403);
      // token must never leak into the error message
      expect(result.errorMessage).not.toContain("wrong-secret");
    }
  });
});
