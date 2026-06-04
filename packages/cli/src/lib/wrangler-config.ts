import * as fs from "node:fs";
import * as path from "node:path";
import { RUN_WORKER_FIRST } from "@tila/schemas";
import { stringify } from "smol-toml";
import {
  isMonorepoLayout,
  resolveUiDistDir,
  resolveWorkerMainPath,
} from "./provisioning";
import { D1_DATABASE_NAME, R2_BUCKET_NAME } from "./resource-names";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The most recent compatibility date for the generated wrangler config.
 * Must be a 2025+ date to ensure run_worker_first semantics work correctly.
 * run_worker_first array support requires wrangler 3.78.0+ (confirmed Task 2).
 */
const COMPATIBILITY_DATE = "2025-05-01";

// ---------------------------------------------------------------------------
// generateWranglerConfig
// ---------------------------------------------------------------------------

export interface GenerateWranglerConfigArgs {
  slug: string;
  /** Intentionally not serialized into the TOML — account scoping happens via the CLOUDFLARE_ACCOUNT_ID env at `wrangler deploy` time. */
  accountId: string;
  databaseId: string;
  d1DatabaseName?: string;
  r2BucketName?: string;
  /**
   * When true, omit the [assets] block from the generated config.
   * Used when --skip-ui is set: deploys the Worker only without static assets.
   */
  skipAssets?: boolean;
}

/**
 * Generate a per-deploy wrangler config file at deploy time.
 *
 * Writes `wrangler.<slug>.toml` into the directory of the resolved worker
 * entry point (`dirname(resolveWorkerMainPath())`). Both `main` and
 * `[assets].directory` are computed relative to the config dir:
 *
 * - monorepo: main = "src/index.ts", assets.directory = "../ui/dist"
 * - sidecar:  main = "index.js",     assets.directory = "../ui/dist"
 *
 * Both layouts yield "../ui/dist" because the worker directory and ui/dist
 * are always siblings (under packages/ or next to process.execPath).
 *
 * Returns the absolute path to the written config file.
 */
export function generateWranglerConfig(
  args: GenerateWranglerConfigArgs,
): string {
  const { slug, databaseId, skipAssets = false } = args;
  const r2BucketName = args.r2BucketName ?? R2_BUCKET_NAME;
  const d1DatabaseName = args.d1DatabaseName ?? D1_DATABASE_NAME;

  const workerMainPath = resolveWorkerMainPath();
  const uiDistDir = resolveUiDistDir();

  // Determine the config directory.
  //
  // The config is placed at the *package root* of the worker, not necessarily
  // the immediate parent of the entry file. For both layouts:
  //
  // - monorepo: resolveWorkerMainPath() = .../packages/worker/src/index.ts
  //             → configDir = .../packages/worker/   (parent of src/)
  //             → main = "src/index.ts"
  //
  // - sidecar:  resolveWorkerMainPath() = .../worker/index.js
  //             → configDir = .../worker/             (dirname)
  //             → main = "index.js"
  //
  // In both cases ui/dist is a sibling of configDir, so assets.directory
  // is always "../ui/dist".
  //
  // The heuristic: if the last path segment of dirname(workerMainPath) is "src",
  // go up one more level — that's the package root for the monorepo layout.
  const workerImmediateDir = path.dirname(workerMainPath);
  const configDir =
    path.basename(workerImmediateDir) === "src"
      ? path.dirname(workerImmediateDir)
      : workerImmediateDir;

  // Compute paths relative to the config directory
  const mainRelative = path.relative(configDir, workerMainPath);
  const assetsDirectoryRelative = path.relative(configDir, uiDistDir);

  // Build the config object (smol-toml will stringify it)
  const config: Record<string, unknown> = {
    name: slug,
    main: mainRelative,
    compatibility_date: COMPATIBILITY_DATE,
    workers_dev: true,

    placement: {
      mode: "smart",
    },

    observability: {
      enabled: true,
    },

    durable_objects: {
      bindings: [
        {
          name: "PROJECT",
          class_name: "ProjectDO",
        },
      ],
    },

    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["ProjectDO"],
      },
    ],

    d1_databases: [
      {
        binding: "DB",
        database_name: d1DatabaseName,
        database_id: databaseId,
      },
    ],

    r2_buckets: [
      {
        binding: "ARTIFACTS",
        bucket_name: r2BucketName,
      },
    ],

    analytics_engine_datasets: [
      {
        binding: "ANALYTICS",
        dataset: "tila-analytics",
      },
    ],

    triggers: {
      crons: ["0 3 * * *"],
    },

    // NOTE: No [vars] entries. CORS_ALLOWED_ORIGINS is intentionally omitted
    // so wrangler (default keep_vars=false) deletes it on deploy — the intended cleanup.
    // All GITHUB_* and UI_ORIGIN are secrets, which wrangler never deletes.
  };

  if (!skipAssets) {
    config.assets = {
      directory: assetsDirectoryRelative,
      not_found_handling: "single-page-application",
      // Single source of truth from @tila/schemas — do not duplicate the list here
      run_worker_first: [...RUN_WORKER_FIRST],
    };
  }

  const tomlContent = stringify(config);

  const configPath = path.join(configDir, `wrangler.${slug}.toml`);
  fs.writeFileSync(configPath, tomlContent, "utf-8");

  return configPath;
}

// ---------------------------------------------------------------------------
// assertAssetLimits
// ---------------------------------------------------------------------------

const MAX_FILES = 20_000;
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB

/**
 * Walk `distDir` recursively and assert Cloudflare Static Assets limits:
 * - Max 20,000 files
 * - Max 25 MiB per file
 *
 * Throws a descriptive error before wrangler errors mid-upload.
 */
export function assertAssetLimits(distDir: string): void {
  let fileCount = 0;

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        fileCount++;

        if (fileCount > MAX_FILES) {
          throw new Error(
            `Asset limit exceeded: directory contains more than 20,000 files (Cloudflare Static Assets limit). Found ${fileCount}+ files in ${distDir}. Consider splitting assets or reducing build output.`,
          );
        }

        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          const sizeMiB = (stat.size / (1024 * 1024)).toFixed(1);
          throw new Error(
            `Asset limit exceeded: file ${entry.name} is ${sizeMiB} MiB, which exceeds the 25 MiB per-file limit (Cloudflare Static Assets limit). Path: ${fullPath}`,
          );
        }
      }
    }
  }

  walk(distDir);
}
