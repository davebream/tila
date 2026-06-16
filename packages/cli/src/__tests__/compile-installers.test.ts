/**
 * C1 coupling note: The copy destination `dist/binaries/` must stay in sync
 * with the `release.yml` upload glob `files: packages/cli/dist/binaries/*`.
 * If that glob changes, update `compile:installers` in package.json.
 *
 * Note: `compile:installers` is intentionally NOT run by single-platform
 * `compile:<platform>` sub-commands — only by the full `compile` chain and this test.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/__tests__ → src → packages/cli
const packageRoot = join(__dirname, "..", "..");

describe("compile:installers", () => {
  it("copies install.sh and install.ps1 into dist/binaries/ for release asset upload", () => {
    let stderr = "";
    try {
      execSync("pnpm run compile:installers", {
        cwd: packageRoot,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      if (err instanceof Error && "stderr" in err) {
        stderr = String(
          (err as NodeJS.ErrnoException & { stderr: Buffer }).stderr,
        );
      }
      throw new Error(`pnpm run compile:installers failed.\nstderr: ${stderr}`);
    }

    const distBinaries = join(packageRoot, "dist/binaries");

    expect(
      existsSync(join(distBinaries, "install.sh")),
      `Expected install.sh to exist in ${distBinaries}`,
    ).toBe(true);

    expect(
      existsSync(join(distBinaries, "install.ps1")),
      `Expected install.ps1 to exist in ${distBinaries}`,
    ).toBe(true);
  });
});
