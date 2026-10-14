import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assemblePayload } from "./build-deploy-payload.mjs";
import { digest } from "./release-common.mjs";
import {
  assertDeployPayload,
  withoutPayloadOverrides,
  workerIdentity,
} from "./release-worker-identity.mjs";

const revision = "a".repeat(40);
const stale = "1".repeat(40);
const manifest = { version: "0.8.0", revision };
// The relevant fragment of Wrangler 4.149.0's non-minified output, built from
// packages/worker/src/routes/health.ts and generated src/version.ts.
const declarations = `var DO_CODE_VERSION = "${revision}";
var PRODUCT_VERSION = "0.8.0";
var BUILD_COMMIT = "${revision}";`;
const route = `var health = new Hono3();
health.get("/health", (c) => {
  return c.json({
    ok: true,
    version: PRODUCT_VERSION,
    commit: BUILD_COMMIT,
    apiVersion: 1,
    minCliVersion: "0.1.0",
    features: ["managed-queue-v1"],
  });
});`;
const bundle = `${declarations}\n${route}\n`;

test("parses Wrangler identity structurally, including multiple declarations and JS escapes", () => {
  const forms = [
    declarations,
    declarations.replaceAll("var ", "export const "),
    `var DO_CODE_VERSION = "${revision}", PRODUCT_VERSION = '0.8.0', BUILD_COMMIT = '${revision}';`,
    `const PRODUCT_VERSION = "\\x30.8.0", BUILD_\\u0043OMMIT = "\\u0061${revision.slice(1)}";`,
  ];
  for (const form of forms) {
    // Parsing never imports or executes the Worker.
    assert.deepEqual(
      workerIdentity(`${form}\n${route}\nthrow new Error("do not execute");`),
      { version: manifest.version, commit: revision },
    );
  }
});

test("rejects missing, malformed, duplicate, mutated and ambiguous Worker identity", () => {
  const invalid = [
    ["missing identity", route],
    ["missing commit", bundle.replace(/var BUILD_COMMIT[^;]+;/, "")],
    ["missing version", bundle.replace(/var PRODUCT_VERSION[^;]+;/, "")],
    [
      "short commit",
      bundle.replace(`BUILD_COMMIT = "${revision}"`, 'BUILD_COMMIT = "abc123"'),
    ],
    [
      "nonhex commit",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = "${"g".repeat(40)}"`,
      ),
    ],
    [
      "trailing newline",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = "${revision}\\n"`,
      ),
    ],
    [
      "nonliteral commit",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = getCommit("${revision}")`,
      ),
    ],
    [
      "computed commit",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = "${revision.slice(0, 20)}" + "${revision.slice(20)}"`,
      ),
    ],
    [
      "template literal",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = \`${revision}\``,
      ),
    ],
    [
      "numeric version",
      bundle.replace('PRODUCT_VERSION = "0.8.0"', "PRODUCT_VERSION = 8"),
    ],
    ["duplicate identity", `${declarations}\n${bundle}`],
    [
      "duplicate in multi declaration",
      bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = "${revision}", BUILD_COMMIT = "${stale}"`,
      ),
    ],
    [
      "shadowed identity",
      `${bundle}\nfunction other() { var BUILD_COMMIT = "${stale}"; }`,
    ],
    ["reassigned identity", `${bundle}\nBUILD_COMMIT = "${stale}";`],
    ["destructured identity", `${bundle}\n({ BUILD_COMMIT } = other);`],
    ["nested declaration", bundle.replace(declarations, `{ ${declarations} }`)],
    [
      "type annotation",
      bundle.replace("BUILD_COMMIT =", "BUILD_COMMIT: string ="),
    ],
    [
      "wrong health binding",
      bundle.replace("commit: BUILD_COMMIT", 'commit: "unrelated"'),
    ],
    [
      "aliased identity",
      bundle.replace(
        route,
        `var alias = BUILD_COMMIT;\n${route.replace("commit: BUILD_COMMIT", "commit: alias")}`,
      ),
    ],
    [
      "duplicate health field",
      bundle.replace(
        "commit: BUILD_COMMIT,",
        `commit: BUILD_COMMIT, commit: "${stale}",`,
      ),
    ],
    [
      "computed health field",
      bundle.replace("commit: BUILD_COMMIT", '["commit"]: BUILD_COMMIT'),
    ],
    ["spread health field", bundle.replace("ok: true,", "ok: true, ...other,")],
    ["duplicate route", `${bundle}\n${route}`],
    ["missing route", declarations],
    ["nested route", `${declarations}\nif (false) { ${route} }`],
    ["malformed JS", `${bundle}\nvar broken = ;`],
    [
      "unrelated SHA text",
      `// ${revision}\nconst example = ${JSON.stringify(bundle)};`,
    ],
  ];
  for (const [name, source] of invalid)
    assert.throws(() => workerIdentity(source), assert.AssertionError, name);
});

test("compares the actual Worker file with the outer manifest despite valid payload hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "tila-worker-identity-"));
  try {
    for (const dir of ["worker", "ui", "migrations"])
      mkdirSync(join(root, dir));
    const worker = join(root, "worker/index.js");
    writeFileSync(join(root, "ui/index.html"), "<html>fixture</html>");
    writeFileSync(join(root, "migrations/0001.sql"), "SELECT 1;");
    const payload = join(root, "payload");
    const output = (changes = {}) =>
      JSON.stringify({
        result: {
          ...manifest,
          source: "embedded",
          overrides: [],
          worker: join(payload, "worker/index.js"),
          migrations: { count: 1 },
          ui: { indexHtml: true },
          ...changes,
        },
      });
    const assemble = (source) => {
      writeFileSync(worker, source);
      assemblePayload({
        workerDir: join(root, "worker"),
        uiDir: join(root, "ui"),
        migrationsDir: join(root, "migrations"),
        output: payload,
        version: manifest.version,
      });
      const inner = JSON.parse(readFileSync(join(payload, "manifest.json")));
      assert.equal(inner.files["worker/index.js"], digest(Buffer.from(source)));
    };
    assemble(bundle);
    assertDeployPayload(output(), manifest);
    for (const badRevision of [
      undefined,
      "",
      "abc123",
      "g".repeat(40),
      `${revision}\n`,
    ])
      assert.throws(
        () =>
          assertDeployPayload(output(), { ...manifest, revision: badRevision }),
        /Release revision/,
      );
    for (const overrides of [
      undefined,
      ["TILA_WORKER_DIST"],
      ["TILA_UI_DIST"],
      ["TILA_MIGRATIONS_DIR"],
      {},
    ])
      assert.throws(
        () => assertDeployPayload(output({ overrides }), manifest),
        /no overrides/,
      );
    assert.throws(
      () => assertDeployPayload(output({ source: "source" }), manifest),
      /Deploy payload source/,
    );
    assert.throws(
      () =>
        assertDeployPayload(
          output({ worker: join(root, "missing.js") }),
          manifest,
        ),
      /ENOENT/,
    );

    // Both payload assembly and hash checks accept this same-version bundle.
    // An expected revision in another constant, comment or string cannot help.
    assemble(
      `${bundle.replace(
        `BUILD_COMMIT = "${revision}"`,
        `BUILD_COMMIT = "${stale}"`,
      )}\n// ${revision}\nvar text = "${revision}";`,
    );
    assert.throws(
      () => assertDeployPayload(output(), manifest),
      /Worker BUILD_COMMIT mismatch/,
    );
    assemble(
      bundle.replace('PRODUCT_VERSION = "0.8.0"', 'PRODUCT_VERSION = "0.7.0"'),
    );
    assert.throws(
      () => assertDeployPayload(output(), manifest),
      /Worker PRODUCT_VERSION mismatch/,
    );
    assemble(bundle);
    writeFileSync(
      join(payload, "worker/index.js"),
      Buffer.concat([Buffer.from(bundle), Buffer.from([0xff])]),
    );
    assert.throws(
      () => assertDeployPayload(output(), manifest),
      /encoded data/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("smoke clears all payload overrides without changing other environment values", () => {
  const env = {
    PATH: "/fixture/bin",
    TILA_HOME: "/fixture/home",
    TILA_WORKER_DIST: "/wrong/worker",
    TILA_UI_DIST: "/wrong/ui",
    TILA_MIGRATIONS_DIR: "/wrong/migrations",
  };
  assert.deepEqual(withoutPayloadOverrides(env), {
    PATH: env.PATH,
    TILA_HOME: env.TILA_HOME,
  });
  assert.equal(env.TILA_WORKER_DIST, "/wrong/worker");
});
