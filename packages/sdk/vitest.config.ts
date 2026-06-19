import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The local-driver tests dynamically import the native better-sqlite3
    // module; cold module-transform + native load on a loaded CI runner exceeds
    // vitest's 5s default (fast locally). A suite-wide timeout keeps them stable.
    testTimeout: 20000,
  },
});
