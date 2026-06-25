import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Standalone configs do not inherit the root's passWithNoTests; the scaffold
    // ships an empty barrel until Phase 2 adds src-co-located tests, so keep
    // `turbo test` / CI green in the interim.
    passWithNoTests: true,
  },
});
