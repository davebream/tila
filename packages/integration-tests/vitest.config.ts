import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Cross-runtime tests spawn `bun`/`node` child processes and drive a built
    // MCP server over stdio JSON-RPC; CI runners are slower than dev machines,
    // so the 5s vitest default is too tight. hookTimeout covers any on-demand
    // build fallback in a beforeAll.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Load .env from package directory (TILA_BASE_URL, TILA_TOKEN)
    // envDir resolves relative to config file location by default
    envDir: ".",
    // Include consumer.ts so it can be targeted by the "consumer" script
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "src/consumer.ts"],
  },
});
