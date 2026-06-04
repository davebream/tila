import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock child_process to prevent gh auth token from intercepting and browser launch
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("gh not available");
  }),
  execFile: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock @clack/prompts for user output
vi.mock("@clack/prompts", () => ({
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

import * as p from "@clack/prompts";
import {
  fetchClientId,
  pollForToken,
  resolveAppUserToken,
  startDeviceFlow,
} from "../../lib/github-oauth-device";

describe("fetchClientId", () => {
  beforeEach(() => {
    // Reset all mocks but preserve the stubGlobal setup
    mockFetch.mockReset();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    // Reset existsSync to return false by default
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("fetches client_id from Worker endpoint first", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ app_id: 12345, client_id: "Iv1.abc123" }),
    });

    const clientId = await fetchClientId(
      "https://test.workers.dev",
      "/tmp/tila",
    );

    expect(clientId).toBe("Iv1.abc123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.workers.dev/api/auth/github/app-info",
    );
  });

  it("falls back to .tila/github-app.json when Worker is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        app_id: 12345,
        client_id: "Iv1.fallback",
        pem: "-----BEGIN RSA PRIVATE KEY-----\n...",
        client_secret: "secret",
        webhook_secret: "whsec_123",
      }),
    );

    const clientId = await fetchClientId(
      "https://test.workers.dev",
      "/tmp/tila",
    );

    expect(clientId).toBe("Iv1.fallback");
  });

  it("throws when Worker is unreachable and local config is missing", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(existsSync).mockReturnValue(false);

    await expect(
      fetchClientId("https://test.workers.dev", "/tmp/tila"),
    ).rejects.toThrow(/GitHub App not configured/i);
  });

  it("throws when Worker is unreachable and local config is malformed", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{ invalid json");

    await expect(
      fetchClientId("https://test.workers.dev", "/tmp/tila"),
    ).rejects.toThrow(/GitHub App not configured/i);
  });
});

describe("startDeviceFlow", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns device code, user code, verification_uri, and interval", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "device_abc123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    });

    const result = await startDeviceFlow("Iv1.abc123");

    expect(result).toEqual({
      device_code: "device_abc123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 5,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://github.com/login/device/code",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
    // Verify the body contains the client_id
    const callArgs = mockFetch.mock.calls[0];
    const body = callArgs[1].body;
    expect(body.get("client_id")).toBe("Iv1.abc123");
  });

  it("rejects non-https verification_uri", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "device_abc123",
        user_code: "ABCD-1234",
        verification_uri: "http://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    });

    await expect(startDeviceFlow("Iv1.abc123")).rejects.toThrow(
      /verification_uri/i,
    );
  });

  it("rejects verification_uri with trailing slash", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "device_abc123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device/",
        expires_in: 900,
        interval: 5,
      }),
    });

    await expect(startDeviceFlow("Iv1.abc123")).rejects.toThrow(
      /verification_uri/i,
    );
  });

  it("rejects verification_uri with query params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "device_abc123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device?foo=bar",
        expires_in: 900,
        interval: 5,
      }),
    });

    await expect(startDeviceFlow("Iv1.abc123")).rejects.toThrow(
      /verification_uri/i,
    );
  });

  it("rejects verification_uri with wrong domain", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "device_abc123",
        user_code: "ABCD-1234",
        verification_uri: "https://example.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    });

    await expect(startDeviceFlow("Iv1.abc123")).rejects.toThrow(
      /verification_uri/i,
    );
  });
});

describe("pollForToken", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns access_token on successful authorization", async () => {
    // First call: authorization_pending (GitHub returns 200 for all poll responses)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "authorization_pending" }),
    });
    // Second call: access_token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ghu_test_token" }),
    });

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);

    // Advance 5 seconds to trigger first poll
    await vi.advanceTimersByTimeAsync(5000);
    // Advance 5 more seconds to trigger second poll
    await vi.advanceTimersByTimeAsync(5000);

    const token = await pollPromise;

    expect(token).toBe("ghu_test_token");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("handles slow_down by increasing interval", async () => {
    // First call: slow_down (GitHub returns 200 for all poll responses)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "slow_down" }),
    });
    // Second call: access_token
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ghu_test_token" }),
    });

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);

    // Advance 5 seconds to trigger first poll
    await vi.advanceTimersByTimeAsync(5000);
    // Interval should now be 10 seconds (5 + 5)
    await vi.advanceTimersByTimeAsync(10000);

    const token = await pollPromise;

    expect(token).toBe("ghu_test_token");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("caps backoff at 60 seconds", async () => {
    // Simulate many slow_down responses (GitHub returns 200 for all poll responses)
    for (let i = 0; i < 15; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: "slow_down" }),
      });
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ghu_test_token" }),
    });

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);

    // Advance through multiple slow_down responses
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(60000); // Max interval is 60s
    }
    await vi.advanceTimersByTimeAsync(60000);

    const token = await pollPromise;

    expect(token).toBe("ghu_test_token");
  });

  it("throws on expired_token", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "expired_token" }),
    });

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(pollPromise).rejects.toThrow(/expired_token/i);

    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
  });

  it("throws on access_denied", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ error: "access_denied" }),
    });

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(pollPromise).rejects.toThrow(/access_denied/i);

    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
  });

  it("stops after 120 attempts", async () => {
    // Simulate authorization_pending for all attempts (GitHub returns 200)
    for (let i = 0; i < 125; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: "authorization_pending" }),
      });
    }

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(pollPromise).rejects.toThrow(/timeout/i);

    // Advance through 120 attempts
    for (let i = 0; i < 120; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }

    await assertion;
  });

  it("enforces 30s timeout on fetch calls", async () => {
    // Mock a hanging fetch that never resolves
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          // Never resolve
        }),
    );

    const pollPromise = pollForToken("Iv1.abc123", "device_abc123", 5);
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(pollPromise).rejects.toThrow(/timeout/i);

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(30000); // 30s timeout

    await assertion;
  }, 10000); // 10s test timeout
});

describe("resolveAppUserToken", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(p.log.warn).mockReset();
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    // Reset isTTY to original
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  it("returns cached token when cache is valid", async () => {
    const futureExpiry = Date.now() / 1000 + 7200; // 2 hours from now
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        user_token: "ghu_cached_token",
        expires_at: futureExpiry,
        project_id: "test-proj",
      }),
    );

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("ghu_cached_token");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("re-exchanges when cache TTL is under 10 minutes", async () => {
    const nearExpiry = Date.now() / 1000 + 300; // 5 minutes from now
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        user_token: "ghu_stale_token",
        expires_at: nearExpiry,
        project_id: "test-proj",
      }),
    );
    process.env.GITHUB_TOKEN = "ghu_env_token";

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("ghu_env_token");
  });

  it("uses GITHUB_TOKEN env var when set", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    process.env.GITHUB_TOKEN = "ghu_env_token";

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("ghu_env_token");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("emits warning for classic PAT in GITHUB_TOKEN env var", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    process.env.GITHUB_TOKEN = "ghp_classic_pat_token";

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("ghp_classic_pat_token");
    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("classic PAT"),
    );
  });

  it("accepts fine-grained PAT (github_pat_) without warning", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    process.env.GITHUB_TOKEN = "github_pat_fine_grained_token";

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("github_pat_fine_grained_token");
    expect(vi.mocked(p.log.warn)).not.toHaveBeenCalled();
  });

  it("accepts ghs_ prefix (GitHub App installation token) without warning", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    process.env.GITHUB_TOKEN = "ghs_installation_token";

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(token).toBe("ghs_installation_token");
    expect(vi.mocked(p.log.warn)).not.toHaveBeenCalled();
  });

  it("throws with interactive terminal message when not a TTY", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    await expect(
      resolveAppUserToken(
        { project_id: "test-proj", worker_url: "https://test.workers.dev" },
        "/tmp/tila",
      ),
    ).rejects.toThrow(/interactive terminal/i);
  });

  it("runs device flow and returns token when TTY is available", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    // Use interval=0 so pollForToken's setTimeout fires with no delay
    // Mock fetchClientId (Worker endpoint)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ app_id: 12345, client_id: "client-123" }),
    });
    // Mock startDeviceFlow — use interval 0 to avoid needing timer advance
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "dev_code_abc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      }),
    });
    // Mock pollForToken — immediate success on first poll
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ghu_token" }),
    });

    const token = await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );
    expect(token).toBe("ghu_token");
  }, 10000);

  it("writes cache after successful device flow", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no cache
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ app_id: 12345, client_id: "client-123" }),
    });
    // interval=0 to avoid timer management in test
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_code: "dev_code_abc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: "ghu_token" }),
    });

    await resolveAppUserToken(
      { project_id: "test-proj", worker_url: "https://test.workers.dev" },
      "/tmp/tila",
    );

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining("github-token-cache.json"),
      expect.stringContaining("ghu_token"),
      expect.objectContaining({ mode: 0o600 }),
    );
  }, 10000);
});
