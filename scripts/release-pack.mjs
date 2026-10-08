import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { packageBinaries } from "./package-binaries.mjs";
import {
  binaryName,
  digest,
  integrity,
  packageDirectories,
  run,
  targets,
  validatePackage,
} from "./release-common.mjs";

const output = resolve(process.argv[2] || ".release");
assert.ok(
  !existsSync(output),
  "Release directory must be fresh; choose a new output path",
);
mkdirSync(join(output, "npm"), { recursive: true });
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const revision = run("git", ["rev-parse", "HEAD"]);
const epoch = Number(run("git", ["show", "-s", "--format=%ct", "HEAD"]));
const bun = run("bun", ["--version"]);
const binaries = resolve("packages/cli/dist/binaries");
for (const target of targets) {
  const destination = resolve(`packages/cli-${target}/bin`);
  mkdirSync(destination, { recursive: true });
  const file = join(
    destination,
    target.startsWith("windows") ? "tila.exe" : "tila",
  );
  copyFileSync(join(binaries, binaryName(target)), file);
  chmodSync(file, 0o755);
}
await packageBinaries(binaries, resolve("packages/cli"), bun, epoch);
cpSync(binaries, join(output, "binaries"), { recursive: true });
const packages = [];
for (const directory of packageDirectories) {
  const pkg = JSON.parse(
    readFileSync(`packages/${directory}/package.json`, "utf8"),
  );
  run("pnpm", [
    "--dir",
    `packages/${directory}`,
    "pack",
    "--pack-destination",
    join(output, "npm"),
  ]);
  const filename = `${pkg.name}-${version}.tgz`;
  const tarball = join(output, "npm", filename);
  const manifest = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"]),
  );
  validatePackage(manifest, version);
  const listing = run("tar", ["-tf", tarball]).split("\n");
  assert.ok(
    !listing.some((name) => name.endsWith(".map")),
    `${pkg.name}: source-map leak`,
  );
  packages.push({
    name: pkg.name,
    file: `npm/${filename}`,
    integrity: integrity(readFileSync(tarball)),
  });
}
const files = {};
for (const folder of ["npm", "binaries"])
  for (const filename of readdirSync(join(output, folder)).sort()) {
    assert.ok(!filename.endsWith(".map"), "Source-map leak");
    files[`${folder}/${filename}`] = digest(
      readFileSync(join(output, folder, filename)),
    );
  }
writeFileSync(
  join(output, "manifest.json"),
  `${JSON.stringify({ version, revision, epoch, bun, targets, packages, files }, null, 2)}\n`,
);
files["manifest.json"] = digest(readFileSync(join(output, "manifest.json")));
writeFileSync(
  join(output, "checksums.txt"),
  `${Object.entries(files)
    .map(([file, hash]) => `${hash}  ${file}`)
    .join("\n")}\n`,
);
console.log(
  `Packed ${packages.length} npm packages and ${targets.length} binaries at ${revision}`,
);
