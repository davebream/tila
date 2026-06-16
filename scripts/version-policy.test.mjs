import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

const platformPackages = [
  "tila-cli-darwin-arm64",
  "tila-cli-darwin-x64",
  "tila-cli-linux-arm64",
  "tila-cli-linux-arm64-musl",
  "tila-cli-linux-x64",
  "tila-cli-linux-x64-musl",
  "tila-cli-windows-arm64",
  "tila-cli-windows-x64",
];

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}`, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function createFixture(version = "1.2.3") {
  const fixture = await mkdtemp(join(tmpdir(), "tila-version-policy-"));

  await writeJson(join(fixture, "package.json"), {
    name: "tila",
    version,
    private: true,
  });

  await writeJson(join(fixture, "packages/cli/package.json"), {
    name: "tila-cli",
    version,
    optionalDependencies: Object.fromEntries(
      platformPackages.map((name) => [name, version]),
    ),
  });

  for (const name of platformPackages) {
    await writeJson(
      join(fixture, `packages/${name.replace("tila-", "")}/package.json`),
      {
        name,
        version,
      },
    );
  }

  await writeJson(join(fixture, "packages/sdk/package.json"), {
    name: "tila-sdk",
    version,
  });
  await writeJson(join(fixture, "packages/mcp-server/package.json"), {
    name: "tila-mcp-server",
    version,
  });
  await writeJson(join(fixture, "packages/mcp-server/server.json"), {
    name: "io.github.davebream/tila",
    version,
  });
  await writeJson(join(fixture, "packages/core/package.json"), {
    name: "@tila/core",
    version: "9.9.9",
    private: true,
  });

  // Seed the homebrew formula so bump-version.mjs can rewrite it.
  // Must contain realistic structure matching publish-tap.yml's sed patterns.
  await mkdir(join(fixture, "homebrew/Formula"), { recursive: true });
  await writeFile(
    join(fixture, "homebrew/Formula/tila.rb"),
    [
      "class Tila < Formula",
      `  version "${version}"`,
      "  on_macos do",
      "    on_arm do",
      `      url "https://github.com/davebream/tila/releases/download/v${version}/tila-darwin-arm64"`,
      `      sha256 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`,
      "    end",
      "    on_intel do",
      `      url "https://github.com/davebream/tila/releases/download/v${version}/tila-darwin-x64"`,
      `      sha256 "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"`,
      "    end",
      "  end",
      "  on_linux do",
      "    on_arm do",
      `      url "https://github.com/davebream/tila/releases/download/v${version}/tila-linux-arm64"`,
      `      sha256 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"`,
      "    end",
      "    on_intel do",
      `      url "https://github.com/davebream/tila/releases/download/v${version}/tila-linux-x64"`,
      `      sha256 "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"`,
      "    end",
      "  end",
      "end",
    ].join("\n") + "\n",
  );

  return fixture;
}

function runScript(scriptName, args = []) {
  return spawnSync(process.execPath, [join(scriptDir, scriptName), ...args], {
    encoding: "utf8",
  });
}

test("check-public-versions reports mismatched public release metadata", async () => {
  const root = await createFixture();

  await writeJson(join(root, "packages/sdk/package.json"), {
    name: "tila-sdk",
    version: "1.2.4",
  });
  const cliPackage = await readJson(join(root, "packages/cli/package.json"));
  cliPackage.optionalDependencies["tila-cli-darwin-arm64"] = "1.2.0";
  await writeJson(join(root, "packages/cli/package.json"), cliPackage);
  await writeJson(join(root, "packages/mcp-server/server.json"), {
    name: "io.github.davebream/tila",
    version: "1.2.0",
  });

  const result = runScript("check-public-versions.mjs", ["--root", root]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /packages\/sdk\/package\.json version 1\.2\.4 != product version 1\.2\.3/,
  );
  assert.match(
    result.stderr,
    /packages\/cli\/package\.json optionalDependencies\.tila-cli-darwin-arm64 1\.2\.0 != product version 1\.2\.3/,
  );
  assert.match(
    result.stderr,
    /packages\/mcp-server\/server\.json version 1\.2\.0 != product version 1\.2\.3/,
  );
});

test("check-public-versions accepts aligned public metadata and ignores private packages", async () => {
  const root = await createFixture();

  const result = runScript("check-public-versions.mjs", ["--root", root]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Public release versions aligned at 1\.2\.3/);
});

test("bump-version updates public release metadata, root product marker, and homebrew formula version/URL", async () => {
  const root = await createFixture();

  const result = runScript("bump-version.mjs", ["2.0.0", "--root", root]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readJson(join(root, "package.json"))).version, "2.0.0");
  assert.equal(
    (await readJson(join(root, "packages/sdk/package.json"))).version,
    "2.0.0",
  );
  assert.equal(
    (await readJson(join(root, "packages/mcp-server/server.json"))).version,
    "2.0.0",
  );
  assert.equal(
    (await readJson(join(root, "packages/core/package.json"))).version,
    "9.9.9",
  );

  const cliPackage = await readJson(join(root, "packages/cli/package.json"));
  assert.equal(cliPackage.version, "2.0.0");
  for (const name of platformPackages) {
    assert.equal(cliPackage.optionalDependencies[name], "2.0.0");
    assert.equal(
      (
        await readJson(
          join(root, `packages/${name.replace("tila-", "")}/package.json`),
        )
      ).version,
      "2.0.0",
    );
  }
});

test("bump-version rewrites homebrew formula version and URL tags, leaving sha256 values unchanged", async () => {
  const root = await createFixture();
  const formulaPath = join(root, "homebrew/Formula/tila.rb");

  // Capture sha256 values BEFORE the bump
  const beforeContent = await readFile(formulaPath, "utf8");
  const beforeShas = [...beforeContent.matchAll(/^\s*sha256\s+"([^"]+)"/gm)].map(
    (m) => m[1],
  );
  assert.equal(beforeShas.length, 4, "fixture formula must have exactly 4 sha256 lines");

  const result = runScript("bump-version.mjs", ["2.0.0", "--root", root]);
  assert.equal(result.status, 0, result.stderr);

  const afterContent = await readFile(formulaPath, "utf8");

  // (a) version line is rewritten
  const versionMatch = afterContent.match(/^\s*version\s+"([^"]+)"/m);
  assert.ok(versionMatch, "formula must still have a version line");
  assert.equal(versionMatch[1], "2.0.0", "formula version must be bumped to 2.0.0");

  // (b) all four URL tags are rewritten
  const urlMatches = [...afterContent.matchAll(/releases\/download\/v([^/]+)\/tila-/g)];
  assert.equal(urlMatches.length, 4, "formula must have exactly 4 URL lines with the tag");
  for (const m of urlMatches) {
    assert.equal(m[1], "2.0.0", `URL tag must be 2.0.0, got ${m[1]}`);
  }

  // (c) sha256 values are byte-for-byte unchanged (REQUIRED guard)
  const afterShas = [...afterContent.matchAll(/^\s*sha256\s+"([^"]+)"/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    afterShas,
    beforeShas,
    "sha256 values must not be changed by bumpHomebrewFormula",
  );
});

test("bump-version rejects invalid semver", async () => {
  const root = await createFixture();

  const result = runScript("bump-version.mjs", ["2.0", "--root", root]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /version must match semver/);
});

test("homebrew formula has no PLACEHOLDER tokens and version matches product version", async () => {
  const formulaPath = join(scriptDir, "..", "homebrew/Formula/tila.rb");
  const rootPackageJsonPath = join(scriptDir, "..", "package.json");

  const formulaContent = await readFile(formulaPath, "utf8");
  const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8"));
  const productVersion = rootPackageJson.version;

  assert.doesNotMatch(
    formulaContent,
    /PLACEHOLDER/,
    "homebrew/Formula/tila.rb must not contain any PLACEHOLDER token",
  );

  const versionMatch = formulaContent.match(/^\s*version\s+"([^"]+)"/m);
  assert.ok(
    versionMatch,
    'homebrew/Formula/tila.rb must contain a version "..." line',
  );
  assert.equal(
    versionMatch[1],
    productVersion,
    `homebrew formula version "${versionMatch[1]}" must match product version "${productVersion}"`,
  );
});
