import {
  type Mock,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resolveDeployConfig } from "../../lib/deploy";

// ---------------------------------------------------------------------------
// Mock modules (hoisted — must be before imports that use them)
// ---------------------------------------------------------------------------

vi.mock("../../lib/wrangler-cli", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/wrangler-cli")>();
  return {
    ...actual,
    detectWrangler: vi.fn(),
    validateTokenScopes: vi.fn(),
    runWrangler: vi.fn(),
    parseDeployedUrl: vi.fn(),
  };
});

vi.mock("../../lib/wrangler-config", () => ({
  generateWranglerConfig: vi.fn(),
  assertAssetLimits: vi.fn(),
}));

vi.mock("../../lib/provisioning", () => ({
  isMonorepoLayout: vi.fn(),
  resolveWorkerMainPath: vi.fn(() => "/fake/packages/worker/src/index.ts"),
  resolveUiDistDir: vi.fn(() => "/fake/packages/ui/dist"),
  tilaHome: vi.fn(() => "/fake/.tila"),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import {
  type UiOutcome,
  deployWorkerWithAssets,
  describeUiOutcome,
} from "../../lib/deploy";
import { isMonorepoLayout } from "../../lib/provisioning";
import {
  WranglerCommandError,
  detectWrangler,
  parseDeployedUrl,
  runWrangler,
  validateTokenScopes,
} from "../../lib/wrangler-cli";
import {
  assertAssetLimits,
  generateWranglerConfig,
} from "../../lib/wrangler-config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
global.fetch = mockFetch;

function makeOpts(
  overrides?: Partial<Parameters<typeof deployWorkerWithAssets>[0]>,
) {
  return {
    cf: {} as never,
    accountId: "acc-123",
    scriptName: "tila-dev",
    d1DatabaseId: "db-abc",
    r2BucketName: "tila-artifacts",
    apiToken: "tok-xyz",
    skipUi: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: resolveDeployConfig (existing, kept green)
// ---------------------------------------------------------------------------

describe("resolveDeployConfig", () => {
  const validConfig = {
    project_id: "tila-111da1",
    schema_version: 1,
    tila_version: "0.1.0",
    created_at: "2026-05-19T21:00:00Z",
    backend: "cloudflare" as const,
    cloudflare: { account_id: "abc123" },
  };

  it("returns slug and accountId for valid cloudflare project", () => {
    const result = resolveDeployConfig({ config: validConfig });
    expect(result).toEqual({ slug: "tila-111da1", accountId: "abc123" });
  });

  it("throws when no config found", () => {
    expect(() => resolveDeployConfig({ config: null })).toThrow(
      "No tila project found",
    );
  });

  it("throws when backend is local", () => {
    expect(() =>
      resolveDeployConfig({
        config: { ...validConfig, backend: "local" as "cloudflare" },
      }),
    ).toThrow("Cloudflare-backed project");
  });

  it("defaults to cloudflare when backend is undefined", () => {
    const { backend: _, ...configWithoutBackend } = validConfig;
    const result = resolveDeployConfig({
      config: configWithoutBackend as typeof validConfig,
    });
    expect(result.slug).toBe("tila-111da1");
  });

  it("throws when cloudflare account_id is missing", () => {
    expect(() =>
      resolveDeployConfig({
        config: { ...validConfig, cloudflare: undefined },
      }),
    ).toThrow("No Cloudflare account ID");
  });
});

// ---------------------------------------------------------------------------
// Tests: deployWorkerWithAssets
// ---------------------------------------------------------------------------

describe("deployWorkerWithAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: wrangler detected, scopes OK, monorepo layout
    (detectWrangler as Mock).mockResolvedValue(undefined);
    (validateTokenScopes as Mock).mockResolvedValue(undefined);
    (isMonorepoLayout as Mock).mockReturnValue(true);
    (execSync as Mock).mockReturnValue(undefined); // pnpm build succeeds
    (assertAssetLimits as Mock).mockReturnValue(undefined);
    (generateWranglerConfig as Mock).mockReturnValue(
      "/fake/packages/worker/wrangler.tila-dev.toml",
    );
    (runWrangler as Mock).mockResolvedValue({
      stdout: "Published tila-dev\nhttps://tila-dev.workers.dev\n",
      stderr: "",
      code: 0,
    });
    (parseDeployedUrl as Mock).mockReturnValue("https://tila-dev.workers.dev");

    // Smoke check: / returns 200, /api/health returns 200
    mockFetch.mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Success path -------------------------------------------------------

  it("returns {kind:'deployed', url} on full success", async () => {
    const result = await deployWorkerWithAssets(makeOpts());

    expect(result.ui.kind).toBe("deployed");
    expect(result.workerUrl).toBe("https://tila-dev.workers.dev");
    if (result.ui.kind === "deployed") {
      expect(result.ui.url).toBe("https://tila-dev.workers.dev");
    }
  });

  it("calls detectWrangler and validateTokenScopes before deploy", async () => {
    await deployWorkerWithAssets(makeOpts());
    expect(detectWrangler).toHaveBeenCalledOnce();
    expect(validateTokenScopes).toHaveBeenCalledWith("tok-xyz", "acc-123");
  });

  it("calls generateWranglerConfig with correct args", async () => {
    await deployWorkerWithAssets(makeOpts());
    expect(generateWranglerConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "tila-dev",
        databaseId: "db-abc",
        r2BucketName: "tila-artifacts",
      }),
    );
  });

  it("calls runWrangler with deploy -c <configPath>", async () => {
    await deployWorkerWithAssets(makeOpts());
    expect(runWrangler).toHaveBeenCalledWith(
      ["deploy", "-c", "/fake/packages/worker/wrangler.tila-dev.toml"],
      expect.objectContaining({
        token: "tok-xyz",
        accountId: "acc-123",
      }),
    );
  });

  // ---- Monorepo UI build gate -------------------------------------------

  it("runs pnpm --filter @tila/ui build when isMonorepoLayout is true", async () => {
    (isMonorepoLayout as Mock).mockReturnValue(true);
    await deployWorkerWithAssets(makeOpts());
    expect(execSync).toHaveBeenCalledWith(
      "pnpm --filter @tila/ui build",
      expect.objectContaining({
        env: expect.objectContaining({ VITE_API_URL: "" }),
      }),
    );
  });

  it("skips pnpm build when isMonorepoLayout is false (sidecar)", async () => {
    (isMonorepoLayout as Mock).mockReturnValue(false);
    await deployWorkerWithAssets(makeOpts());
    expect(execSync).not.toHaveBeenCalled();
  });

  // ---- skipUi flag -------------------------------------------------------

  it("returns {kind:'skipped', reason:'flag'} when skipUi is true", async () => {
    const result = await deployWorkerWithAssets(makeOpts({ skipUi: true }));
    expect(result.ui).toEqual({ kind: "skipped", reason: "flag" });
  });

  it("does not run UI build when skipUi is true", async () => {
    await deployWorkerWithAssets(makeOpts({ skipUi: true }));
    expect(execSync).not.toHaveBeenCalled();
    expect(assertAssetLimits).not.toHaveBeenCalled();
  });

  it("passes skipAssets:true to generateWranglerConfig when skipUi", async () => {
    await deployWorkerWithAssets(makeOpts({ skipUi: true }));
    expect(generateWranglerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ skipAssets: true }),
    );
  });

  // ---- Wrangler non-zero throws ------------------------------------------

  it("throws when runWrangler rejects (wrangler non-zero exit)", async () => {
    (runWrangler as Mock).mockRejectedValue(
      new WranglerCommandError("deploy failed: [REDACTED] error"),
    );

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      WranglerCommandError,
    );
  });

  it("does not proceed to smoke check after runWrangler throws", async () => {
    (runWrangler as Mock).mockRejectedValue(new WranglerCommandError("error"));

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ---- Smoke check gate --------------------------------------------------

  it("throws when GET / returns 500 after retries", async () => {
    // / → 500 always; /api/health never gets called
    mockFetch.mockResolvedValue({ status: 500 });

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      /Smoke check failed.*\/ returned HTTP 500/,
    );
  });

  it("throws when GET /api/health returns 503 after retries", async () => {
    // / → 200, /api/health → 503
    mockFetch
      .mockResolvedValueOnce({ status: 200 }) // GET /  attempt 1
      .mockResolvedValue({ status: 503 }); // GET /api/health all attempts

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      /Smoke check failed.*\/api\/health returned HTTP 503/,
    );
  });

  it("succeeds when smoke check returns non-500 statuses", async () => {
    // / → 200, /api/health → 200
    mockFetch.mockResolvedValue({ status: 200 });
    const result = await deployWorkerWithAssets(makeOpts());
    expect(result.ui.kind).toBe("deployed");
  });

  it("retries smoke check on 500 and succeeds on second attempt", async () => {
    // / → 500 then 200; /api/health → 200
    mockFetch
      .mockResolvedValueOnce({ status: 500 }) // GET /  attempt 1
      .mockResolvedValueOnce({ status: 200 }) // GET /  attempt 2
      .mockResolvedValueOnce({ status: 200 }); // GET /api/health attempt 1

    const result = await deployWorkerWithAssets(makeOpts());
    expect(result.ui.kind).toBe("deployed");
  });

  it("throws when ALL fetch attempts throw for BOTH / and /api/health (wholly unreachable)", async () => {
    // Every fetch attempt rejects — no HTTP response ever received
    mockFetch.mockRejectedValue(
      new TypeError("fetch failed: connection refused"),
    );

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      /Smoke check failed.*unreachable/,
    );
  }, 15_000);

  it("does not throw when one path all-throws but the other returns 200 (asymmetric-flake tolerance)", async () => {
    // / → all attempts throw; /api/health → 200
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed")) // GET / attempt 1
      .mockRejectedValueOnce(new TypeError("fetch failed")) // GET / attempt 2
      .mockRejectedValueOnce(new TypeError("fetch failed")) // GET / attempt 3
      .mockResolvedValueOnce({ status: 200 }); // GET /api/health attempt 1

    const result = await deployWorkerWithAssets(makeOpts());
    expect(result.ui.kind).toBe("deployed");
  });

  it("propagates assertAssetLimits violation — does not swallow it into {kind:'deployed'}", async () => {
    (assertAssetLimits as Mock).mockImplementation(() => {
      throw new Error("Asset limit exceeded: too many files");
    });

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      /Asset limit exceeded/,
    );
  });

  // ---- UI build failure throws -------------------------------------------

  it("throws when pnpm build fails (monorepo layout)", async () => {
    (isMonorepoLayout as Mock).mockReturnValue(true);
    const buildErr = Object.assign(new Error("build error"), {
      stdout: "Build error output",
      stderr: "",
    });
    (execSync as Mock).mockImplementation(() => {
      throw buildErr;
    });

    await expect(deployWorkerWithAssets(makeOpts())).rejects.toThrow(
      /UI build failed/,
    );
  });

  // ---- describeUiOutcome -------------------------------------------------

  describe("describeUiOutcome", () => {
    it("deployed: returns worker+UI message", () => {
      const result = describeUiOutcome({
        kind: "deployed",
        url: "https://tila.workers.dev",
      });
      expect(result.spinnerMessage).toContain("UI deployed");
      expect(result.uiLine).toContain("https://tila.workers.dev");
    });

    it("skipped: returns worker-only message", () => {
      const result = describeUiOutcome({ kind: "skipped", reason: "flag" });
      expect(result.spinnerMessage).toContain("skipped");
      expect(result.uiLine).toContain("not deployed");
    });
  });
});
