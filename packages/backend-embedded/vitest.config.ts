import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest runs under Node. The `*.bun.test.ts` files require `bun:sqlite`
    // and run under `bun test` (see the `test:bun` script) — exclude them here.
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.bun.test.ts", "node_modules/**"],
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
