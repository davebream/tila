import assert from "node:assert/strict";
import { resolve } from "node:path";
import { run } from "./release-common.mjs";
import { verifyRelease } from "./release-verify.mjs";

export function maySkipExisting(expected, registry) {
  if (!registry) return false;
  assert.equal(
    registry,
    expected,
    "Existing npm version has different integrity; refusing publication",
  );
  return true;
}
if (process.argv[1]?.endsWith("release-publish.mjs")) {
  assert.equal(
    process.env.GITHUB_EVENT_NAME,
    "push",
    "Rehearsals cannot publish",
  );
  const directory = resolve(process.argv[2] || ".release");
  const manifest = verifyRelease(directory, process.env.RELEASE_SHA);
  assert.equal(process.env.GITHUB_REF, `refs/tags/v${manifest.version}`);
  for (const pkg of manifest.packages) {
    // A network/auth error is fatal. Only a registry-confirmed missing version
    // permits publishing; never treat arbitrary lookup failures as absence.
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${manifest.version}`,
    );
    let existing;
    if (response.ok) existing = (await response.json()).dist?.integrity;
    else
      assert.equal(
        response.status,
        404,
        `Registry lookup failed for ${pkg.name}: ${response.status}`,
      );
    if (response.ok)
      assert.ok(existing, "Published version has no integrity metadata");
    if (maySkipExisting(pkg.integrity, existing))
      console.log(`Verified existing ${pkg.name}@${manifest.version}`);
    else
      run(
        "npm",
        [
          "publish",
          resolve(directory, pkg.file),
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
        ],
        { stdio: "inherit" },
      );
  }
}
