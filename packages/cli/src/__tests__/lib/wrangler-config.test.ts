import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RUN_WORKER_FIRST } from "@tila/schemas";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// We need to mock isMonorepoLayout and resolveWorkerMainPath / resolveUiDistDir
// so tests control which layout scenario is exercised.
// ---------------------------------------------------------------------------
vi.mock("../../lib/provisioning", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/provisioning")>();
  return {
    ...original,
    isMonorepoLayout: vi.fn(),
    resolveWorkerMainPath: vi.fn(),
    resolveUiDistDir: vi.fn(),
  };
});

import {
  isMonorepoLayout,
  resolveUiDistDir,
  resolveWorkerMainPath,
} from "../../lib/provisioning";
import {
  assertAssetLimits,
  generateWranglerConfig,
} from "../../lib/wrangler-config";

const mockIsMonorepoLayout = vi.mocked(isMonorepoLayout);
const mockResolveWorkerMainPath = vi.mocked(resolveWorkerMainPath);
const mockResolveUiDistDir = vi.mocked(resolveUiDistDir);

// ---------------------------------------------------------------------------
// Helper: build temp dirs simulating monorepo or sidecar layout
// ---------------------------------------------------------------------------

function makeTempLayout(variant: "monorepo" | "sidecar"): {
  workerDir: string;
  workerMain: string;
  uiDist: string;
  cleanup: () => void;
} {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tila-test-"));
  let workerDir: string;
  let workerMain: string;
  let uiDist: string;

  if (variant === "monorepo") {
    // <tmp>/packages/worker/src/index.ts + <tmp>/packages/ui/dist
    workerDir = path.join(tmpBase, "packages", "worker");
    workerMain = path.join(workerDir, "src", "index.ts");
    uiDist = path.join(tmpBase, "packages", "ui", "dist");
  } else {
    // <tmp>/worker/index.js + <tmp>/ui/dist
    workerDir = path.join(tmpBase, "worker");
    workerMain = path.join(workerDir, "index.js");
    uiDist = path.join(tmpBase, "ui", "dist");
  }

  fs.mkdirSync(path.dirname(workerMain), { recursive: true });
  fs.writeFileSync(workerMain, "// entry");
  fs.mkdirSync(uiDist, { recursive: true });

  return {
    workerDir,
    workerMain,
    uiDist,
    cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// generateWranglerConfig — shared input args
// ---------------------------------------------------------------------------
const BASE_ARGS = {
  slug: "my-project",
  accountId: "account-123",
  databaseId: "db-456",
  d1DatabaseName: "tila-global",
  r2BucketName: "tila-artifacts",
};

// ---------------------------------------------------------------------------
// Task 4: generateWranglerConfig
// ---------------------------------------------------------------------------
describe("generateWranglerConfig", () => {
  describe("monorepo layout", () => {
    let layout: ReturnType<typeof makeTempLayout>;
    let configPath: string;
    let parsed: Record<string, unknown>;

    beforeEach(async () => {
      layout = makeTempLayout("monorepo");
      mockIsMonorepoLayout.mockReturnValue(true);
      mockResolveWorkerMainPath.mockReturnValue(layout.workerMain);
      mockResolveUiDistDir.mockReturnValue(layout.uiDist);

      configPath = generateWranglerConfig(BASE_ARGS);
      parsed = parse(fs.readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
    });

    afterEach(() => {
      layout.cleanup();
      vi.clearAllMocks();
    });

    it("writes config file into dirname(resolveWorkerMainPath())", () => {
      expect(path.dirname(configPath)).toBe(layout.workerDir);
      expect(path.basename(configPath)).toBe(`wrangler.${BASE_ARGS.slug}.toml`);
    });

    it("sets name = slug", () => {
      expect(parsed.name).toBe(BASE_ARGS.slug);
    });

    it("sets main relative to config dir (src/index.ts for monorepo)", () => {
      expect(parsed.main).toBe("src/index.ts");
    });

    it("has a recent compatibility_date (2025+)", () => {
      const date = parsed.compatibility_date as string;
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number(date.slice(0, 4))).toBeGreaterThanOrEqual(2025);
    });

    it("sets workers_dev = true", () => {
      expect(parsed.workers_dev).toBe(true);
    });

    it("sets [placement] mode = smart", () => {
      const placement = parsed.placement as { mode: string };
      expect(placement.mode).toBe("smart");
    });

    it("sets [observability] enabled = true", () => {
      const obs = parsed.observability as { enabled: boolean };
      expect(obs.enabled).toBe(true);
    });

    it("has durable_objects binding PROJECT→ProjectDO", () => {
      const doBindings = parsed.durable_objects as {
        bindings: Array<{ name: string; class_name: string }>;
      };
      const projectBinding = doBindings.bindings.find(
        (b) => b.name === "PROJECT",
      );
      expect(projectBinding).toBeDefined();
      expect(projectBinding?.class_name).toBe("ProjectDO");
    });

    it("has [[migrations]] tag='v1' new_sqlite_classes=['ProjectDO']", () => {
      const migrations = parsed.migrations as Array<{
        tag: string;
        new_sqlite_classes: string[];
      }>;
      expect(migrations).toHaveLength(1);
      expect(migrations[0].tag).toBe("v1");
      expect(migrations[0].new_sqlite_classes).toEqual(["ProjectDO"]);
    });

    it("has d1_databases binding DB with the real database_id", () => {
      const d1 = parsed.d1_databases as Array<{
        binding: string;
        database_id: string;
        database_name: string;
      }>;
      const dbBinding = d1.find((b) => b.binding === "DB");
      expect(dbBinding).toBeDefined();
      expect(dbBinding?.database_id).toBe(BASE_ARGS.databaseId);
    });

    it("has r2_buckets binding ARTIFACTS", () => {
      const r2 = parsed.r2_buckets as Array<{
        binding: string;
        bucket_name: string;
      }>;
      const artifactsBinding = r2.find((b) => b.binding === "ARTIFACTS");
      expect(artifactsBinding).toBeDefined();
      expect(artifactsBinding?.bucket_name).toBe(BASE_ARGS.r2BucketName);
    });

    it("has analytics_engine_datasets binding ANALYTICS", () => {
      const analytics = parsed.analytics_engine_datasets as Array<{
        binding: string;
      }>;
      const analyticsBinding = analytics.find((b) => b.binding === "ANALYTICS");
      expect(analyticsBinding).toBeDefined();
    });

    it("has [triggers] crons=['0 3 * * *']", () => {
      const triggers = parsed.triggers as { crons: string[] };
      expect(triggers.crons).toContain("0 3 * * *");
    });

    it("has [assets] directory = '../ui/dist' (relative to config dir)", () => {
      const assets = parsed.assets as { directory: string };
      expect(assets.directory).toBe("../ui/dist");
    });

    it("has [assets] not_found_handling = 'single-page-application'", () => {
      const assets = parsed.assets as { not_found_handling: string };
      expect(assets.not_found_handling).toBe("single-page-application");
    });

    it("has [assets] run_worker_first equal to RUN_WORKER_FIRST from @tila/schemas", () => {
      const assets = parsed.assets as { run_worker_first: string[] };
      expect(assets.run_worker_first).toEqual([...RUN_WORKER_FIRST]);
    });

    it("has no [vars] entries (CORS_ALLOWED_ORIGINS intentionally dropped)", () => {
      // vars should be absent or empty
      const vars = parsed.vars as Record<string, unknown> | undefined;
      if (vars !== undefined) {
        expect(Object.keys(vars)).toHaveLength(0);
      }
    });
  });

  describe("sidecar (binary) layout", () => {
    let layout: ReturnType<typeof makeTempLayout>;
    let parsed: Record<string, unknown>;

    beforeEach(async () => {
      layout = makeTempLayout("sidecar");
      mockIsMonorepoLayout.mockReturnValue(false);
      mockResolveWorkerMainPath.mockReturnValue(layout.workerMain);
      mockResolveUiDistDir.mockReturnValue(layout.uiDist);

      const configPath = generateWranglerConfig(BASE_ARGS);
      parsed = parse(fs.readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
    });

    afterEach(() => {
      layout.cleanup();
      vi.clearAllMocks();
    });

    it("sets main = 'index.js' for sidecar pre-built bundle", () => {
      expect(parsed.main).toBe("index.js");
    });

    it("has [assets] directory = '../ui/dist' (both layouts yield same relative path)", () => {
      const assets = parsed.assets as { directory: string };
      expect(assets.directory).toBe("../ui/dist");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 5: assertAssetLimits
// ---------------------------------------------------------------------------
describe("assertAssetLimits", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tila-assets-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes for a normal SPA (a few small files)", () => {
    fs.writeFileSync(path.join(tmpDir, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(tmpDir, "main.js"), "console.log('hi')");
    expect(() => assertAssetLimits(tmpDir)).not.toThrow();
  });

  it("throws when a file exceeds 25 MiB", () => {
    const bigFile = path.join(tmpDir, "huge.bin");
    // Write 26 MiB (26 * 1024 * 1024 bytes)
    const buf = Buffer.alloc(26 * 1024 * 1024, 0);
    fs.writeFileSync(bigFile, buf);
    expect(() => assertAssetLimits(tmpDir)).toThrow(/25 MiB/);
  });

  it("throws when file count exceeds 20,000", () => {
    // Write 20,001 files — use a subdirectory to keep FS clean
    const subDir = path.join(tmpDir, "files");
    fs.mkdirSync(subDir);
    for (let i = 0; i < 20_001; i++) {
      fs.writeFileSync(path.join(subDir, `f${i}.txt`), "x");
    }
    expect(() => assertAssetLimits(tmpDir)).toThrow(/20,000/);
  });

  it("error message includes the file path for oversized file", () => {
    const bigFile = path.join(tmpDir, "big.bin");
    fs.writeFileSync(bigFile, Buffer.alloc(26 * 1024 * 1024));
    expect(() => assertAssetLimits(tmpDir)).toThrow(/big\.bin/);
  });
});
