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
  // `createTila`'s local branch does `await import("./local/index")` to load the
  // heavy SQLite stack lazily. esbuild code-splits that for ESM but INLINES it
  // for CJS — which would drag the native stack into the zod-only main CJS
  // entry. This plugin marks the relative local specifier external and rewrites
  // it to the sibling BUILT ESM entry (`./local.js`), so BOTH the ESM and CJS
  // main bundles emit a literal runtime `import("./local.js")` to the separate
  // file — keeping the main entry zod-only (enforced by bundle-hygiene.test.ts).
  //
  // Always targeting `./local.js` (ESM) is correct for both formats: a dynamic
  // `import()` of an ESM module works from a CJS module too (Node async ESM
  // interop), so CJS consumers load the local stack fine (verified end-to-end).
  esbuildPlugins: [
    {
      name: "externalize-local-entry",
      setup(build: {
        onResolve: (
          opts: { filter: RegExp },
          cb: () => { path: string; external: boolean },
        ) => void;
      }) {
        build.onResolve({ filter: /\.\/local\/index$/ }, () => ({
          path: "./local.js",
          external: true,
        }));
      },
    },
  ],
};

// Local entry: the heavy `tila-sdk/local` surface (createTilaLocal + the
// embedded better-sqlite3/node:fs backend bundle). The whole @tila/* SQLite
// stack is bundled here (noExternal) so consumers install ONLY zod +
// better-sqlite3, never the unpublished @tila/* packages. The native driver and
// its drizzle adapter stay EXTERNAL (C6): they are dynamically imported at
// runtime, kept out of dist/local.js, and surfaced as the optional peer dep.
//
// This is a SEPARATE config object (not a second entry on mainConfig) because
// noExternal/external/dts.resolve are global per config — folding /local into
// mainConfig would bleed the heavy stack into the zod-only main entry.
const localConfig = {
  entry: { local: "src/local/index.ts" },
  format: ["esm", "cjs"] as const,
  dts: {
    compilerOptions: { composite: false, incremental: false },
    // Inline ALL imported declarations so the rolled-up local.d.ts is fully
    // self-contained — none of the @tila/* workspace packages is published, and
    // the embedded backends' barrel d.ts re-export from sibling files that a
    // package-name allow-list leaves DANGLING. `resolve: true` chases every
    // import (including @tila/backend-embedded's `./embedded-project` siblings)
    // so consumers never hit an unresolved relative path.
    //
    // The cost is that drizzle-orm's internal declarations get inlined too, and
    // drizzle's intricate generics don't fully survive rollup-dts (a known
    // limitation). That is benign in practice: consumers compile with
    // `skipLibCheck: true` (the ecosystem default, including this monorepo), so
    // library .d.ts internals are not re-checked. zod stays a real runtime dep
    // consumers already install.
    resolve: true,
  },
  // Do not `clean` here — that runs per-config and would wipe the main entry's
  // freshly-built dist. mainConfig owns `clean: true`.
  treeshake: true,
  sourcemap: false,
  noExternal: [
    "@tila/schemas",
    "@tila/core",
    "@tila/backend-embedded",
    "@tila/ops-sqlite",
  ],
  // zod is a real runtime dep; better-sqlite3 + its drizzle adapter are the
  // dynamically-imported native stack and MUST stay external (never inlined).
  external: ["zod", "better-sqlite3", "drizzle-orm/better-sqlite3"],
};

export default defineConfig([mainConfig, localConfig]);
