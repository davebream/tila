import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TilaApiError,
  TilaClient,
  exchangeGitHubToken,
  isTilaApiError,
} from "../client";

describe("TilaClient", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets default X-Tila-Source header with SDK version", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
    });
    await client.get("/test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Tila-Source"]).toMatch(/^sdk\/\d+\.\d+\.\d+$/);
  });

  it("allows extraHeaders to override default X-Tila-Source", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
      extraHeaders: { "X-Tila-Source": "cli/1.0.0" },
    });
    await client.get("/test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Tila-Source"]).toBe("cli/1.0.0");
  });

  it("sets Authorization header from constructor token", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "tila_secret",
    });
    await client.get("/test");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tila_secret");
  });

  it("strips trailing slash from baseUrl", async () => {
    const client = new TilaClient({
      baseUrl: "https://api.test///",
      token: "t",
    });
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await client.get("/path");
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/path");
  });

  it("throws TilaApiError on non-2xx with error envelope", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Entity not found",
            retryable: false,
          },
        }),
        { status: 404 },
      ),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    await expect(client.get("/test")).rejects.toThrow(TilaApiError);
  });

  it("throws TilaApiError with UNKNOWN code on non-parseable error body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("not json", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TilaApiError);
      expect((err as TilaApiError).code).toBe("UNKNOWN");
      expect((err as TilaApiError).status).toBe(500);
    }
  });

  it("throws Error (not TilaApiError) on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).not.toBeInstanceOf(TilaApiError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Network error");
    }
  });

  it("does not run Zod validation by default (validate: false)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 }),
    );
    const client = new TilaClient({ baseUrl: "https://api.test", token: "t" });
    // Should return raw parsed JSON without validation
    const result = await client.get("/test");
    expect(result).toEqual({ unexpected: "shape" });
  });

  it("throws descriptive Error on timeout (AbortError)", async () => {
    mockFetch.mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "tila_secret_test", // gitleaks:allow
      timeoutMs: 5000,
    });

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TilaApiError);
      expect((err as Error).message).toContain("timed out");
      expect((err as Error).message).toContain("5000ms");
      expect((err as Error).message).toContain("https://api.test");
      // Security: error message must NOT contain the token value
      expect((err as Error).message).not.toContain("tila_secret_test");
    }
  });

  it("throws descriptive Error on timeout (TimeoutError)", async () => {
    mockFetch.mockRejectedValueOnce(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
      timeoutMs: 3000,
    });

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timed out");
      expect((err as Error).message).toContain("3000ms");
    }
  });

  it("passes AbortSignal to fetch in request()", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
      timeoutMs: 10000,
    });
    await client.get("/test");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses default 30000ms timeout when timeoutMs not specified", async () => {
    mockFetch.mockRejectedValueOnce(
      new DOMException("timeout", "TimeoutError"),
    );
    const client = new TilaClient({
      baseUrl: "https://api.test",
      token: "t",
    });

    try {
      await client.get("/test");
      expect.fail("should throw");
    } catch (err) {
      expect((err as Error).message).toContain("30000ms");
    }
  });
});

describe("isTilaApiError", () => {
  it("returns true for TilaApiError instances", () => {
    const err = new TilaApiError(409, "FENCE_CONFLICT", "stale fence", false);
    expect(isTilaApiError(err)).toBe(true);
  });

  it("returns false for plain Error with similar shape", () => {
    const err = Object.assign(new Error("test"), {
      status: 409,
      code: "FENCE_CONFLICT",
      retryable: false,
    });
    expect(isTilaApiError(err)).toBe(false);
  });
});

describe("exchangeGitHubToken", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls POST /api/auth/github/exchange and returns session token", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          session_token: "tila_s.test-fake-session-value", // gitleaks:allow
          expires_at: 1700000000,
          permission: "write",
        }),
        { status: 200 },
      ),
    );

    const result = await exchangeGitHubToken(
      "https://api.test",
      "proj-1",
      "ghp_fake",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test/api/auth/github/exchange");
    expect(JSON.parse(init.body)).toEqual({
      project_id: "proj-1",
      github_token: "ghp_fake",
    });
    expect(result.sessionToken).toBe("tila_s.test-fake-session-value"); // gitleaks:allow
    expect(result.expiresAt).toBe(1700000000);
    expect(result.permission).toBe("write");
  });

  it("throws TilaApiError when exchange returns non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "REPO_NOT_ALLOWED",
            message: "not allowed",
            retryable: false,
          },
        }),
        { status: 403 },
      ),
    );

    await expect(
      exchangeGitHubToken("https://api.test", "proj-1", "ghp_fake"),
    ).rejects.toThrow(TilaApiError);
  });
});
