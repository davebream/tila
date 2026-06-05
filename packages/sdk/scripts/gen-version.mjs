// Regenerates src/version.ts from package.json so the SDK version stays in sync
// without a runtime package.json read. Run from the package root (cwd = packages/sdk).
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "src/version.ts",
  `// Auto-generated from package.json by scripts/gen-version.mjs — do not edit by hand.
// Imported (not read at runtime) so bundlers and \`bun build --compile\` embed it.
export const SDK_VERSION = "${version}";
`,
);
