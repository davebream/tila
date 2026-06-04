import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Executable MCP server: bundle all internal @tila/* packages so it ships
  // fully self-contained. Only third-party runtime deps stay external.
  // The shebang comes from src/index.ts (esbuild preserves it) — no banner.
  noExternal: ["@tila/schemas", "@tila/sdk"],
  external: ["@modelcontextprotocol/sdk", "smol-toml", "zod"],
});
