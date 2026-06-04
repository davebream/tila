import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process BEFORE importing the module under test.
// This is critical: no test must invoke the real wrangler binary.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import {
  TokenScopeError,
  WranglerCommandError,
  WranglerNotFoundError,
  WranglerVersionError,
  detectWrangler,
  parseDeployedUrl,
  runWrangler,
  validateTokenScopes,
} from "../../lib/wrangler-cli";

import { execFile as _execFile } from "node:child_process";

const execFile = _execFile as unknown as ReturnType<typeof vi.fn>;

// Helper to make execFile call its callback with given args
function mockExecFile(error: Error | null, stdout: string, stderr: string) {
  execFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: object,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(error, stdout, stderr);
    },
  );
}

describe("detectWrangler()", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("throws WranglerNotFoundError on ENOENT", async () => {
    const enoentError = new Error(
      "spawn wrangler ENOENT",
    ) as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";
    mockExecFile(enoentError, "", "");

    await expect(detectWrangler()).rejects.toThrow(WranglerNotFoundError);
  });

  it("WranglerNotFoundError includes install guidance without wrangler login", async () => {
    const enoentError = new Error(
      "spawn wrangler ENOENT",
    ) as NodeJS.ErrnoException;
    enoentError.code = "ENOENT";
    mockExecFile(enoentError, "", "");

    let err: WranglerNotFoundError | undefined;
    try {
      await detectWrangler();
    } catch (e) {
      err = e as WranglerNotFoundError;
    }

    expect(err).toBeInstanceOf(WranglerNotFoundError);
    expect(err?.message).toContain("wrangler");
    // Must include install guidance
    expect(err?.message).toMatch(/npm i -g wrangler|pnpm add -g wrangler/);
    // Must NOT mention wrangler login
    expect(err?.message).not.toContain("wrangler login");
  });

  it("throws WranglerVersionError when wrangler version is below the minimum floor", async () => {
    // Version 3.0.0 is below the floor (3.78.0)
    mockExecFile(null, "3.0.0", "");

    await expect(detectWrangler()).rejects.toThrow(WranglerVersionError);
  });

  it("WranglerVersionError includes upgrade guidance", async () => {
    mockExecFile(null, "2.0.0", "");

    let err: WranglerVersionError | undefined;
    try {
      await detectWrangler();
    } catch (e) {
      err = e as WranglerVersionError;
    }

    expect(err).toBeInstanceOf(WranglerVersionError);
    expect(err?.message).toContain("wrangler");
    // Should mention upgrade or minimum version
    expect(err?.message).toMatch(/upgrade|update|minimum|3\./i);
  });

  it("resolves successfully when wrangler version meets the minimum floor", async () => {
    // 3.78.0 is the minimum floor
    mockExecFile(null, " 3.78.0 ", "");

    await expect(detectWrangler()).resolves.toBeUndefined();
  });

  it("resolves successfully for a newer wrangler version", async () => {
    mockExecFile(null, "4.93.0", "");

    await expect(detectWrangler()).resolves.toBeUndefined();
  });
});

describe("runWrangler()", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls execFile with an argv array (never a shell string)", async () => {
    mockExecFile(null, "deployed successfully", "");

    await runWrangler(["deploy", "-c", "wrangler.toml"], {
      token: "test-token",
      accountId: "test-account-id",
    });

    expect(execFile).toHaveBeenCalledOnce();
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]];
    // Must be called with separate argv elements, not a shell string
    expect(typeof cmd).toBe("string");
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain("deploy");
    expect(args).toContain("-c");
    expect(args).toContain("wrangler.toml");
  });

  it("passes shell:false (no shell interpolation)", async () => {
    mockExecFile(null, "ok", "");

    await runWrangler(["deploy"], { token: "tok", accountId: "acc" });

    const [, , opts] = execFile.mock.calls[0] as [
      string,
      string[],
      { shell?: boolean },
    ];
    expect(opts.shell).toBe(false);
  });

  it("passes only minimal env: PATH, HOME, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID", async () => {
    mockExecFile(null, "ok", "");

    await runWrangler(["deploy"], {
      token: "my-secret-token",
      accountId: "my-account-id",
    });

    const [, , opts] = execFile.mock.calls[0] as [
      string,
      string[],
      { env?: Record<string, string> },
    ];
    const env = opts.env ?? {};

    // Must have required keys
    expect(env).toHaveProperty("CLOUDFLARE_API_TOKEN", "my-secret-token");
    expect(env).toHaveProperty("CLOUDFLARE_ACCOUNT_ID", "my-account-id");
    expect(env).toHaveProperty("PATH");
    expect(env).toHaveProperty("HOME");

    // Must NOT spread process.env (should only have exactly these 4 keys)
    const envKeys = Object.keys(env);
    expect(envKeys).toHaveLength(4);
    expect(envKeys).toContain("PATH");
    expect(envKeys).toContain("HOME");
    expect(envKeys).toContain("CLOUDFLARE_API_TOKEN");
    expect(envKeys).toContain("CLOUDFLARE_ACCOUNT_ID");
  });

  it("returns stdout and stderr on success", async () => {
    mockExecFile(null, "deployed: https://my-worker.workers.dev", "");

    const result = await runWrangler(["deploy"], {
      token: "tok",
      accountId: "acc",
    });

    expect(result.stdout).toBe("deployed: https://my-worker.workers.dev");
    expect(result.code).toBe(0);
  });

  it("throws WranglerCommandError on non-zero exit", async () => {
    const exitError = new Error("Command failed") as NodeJS.ErrnoException;
    (exitError as unknown as { code: number }).code = 1;
    mockExecFile(exitError, "", "Deploy failed: some error");

    await expect(
      runWrangler(["deploy"], { token: "tok", accountId: "acc" }),
    ).rejects.toThrow(WranglerCommandError);
  });

  it("redacts token-shaped strings (30+ chars) in error output", async () => {
    const tokenLikeString = "a".repeat(40); // 40 char token-shaped string
    const exitError = new Error("Command failed") as NodeJS.ErrnoException;
    (exitError as unknown as { code: number }).code = 1;
    mockExecFile(
      exitError,
      "",
      `Error: bad token ${tokenLikeString} was rejected`,
    );

    let err: WranglerCommandError | undefined;
    try {
      await runWrangler(["deploy"], { token: "tok", accountId: "acc" });
    } catch (e) {
      err = e as WranglerCommandError;
    }

    expect(err).toBeInstanceOf(WranglerCommandError);
    expect(err?.message).not.toContain(tokenLikeString);
    expect(err?.message).toContain("[REDACTED]");
  });

  it("does not log or interpolate the token in any argument", async () => {
    mockExecFile(null, "ok", "");

    const secretToken = "super-secret-cloudflare-api-token-value";
    await runWrangler(["deploy"], { token: secretToken, accountId: "acc" });

    const [, args] = execFile.mock.calls[0] as [string, string[]];
    // Token must not appear in any argument
    for (const arg of args) {
      expect(arg).not.toContain(secretToken);
    }
  });
});

describe("parseDeployedUrl()", () => {
  it("extracts a workers.dev URL from wrangler output", () => {
    const stdout =
      "Deployed to https://my-worker.my-account.workers.dev\nOther stuff";
    expect(parseDeployedUrl(stdout)).toBe(
      "https://my-worker.my-account.workers.dev",
    );
  });

  it("extracts URL from wrangler's standard deploy output format", () => {
    const stdout = `
✨  Built successfully, built project size is 20 KiB.
✨  Successfully published your script to
 https://tila-worker.my-subdomain.workers.dev
Current Deployment ID: abc123
    `;
    const url = parseDeployedUrl(stdout);
    expect(url).toMatch(/^https:\/\/.+\.workers\.dev$/);
  });

  it("returns null when no URL is found in output", () => {
    expect(parseDeployedUrl("No URL here")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3: validateTokenScopes — capability probes
// ---------------------------------------------------------------------------

describe("validateTokenScopes()", () => {
  // We mock global fetch for these tests — no real Cloudflare calls
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  function mockFetchResponses(
    responses: Record<string, { status: number; body?: object }>,
  ) {
    // Sort patterns by length (longest first) to ensure more specific patterns win
    const sortedEntries = Object.entries(responses).sort(
      ([a], [b]) => b.length - a.length,
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      for (const [pattern, response] of sortedEntries) {
        if (url.includes(pattern)) {
          return Promise.resolve({
            ok: response.status < 400,
            status: response.status,
            json: () => Promise.resolve(response.body ?? {}),
            text: () => Promise.resolve(JSON.stringify(response.body ?? {})),
          });
        }
      }
      // Default: 200 OK
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
      });
    });
  }

  it("throws TokenScopeError for Workers Scripts: Edit when /workers/scripts returns 403", async () => {
    mockFetchResponses({
      // Account probe: OK
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      // Workers scripts probe: 403
      "/workers/scripts": { status: 403 },
      // D1 probe: OK
      "/d1/database": { status: 200 },
      // R2 probe: OK
      "/r2/buckets": { status: 200 },
    });

    await expect(validateTokenScopes("tok", "acc123")).rejects.toThrow(
      TokenScopeError,
    );

    let err: TokenScopeError | undefined;
    try {
      await validateTokenScopes("tok", "acc123");
    } catch (e) {
      err = e as TokenScopeError;
    }
    expect(err).toBeInstanceOf(TokenScopeError);
    expect(err?.message).toContain("Workers Scripts: Edit");
  });

  it("throws TokenScopeError for D1: Edit when /d1/database returns 403", async () => {
    mockFetchResponses({
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      "/workers/scripts": { status: 200 },
      "/d1/database": { status: 403 },
      "/r2/buckets": { status: 200 },
    });

    let err: TokenScopeError | undefined;
    try {
      await validateTokenScopes("tok", "acc123");
    } catch (e) {
      err = e as TokenScopeError;
    }
    expect(err).toBeInstanceOf(TokenScopeError);
    expect(err?.message).toContain("D1: Edit");
  });

  it("throws TokenScopeError for R2 Storage: Edit when /r2/buckets returns 403", async () => {
    mockFetchResponses({
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      "/workers/scripts": { status: 200 },
      "/d1/database": { status: 200 },
      "/r2/buckets": { status: 403 },
    });

    let err: TokenScopeError | undefined;
    try {
      await validateTokenScopes("tok", "acc123");
    } catch (e) {
      err = e as TokenScopeError;
    }
    expect(err).toBeInstanceOf(TokenScopeError);
    expect(err?.message).toContain("R2 Storage: Edit");
  });

  it("includes the Cloudflare dashboard token URL in TokenScopeError message", async () => {
    mockFetchResponses({
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      "/workers/scripts": { status: 403 },
    });

    let err: TokenScopeError | undefined;
    try {
      await validateTokenScopes("tok", "acc123");
    } catch (e) {
      err = e as TokenScopeError;
    }
    expect(err?.message).toMatch(/dash\.cloudflare\.com.*token/i);
  });

  it("resolves without throwing when all probes succeed", async () => {
    mockFetchResponses({
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      "/workers/scripts": { status: 200 },
      "/d1/database": { status: 200 },
      "/r2/buckets": { status: 200 },
    });

    await expect(validateTokenScopes("tok", "acc123")).resolves.toBeUndefined();
  });

  it("does not throw on network error / 5xx (non-fatal, non-403)", async () => {
    // A 500 on any probe is non-fatal — don't block deploy on unreliable probe
    mockFetchResponses({
      "/accounts": {
        status: 200,
        body: { result: [{ id: "acc123", name: "Test" }] },
      },
      "/workers/scripts": { status: 500 },
      "/d1/database": { status: 500 },
      "/r2/buckets": { status: 500 },
    });

    await expect(validateTokenScopes("tok", "acc123")).resolves.toBeUndefined();
  });

  it("does not throw when fetch rejects with a network error (non-fatal)", async () => {
    // Mock all fetch calls to reject (network error)
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/accounts")) {
        // Account probe must succeed for verifyCloudflareAuth
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ result: [{ id: "acc123", name: "Test" }] }),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.reject(new Error("Network error"));
    });
    globalThis.fetch = mockFetch;

    // Network errors on capability probes are non-fatal
    await expect(validateTokenScopes("tok", "acc123")).resolves.toBeUndefined();
  });
});
