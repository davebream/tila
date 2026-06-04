import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // The package tsconfig uses `composite: true` for turbo/project-references,
  // which conflicts with tsup's single-entry dts program (TS6307). Disable it
  // for the declaration rollup only.
  dts: {
    compilerOptions: { composite: false, incremental: false },
    // Inline @tila/schemas TYPES into the .d.ts (JS is handled by noExternal);
    // without this, rollup-dts leaves `import ... from "@tila/schemas"` in the
    // declarations, which would break consumers since schemas isn't published.
    resolve: ["@tila/schemas"],
  },
  clean: true,
  treeshake: true,
  sourcemap: false,
  // Inline the internal @tila/schemas package so the SDK ships self-contained
  // and @tila/schemas never needs to be published. zod stays external (a real
  // runtime dependency) to avoid duplicating it in consumer installs.
  noExternal: ["@tila/schemas"],
  external: ["zod"],
});
