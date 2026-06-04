import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No Workers pool -- pure Node.js unit tests for CLI
    server: {
      deps: {
        external: ["esbuild"],
      },
    },
  },
});
