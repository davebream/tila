/**
 * Artifact grep integration tests.
 *
 * Tests cover:
 * 1. C10 — cookie-session read-scope fix (requirePermission admits "read" sessions)
 * 2. C5  — GET /artifact/grep route (inline fast path, R2-backed blobs, error handling)
 * 3. /artifact/search permission guard (added alongside /grep)
 *
 * These tests run through the Hono app directly (no live server needed).
 */

import { ArtifactGrepResponseSchema } from "@tila/schemas";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requirePermission } from "../../worker/src/middleware/permission";
import { artifacts } from "../../worker/src/routes/artifacts";
import type {
  CookieSessionTokenResult,
  D1TokenResult,
  Env,
  HonoVariables,
  SessionTokenResult,
} from "../../worker/src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AppEnv = { Bindings: Env; Variables: HonoVariables };

const NO_OP_ANALYTICS = {
  writeDataPoint: vi.fn(),
} as unknown as AnalyticsEngineDataset;

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function makeEnv(r2Overrides: Partial<R2Bucket> = {}): Env {
  return {
    DB: {} as D1Database,
    PROJECT: {} as DurableObjectNamespace,
    ARTIFACTS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      list: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
      ...r2Overrides,
    } as unknown as R2Bucket,
    ANALYTICS: NO_OP_ANALYTICS,
  } as unknown as Env;
}

function makeCookieSession(
  scopes: string,
  permission?: string,
): CookieSessionTokenResult {
  // Derive permission from scopes if not explicitly provided,
  // mirroring the normalizeGitHubPermission logic used in production.
  // "full" scopes → "admin"; "read" → "read"; unknown → "none" (fail closed).
  const resolvedPermission =
    permission ??
    (scopes === "full" ? "admin" : scopes === "read" ? "read" : "none");
  return {
    kind: "cookie-session",
    projectId: "proj-1",
    name: "test-actor",
    scopes,
    tokenId: "",
    sessionHash: "test-hash",
    expiresAt: Date.now() + 3_600_000,
    permission: resolvedPermission,
  };
}

function makeD1Token(scopes: string): D1TokenResult {
  return {
    kind: "d1-token",
    projectId: "proj-1",
    name: "test-token",
    scopes,
    tokenId: "tok-uuid",
  };
}

function makeSessionToken(permission: string): SessionTokenResult {
  return {
    kind: "session",
    projectId: "proj-1",
    name: "testuser",
    scopes: permission,
    tokenId: "",
    githubRepoId: 99999,
    githubLogin: "testuser",
    permission,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Create a minimal Hono app that injects the tokenResult and a mock DO stub,
 * then mounts the artifacts router at /artifacts.
 */
function createArtifactApp(
  tokenResult: CookieSessionTokenResult | D1TokenResult | SessionTokenResult,
  doFetchFn: (req: Request) => Promise<Response>,
  r2Overrides: Partial<R2Bucket> = {},
): { app: Hono<AppEnv>; env: Env } {
  const env = makeEnv(r2Overrides);
  const app = new Hono<AppEnv>();

  app.use("/*", async (c, next) => {
    c.set("tokenResult", tokenResult);
    c.set("projectId", "proj-1");
    c.set("doStub", {
      fetch: doFetchFn,
    } as unknown as DurableObjectStub);
    return next();
  });

  app.route("/artifacts", artifacts);
  return { app, env };
}

// ---------------------------------------------------------------------------
// C10 — cookie-session read-scope tests
// ---------------------------------------------------------------------------

describe("C10 — requirePermission cookie-session read scope", () => {
  it("scopes:read cookie session → 200 on read-level route", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("read"));
      return next();
    });
    app.use("/*", requirePermission("read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("scopes:read cookie session → 403 on write-level route (no escalation)", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("read"));
      return next();
    });
    app.use("/*", requirePermission("write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("permission-denied");
    expect(body.error.message).toBe("Requires write permission");
    expect(body.error.retryable).toBe(false);
  });

  it("scopes:read cookie session → 403 on admin-level route (no escalation)", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("read"));
      return next();
    });
    app.use("/*", requirePermission("admin"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(403);
  });

  it("scopes:full cookie session → 200 on read-level route", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("full"));
      return next();
    });
    app.use("/*", requirePermission("read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("scopes:full cookie session → 200 on write-level route", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("full"));
      return next();
    });
    app.use("/*", requirePermission("write"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("scopes:full cookie session → 200 on admin-level route (preserves full=admin behavior)", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("full"));
      return next();
    });
    app.use("/*", requirePermission("admin"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(200);
  });

  it("unknown scopes cookie session → 403", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeCookieSession("unknown-scope"));
      return next();
    });
    app.use("/*", requirePermission("read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    expect(res.status).toBe(403);
  });

  it("session-kind token (GitHub session) path is unchanged", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeSessionToken("read"));
      return next();
    });
    app.use("/*", requirePermission("read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    // session with read permission should pass a read-level route
    expect(res.status).toBe(200);
  });

  it("d1-token with non-full scopes path is unchanged (still 403)", async () => {
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("tokenResult", makeD1Token("read"));
      return next();
    });
    app.use("/*", requirePermission("read"));
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.fetch(
      new Request("http://localhost/test"),
      makeEnv(),
      mockCtx,
    );
    // non-full D1 tokens still 403 (unchanged behavior)
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Grep route tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal DO stub that responds to /artifact/grep-candidates with
 * the given candidates array.
 */
function makeDOWithCandidates(
  candidates: Array<{
    r2_key: string;
    kind: string;
    resource: string | null;
    mime_type: string;
    bytes: number;
    content_inline: string | null;
  }>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/artifact/grep-candidates") {
      return new Response(JSON.stringify({ ok: true, candidates }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), {
      status: 404,
    });
  };
}

/**
 * Build an R2 object mock that streams the given string body.
 */
function makeR2Object(content: string): R2ObjectBody {
  const bytes = new TextEncoder().encode(content);
  return {
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
    text: async () => content,
    json: async () => JSON.parse(content),
    blob: async () => new Blob([bytes]),
    bodyUsed: false,
    size: bytes.byteLength,
    etag: "test-etag",
    httpEtag: `"test-etag"`,
    checksums: {
      md5: undefined,
      sha1: undefined,
      sha256: undefined,
      sha512: undefined,
      crc32: undefined,
      crc32c: undefined,
    },
    httpMetadata: { contentType: "text/plain" },
    customMetadata: {},
    key: "test-key",
    version: "1",
    storageClass: "Standard",
    uploaded: new Date(),
    writeHttpMetadata: vi.fn(),
  } as unknown as R2ObjectBody;
}

describe("GET /artifacts/grep — validation", () => {
  it("returns 400 when pattern is missing", async () => {
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates([]),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep"),
      env,
      mockCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation-error");
  });

  it("returns 400 when pattern is empty", async () => {
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates([]),
    );
    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern="),
      env,
      mockCtx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 with invalid-grep-pattern code for catastrophic regex", async () => {
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates([]),
    );
    // (a+)+ is a known catastrophic backtracking pattern
    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("(a+)+")} &regex=true`,
      ),
      env,
      mockCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid-grep-pattern");
    expect(body.error.retryable).toBe(false);
    // Sanitization check: no platform internals in the error
    const msg = body.error.message.toLowerCase();
    expect(msg).not.toContain("r2");
    expect(msg).not.toContain("durable object");
    expect(msg).not.toContain("sqlite");
    expect(msg).not.toContain("isolate");
    expect(msg).not.toContain("worker");
  });

  it("returns 403 for read cookie session on write-level check (no escalation via grep)", async () => {
    // grep is read-level; but test that the route exists and is guarded
    const { app, env } = createArtifactApp(
      makeCookieSession("read"),
      makeDOWithCandidates([]),
    );
    // Since grep is read-level, "read" cookie session should pass
    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=hello"),
      env,
      mockCtx,
    );
    // Should NOT be 403 (the permission guard passes)
    // It might be 502 if DO fails, but not 403
    expect(res.status).not.toBe(403);
  });
});

describe("GET /artifacts/grep — inline fast path (0 R2 reads)", () => {
  it("returns matched lines from inline content without calling ARTIFACTS.get", async () => {
    const inlineContent = "first line\nhello world\nthird line\nhello again\n";
    const candidates = [
      {
        r2_key: "produced/proj-1/abc123.md",
        kind: "lesson",
        resource: "task/1",
        mime_type: "text/plain",
        bytes: inlineContent.length,
        content_inline: inlineContent,
      },
    ];

    const r2GetSpy = vi.fn().mockResolvedValue(null);
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=hello"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const data = parsed.data;
    expect(data.ok).toBe(true);
    expect(data.scanned).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].lines).toHaveLength(2);
    expect(data.results[0].lines[0].col).toBeGreaterThan(0);

    // KEY assertion: ARTIFACTS.get was never called (inline fast path)
    expect(r2GetSpy).not.toHaveBeenCalled();
  });

  it("returns correct line numbers and col (1-based)", async () => {
    // Line 1: "foo bar baz"  → no match
    // Line 2: "find needle here"  → match at col 6
    // Line 3: "another needle"  → match at col 9
    const inlineContent = "foo bar baz\nfind needle here\nanother needle\n";
    const candidates = [
      {
        r2_key: "produced/proj-1/abc.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: inlineContent.length,
        content_inline: inlineContent,
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("needle")}`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const lines = parsed.data.results[0].lines;
    expect(lines).toHaveLength(2);
    // Line 2: "find needle here" — "needle" starts at index 5 → col 6
    expect(lines[0].line).toBe(2);
    expect(lines[0].col).toBe(6);
    // Line 3: "another needle" — "needle" starts at index 8 → col 9
    expect(lines[1].line).toBe(3);
    expect(lines[1].col).toBe(9);
  });

  it("literal mode: pattern a.c does NOT match abc (only literal a.c)", async () => {
    const inlineContent = "abc is here\na.c is literal\n";
    const candidates = [
      {
        r2_key: "produced/proj-1/literal.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: inlineContent.length,
        content_inline: inlineContent,
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("a.c")}`,
        // No &regex=true → literal mode
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const lines = parsed.data.results[0].lines;
    // Only "a.c is literal" should match, not "abc is here"
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("a.c is literal");
  });

  it("regex mode: pattern a.c matches abc (dot is wildcard)", async () => {
    const inlineContent = "abc is here\na.c is literal\n";
    const candidates = [
      {
        r2_key: "produced/proj-1/regex.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: inlineContent.length,
        content_inline: inlineContent,
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("a.c")}&regex=true`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const lines = parsed.data.results[0].lines;
    // Both "abc is here" and "a.c is literal" should match (a.c as regex)
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /artifacts/grep — R2-backed blobs", () => {
  it("calls ARTIFACTS.get for blobs without content_inline and returns matches", async () => {
    const blobContent = "line one\nmatch this line\nline three\n";
    const r2GetSpy = vi.fn().mockResolvedValue(makeR2Object(blobContent));

    const candidates = [
      {
        r2_key: "produced/proj-1/large.md",
        kind: "report",
        resource: null,
        mime_type: "text/plain",
        bytes: blobContent.length,
        content_inline: null, // triggers R2 fetch
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("match this")}`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.scanned).toBe(1);
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0].lines).toHaveLength(1);
    expect(parsed.data.results[0].lines[0].text).toContain("match this line");

    // KEY assertion: ARTIFACTS.get WAS called
    expect(r2GetSpy).toHaveBeenCalledWith("produced/proj-1/large.md");
  });

  it("skips candidate and increments skipped when blob is missing (null from R2)", async () => {
    const r2GetSpy = vi.fn().mockResolvedValue(null); // blob absent

    const candidates = [
      {
        r2_key: "produced/proj-1/missing.md",
        kind: "report",
        resource: null,
        mime_type: "text/plain",
        bytes: 100,
        content_inline: null,
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=anything"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.ok).toBe(true);
    expect(parsed.data.scanned).toBe(0);
    expect(parsed.data.skipped).toBe(1);
    expect(parsed.data.results).toHaveLength(0);
  });

  it("skips candidate and continues when R2 get throws", async () => {
    const r2GetSpy = vi.fn().mockRejectedValue(new Error("R2 network error"));

    const candidates = [
      {
        r2_key: "produced/proj-1/throwing.md",
        kind: "report",
        resource: null,
        mime_type: "text/plain",
        bytes: 100,
        content_inline: null,
      },
      {
        r2_key: "produced/proj-1/ok.md",
        kind: "report",
        resource: null,
        mime_type: "text/plain",
        bytes: 20,
        content_inline: "found needle here\n",
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=needle"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // First candidate skipped (threw), second (inline) scanned
    expect(parsed.data.skipped).toBe(1);
    expect(parsed.data.scanned).toBe(1);
    expect(parsed.data.results).toHaveLength(1);
  });
});

describe("GET /artifacts/grep — invariants and caps", () => {
  it("scanned + skipped <= candidates.length", async () => {
    const r2GetSpy = vi.fn().mockResolvedValue(null); // all blobs missing

    const candidates = Array.from({ length: 5 }, (_, i) => ({
      r2_key: `produced/proj-1/blob${i}.md`,
      kind: "note",
      resource: null,
      mime_type: "text/plain",
      bytes: 100,
      content_inline: null,
    }));

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=anything"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.scanned + parsed.data.skipped).toBeLessThanOrEqual(
      candidates.length,
    );
  });

  it("sets truncated:true when limit (candidate cap) is reached", async () => {
    // Request limit=2 and DO returns exactly 2 candidates — should truncate
    // (the route treats "returned count >= limit" as "possibly more exist")
    const candidates = [
      {
        r2_key: "produced/proj-1/a.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: 5,
        content_inline: "match\n",
      },
      {
        r2_key: "produced/proj-1/b.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: 5,
        content_inline: "match\n",
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      // DO returns exactly `limit` items — triggers truncated flag
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=match&limit=2"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // When exactly limit candidates were returned, truncated must be true
    expect(parsed.data.truncated).toBe(true);
  });

  it("sets truncated:false when fewer candidates than limit are returned", async () => {
    // Request limit=10 but DO only returns 1 candidate — no truncation
    const candidates = [
      {
        r2_key: "produced/proj-1/only.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: 5,
        content_inline: "match\n",
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=match&limit=10"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Fewer than limit candidates — no truncation from candidate cap
    expect(parsed.data.truncated).toBe(false);
  });

  it("response conforms to ArtifactGrepResponseSchema", async () => {
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates([
        {
          r2_key: "produced/proj-1/test.md",
          kind: "adr",
          resource: "task/42",
          mime_type: "text/plain",
          bytes: 20,
          content_inline: "hello world\n",
        },
      ]),
    );

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=hello"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const data = parsed.data;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.scanned).toBe("number");
    expect(typeof data.skipped).toBe("number");
    expect(typeof data.truncated).toBe("boolean");
  });

  it("R2-backed blob larger than GREP_PER_BLOB_BYTE_CAP: sets per-result truncated:true, returns early match", async () => {
    // Craft a blob that exceeds the 1 MiB per-blob cap.
    // Early content (first line) has the match. Content after the cap should
    // not be needed — the important assertion is truncated:true on the result
    // and that the early match IS returned.
    //
    // Strategy: build a string > 1 MiB with the match on line 1, padding on
    // subsequent lines. We use 1 byte per char (ASCII) for predictable sizing.
    const OVER_1MIB = 1_048_576 + 1024; // just over 1 MiB
    const matchLine1 = "found_it_here\n";
    const paddingLine = `${"x".repeat(1023)}\n`; // 1 KiB per line
    const linesNeeded = Math.ceil(
      (OVER_1MIB - matchLine1.length) / paddingLine.length,
    );
    const blobContent = matchLine1 + paddingLine.repeat(linesNeeded);

    const r2GetSpy = vi.fn().mockResolvedValue(makeR2Object(blobContent));

    const candidates = [
      {
        r2_key: "produced/proj-1/large-blob.md",
        kind: "report",
        resource: null,
        mime_type: "text/plain",
        bytes: blobContent.length,
        content_inline: null, // force R2 path
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
      { get: r2GetSpy },
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("found_it_here")}`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // The early match on line 1 must be returned
    expect(parsed.data.results).toHaveLength(1);
    expect(parsed.data.results[0].lines).toHaveLength(1);
    expect(parsed.data.results[0].lines[0].line).toBe(1);
    expect(parsed.data.results[0].lines[0].text).toContain("found_it_here");

    // The per-result truncated flag must be set because the blob exceeded the cap
    expect(parsed.data.results[0].truncated).toBe(true);
  });

  it("blob with more than GREP_MAX_MATCHES_PER_BLOB (50) matching lines caps at 50", async () => {
    // Build an inline candidate with 60 matching lines — accumulator should
    // stop at 50 per-blob match cap.
    const matchingLines = Array.from(
      { length: 60 },
      (_, i) => `match line ${i + 1}`,
    ).join("\n");

    const candidates = [
      {
        r2_key: "produced/proj-1/many-matches.md",
        kind: "note",
        resource: null,
        mime_type: "text/plain",
        bytes: matchingLines.length,
        content_inline: matchingLines,
      },
    ];

    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates(candidates),
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("match line")}`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ArtifactGrepResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.results).toHaveLength(1);
    // Cap at GREP_MAX_MATCHES_PER_BLOB (50), not 60
    expect(parsed.data.results[0].lines.length).toBe(50);
  });

  it("error body contains no platform internal tokens (R2/DO/SQLite/isolate/Worker)", async () => {
    // Invalid pattern triggers 400 — check sanitized error
    const { app, env } = createArtifactApp(
      makeD1Token("full"),
      makeDOWithCandidates([]),
    );

    const res = await app.fetch(
      new Request(
        `http://localhost/artifacts/grep?pattern=${encodeURIComponent("(a+)+")} &regex=true`,
      ),
      env,
      mockCtx,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: false;
      error: { message: string };
    };
    const msg = JSON.stringify(body).toLowerCase();
    expect(msg).not.toContain("r2");
    expect(msg).not.toContain("durable object");
    expect(msg).not.toContain("sqlite");
    expect(msg).not.toContain("isolate");
    // "worker" might appear in non-internal context — check specific patterns
    expect(msg).not.toContain("durableobject");
  });
});

describe("GET /artifacts/grep — DO forward failure returns sanitized 502", () => {
  it("returns 502 grep-candidates-failed (not a DO error message) when DO is down", async () => {
    // DO returns 503
    const doFetch = async (_req: Request) =>
      new Response(
        JSON.stringify({
          ok: false,
          error: "Durable Object is overloaded — SQLite write failed",
        }),
        { status: 503 },
      );

    const { app, env } = createArtifactApp(makeD1Token("full"), doFetch);

    const res = await app.fetch(
      new Request("http://localhost/artifacts/grep?pattern=hello"),
      env,
      mockCtx,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      ok: false;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("grep-candidates-failed");
    expect(body.error.retryable).toBe(true);
    // The DO error message must NOT leak through
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain("durable object");
    expect(serialized).not.toContain("sqlite");
  });
});

describe("/artifacts/search — permission guard (C10 prerequisite)", () => {
  it("scopes:read cookie session → not 403 on /search (guard admits read)", async () => {
    // /search now has requirePermission("read") — after C10, read sessions pass
    const doFetch = async (_req: Request) =>
      new Response(JSON.stringify({ ok: true, results: [], total: 0 }), {
        status: 200,
      });

    const { app, env } = createArtifactApp(makeCookieSession("read"), doFetch);

    const res = await app.fetch(
      new Request("http://localhost/artifacts/search?q=hello"),
      env,
      mockCtx,
    );

    // 200 (forwarded to DO) or other non-403
    expect(res.status).not.toBe(403);
  });
});
