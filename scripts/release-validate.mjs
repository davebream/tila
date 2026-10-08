import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { run } from "./release-common.mjs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const sha = run("git", ["rev-parse", "HEAD"]);
assert.equal(
  run("git", ["status", "--porcelain"]),
  "",
  "Release validation requires a clean checkout",
);
const tag = process.env.RELEASE_TAG;
if (process.env.GITHUB_EVENT_NAME === "push")
  assert.ok(tag, "A publish attempt must name a tag");
if (tag) {
  assert.equal(
    tag,
    `v${version}`,
    "Release tag must match the product version",
  );
  assert.equal(
    run("git", ["rev-parse", `refs/tags/${tag}^{commit}`]),
    sha,
    "Checkout must be the tagged commit",
  );
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
}
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nsha=${sha}\ntag=v${version}\n`,
  );
console.log(`Validated ${tag || "rehearsal"} at ${sha} (version ${version})`);
