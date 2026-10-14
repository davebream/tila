import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Private workspace packages and the YAML adapter ship inside the bundle.
  // They must never become unresolved published runtime dependencies.
  // The shebang comes from src/index.ts (esbuild preserves it).
  // yaml's Node entry is CommonJS and requires built-ins such as process.
  // Give bundled CommonJS modules a Node require inside the ESM executable.
  banner: {
    js: 'import { createRequire as createBundledRequire } from "node:module"; const require = createBundledRequire(import.meta.url);',
  },
  noExternal: ["@tila/schemas", "@tila/client-lifecycle", "@tila/core", "yaml"],
  // SDK HTTP transport stays external; MCP does not load SDK local storage.
  external: [
    "@modelcontextprotocol/sdk",
    "smol-toml",
    "proper-lockfile",
    // Keep the lifecycle daemon transport's CommonJS implementation external
    // for Node ESM consumers; the alias also avoids Bun's built-in ws shim.
    "ws-node",
    "zod",
    "tila-sdk",
  ],
});
