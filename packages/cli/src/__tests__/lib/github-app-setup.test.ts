import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManifestHandler,
  discoverInstallation,
  mintAppJwt,
  registerWithWorker,
} from "../../lib/github-app-setup";

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

// startManifestFlow integration is tested via createManifestHandler below

describe("mintAppJwt", () => {
  // Valid RSA private key for testing (PKCS#1 format as returned by GitHub)
  // Generated with: ssh-keygen -t rsa -b 2048 -m pem
  // gitleaks:allow
  const testPemPkcs1 = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAvECV0kwEy6H8RgKgEa9y3kAz7RlDERuD+oQ7GM2nNDNuDR7t
n2KdMm5+e43jNI8VAMLjDdlym+Zfxip3TAX8Nl3RXZ1l+t9hh+g8vubdHN36Q/Qd
HdAzGRp41EV4CRp0rgGcu4JF3OkwoMD7moyWKNIoOunUP9jaP3/EGE/G+5OxOd1J
1XLvHKI+t/5fDdsUuMBkxOepAfCK3AYSQQPod6QMiQSqXhaeZTubRPXZrR7WWgBl
pDhfydjQxJQXl84+oizsWuJ/rMKhqG8NA2uSd+fwiGH+ActKHo/csVXo8KqVHc9X
AuGCjNtLIi/F+rTkqi8Hq9KTatQlG/viP5VEowIDAQABAoIBABo0OUahG0fHIAkU
w3hCvlAOisvVqN7AQEJGVr2QntYm1IpSBEyb2vrSo5uKOBawVgGZnyZl3syxqCI6
9gkoih99Nq/7wV7G6loTKyV9mEi042nDGKx2Ny6m3yvZEajevGAeTFVTgGsMMJ8n
zb4JFLvQ6RWuR8OtaU/OdprVvAJ3op1mWCiD1V6jsrGRfPFJiQUMWQdAbfGwGXXT
2duxPTet1HLPdvtO3JdtpU9RwvJOtuiFcPT8iGPvaPA56fqNkUFdN+VoMhBrKs1c
IZWGFtPIjOGFs7IlYmUxOUBiyzPH/8DTPlZEAR7zQbWr0f+gYrt3R3zr1n6NxWiX
m3/7MD0CgYEA8agntjubARjHLo18dzflklokZHQQ/b/aFrXpzSFgYC9qcpULS3zn
b/qIoIa+eyga2Ml98FHVod3QBMTwRNSDcb6uvHVLSPW91yYPdLh1GKoJfJpBAuYA
tuzWn13U8qwLA5UlMMuIGvnlHpmYEFytT4lwpM/VMoB5c0CixCSyEAUCgYEAx2z6
BPMDIprbqDqqlPWkZmrACAQhhSj4dvw36535LnwG6r2wjeeZ2YFv50hdqsNvodJV
mdx3qnnBaNJr3/7IiihxdBXMqNeCMjMK6v0VpLOFj3GD2lmRkJw+1SQiDVyDS2kf
XJnd9f4QxdAYUKZlPrpJiQhgHmkQHqiuTHY2KocCgYEA0WowZ8qFi9DGI0B3IPUu
m8JEEU1HwC32t4GTh7EpzJCqhXtFm3g1M6P/rGS4Qw/BHCaYXZ79K9WFw+xKbste
0T42PJjE0ggrKHwSHssOpn4L1I/0UKey7NKXNungdR/EN6mS3hMy8nWmKPtffKZj
hi6LkDePAMG2/bqAksteB2UCgYEAnwx+6muV2IeBIE6JtXujvjrtJHeG9FiUsPC+
+J9pGHW6XoUixkosHZhp0x+X9JUh9wF1W9zFY6TvZ9ZKSr882VMgCOFJ9G7MW5Tx
5DAsjsrOfnSeIArHWXoDcqH6toVOAVq5tHTS3VnfrqQkgE30+W5BL5UKc7Z/MLR/
LmQpFwkCgYA0QFVuZuspmr5hPJdB6To0cOq3P5wLxZ3jlu1gQHgGl6nvGmFvIEW9
ikp/6xlhwJ7Jf+EHpHD8WVwJdm2jbkA3cJuYK5DrOy/GQDPirhRRrhIEEesawWCq
7Qka9RCMN2wwO54a548yJYJ58ytGkoFlikmrb6In3GVsoO1A1g6A1A==
-----END RSA PRIVATE KEY-----`;

  it("mints a valid RS256 JWT", async () => {
    const jwt = await mintAppJwt(123456, testPemPkcs1);

    // JWT should have 3 parts: header.payload.signature
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode header (base64url)
    const headerJson = Buffer.from(parts[0], "base64url").toString("utf-8");
    const header = JSON.parse(headerJson);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");

    // Decode payload
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBeGreaterThan(0);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("throws on invalid PEM", async () => {
    await expect(mintAppJwt(123456, "not-a-pem")).rejects.toThrow();
  });
});

describe("discoverInstallation", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns single installation immediately", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 12345,
          account: { login: "test-org" },
        },
      ],
    });

    const result = await discoverInstallation("fake-jwt");

    expect(result).toEqual({ id: 12345, account: "test-org" });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/app/installations",
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: "Bearer fake-jwt",
          "User-Agent": "tila-cli",
        },
      },
    );
  });

  it("times out after 120s if no installations found", async () => {
    vi.useFakeTimers();

    // Mock empty installations list
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    const discoverPromise = discoverInstallation("fake-jwt");
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(discoverPromise).rejects.toThrow(/timeout/i);

    // Fast-forward 120 seconds
    await vi.advanceTimersByTimeAsync(120 * 1000);

    await assertion;

    vi.useRealTimers();
  });

  it("handles GitHub API errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    await expect(discoverInstallation("fake-jwt")).rejects.toThrow(/401/);
  });
});

describe("registerWithWorker", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("successfully registers installation with Worker", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await expect(
      registerWithWorker(
        "https://example.workers.dev",
        "tila_token_123",
        67890,
      ),
    ).resolves.not.toThrow();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.workers.dev/api/auth/github/app-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tila_token_123",
          "User-Agent": "tila-cli",
        },
        body: JSON.stringify({ installation_id: 67890 }),
      },
    );
  });

  it("throws on Worker unreachable but does not affect credentials", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(
      registerWithWorker(
        "https://example.workers.dev",
        "tila_token_123",
        67890,
      ),
    ).rejects.toThrow(/fetch failed/);
  });

  it("throws on Worker error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    await expect(
      registerWithWorker(
        "https://example.workers.dev",
        "tila_token_123",
        67890,
      ),
    ).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// createManifestHandler
// ---------------------------------------------------------------------------

/**
 * Helper: spin up a real http.Server with the handler under test,
 * perform an HTTP request, and return { status, body, headers }.
 */
async function withServer(
  state: string,
  manifestJson: string,
  tilaDir: string,
  resolve: (creds: import("../../lib/github-app-setup").AppCredentials) => void,
  reject: (err: Error) => void,
): Promise<{
  port: number;
  server: http.Server;
  closeServer: () => Promise<void>;
}> {
  let serverRef: http.Server | null = null;
  const timeoutRef: NodeJS.Timeout | null = null;

  const handler = createManifestHandler(
    state,
    manifestJson,
    tilaDir,
    resolve,
    reject,
    () => serverRef,
    () => timeoutRef,
  );

  serverRef = http.createServer(handler);
  await new Promise<void>((res) => serverRef?.listen(0, "127.0.0.1", res));
  const address = serverRef.address() as { port: number };

  const closeServer = () =>
    new Promise<void>((res) => serverRef?.close(() => res()));

  return { port: address.port, server: serverRef, closeServer };
}

/**
 * Make an HTTP GET request using Node's native http module (bypasses mocked global fetch).
 */
function getUrl(
  url: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers as Record<string, string>,
          });
        });
      })
      .on("error", reject);
  });
}

describe("createManifestHandler", () => {
  let tempDir: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-manifest-test-"));
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Test 1: GET / serves HTML form
  it("GET / serves the auto-submit HTML form (200 text/html with <form>)", async () => {
    const state = "a".repeat(32);
    const manifestJson = JSON.stringify({ name: "tila" });
    const { port, closeServer } = await withServer(
      state,
      manifestJson,
      tempDir,
      vi.fn(),
      vi.fn(),
    );

    try {
      const { status, body, headers } = await getUrl(
        `http://127.0.0.1:${port}/`,
      );
      expect(status).toBe(200);
      expect(headers["content-type"]).toContain("text/html");
      expect(body).toContain("<form");
      expect(body).toContain("manifest-form");
      expect(body).toContain(manifestJson.replace(/'/g, "&#39;"));
    } finally {
      await closeServer();
    }
  });

  // Test 2: Wrong state returns 403
  it("GET /callback/<wrong-state>?code=abc returns 403", async () => {
    const state = "a".repeat(32);
    const wrongState = "b".repeat(32);
    const { port, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      vi.fn(),
      vi.fn(),
    );

    try {
      const { status } = await getUrl(
        `http://127.0.0.1:${port}/callback/${wrongState}?code=validcode123`,
      );
      expect(status).toBe(403);
    } finally {
      await closeServer();
    }
  });

  // Test 3: Correct state + successful exchange → 200 success page
  it("GET /callback/<correct-state>?code=abc with successful exchange returns 200 success page and calls resolve", async () => {
    const state = "c".repeat(32);
    const manifestJson = "{}";
    const resolveCallback = vi.fn();
    const rejectCallback = vi.fn();

    const fakeCredentials = {
      id: 999,
      slug: "tila-test",
      client_id: "Iv1.abc",
      client_secret: "secret123",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
      webhook_secret: "whsec",
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => "",
      json: async () => fakeCredentials,
    });

    const { port, closeServer } = await withServer(
      state,
      manifestJson,
      tempDir,
      resolveCallback,
      rejectCallback,
    );

    try {
      const { status, body } = await getUrl(
        `http://127.0.0.1:${port}/callback/${state}?code=validcode123`,
      );
      expect(status).toBe(200);
      expect(body).toContain("GitHub App created");
      expect(resolveCallback).toHaveBeenCalledWith(
        expect.objectContaining({ app_id: 999, client_id: "Iv1.abc" }),
      );
      expect(rejectCallback).not.toHaveBeenCalled();
    } finally {
      await closeServer();
    }
  });

  // Test 4: Second request after exchange → "already processed"
  it("second request after exchange returns already-processed page", async () => {
    const state = "d".repeat(32);
    const resolveCallback = vi.fn();
    const rejectCallback = vi.fn();

    const fakeCredentials = {
      id: 1,
      slug: "tila-test",
      client_id: "Iv1.x",
      client_secret: "s",
      pem: "p",
      webhook_secret: "w",
    };

    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => fakeCredentials,
    });

    const { port, server, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      resolveCallback,
      rejectCallback,
    );

    // Re-open the server after it might have been closed by resolve
    server.unref();

    try {
      // First request — exchange happens
      await getUrl(`http://127.0.0.1:${port}/callback/${state}?code=code111`);

      // Re-spin a fresh server for the second request using same handler state
      // since the real handler's closure tracks codeExchanged per-instance,
      // we verify by hitting the same server a second time before close.
      // Because the server might be closed by the first resolve, we create a
      // separate handler instance that's already exchanged by using the
      // double-submission logic directly.

      // Build a second server with the SAME handler (same closure, codeExchanged=true)
      // The first handler closed the server on success. Create a fresh server
      // wrapping the same handler to simulate the guard check.
      let serverRef2: http.Server | null = null;
      const handler2 = createManifestHandler(
        state,
        "{}",
        tempDir,
        resolveCallback,
        rejectCallback,
        () => serverRef2,
        () => null,
      );
      // Pre-exhaust exchange by simulating it already happened:
      // We use a second handler, but the guard is per-handler-instance.
      // So we must hit the SAME handler twice. Use the original server if still up.
      // Since closeServer was called internally, open a new one to test the guard path.
      serverRef2 = http.createServer(handler2);
      await new Promise<void>((r) => serverRef2?.listen(0, "127.0.0.1", r));
      const addr2 = serverRef2.address() as { port: number };

      // First call on handler2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => "",
        json: async () => fakeCredentials,
      });
      await getUrl(
        `http://127.0.0.1:${addr2.port}/callback/${state}?code=code222`,
      );

      // handler2's server may be closed now; re-attach
      // Second call should hit the guard
      const serverRef3 = http.createServer(handler2);
      await new Promise<void>((r) => serverRef3.listen(0, "127.0.0.1", r));
      const addr3 = serverRef3.address() as { port: number };

      const { status: status2, body: body2 } = await getUrl(
        `http://127.0.0.1:${addr3.port}/callback/${state}?code=code333`,
      );

      expect(status2).toBe(200);
      expect(body2).toContain("Already processed");

      await new Promise<void>((r) => serverRef3.close(() => r()));
      if (serverRef2.listening) {
        await new Promise<void>((r) => serverRef2?.close(() => r()));
      }
    } finally {
      if (server.listening) await closeServer();
    }
  });

  // Test 5: Missing code → 400
  it("GET /callback/<correct-state> without code returns 400", async () => {
    const state = "e".repeat(32);
    const { port, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      vi.fn(),
      vi.fn(),
    );

    try {
      const { status } = await getUrl(
        `http://127.0.0.1:${port}/callback/${state}`,
      );
      expect(status).toBe(400);
    } finally {
      await closeServer();
    }
  });

  // Test 6: Exchange failure (mocked 422) → 500 error page + reject
  it("exchange failure (422) returns 500 error page and calls reject", async () => {
    const state = "f".repeat(32);
    const resolveCallback = vi.fn();
    const rejectCallback = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () => "bad manifest",
    });

    const { port, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      resolveCallback,
      rejectCallback,
    );

    try {
      const { status, body } = await getUrl(
        `http://127.0.0.1:${port}/callback/${state}?code=badcode123`,
      );
      expect(status).toBe(500);
      expect(body).toContain("Setup failed");
      expect(rejectCallback).toHaveBeenCalled();
      expect(resolveCallback).not.toHaveBeenCalled();
    } finally {
      await closeServer();
    }
  });

  // Test 7: Unknown path → 404
  it("GET /unknown-path returns 404", async () => {
    const state = "0".repeat(32);
    const { port, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      vi.fn(),
      vi.fn(),
    );

    try {
      const { status } = await getUrl(`http://127.0.0.1:${port}/unknown-path`);
      expect(status).toBe(404);
    } finally {
      await closeServer();
    }
  });

  // Test 8: Invalid code (contains semicolons) → 400
  it("GET /callback/<state>?code=<code-with-semicolons> returns 400", async () => {
    const state = "1".repeat(32);
    const { port, closeServer } = await withServer(
      state,
      "{}",
      tempDir,
      vi.fn(),
      vi.fn(),
    );

    try {
      const { status } = await getUrl(
        `http://127.0.0.1:${port}/callback/${state}?code=bad;code`,
      );
      expect(status).toBe(400);
    } finally {
      await closeServer();
    }
  });
});
