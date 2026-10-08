import assert from "node:assert/strict";
import { resolve } from "node:path";
import { binaryName, run, targets } from "./release-common.mjs";
import { verifyRelease } from "./release-verify.mjs";

const directory = resolve(process.argv[2] || ".release");
const manifest = verifyRelease(directory, process.env.RELEASE_SHA);
const repository = process.env.GITHUB_REPOSITORY;
assert.ok(repository, "GITHUB_REPOSITORY is required");
const policy = [
  "--repo",
  repository,
  "--signer-workflow",
  `${repository}/.github/workflows/release.yml`,
  "--source-digest",
  manifest.revision,
  "--deny-self-hosted-runners",
];
for (const file of [
  ...Object.keys(manifest.files),
  "manifest.json",
  "checksums.txt",
])
  run("gh", ["attestation", "verify", resolve(directory, file), ...policy]);
for (const target of targets)
  for (const suffix of ["", ".gz"])
    run("gh", [
      "attestation",
      "verify",
      resolve(directory, "binaries", `${binaryName(target)}${suffix}`),
      ...policy,
      "--predicate-type",
      "https://spdx.dev/Document/v2.3",
    ]);
console.log(
  `Verified provenance and SBOM attestations for ${manifest.revision}`,
);
