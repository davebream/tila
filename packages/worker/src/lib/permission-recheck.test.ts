import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERMISSION_RECHECK_BACKOFF_MS,
  PERMISSION_RECHECK_CACHE_MAX_SIZE,
  PERMISSION_RECHECK_TTL_MS,
} from "../config";
import type { Env, SessionTokenResult } from "../types";

// ---------------------------------------------------------------------------
// Hoist mocks so they are available inside vi.mock factories (hoisted to top)
// ---------------------------------------------------------------------------
const {
  mockGetInstallation,
  mockIsRegistered,
  mockMintAppJwt,
  mockGetInstallationAccessToken,
} = vi.hoisted(() => ({
  mockGetInstallation: vi.fn(),
  mockIsRegistered: vi.fn(),
  mockMintAppJwt: vi.fn(),
  mockGetInstallationAccessToken: vi.fn(),
}));

// Mock @tila/backend-d1 stores — mirrors auth-github.test.ts:59-83
vi.mock("@tila/backend-d1", () => ({
  GitHubAppConfigStore: vi.fn().mockImplementation(
    class {
      getInstallation = mockGetInstallation;
    } as unknown as () => unknown,
  ),
  RepoAllowlistStore: vi.fn().mockImplementation(
    class {
      isRegistered = mockIsRegistered;
    } as unknown as () => unknown,
  ),
}));

// Mock github-app module.
// mintAppJwt and getInstallationAccessToken are controlled per-test.
// checkUserMembershipStatus is implemented inline (delegates to global.fetch)
// so test case (b) drives it through a real HTTP 404 → {kind:"absent"} mapping
// without circular mocking.
// GitHubAppTokenError is re-implemented with the same shape as the real class.
vi.mock("./github-app", () => ({
  mintAppJwt: mockMintAppJwt,
  getInstallationAccessToken: mockGetInstallationAccessToken,
  GitHubAppTokenError: class GitHubAppTokenError extends Error {
    readonly status: number;
    constructor(status: number, message?: string) {
      super(message ?? `GitHub API returned ${status}`);
      this.name = "GitHubAppTokenError";
      this.status = status;
    }
  },
  checkUserMembershipStatus: async (
    installationToken: string,
    owner: string,
    repo: string,
    login: string,
    apiBase = "https://api.github.com",
  ) => {
    try {
      const res = await fetch(
        `${apiBase}/repos/${owner}/${repo}/collaborators/${login}/permission`,
        { headers: { Authorization: `Bearer ${installationToken}` } },
      );
      if (res.status === 200) {
        const data = (await res.json()) as { permission: string };
        return { kind: "permission" as const, value: data.permission };
      }
      if (res.status === 404) {
        return { kind: "absent" as const };
      }
      return { kind: "error" as const };
    } catch {
      return { kind: "error" as const };
    }
  },
}));

// Import after mocks are set up
import { GitHubAppTokenError } from "./github-app";
import {
  _resetPermissionRecheckCacheForTest,
  reverifySessionPermission,
} from "./permission-recheck";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(envOverrides: Partial<Env> = {}) {
  return {
    env: {
      DB: {} as D1Database,
      PROJECT: {} as DurableObjectNamespace,
      ARTIFACTS: {} as R2Bucket,
      ANALYTICS: {
        writeDataPoint: vi.fn(),
      } as unknown as AnalyticsEngineDataset,
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "FAKE_KEY",
      ...envOverrides,
    } as Env,
  } as unknown as Parameters<typeof reverifySessionPermission>[0];
}

function makeSession(
  overrides: Partial<SessionTokenResult> = {},
): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-1",
    name: "alice",
    scopes: "full",
    tokenId: "tok-1",
    githubRepoId: 42,
    githubLogin: "alice",
    githubUserId: 42,
    permission: "admin",
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    jti: "jti-test-123",
    ...overrides,
  };
}

function makeResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const DEFAULT_INSTALLATION = { installation_id: 999, project_id: "proj-1" };
const DEFAULT_REPO_ROW = {
  project_id: "proj-1",
  github_host: "github.com",
  github_repo_id: 42,
  github_owner: "acme",
  github_repo: "myrepo",
  min_read_permission: "read",
  min_write_permission: "write",
  max_permission: "admin",
  membership_enabled: 1,
  membership_role_cap: "maintainer",
};
const INSTALL_TOKEN = "ghs_install_token";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("reverifySessionPermission", () => {
  beforeEach(() => {
    _resetPermissionRecheckCacheForTest();
    vi.clearAllMocks();
    // Default happy-path stubs
    mockGetInstallation.mockResolvedValue(DEFAULT_INSTALLATION);
    mockIsRegistered.mockResolvedValue(DEFAULT_REPO_ROW);
    mockMintAppJwt.mockResolvedValue("app_jwt");
    mockGetInstallationAccessToken.mockResolvedValue(INSTALL_TOKEN);
  });

  // -------------------------------------------------------------------------
  // (a) 200 downgrade admin→read → deny
  // -------------------------------------------------------------------------
  it("(a) denies when live GitHub permission is lower than required (admin→read)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "read" }));
    const c = makeContext();
    const session = makeSession({ permission: "admin", jti: "jti-a" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toMatch(/permission downgraded/i);
    }
  });

  // -------------------------------------------------------------------------
  // (b) 404 absent → deny (must NOT fail open)
  // global.fetch returns a real HTTP 404 so checkUserMembershipStatus (inline
  // mock impl) maps it to {kind:"absent"} — non-circular.
  // -------------------------------------------------------------------------
  it("(b) denies when GitHub returns 404 (collaborator absent)", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResponse(404));
    const c = makeContext();
    const session = makeSession({ jti: "jti-b" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toMatch(/access was revoked/i);
    }
  });

  // -------------------------------------------------------------------------
  // (c) unchanged admin (200 admin) → allow{cacheable:true}
  // -------------------------------------------------------------------------
  it("(c) allows when live permission meets requirement (admin, required admin)", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    const c = makeContext();
    const session = makeSession({ jti: "jti-c" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("allow");
    if (result.decision === "allow") {
      expect(result.cacheable).toBe(true);
    }
  });

  it("denies when the repository policy caps a live admin at write", async () => {
    mockIsRegistered.mockResolvedValue({
      ...DEFAULT_REPO_ROW,
      max_permission: "write",
    });
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));

    const result = await reverifySessionPermission(
      makeContext(),
      makeSession({ jti: "jti-cap" }),
      "admin",
    );

    expect(result.decision).toBe("deny");
  });

  it("caches the effective role instead of a requirement-independent grant", async () => {
    mockIsRegistered.mockResolvedValue({
      ...DEFAULT_REPO_ROW,
      max_permission: "write",
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    global.fetch = fetchSpy;
    const session = makeSession({ jti: "jti-role-cache" });

    await expect(
      reverifySessionPermission(makeContext(), session, "write"),
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      reverifySessionPermission(makeContext(), session, "admin"),
    ).resolves.toMatchObject({ decision: "deny" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // (d) no App installation → deny (unavailable)
  // -------------------------------------------------------------------------
  it("(d) denies when no App installation is configured (unavailable)", async () => {
    mockGetInstallation.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-d" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (d2) App secrets absent → deny (unavailable) — MUST NOT throw/500
  // -------------------------------------------------------------------------
  it("(d2) denies when GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY are absent", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext({
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
    });
    const session = makeSession({ jti: "jti-d2" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Second call: should be cache-served (still allow)
    const result2 = await reverifySessionPermission(c, session, "admin");
    expect(result2.decision).toBe("deny");
    // getInstallation should not have been called (secrets guard fires first)
    expect(mockGetInstallation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (e) App uninstalled (getInstallationAccessToken throws GitHubAppTokenError
  //     status 404) → deny (unavailable); second call issues no GitHub call
  // -------------------------------------------------------------------------
  it("(e) denies as unavailable and caches when App is uninstalled (404 token error)", async () => {
    mockGetInstallationAccessToken.mockRejectedValue(
      new GitHubAppTokenError(404, "GitHub API returned 404"),
    );
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-e" });

    const result = await reverifySessionPermission(c, session, "admin");
    expect(result.decision).toBe("deny");

    // Second call: must be cache-served — no new GitHub calls
    const result2 = await reverifySessionPermission(c, session, "admin");
    expect(result2.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockMintAppJwt).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // (e2) non-404 install-token throw → deny (retryable) + backoff
  // -------------------------------------------------------------------------
  it("(e2) denies transiently when getInstallationAccessToken throws non-404", async () => {
    mockGetInstallationAccessToken.mockRejectedValue(
      new GitHubAppTokenError(500, "GitHub API returned 500"),
    );
    global.fetch = vi.fn();
    const c = makeContext();
    const session = makeSession({ jti: "jti-e2" });

    const result = await reverifySessionPermission(c, session, "admin");
    expect(result.decision).toBe("deny");
  });

  // -------------------------------------------------------------------------
  // (f) repo de-listed (isRegistered → null) → deny
  // -------------------------------------------------------------------------
  it("(f) denies when repo is no longer in the allowlist", async () => {
    mockIsRegistered.mockResolvedValue(null);
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-f" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toMatch(/no longer registered/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (g) getInstallation D1 throw → deny (fail-closed)
  // -------------------------------------------------------------------------
  it("(g) denies when getInstallation throws (fail-closed D1 error)", async () => {
    mockGetInstallation.mockRejectedValue(new Error("D1 unavailable"));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-g" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (g2) isRegistered D1 throw → deny (fail-closed)
  // -------------------------------------------------------------------------
  it("(g2) denies when isRegistered throws (fail-closed D1 error)", async () => {
    mockIsRegistered.mockRejectedValue(new Error("D1 timeout"));
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-g2" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (h) membership 503 → deny (retryable) + backoff:
  //   - call within backoff issues no GitHub call
  //   - call after backoff retries
  // -------------------------------------------------------------------------
  it("(h) transient GitHub error triggers backoff; retries after backoff window", async () => {
    // First call: GitHub returns 503
    global.fetch = vi.fn().mockResolvedValue(makeResponse(503));
    const c = makeContext();
    const session = makeSession({ jti: "jti-h" });

    const result1 = await reverifySessionPermission(c, session, "admin");
    expect(result1.decision).toBe("deny");

    // Second call within backoff window — must NOT hit GitHub again
    const fetchSpy2 = vi.fn();
    global.fetch = fetchSpy2;
    const result2 = await reverifySessionPermission(c, session, "admin");
    expect(result2.decision).toBe("deny");
    expect(fetchSpy2).not.toHaveBeenCalled();

    // Simulate backoff window expiry
    const origNow = Date.now.bind(Date);
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(origNow() + PERMISSION_RECHECK_BACKOFF_MS + 1);
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));

    const result3 = await reverifySessionPermission(c, session, "admin");
    expect(result3.decision).toBe("allow");
    expect(global.fetch).toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // (i) two calls within settled TTL after a grant → exactly one membership call
  // -------------------------------------------------------------------------
  it("(i) caches grant and issues only one checkUserMembershipStatus within settled TTL", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: "jti-i" });

    const result1 = await reverifySessionPermission(c, session, "admin");
    expect(result1.decision).toBe("allow");

    const result2 = await reverifySessionPermission(c, session, "admin");
    expect(result2.decision).toBe("allow");

    // global.fetch is called once per checkUserMembershipStatus call;
    // the second reverify should be cache-served
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // (j) session with githubHost undefined → defaults to "github.com"
  // -------------------------------------------------------------------------
  it("(j) defaults githubHost to 'github.com' when absent on the session", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    const c = makeContext();
    const session = makeSession({ githubHost: undefined, jti: "jti-j" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("allow");
    expect(mockIsRegistered).toHaveBeenCalledWith("proj-1", "github.com", 42);
  });

  // -------------------------------------------------------------------------
  // (k) cache exceeds PERMISSION_RECHECK_CACHE_MAX_SIZE → oldest entry evicted
  // -------------------------------------------------------------------------
  it("(k) evicts oldest entry when cache exceeds max size", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    const c = makeContext();

    const firstJti = "jti-k-first";
    // Insert firstJti first so it becomes the oldest entry
    await reverifySessionPermission(c, makeSession({ jti: firstJti }), "admin");

    // Fill the rest of the cache (MAX_SIZE - 1 more entries)
    for (let i = 1; i < PERMISSION_RECHECK_CACHE_MAX_SIZE; i++) {
      await reverifySessionPermission(
        c,
        makeSession({ jti: `jti-k-fill-${i}` }),
        "admin",
      );
    }

    // One more → should evict firstJti (the oldest)
    await reverifySessionPermission(
      c,
      makeSession({ jti: "jti-k-overflow" }),
      "admin",
    );

    // The next call for firstJti must re-issue a fetch (cache miss after eviction)
    const fetchCountBefore = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;
    await reverifySessionPermission(c, makeSession({ jti: firstJti }), "admin");
    const fetchCountAfter = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(fetchCountAfter).toBeGreaterThan(fetchCountBefore);
  });

  // -------------------------------------------------------------------------
  // (l) downgrade vs required, not snapshot:
  //   session minted admin, live GitHub permission now write, route required admin → deny
  //   proves comparison floor is the `required` argument, not session.permission
  // -------------------------------------------------------------------------
  it("(l) denies when live permission is below required, regardless of session.permission", async () => {
    // Live GitHub returns write — enough if the session was minted at write,
    // but the ROUTE requires admin → should still deny
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "write" }));
    const c = makeContext();
    const session = makeSession({ permission: "admin", jti: "jti-l" });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    if (result.decision === "deny") {
      expect(result.reason).toMatch(/permission downgraded/i);
    }
  });

  // -------------------------------------------------------------------------
  // pre-C9 token (no jti) → deny without cache key
  // -------------------------------------------------------------------------
  it("denies without re-verify when session has no jti (pre-C9 token)", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const c = makeContext();
    const session = makeSession({ jti: undefined });

    const result = await reverifySessionPermission(c, session, "admin");

    expect(result.decision).toBe("deny");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("fail-closed cache transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPermissionRecheckCacheForTest();
    mockGetInstallation.mockResolvedValue(DEFAULT_INSTALLATION);
    mockIsRegistered.mockResolvedValue({ ...DEFAULT_REPO_ROW });
    mockMintAppJwt.mockResolvedValue("app-jwt");
    mockGetInstallationAccessToken.mockResolvedValue("installation-token");
    global.fetch = vi
      .fn()
      .mockImplementation(async () =>
        makeResponse(200, { permission: "admin" }),
      );
    vi.useFakeTimers();
  });
  it.each([404, 500, 429])(
    "expired grant followed by installation HTTP %s never reuses old authority",
    async (status) => {
      const c = makeContext();
      const session = makeSession();
      expect(
        (await reverifySessionPermission(c, session, "admin")).decision,
      ).toBe("allow");
      vi.advanceTimersByTime(PERMISSION_RECHECK_TTL_MS);
      mockGetInstallationAccessToken.mockRejectedValue(
        new GitHubAppTokenError(status),
      );
      const failure = await reverifySessionPermission(c, session, "admin");
      expect(failure).toMatchObject({
        decision: "deny",
        status: 503,
        retryable: status !== 404,
      });
      expect(await reverifySessionPermission(c, session, "admin")).toEqual(
        failure,
      );
      expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(2);
      mockGetInstallationAccessToken.mockResolvedValue("new-token");
      vi.advanceTimersByTime(
        status === 404
          ? PERMISSION_RECHECK_TTL_MS
          : PERMISSION_RECHECK_BACKOFF_MS,
      );
      expect(
        (await reverifySessionPermission(c, session, "admin")).decision,
      ).toBe("allow");
    },
  );
  it("cached collaborator denial expires exactly at the settled TTL", async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResponse(404));
    const c = makeContext();
    const session = makeSession();
    const failure = await reverifySessionPermission(c, session, "write");
    expect(failure).toMatchObject({ status: 403, retryable: false });
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    vi.advanceTimersByTime(PERMISSION_RECHECK_TTL_MS - 1);
    expect(await reverifySessionPermission(c, session, "write")).toEqual(
      failure,
    );
    expect(global.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(
      (await reverifySessionPermission(c, session, "write")).decision,
    ).toBe("allow");
  });
  it.each([
    "secrets",
    "installation",
    "repository",
    "disabled",
    "policy",
    "membership-cap",
    "D1",
  ])("a warm grant cannot hide changed %s", async (change) => {
    const c = makeContext();
    const session = makeSession();
    expect(
      (await reverifySessionPermission(c, session, "admin")).decision,
    ).toBe("allow");
    if (change === "secrets") c.env.GITHUB_APP_PRIVATE_KEY = undefined;
    if (change === "installation") mockGetInstallation.mockResolvedValue(null);
    if (change === "repository") mockIsRegistered.mockResolvedValue(null);
    if (change === "disabled")
      mockIsRegistered.mockResolvedValue({
        ...DEFAULT_REPO_ROW,
        membership_enabled: 0,
      });
    if (change === "policy")
      mockIsRegistered.mockResolvedValue({
        ...DEFAULT_REPO_ROW,
        max_permission: "write",
      });
    if (change === "membership-cap")
      mockIsRegistered.mockResolvedValue({
        ...DEFAULT_REPO_ROW,
        membership_role_cap: "participant",
      });
    if (change === "D1")
      mockGetInstallation.mockRejectedValue(new Error("D1 offline"));
    expect(
      (await reverifySessionPermission(c, session, "admin")).decision,
    ).toBe("deny");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("rotation to an invalid App key cannot reuse a cached grant", async () => {
    const c = makeContext();
    const session = makeSession();
    await reverifySessionPermission(c, session, "admin");
    c.env.GITHUB_APP_PRIVATE_KEY = "invalid-rotated-key";
    mockMintAppJwt.mockRejectedValue(new Error("invalid PEM"));
    expect(await reverifySessionPermission(c, session, "admin")).toMatchObject({
      status: 503,
      retryable: false,
      reason: expect.stringMatching(/repair/i),
    });
  });
  it.each(["jti", "project", "repo", "installation", "cookie"])(
    "does not share verified authority across %s identities",
    async (change) => {
      const c = makeContext();
      const session = makeSession();
      await reverifySessionPermission(c, session, "admin");
      global.fetch = vi.fn().mockResolvedValue(makeResponse(404));
      if (change === "jti") session.jti = "another-jti";
      if (change === "project") session.projectId = "another-project";
      if (change === "repo") session.githubRepoId = 99;
      if (change === "installation")
        mockGetInstallation.mockResolvedValue({ installation_id: 1000 });
      const credential =
        change === "cookie"
          ? {
              kind: "cookie-session" as const,
              projectId: session.projectId,
              name: "alice",
              scopes: "admin",
              tokenId: "",
              sessionHash: session.jti ?? "missing-jti",
              expiresAt: session.expiresAt,
              permission: "admin",
              principalId: "github:github.com:42",
              sourceRepoId: 42,
            }
          : session;
      expect(
        await reverifySessionPermission(c, credential, "admin"),
      ).toMatchObject({ status: 403 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("network failure stays denied through backoff and recovers at its boundary", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const c = makeContext();
    const session = makeSession();
    const failure = await reverifySessionPermission(c, session, "admin");
    expect(failure).toMatchObject({ status: 503, retryable: true });
    global.fetch = vi
      .fn()
      .mockResolvedValue(makeResponse(200, { permission: "admin" }));
    vi.advanceTimersByTime(PERMISSION_RECHECK_BACKOFF_MS - 1);
    expect(await reverifySessionPermission(c, session, "admin")).toEqual(
      failure,
    );
    expect(global.fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(
      (await reverifySessionPermission(c, session, "admin")).decision,
    ).toBe("allow");
  });
});
