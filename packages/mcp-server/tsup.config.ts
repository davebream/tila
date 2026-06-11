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
  noExternal: ["@tila/schemas"],
  // `tila-sdk` is kept EXTERNAL (resolved from node_modules at runtime). Its
  // `createTila` local branch does `await import("./local.js")`, a specifier
  // RELATIVE to the SDK's own dist — bundling the SDK into this dist would make
  // that relative import dangle (no local.js next to mcp-server/dist/index.js).
  // Keeping it external means the bundled `import { createTila } from "tila-sdk"`
  // resolves the SDK package, and the SDK's `./local.js` resolves relative to
  // `tila-sdk/dist/`, loading the embedded SQLite stack correctly under node.
  //
  // `better-sqlite3` + `drizzle-orm/better-sqlite3` are the native driver and
  // its Drizzle adapter (C6). They live behind `tila-sdk/local`'s dynamic
  // imports and MUST stay external so a remote-mode startup never loads the
  // native binary.
  external: [
    "@modelcontextprotocol/sdk",
    "smol-toml",
    "zod",
    "tila-sdk",
    "better-sqlite3",
    "drizzle-orm/better-sqlite3",
  ],
});
