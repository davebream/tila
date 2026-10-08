import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Route modules pull in a large import graph; on loaded CI runners the
    // first test of a file can otherwise exceed the 5s default while the
    // graph loads. Matches the timeout used by the other packages.
    testTimeout: 15000,
  },
});
