import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { packageBinaries } from "./package-binaries.mjs";

test("all eight assets round-trip, have exact checksums and bundle-derived SBOMs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tila-package-"));
  try {
    const directory = join(root, "dist/binaries");
    await mkdir(directory, { recursive: true });
    await mkdir(join(root, "dist/metadata"), { recursive: true });
    await mkdir(join(root, "lifecycle"));
    await mkdir(join(root, "worker"));
    await writeFile(
      join(root, "worker/bundle-meta.json"),
      JSON.stringify({ inputs: {} }),
    );
    await writeFile(
      join(root, "lifecycle/package.json"),
      JSON.stringify({
        name: "@tila/client-lifecycle",
        version: "0.0.0",
        license: "MIT",
      }),
    );
    const names = [
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "linux-x64-musl",
      "linux-arm64-musl",
      "windows-x64.exe",
      "windows-arm64.exe",
    ].map((x) => `tila-${x}`);
    for (const name of names) {
      await writeFile(join(directory, name), Buffer.alloc(20000, name));
      await writeFile(
        join(root, `dist/metadata/${name}.json`),
        JSON.stringify({ inputs: { "lifecycle/index.ts": { bytes: 100 } } }),
      );
    }
    await packageBinaries(directory, root, "1.2.3", 1234);
    const first = await readFile(join(directory, "checksums.txt"), "utf8");
    for (const line of first.trim().split("\n")) {
      const [hash, name] = line.split("  ");
      const bytes = await readFile(join(directory, name));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
      if (name.endsWith(".gz"))
        assert.deepEqual(
          gunzipSync(bytes),
          await readFile(join(directory, name.slice(0, -3))),
        );
    }
    const sbom = JSON.parse(
      await readFile(join(directory, `${names[0]}.spdx.json`), "utf8"),
    );
    assert.equal(sbom.spdxVersion, "SPDX-2.3");
    assert.ok(
      sbom.packages.some((pkg) => pkg.name === "@tila/client-lifecycle"),
    );
    assert.ok(
      sbom.packages.some(
        (pkg) => pkg.name === "bun" && pkg.versionInfo === "1.2.3",
      ),
    );
    await packageBinaries(directory, root, "1.2.3", 1234);
    assert.equal(
      await readFile(join(directory, "checksums.txt"), "utf8"),
      first,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
