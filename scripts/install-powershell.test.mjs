import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const pwsh = process.env.TILA_TEST_PWSH ?? "pwsh";
const available =
  spawnSync(pwsh, ["-NoProfile", "-Command", "exit 0"]).status === 0;
for (const scenario of [
  "compressed",
  "legacy",
  "checksum",
  "corrupt",
  "server-error",
  "missing-assets",
  "missing-checksum",
]) {
  test(`PowerShell installer: ${scenario}`, { skip: !available }, async () => {
    const root = await mkdtemp(join(tmpdir(), "tila-ps-install-"));
    try {
      const assets = join(root, "assets");
      await mkdir(assets);
      const name = `tila-windows-${process.arch === "arm64" ? "arm64" : "x64"}.exe`;
      const bytes = Buffer.from("fixture binary bytes");
      const archive =
        scenario === "corrupt" ? Buffer.from("invalid gzip") : gzipSync(bytes);
      if (scenario !== "missing-assets")
        await writeFile(join(assets, name), bytes);
      if (!["legacy", "missing-assets"].includes(scenario))
        await writeFile(join(assets, `${name}.gz`), archive);
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      await writeFile(
        join(assets, "checksums.txt"),
        `${hash(bytes)}  ${name}\n${scenario === "missing-checksum" ? "" : `${scenario === "checksum" ? "0".repeat(64) : hash(archive)}  ${name}.gz\n`}`,
      );
      const source = await readFile(resolve("scripts/install.ps1"), "utf8");
      // Isolate the user-profile side effect. The download, hash, decompression and move code is unmodified.
      const isolated = source.replace(
        '[Environment]::GetEnvironmentVariable("PATH", "User")',
        '"C:\\.tila\\bin"',
      );
      const prelude = `
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing)
  $asset = ($Uri -split '/')[-1]
  $path = Join-Path $env:TILA_TEST_ASSETS $asset
  if (($asset.EndsWith('.gz') -and $env:TILA_TEST_SCENARIO -eq 'server-error') -or -not (Test-Path $path)) {
    $status = if ($env:TILA_TEST_SCENARIO -eq 'server-error') { 503 } else { 404 }
    $error = [System.Exception]::new("HTTP $status")
    $error | Add-Member -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{StatusCode=$status})
    throw $error
  }
  Copy-Item $path $OutFile
}
`;
      const script = join(root, "fixture.ps1");
      await writeFile(script, prelude + isolated);
      const result = spawnSync(pwsh, ["-NoProfile", "-File", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          USERPROFILE: root,
          TEMP: root,
          TILA_VERSION: "v0.0.0-test",
          TILA_TEST_ASSETS: assets,
          TILA_TEST_SCENARIO: scenario,
        },
      });
      if (["compressed", "legacy"].includes(scenario)) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          await readFile(join(root, ".tila/bin/tila.exe")),
          bytes,
        );
      } else {
        assert.notEqual(result.status, 0, result.stdout);
        await assert.rejects(readFile(join(root, ".tila/bin/tila.exe")), {
          code: "ENOENT",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
