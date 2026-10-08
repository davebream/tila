import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("version generation uses explicit revision and package versions independent of caller cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "tila-versions-"));
  try {
    mkdirSync(join(dir, "scripts"));
    copyFileSync(
      "scripts/generate-version.mjs",
      join(dir, "scripts/generate-version.mjs"),
    );
    for (const [name, symbol] of [
      ["cli", "VERSION"],
      ["sdk", "SDK_VERSION"],
      ["backend-do", "DO_CODE_VERSION"],
    ]) {
      mkdirSync(join(dir, "packages", name, "src"), { recursive: true });
      writeFileSync(
        join(dir, "packages", name, "package.json"),
        JSON.stringify({ version: "1.2.3" }),
      );
      execFileSync(
        process.execPath,
        [join(dir, "scripts/generate-version.mjs"), name],
        {
          cwd: tmpdir(),
          env: { ...process.env, TILA_BUILD_REVISION: "abc1234" },
        },
      );
      assert.match(
        readFileSync(join(dir, "packages", name, "src/version.ts"), "utf8"),
        new RegExp(
          `export const ${symbol} = "${name === "backend-do" ? "abc1234" : "1.2.3"}"`,
        ),
      );
    }
    execFileSync(
      process.execPath,
      [join(dir, "scripts/generate-version.mjs"), "backend-do"],
      { env: { ...process.env, TILA_BUILD_REVISION: "def5678" } },
    );
    assert.match(
      readFileSync(join(dir, "packages/backend-do/src/version.ts"), "utf8"),
      /def5678/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
