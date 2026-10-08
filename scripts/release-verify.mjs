import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  binaryName,
  digest,
  integrity,
  packageDirectories,
  readManifest,
  targets,
} from "./release-common.mjs";

export function verifyRelease(directory, revision) {
  const manifest = readManifest(directory);
  if (revision)
    assert.equal(manifest.revision, revision, "Artifact revision mismatch");
  assert.deepEqual(
    manifest.targets,
    targets,
    "Release must contain all eight targets",
  );
  assert.equal(
    manifest.packages.length,
    11,
    "Release must contain eleven packages",
  );
  assert.deepEqual(
    manifest.packages.map((pkg) => pkg.name).sort(),
    packageDirectories
      .map((name) => (name === "sdk" ? "tila-sdk" : `tila-${name}`))
      .sort(),
  );
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.ok(
      /^(npm|binaries)\/[a-zA-Z0-9._-]+$/.test(file),
      "Unsafe artifact path",
    );
    assert.equal(
      digest(readFileSync(resolve(directory, file))),
      hash,
      `Altered artifact: ${file}`,
    );
  }
  for (const target of targets)
    for (const suffix of ["", ".gz", ".spdx.json"])
      assert.ok(
        manifest.files[`binaries/${binaryName(target)}${suffix}`],
        `Missing target artifact: ${target}${suffix}`,
      );
  for (const pkg of manifest.packages) {
    assert.ok(manifest.files[pkg.file], `Missing tarball ${pkg.name}`);
    assert.equal(
      integrity(readFileSync(resolve(directory, pkg.file))),
      pkg.integrity,
      `Tarball integrity mismatch: ${pkg.name}`,
    );
  }
  const checksumLines = readFileSync(
    resolve(directory, "checksums.txt"),
    "utf8",
  )
    .trim()
    .split("\n");
  const expected = {
    ...manifest.files,
    "manifest.json": digest(readFileSync(resolve(directory, "manifest.json"))),
  };
  assert.deepEqual(
    Object.fromEntries(
      checksumLines.map((line) => {
        const [hash, file] = line.split("  ");
        return [file, hash];
      }),
    ),
    expected,
  );
  return manifest;
}
if (process.argv[1]?.endsWith("release-verify.mjs")) {
  const manifest = verifyRelease(
    resolve(process.argv[2] || ".release"),
    process.env.RELEASE_SHA,
  );
  console.log(
    `Verified ${Object.keys(manifest.files).length} artifacts for ${manifest.revision}`,
  );
}
