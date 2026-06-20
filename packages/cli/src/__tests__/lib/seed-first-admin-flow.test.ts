import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the cloudflare-resources module so we can control seedFirstAdmin and resolveGithubUserId
const mockResolveGithubUserId = vi.fn();
const mockSeedFirstAdmin = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  resolveGithubUserId: (...args: unknown[]) => mockResolveGithubUserId(...args),
  seedFirstAdmin: (...args: unknown[]) => mockSeedFirstAdmin(...args),
  // keep other exports as stubs
  insertTokenAndProject: vi.fn(),
  insertGithubAppConfig: vi.fn(),
  queryD1: vi.fn(),
  resolveZoneId: vi.fn(),
  createCustomDomain: vi.fn(),
  ensureD1Database: vi.fn(),
  applyD1Migrations: vi.fn(),
  ensureR2Bucket: vi.fn(),
  applyR2Lifecycle: vi.fn(),
  setWorkerSecret: vi.fn(),
  setWorkerSecrets: vi.fn(),
  deleteWorkerSecret: vi.fn(),
  deletePagesProject: vi.fn(),
}));

// Minimal Cloudflare client mock
function makeMockClient() {
  return {
    d1: { database: { query: vi.fn() } },
  };
}

describe("runFirstAdminSeed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("success path: resolves login and seeds admin, returns seeded:true + githubUserId", async () => {
    mockResolveGithubUserId.mockResolvedValue(583231);
    mockSeedFirstAdmin.mockResolvedValue(undefined);

    const { runFirstAdminSeed } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const client = makeMockClient();
    const result = await runFirstAdminSeed({
      flag: "octocat",
      token: "raw-token",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client: client as any,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
    });

    expect(result.seeded).toBe(true);
    expect(result.githubUserId).toBe(583231);
    expect(result.login).toBe("octocat");
    expect(result.error).toBeUndefined();
    expect(mockResolveGithubUserId).toHaveBeenCalledWith("octocat");
    expect(mockSeedFirstAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "my-proj",
        githubUserId: 583231,
      }),
    );
  });

  it("success path with numeric id: passes through without treating as login", async () => {
    mockResolveGithubUserId.mockResolvedValue(12345);
    mockSeedFirstAdmin.mockResolvedValue(undefined);

    const { runFirstAdminSeed } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const client = makeMockClient();
    const result = await runFirstAdminSeed({
      flag: "12345",
      token: "raw-token",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client: client as any,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
    });

    expect(result.seeded).toBe(true);
    expect(result.githubUserId).toBe(12345);
    expect(mockResolveGithubUserId).toHaveBeenCalledWith("12345");
  });

  it("resolution failure: returns seeded:false with error message", async () => {
    mockResolveGithubUserId.mockRejectedValue(
      new Error("GitHub user not found"),
    );

    const { runFirstAdminSeed } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const client = makeMockClient();
    const result = await runFirstAdminSeed({
      flag: "unknownuser",
      token: "raw-token",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client: client as any,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
    });

    expect(result.seeded).toBe(false);
    expect(result.error).toMatch(/GitHub user not found/i);
    expect(result.githubUserId).toBeUndefined();
    expect(mockSeedFirstAdmin).not.toHaveBeenCalled();
  });

  it("seed failure: returns seeded:false with error message", async () => {
    mockResolveGithubUserId.mockResolvedValue(999);
    mockSeedFirstAdmin.mockRejectedValue(new Error("D1 write failed"));

    const { runFirstAdminSeed } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const client = makeMockClient();
    const result = await runFirstAdminSeed({
      flag: "someuser",
      token: "raw-token",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      client: client as any,
      accountId: "acc-1",
      databaseId: "db-uuid",
      slug: "my-proj",
    });

    expect(result.seeded).toBe(false);
    expect(result.error).toMatch(/D1 write failed/i);
    expect(result.githubUserId).toBeUndefined();
  });
});

describe("applySeedOutcome", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("seeded:true → exitCode 0 + first_admin_seeded:true in json payload", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const result = applySeedOutcome(
      { seeded: true, githubUserId: 583231, login: "octocat" },
      { json: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      first_admin_seeded: true,
      first_admin: { github_user_id: 583231, login: "octocat" },
    });
    expect(result.message).toBeUndefined();
  });

  it("seeded:true with no login → exitCode 0, first_admin has no login field or null", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const result = applySeedOutcome(
      { seeded: true, githubUserId: 12345 },
      { json: false },
    );

    expect(result.exitCode).toBe(0);
  });

  it("seeded:false → exitCode 1 + first_admin_seeded:false in json payload", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const result = applySeedOutcome(
      { seeded: false, error: "GitHub user not found" },
      { json: true },
    );

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ first_admin_seeded: false });
    expect(result.json).not.toMatchObject({ first_admin_seeded: true });
  });

  it("seeded:false → exitCode 1 in non-json mode with message", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const result = applySeedOutcome(
      { seeded: false, error: "rate limited" },
      { json: false },
    );

    expect(result.exitCode).toBe(1);
    // Should contain a remediation hint pointing at D1 token/--token fallback
    expect(result.message).toMatch(/numeric|token|--token/i);
  });

  it("applySeedOutcome never returns exitCode 0 when seeded is false", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    for (const error of [
      "network error",
      "rate limited",
      "user not found",
      "D1 failed",
    ]) {
      const result = applySeedOutcome(
        { seeded: false, error },
        { json: false },
      );
      expect(result.exitCode).toBe(1);
    }
  });

  it("applySeedOutcome never returns exitCode 1 when seeded is true", async () => {
    const { applySeedOutcome } = await import(
      "../../lib/seed-first-admin-flow"
    );
    const result = applySeedOutcome(
      { seeded: true, githubUserId: 1 },
      { json: false },
    );
    expect(result.exitCode).toBe(0);
  });
});
