import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    // jsdom renders of large journals (hundreds of rows) plus React Query state
    // transitions exceed vitest's 5s default on cold, loaded CI runners (the
    // same render is <2s locally). Raise the suite-wide timeout to keep these
    // heavy component tests deterministic instead of patching them one by one.
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
