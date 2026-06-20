import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  text: vi.fn().mockResolvedValue(""),
  password: vi.fn().mockResolvedValue(""),
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn().mockResolvedValue(null),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

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

describe("ensureD1Database", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.spyOn(process, "exit").mockImplementation(
      (_code: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchD1List(
    databases: Array<{ name: string; uuid: string }>,
    status = 200,
  ) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ result: databases }),
      text: async () => JSON.stringify({ result: databases }),
    } as Response);
  }

  it("returns existing database UUID when tila-global exists", async () => {
    const client = makeMockClient();
    mockFetchD1List([
      { name: "other-db", uuid: "other-uuid" },
      { name: "tila-global", uuid: "existing-uuid" },
    ]);

    const { ensureD1Database } = await import("../../lib/cloudflare-resources");
    const uuid = await ensureD1Database(client, "acct-123", "test-token");
    expect(uuid).toBe("existing-uuid");
    expect(client.d1.database.create).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("name=tila-global"),
      expect.anything(),
    );
  });

  it("creates database when tila-global does not exist", async () => {
    const client = makeMockClient();
    mockFetchD1List([{ name: "other-db", uuid: "other-uuid" }]);
    (client.d1.database.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "new-uuid",
    });

    const { ensureD1Database } = await import("../../lib/cloudflare-resources");
    const uuid = await ensureD1Database(client, "acct-123", "test-token");
    expect(uuid).toBe("new-uuid");
    expect(client.d1.database.create).toHaveBeenCalledWith({
      account_id: "acct-123",
      name: "tila-global",
    });
  });

  it("creates database when list is empty", async () => {
    const client = makeMockClient();
    mockFetchD1List([]);
    (client.d1.database.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: "new-uuid",
    });

    const { ensureD1Database } = await import("../../lib/cloudflare-resources");
    const uuid = await ensureD1Database(client, "acct-123", "test-token");
    expect(uuid).toBe("new-uuid");
  });

  it("exits when D1 create returns no UUID", async () => {
    const client = makeMockClient();
    mockFetchD1List([]);
    (client.d1.database.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { ensureD1Database } = await import("../../lib/cloudflare-resources");
    await expect(
      ensureD1Database(client, "acct-123", "test-token"),
    ).rejects.toThrow("process.exit(1)");
  });

  it("propagates SDK errors", async () => {
    const client = makeMockClient();
    mockFetchD1List([]);
    (client.d1.database.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API error"),
    );

    const { ensureD1Database } = await import("../../lib/cloudflare-resources");
    await expect(
      ensureD1Database(client, "acct-123", "test-token"),
    ).rejects.toThrow("API error");
  });
});

describe("insertTokenAndProject", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("calls two parameterized D1 queries for project and token", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { insertTokenAndProject } = await import(
      "../../lib/cloudflare-resources"
    );
    await insertTokenAndProject({
      client,
      accountId: "acc-1",
      databaseId: "db-uuid",
      tokenHash: "abc123hash",
      slug: "test-proj",
    });

    // Three queries: project insert, token delete, token insert
    expect(client.d1.database.query).toHaveBeenCalledTimes(3);

    // First call: project insert with parameterized query
    const firstCall = (client.d1.database.query as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(firstCall[0]).toBe("db-uuid");
    expect(firstCall[1].sql).toContain("_projects");
    expect(firstCall[1].params).toEqual(
      expect.arrayContaining(["test-proj", "tila-init", "acc-1"]),
    );
    for (const p of firstCall[1].params) {
      expect(typeof p).toBe("string");
    }

    // Second call: delete existing non-revoked init token
    const secondCall = (client.d1.database.query as ReturnType<typeof vi.fn>)
      .mock.calls[1];
    expect(secondCall[0]).toBe("db-uuid");
    expect(secondCall[1].sql).toContain("DELETE");
    expect(secondCall[1].sql).toContain("_tokens");
    expect(secondCall[1].params).toEqual(["test-proj", "init"]);

    // Third call: token insert with parameterized query
    const thirdCall = (client.d1.database.query as ReturnType<typeof vi.fn>)
      .mock.calls[2];
    expect(thirdCall[0]).toBe("db-uuid");
    expect(thirdCall[1].sql).toContain("INSERT");
    expect(thirdCall[1].sql).toContain("_tokens");
    expect(thirdCall[1].params).toEqual(
      expect.arrayContaining(["abc123hash", "test-proj", "init", "full"]),
    );
    for (const p of thirdCall[1].params) {
      expect(typeof p).toBe("string");
    }
  });

  it("propagates SDK errors from query", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("D1 error"),
    );

    const { insertTokenAndProject } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(
      insertTokenAndProject({
        client,
        accountId: "acc-1",
        databaseId: "db-uuid",
        tokenHash: "abc123hash",
        slug: "test-proj",
      }),
    ).rejects.toThrow("D1 error");
  });
});

function makeD1Page(rows: unknown[]) {
  return makeAsyncIterable([{ results: rows }]);
}

describe("queryD1", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns rows from a single-result D1 query", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeD1Page([
        { project_id: "proj-1", display_name: "Project One" },
        { project_id: "proj-2", display_name: "Project Two" },
      ]),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    const rows = await queryD1(
      client,
      "acct-1",
      "db-uuid",
      "SELECT * FROM _projects",
    );

    expect(rows).toEqual([
      { project_id: "proj-1", display_name: "Project One" },
      { project_id: "proj-2", display_name: "Project Two" },
    ]);
    expect(client.d1.database.query).toHaveBeenCalledWith("db-uuid", {
      account_id: "acct-1",
      sql: "SELECT * FROM _projects",
    });
  });

  it("passes params when provided", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeD1Page([{ cnt: 3 }]),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    const rows = await queryD1(
      client,
      "acct-1",
      "db-uuid",
      "SELECT COUNT(*) as cnt FROM _tokens WHERE project_id = ?",
      ["my-proj"],
    );

    expect(rows).toEqual([{ cnt: 3 }]);
    expect(client.d1.database.query).toHaveBeenCalledWith("db-uuid", {
      account_id: "acct-1",
      sql: "SELECT COUNT(*) as cnt FROM _tokens WHERE project_id = ?",
      params: ["my-proj"],
    });
  });

  it("returns empty array when query yields no results", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeD1Page([]),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    const rows = await queryD1(
      client,
      "acct-1",
      "db-uuid",
      "SELECT * FROM _projects",
    );

    expect(rows).toEqual([]);
  });

  it("returns empty array when page has no items", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAsyncIterable([]),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    const rows = await queryD1(client, "acct-1", "db-uuid", "SELECT 1");

    expect(rows).toEqual([]);
  });

  it("returns empty array when QueryResult has no results property", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeAsyncIterable([{}]),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    const rows = await queryD1(client, "acct-1", "db-uuid", "SELECT 1");

    expect(rows).toEqual([]);
  });

  it("propagates SDK errors", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("D1 query failed"),
    );

    const { queryD1 } = await import("../../lib/cloudflare-resources");
    await expect(
      queryD1(client, "acct-1", "db-uuid", "SELECT 1"),
    ).rejects.toThrow("D1 query failed");
  });
});

describe("ensureR2Bucket", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.spyOn(process, "exit").mockImplementation(
      (_code: string | number | null | undefined) => {
        throw new Error(`process.exit(${_code})`);
      },
    );
  });

  it("creates bucket via SDK", async () => {
    const client = makeMockClient({
      r2: {
        buckets: { create: vi.fn().mockResolvedValue({ name: "my-bucket" }) },
      },
    });

    const { ensureR2Bucket } = await import("../../lib/cloudflare-resources");
    await ensureR2Bucket(client, "acct-123", "my-bucket");

    expect(client.r2.buckets.create).toHaveBeenCalledWith({
      account_id: "acct-123",
      name: "my-bucket",
    });
  });

  it("handles bucket already exists gracefully", async () => {
    const client = makeMockClient({
      r2: {
        buckets: {
          create: vi.fn().mockRejectedValue(new Error("already exists")),
        },
      },
    });

    const { ensureR2Bucket } = await import("../../lib/cloudflare-resources");
    // Should not throw
    await ensureR2Bucket(client, "acct-123", "my-bucket");
  });

  it("exits on other SDK errors", async () => {
    const client = makeMockClient({
      r2: {
        buckets: {
          create: vi.fn().mockRejectedValue(new Error("permission denied")),
        },
      },
    });

    const { ensureR2Bucket } = await import("../../lib/cloudflare-resources");
    await expect(
      ensureR2Bucket(client, "acct-123", "my-bucket"),
    ).rejects.toThrow("process.exit(1)");
  });
});

describe("applyR2Lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("calls SDK lifecycle.update with correct rules", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    const client = makeMockClient({
      r2: { buckets: { lifecycle: { update: mockUpdate } } },
    });

    const { applyR2Lifecycle } = await import("../../lib/cloudflare-resources");
    await applyR2Lifecycle(client, "acct-123", "my-bucket");

    expect(mockUpdate).toHaveBeenCalledWith("my-bucket", {
      account_id: "acct-123",
      rules: expect.arrayContaining([
        expect.objectContaining({
          id: "backstop-produced-1y",
          conditions: { prefix: "produced/" },
          enabled: true,
          deleteObjectsTransition: {
            condition: { maxAge: 365 * 86400, type: "Age" },
          },
        }),
        expect.objectContaining({
          id: "abort-incomplete-uploads-1d",
          enabled: true,
          abortMultipartUploadsTransition: {
            condition: { maxAge: 86400, type: "Age" },
          },
        }),
      ]),
    });
  });

  it("does not throw on SDK failure", async () => {
    const mockUpdate = vi.fn().mockRejectedValue(new Error("Access denied"));
    const client = makeMockClient({
      r2: { buckets: { lifecycle: { update: mockUpdate } } },
    });

    const { applyR2Lifecycle } = await import("../../lib/cloudflare-resources");
    await expect(
      applyR2Lifecycle(client, "acct-123", "my-bucket"),
    ).resolves.toBeUndefined();
  });
});

describe("setWorkerSecret", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("calls SDK secrets.update with correct args", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockClient = {
      workers: { scripts: { secrets: { update: mockUpdate } } },
    } as unknown as Cloudflare;

    const { setWorkerSecret } = await import("../../lib/cloudflare-resources");
    await setWorkerSecret(
      mockClient,
      "acct-123",
      "my-worker",
      "MY_SECRET",
      "secret-value",
    );

    expect(mockUpdate).toHaveBeenCalledWith("my-worker", {
      account_id: "acct-123",
      name: "MY_SECRET",
      text: "secret-value",
      type: "secret_text",
    });
  });

  it("throws on SDK error with secret name in message", async () => {
    const mockClient = {
      workers: {
        scripts: {
          secrets: {
            update: vi.fn().mockRejectedValue(new Error("Forbidden")),
          },
        },
      },
    } as unknown as Cloudflare;

    const { setWorkerSecret } = await import("../../lib/cloudflare-resources");
    await expect(
      setWorkerSecret(
        mockClient,
        "acct-123",
        "my-worker",
        "MY_SECRET",
        "value",
      ),
    ).rejects.toThrow("Forbidden");
  });

  it("setWorkerSecrets calls all secrets in parallel", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    const mockClient = {
      workers: { scripts: { secrets: { update: mockUpdate } } },
    } as unknown as Cloudflare;

    const { setWorkerSecrets } = await import("../../lib/cloudflare-resources");
    await setWorkerSecrets(mockClient, "acct-123", "my-worker", {
      FIRST: "value1",
      SECOND: "value2",
      THIRD: "value3",
    });

    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });
});

// ensurePagesProject and deployToPages removed in Option A refactor (wrangler deploy path)

// --------------------------------------------------------------------------
// seedFirstAdmin
// --------------------------------------------------------------------------

describe("seedFirstAdmin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("issues a parameterized INSERT OR IGNORE into _admin_grants with numeric id", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { seedFirstAdmin } = await import("../../lib/cloudflare-resources");
    await seedFirstAdmin({
      client,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
      githubUserId: 12345,
      githubLoginSnapshot: "octocat",
    });

    expect(client.d1.database.query).toHaveBeenCalledTimes(1);
    const call = (client.d1.database.query as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe("db-uuid");
    expect(call[1].account_id).toBe("acc-1");
    expect(call[1].sql).toContain("INSERT OR IGNORE INTO _admin_grants");
    expect(call[1].sql).toContain("github.com");
    // Params: [slug, githubUserId as string, githubLoginSnapshot, grantedAt]
    const params: string[] = call[1].params;
    expect(params[0]).toBe("my-proj");
    expect(params[1]).toBe("12345");
    expect(params[2]).toBe("octocat");
    // params[3] is grantedAt (Unix seconds string) — must be numeric string
    expect(/^\d+$/.test(params[3])).toBe(true);
    // Unix seconds (not milliseconds): should be a 10-digit number
    expect(params[3].length).toBe(10);
  });

  it("passes NULL (null) for githubLoginSnapshot when omitted", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockResolvedValue(
      {},
    );

    const { seedFirstAdmin } = await import("../../lib/cloudflare-resources");
    await seedFirstAdmin({
      client,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
      githubUserId: 999,
    });

    const call = (client.d1.database.query as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const params: (string | null)[] = call[1].params;
    expect(params[0]).toBe("my-proj");
    expect(params[1]).toBe("999");
    expect(params[2]).toBeNull(); // no snapshot
  });

  it("propagates D1 SDK errors", async () => {
    const client = makeMockClient();
    (client.d1.database.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("D1 error"),
    );

    const { seedFirstAdmin } = await import("../../lib/cloudflare-resources");
    await expect(
      seedFirstAdmin({
        client,
        accountId: "acc-1",
        databaseId: "db-uuid",
        slug: "my-proj",
        githubUserId: 1,
      }),
    ).rejects.toThrow("D1 error");
  });
});

// --------------------------------------------------------------------------
// resolveGithubUserId
// --------------------------------------------------------------------------

describe("resolveGithubUserId — passthrough for numeric ids", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns the numeric id directly without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    const result = await resolveGithubUserId("123");
    expect(result).toBe(123);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns large numeric id correctly", async () => {
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    expect(await resolveGithubUserId("9999999")).toBe(9999999);
  });
});

describe("resolveGithubUserId — login resolution via GitHub API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("fetches from api.github.com/users/{encodeURIComponent(login)} and returns id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 583231, login: "octocat" }),
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    const result = await resolveGithubUserId("octocat");
    expect(result).toBe(583231);

    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain("api.github.com/users/octocat");
  });

  it("URL-encodes the login in the request URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 100, login: "user-name" }),
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await resolveGithubUserId("user-name");
    const calledUrl = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(calledUrl).toContain(encodeURIComponent("user-name"));
  });

  it("sends Authorization header when GITHUB_TOKEN is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test_token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 42, login: "someuser" }),
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await resolveGithubUserId("someuser");
    const calledInit = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(calledInit.headers?.Authorization).toBe("Bearer ghp_test_token");
    vi.unstubAllEnvs();
  });

  it("sends Authorization header when GH_TOKEN is set (fallback, no GITHUB_TOKEN)", async () => {
    // Clear GITHUB_TOKEN so GH_TOKEN fallback is exercised
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ghp_gh_token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 43, login: "otheruser" }),
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await resolveGithubUserId("otheruser");
    const calledInit = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(calledInit.headers?.Authorization).toBe("Bearer ghp_gh_token");
    vi.unstubAllEnvs();
  });
});

describe("resolveGithubUserId — failure status map", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("throws user-not-found error on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("unknownuser")).rejects.toThrow(
      /not found/i,
    );
  });

  it("throws with numeric-id hint on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("somelogin")).rejects.toThrow(
      /pass a numeric/i,
    );
  });

  it("throws with numeric-id hint on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("somelogin")).rejects.toThrow(
      /pass a numeric/i,
    );
  });

  it("throws with numeric-id hint on 429 (rate limit)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("somelogin")).rejects.toThrow(
      /pass a numeric/i,
    );
  });

  it("throws with numeric-id hint on 5xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("somelogin")).rejects.toThrow(
      /pass a numeric/i,
    );
  });

  it("throws with numeric-id hint on network timeout/error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("fetch failed: connection timeout"),
    );

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("somelogin")).rejects.toThrow(
      /pass a numeric/i,
    );
  });
});

describe("resolveGithubUserId — login regex parity with GITHUB_LOGIN_REGEX", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("rejects logins that start with a hyphen", async () => {
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("-badlogin")).rejects.toThrow(
      /invalid.*login|not a valid/i,
    );
  });

  it("rejects logins that end with a hyphen", async () => {
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId("badlogin-")).rejects.toThrow(
      /invalid.*login|not a valid/i,
    );
  });

  it("rejects logins longer than 39 characters", async () => {
    const longLogin = "a".repeat(40);
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    await expect(resolveGithubUserId(longLogin)).rejects.toThrow(
      /invalid.*login|not a valid/i,
    );
  });

  it("accepts a valid login (alphanumeric + hyphens within)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 55, login: "valid-user" }),
    } as Response);

    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    const id = await resolveGithubUserId("valid-user");
    expect(id).toBe(55);
  });

  it("rejects empty string", async () => {
    const { resolveGithubUserId } = await import(
      "../../lib/cloudflare-resources"
    );
    // Empty string is all-digits (empty) — but actually "" is not digits-only
    // It fails the login regex (no characters) → error
    await expect(resolveGithubUserId("")).rejects.toThrow();
  });
});
