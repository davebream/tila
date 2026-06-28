import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No Workers pool -- pure Node.js unit tests for CLI
    //
    // Raised from the 5s default: the first test in cold-start-sensitive suites
    // (e.g. the `tila infra provision` block, where the first invokeProvision()
    // pays one-time module-load cost) intermittently exceeds 5s on slow/cold CI
    // runners, producing flaky "Test timed out in 5000ms" failures. The work
    // itself is fast on a warm process; this only widens the ceiling.
    testTimeout: 20000,
    hookTimeout: 20000,
    server: {
      deps: {
        external: ["esbuild"],
      },
    },
  },
});
