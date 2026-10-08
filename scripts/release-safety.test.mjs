import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  binaryName,
  digest,
  integrity,
  packageDirectories,
  targets,
  validatePackage,
} from "./release-common.mjs";
import { maySkipExisting } from "./release-publish.mjs";
import { verifyRelease } from "./release-verify.mjs";

test("release verification rejects altered artifacts, missing targets and integrity mismatches", () => {
  const directory = mkdtempSync(join(tmpdir(), "tila-release-check-"));
  const files = {};
  const put = (name) => {
    const bytes = Buffer.from(name);
    writeFileSync(join(directory, name), bytes);
    files[name] = digest(bytes);
    return bytes;
  };
  try {
    mkdirSync(join(directory, "binaries"));
    mkdirSync(join(directory, "npm"));
    for (const target of targets)
      for (const suffix of ["", ".gz", ".spdx.json"])
        put(`binaries/${binaryName(target)}${suffix}`);
    const packages = packageDirectories.map((pkg) => {
      const name = pkg === "sdk" ? "tila-sdk" : `tila-${pkg}`;
      const file = `npm/${name}-1.2.3.tgz`;
      return { name, file, integrity: integrity(put(file)) };
    });
    const manifest = {
      targets,
      packages,
      files,
      version: "1.2.3",
      revision: "abc123",
    };
    const save = () => {
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
      const checksums = {
        ...files,
        "manifest.json": digest(readFileSync(join(directory, "manifest.json"))),
      };
      writeFileSync(
        join(directory, "checksums.txt"),
        Object.entries(checksums)
          .map(([name, hash]) => `${hash}  ${name}`)
          .join("\n"),
      );
    };
    save();
    verifyRelease(directory, "abc123");
    assert.throws(
      () => verifyRelease(directory, "other-commit"),
      /revision mismatch/,
    );
    const file = packages[0].file;
    writeFileSync(join(directory, file), "altered");
    assert.throws(() => verifyRelease(directory), /Altered artifact/);
    put(file);
    packages[0].integrity = "sha512-invalid";
    save();
    assert.throws(() => verifyRelease(directory), /integrity mismatch/);
    packages[0].integrity = integrity(readFileSync(join(directory, file)));
    delete files[`binaries/${binaryName(targets[0])}`];
    save();
    assert.throws(() => verifyRelease(directory), /Missing target artifact/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publication rejects broken manifests and mismatched existing npm versions", () => {
  validatePackage(
    { name: "tila-sdk", version: "1.2.3", dependencies: { zod: "^3.24.0" } },
    "1.2.3",
  );
  for (const dependencies of [
    { "@tila/core": "0.1.0" },
    { "tila-sdk": "workspace:*" },
    { zod: "file:../zod" },
  ])
    assert.throws(() =>
      validatePackage(
        { name: "fixture", version: "1.2.3", dependencies },
        "1.2.3",
      ),
    );
  assert.equal(maySkipExisting("sha512-tested", undefined), false);
  assert.equal(maySkipExisting("sha512-tested", "sha512-tested"), true);
  assert.throws(
    () => maySkipExisting("sha512-tested", "sha512-different"),
    /different integrity/,
  );
  const rehearsal = spawnSync(
    process.execPath,
    ["scripts/release-publish.mjs"],
    {
      env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch" },
      encoding: "utf8",
    },
  );
  assert.notEqual(rehearsal.status, 0);
  assert.match(rehearsal.stderr, /Rehearsals cannot publish/);
});

test("tag validation requires matching version and a commit reachable from main", () => {
  const directory = mkdtempSync(join(tmpdir(), "tila-tag-check-"));
  const script = resolve("scripts/release-validate.mjs");
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd: directory, stdio: "ignore" },
    );
  const validate = (tag) =>
    spawnSync(process.execPath, [script], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_OUTPUT: "",
        GITHUB_EVENT_NAME: "push",
        RELEASE_TAG: tag,
      },
      encoding: "utf8",
    });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(directory, "package.json"), '{"version":"1.2.3"}');
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("tag", "v1.2.3");
    assert.equal(validate("v1.2.3").status, 0);
    assert.notEqual(validate("v9.9.9").status, 0);
    git("checkout", "--orphan", "unreachable");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "unreachable",
    );
    git("tag", "-f", "v1.2.3");
    assert.notEqual(validate("v1.2.3").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
