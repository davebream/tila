import { defineConfig } from "tsup";

// Main entry: the zod-only public SDK surface (TilaClient, resource-method
// factories, and the HTTP RemoteBackend seam). Kept deliberately free of any
// SQLite/node:fs runtime — @tila/core is inlined as TYPES only (dts.resolve),
// never as runtime (noExternal). Task 9 appends a separate `localConfig` to
// this array for the heavy `tila-sdk/local` entry.
const mainConfig = {
  entry: ["src/index.ts"],
  format: ["esm", "cjs"] as const,
  // The package tsconfig uses `composite: true` for turbo/project-references,
  // which conflicts with tsup's single-entry dts program (TS6307). Disable it
  // for the declaration rollup only.
  dts: {
    compilerOptions: { composite: false, incremental: false },
    // Inline @tila/schemas and @tila/core TYPES into the .d.ts. @tila/schemas'
    // JS is also inlined via noExternal; @tila/core supplies interface TYPES
    // ONLY (the remote backends import it type-only), so it is inlined into the
    // declarations here but deliberately NOT added to noExternal — that would
    // drag core's runtime (schema parser, grep engine) into the zod-only entry.
    // Without dts.resolve, rollup-dts would leave bare `import ... from
    // "@tila/core"`/"@tila/schemas"` in the declarations, breaking consumers
    // since neither package is published.
    resolve: ["@tila/schemas", "@tila/core"],
  },
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Inline the internal @tila/schemas package so the SDK ships self-contained
  // and @tila/schemas never needs to be published. zod stays external (a real
  // runtime dependency) to avoid duplicating it in consumer installs.
  noExternal: ["@tila/schemas"],
  external: ["zod"],
};

export default defineConfig([mainConfig]);
