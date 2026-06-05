// Regenerates src/version.ts from package.json so the compiled binary reports
// the correct version. Run from the package root (cwd = packages/cli).
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "src/version.ts",
  `// Auto-generated from package.json by scripts/gen-version.mjs — do not edit by hand.
// Imported (not read at runtime) so \`bun build --compile\` embeds it into the binary.
export const VERSION = "${version}";
`,
);
