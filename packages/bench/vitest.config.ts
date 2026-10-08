import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The smoke suite drives every scenario through the in-process Worker
    // routes and DO router; CI runners are slower than dev machines.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
