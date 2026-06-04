import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Load .env from package directory (TILA_BASE_URL, TILA_TOKEN)
    // envDir resolves relative to config file location by default
    envDir: ".",
    // Include consumer.ts so it can be targeted by the "consumer" script
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "src/consumer.ts"],
  },
});
