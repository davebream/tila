import type { ProjectMembership } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliClient } from "../../lib/client-factory";

const mockResolveGithubUserId = vi.fn();
vi.mock("../../lib/cloudflare-resources", () => ({
  resolveGithubUserId: (...args: unknown[]) => mockResolveGithubUserId(...args),
}));

function grantResponse(
  overrides: Partial<ProjectMembership> = {},
  created = true,
) {
  return {
    ok: true,
    created,
    membership: {
      membership_id: "61728627-2d74-4ec0-8a52-bc8c59bf0036",
      project_id: "my-proj",
      principal_id: "github:github.com:583231",
      provider: "github",
      identity_host: "github.com",
      subject_id: "583231",
      subject_kind: "human",
      role: "owner",
      display_name: "octocat",
      granted_by: "token:bootstrap-id",
      granted_at: 1791820000000,
      revoked_by: null,
      revoked_at: null,
      ...overrides,
    },
  };
}

async function seed(flag = "octocat") {
  const { runFirstAdminSeed } = await import("../../lib/seed-first-admin-flow");
  return runFirstAdminSeed({
    flag,
    client: createCliClient("https://worker.example", "tila_test_bootstrap"),
    slug: "my-proj",
  });
}

describe("runFirstAdminSeed", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockResolveGithubUserId.mockResolvedValue(583231);
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves a login and grants an audited owner membership through the Worker", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(grantResponse()));
    expect(await seed()).toEqual({
      seeded: true,
      githubUserId: 583231,
      login: "octocat",
    });
    expect(mockResolveGithubUserId).toHaveBeenCalledWith("octocat");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("https://worker.example/projects/my-proj/memberships");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({
      Authorization: "Bearer tila_test_bootstrap",
    });
    expect(JSON.parse(String(options?.body))).toEqual({
      principal: {
        provider: "github",
        host: "github.com",
        user_id: 583231,
        login: "octocat",
      },
      subject_kind: "human",
      role: "owner",
    });
  });

  it("seeds a numeric identity without a login snapshot", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(grantResponse()));
    expect(await seed("583231")).toEqual({
      seeded: true,
      githubUserId: 583231,
    });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).principal).toEqual({
      provider: "github",
      host: "github.com",
      user_id: 583231,
    });
  });

  it("accepts an existing owner without another grant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(grantResponse({}, false)),
    );
    expect(await seed()).toMatchObject({ seeded: true });
  });

  it.each(["viewer", "participant", "maintainer"] as const)(
    "fails when the persisted role is %s",
    async (role) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json(grantResponse({ role }, false)));
      expect(await seed()).toMatchObject({
        seeded: false,
        error: expect.stringContaining("Explicitly update"),
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { project_id: "another-project" },
    { principal_id: "github:github.com:99", subject_id: "99" },
    { provider: "oidc" as const },
    { identity_host: "another.example" },
    { subject_kind: "service" as const },
    { revoked_at: 1791820000000 },
  ])(
    "rejects a membership that differs from the requested active GitHub owner: %j",
    async (overrides) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json(grantResponse(overrides)),
      );
      expect(await seed()).toMatchObject({
        seeded: false,
        error: expect.stringContaining("does not match"),
      });
    },
  );

  it("validates the response with the shared schema", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: true, created: true }),
    );
    expect(await seed()).toMatchObject({
      seeded: false,
      error: expect.any(String),
    });
  });

  it("does not call the Worker when GitHub resolution fails", async () => {
    mockResolveGithubUserId.mockRejectedValue(
      new Error("GitHub user not found"),
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await seed()).toEqual({
      seeded: false,
      error: "GitHub user not found",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports rejected bootstrap authentication as seed failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Invalid token",
            retryable: false,
          },
        },
        { status: 401 },
      ),
    );
    expect(await seed()).toMatchObject({
      seeded: false,
      error: expect.stringContaining("Invalid token"),
    });
  });

  it("reports an unreachable Worker as seed failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Worker unreachable"),
    );
    expect(await seed()).toMatchObject({
      seeded: false,
      error: expect.stringContaining("Network error connecting"),
    });
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
