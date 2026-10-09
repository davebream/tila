import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { parse } from "smol-toml";
import { defineConfig } from "vitest/config";

const root = resolve(import.meta.dirname, "../..");
const production = parse(
  readFileSync(resolve(root, "packages/worker/wrangler.toml"), "utf8"),
);
const paths = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"))
  .compilerOptions.paths;

export default defineConfig({
  resolve: {
    alias: Object.entries(paths).map(([name, targets]) => ({
      find: new RegExp(`^${name}$`),
      replacement: resolve(root, (targets as [string])[0]),
    })),
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./runtime/worker.ts",
      miniflare: {
        compatibilityDate: production.compatibility_date as string,
        compatibilityFlags: (production.compatibility_flags ?? []) as string[],
        durableObjects: {
          PROJECT: { className: "ProjectDO", useSQLite: true },
          MIGRATION: { className: "MigrationFixture", useSQLite: true },
        },
        d1Databases: ["DB"],
        r2Buckets: ["ARTIFACTS"],
        bindings: {
          HASH_PEPPER: "runtime-test-conversation-pepper",
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(root, "packages/worker/migrations/global"),
          ),
          GITHUB_SESSION_HMAC_KEY:
            "dGVzdC1vbmx5LW5vLXByb2R1Y3Rpb24tc2VjcmV0LTA",
        },
      },
    })),
  ],
  test: {
    include: ["runtime/**/*.test.ts"],
    setupFiles: ["./runtime/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ["default", "json"],
    outputFile: { json: resolve(root, ".ci-reports/runtime.json") },
    allowOnly: false,
    passWithNoTests: false,
  },
});
