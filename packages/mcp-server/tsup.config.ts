import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Bundle the internal @tila/schemas package so the server ships self-contained
  // and @tila/schemas never needs to be published.
  // The shebang comes from src/index.ts (esbuild preserves it) — no banner.
  noExternal: ["@tila/schemas", "@tila/client-lifecycle"],
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
