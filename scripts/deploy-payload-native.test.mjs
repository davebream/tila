import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assemblePayload } from "./build-deploy-payload.mjs";

const cli = resolve("packages/cli");
const migrationsDir = resolve("packages/worker/migrations/global");
const exe = process.platform === "win32" ? ".exe" : "";

function compile(root, name, assets) {
  const outfile = join(root, `${name}${exe}`);
  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      // Resolve workspace packages from source so no prior build is needed.
      "--tsconfig-override",
      "../../tsconfig.json",
      ...assets.flatMap((asset) => ["--asset", asset]),
      "src/index.ts",
      "--outfile",
      outfile,
    ],
    { cwd: cli, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return outfile;
}

function dryRun(binary, home) {
  return spawnSync(binary, ["deploy", "--dry-run", "--json"], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TILA_HOME: home },
  });
}

test("a compiled CLI deploys from its embedded payload and fails closed without one", () => {
  const root = mkdtempSync(join(tmpdir(), "tila-payload-native-"));
  try {
    for (const name of ["cli", "sdk", "worker"]) {
      const version = spawnSync(
        process.execPath,
        [resolve("scripts/generate-version.mjs"), name],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(version.status, 0, version.stderr);
    }

    const fixture = join(root, "fixture");
    mkdirSync(join(fixture, "worker"), { recursive: true });
    mkdirSync(join(fixture, "ui"), { recursive: true });
    writeFileSync(join(fixture, "worker/index.js"), "export default {};\n");
    writeFileSync(join(fixture, "ui/index.html"), "<!doctype html>\n");
    const payload = join(root, "deploy-payload");
    assemblePayload({
      workerDir: join(fixture, "worker"),
      uiDir: join(fixture, "ui"),
      migrationsDir,
      output: payload,
      version: JSON.parse(readFileSync(join(cli, "package.json"), "utf8"))
        .version,
    });
    const migrations = readdirSync(migrationsDir).filter((f) =>
      f.endsWith(".sql"),
    ).length;

    const withPayload = compile(root, "tila", [payload]);
    // The binary must not depend on the payload directory it was built from.
    rmSync(payload, { recursive: true });
    const home = join(root, "home");
    mkdirSync(home);

    const first = dryRun(withPayload, home);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const { result } = JSON.parse(first.stdout);
    assert.equal(result.source, "embedded");
    assert.equal(result.migrations.count, migrations);
    assert.equal(result.ui.indexHtml, true);
    assert.ok(result.worker.startsWith(join(home, "cache", "deploy-payload")));

    // A modified cache is rebuilt from the embedded copy.
    writeFileSync(result.worker, "tampered");
    const second = dryRun(withPayload, home);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(result.worker, "utf8"), "export default {};\n");

    const withoutPayload = compile(root, "tila-bare", []);
    const bare = dryRun(withoutPayload, home);
    assert.equal(bare.status, 1);
    const output = `${bare.stdout}${bare.stderr}`;
    assert.match(output, /no usable deploy payload/);
    assert.doesNotMatch(output, /packages\/worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
