import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The local-driver tests dynamically import the native better-sqlite3
    // module; cold module-transform + native load on a loaded CI runner can
    // exceed Vitest's default test and hook timeouts (fast locally). Setup hooks
    // perform the same initialization, so they need the same timeout budget.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
