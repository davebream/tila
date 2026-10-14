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
import {
  assertDeployPayload,
  withoutPayloadOverrides,
} from "./release-worker-identity.mjs";

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

function dryRun(binary, home, env = {}) {
  return spawnSync(binary, ["deploy", "--dry-run", "--json"], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
    env: withoutPayloadOverrides({ ...process.env, TILA_HOME: home, ...env }),
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
    const version = JSON.parse(
      readFileSync(join(cli, "package.json"), "utf8"),
    ).version;
    const revision = "a".repeat(40);
    const worker = `var PRODUCT_VERSION = ${JSON.stringify(version)}, BUILD_COMMIT = "${revision}";
var health = new Hono();
health.get("/health", (c) => {
  return c.json({ok: true, version: PRODUCT_VERSION, commit: BUILD_COMMIT});
});
export default health;
`;
    writeFileSync(join(fixture, "worker/index.js"), worker);
    writeFileSync(join(fixture, "ui/index.html"), "<!doctype html>\n");
    const payload = join(root, "deploy-payload");
    assemblePayload({
      workerDir: join(fixture, "worker"),
      uiDir: join(fixture, "ui"),
      migrationsDir,
      output: payload,
      version,
    });
    const migrations = readdirSync(migrationsDir).filter((f) =>
      f.endsWith(".sql"),
    ).length;

    const withPayload = compile(root, "tila", [payload]);
    // The binary must not depend on the payload directory it was built from.
    rmSync(payload, { recursive: true });
    const home = join(root, "home");
    mkdirSync(home);

    const first = dryRun(withPayload, home, {
      TILA_WORKER_DIST: join(root, "wrong-worker"),
      TILA_UI_DIST: join(root, "wrong-ui"),
      TILA_MIGRATIONS_DIR: join(root, "wrong-migrations"),
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const { result } = JSON.parse(first.stdout);
    assert.equal(result.source, "embedded");
    assert.equal(result.migrations.count, migrations);
    assert.equal(result.ui.indexHtml, true);
    assert.ok(result.worker.startsWith(join(home, "cache", "deploy-payload")));
    assert.equal(readFileSync(result.worker, "utf8"), worker);
    assertDeployPayload(first.stdout, { version, revision });
    // The compiled, valid-hash, same-version payload must fail for a release
    // stamped with another full commit, even though staging itself succeeds.
    assert.throws(
      () =>
        assertDeployPayload(first.stdout, {
          version,
          revision: "1".repeat(40),
        }),
      /Worker BUILD_COMMIT mismatch/,
    );

    // A modified cache is rebuilt from the embedded copy.
    writeFileSync(result.worker, "tampered");
    assert.throws(
      () => assertDeployPayload(first.stdout, { version, revision }),
      /Worker/,
    );
    const second = dryRun(withPayload, home);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(result.worker, "utf8"), worker);
    assertDeployPayload(second.stdout, { version, revision });

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
