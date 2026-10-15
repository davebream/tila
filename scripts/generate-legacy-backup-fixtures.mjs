// Regenerates the pre-0.8 backup regression oracles from the real v0.7.0
// source. Not run in CI: the committed outputs are the oracle, and a
// regenerated archive must be pinned again in the tests that consume it.
//
//   git archive v0.7.0 | tar -x -C "$TREE"          # fresh, empty directory
//   ln -s "$PWD/node_modules" "$TREE/node_modules"   # plus each package's node_modules
//   TILA_BUILD_REVISION=<v0.7.0 commit> node "$TREE/scripts/generate-version.mjs" sdk
//   node_modules/.bin/tsx --tsconfig "$TREE/tsconfig.json" \
//     scripts/generate-legacy-backup-fixtures.mjs --tree "$TREE" --commit <v0.7.0 commit> [--work <scratch parent dir>]
//
// Prints the digests to pin; writes the archive fixture module.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tree: { type: "string" },
    commit: { type: "string" },
    work: { type: "string" },
  },
});
if (!values.tree || !values.commit)
  throw new Error("Pass --tree <v0.7.0 source tree> and --commit <sha>");
const tree = resolve(values.tree);
const repo = fileURLToPath(new URL("..", import.meta.url));
const load = (root, path) => import(pathToFileURL(join(root, path)).href);

const sdkPackage = JSON.parse(
  readFileSync(join(tree, "packages/sdk/package.json"), "utf8"),
);
if (sdkPackage.version !== "0.7.0")
  throw new Error(`Expected a v0.7.0 tree, found ${sdkPackage.version}`);
const { MIGRATIONS, MIGRATION_BOOTSTRAP, LATEST_PROJECT_MIGRATION } =
  await load(tree, "packages/ops-sqlite/src/migrations-sql.ts");
if (LATEST_PROJECT_MIGRATION !== 40)
  throw new Error(
    `Expected migration level 40, found ${LATEST_PROJECT_MIGRATION}`,
  );

// 1. Digest over the fixed rows, computed by v0.7.0's own semanticDigest.
const Database = createRequire(join(tree, "packages/ops-sqlite/package.json"))(
  "better-sqlite3",
);
const { runMigration } = await load(
  tree,
  "packages/ops-sqlite/test/helpers.ts",
);
const transfer = await load(
  tree,
  "packages/ops-sqlite/src/project-transfer-ops.ts",
);
const { insertLegacyDigestRows } = await load(
  repo,
  "packages/ops-sqlite/test/fixtures/legacy-digest-rows.ts",
);
const raw = new Database(":memory:");
raw.pragma("foreign_keys = ON");
raw.exec(MIGRATION_BOOTSTRAP);
for (const migration of MIGRATIONS) runMigration(raw, migration);
insertLegacyDigestRows(raw);
const sql = {
  exec(statement, ...bindings) {
    if (/^\s*(SELECT|PRAGMA)/i.test(statement))
      return { toArray: () => raw.prepare(statement).all(...bindings) };
    if (bindings.length > 0) raw.prepare(statement).run(...bindings);
    else raw.exec(statement);
    return { toArray: () => [] };
  },
};
const rowsDigest = await transfer.semanticDigest(sql, 40);
raw.close();

// 2. An archive exported by v0.7.0's own SDK: 1 task, 1 record, 1 reviewed artifact.
const { createTilaLocal, buildLocalResources } = await load(
  tree,
  "packages/sdk/src/local/index.ts",
);
const { exportProjectBackup, inspectProjectBackup } = await load(
  tree,
  "packages/sdk/src/backup/index.ts",
);
const work = mkdtempSync(join(values.work ?? tmpdir(), "tila-legacy-fixture-"));
let archive;
let manifest;
try {
  const options = {
    dbPath: join(work, "db.sqlite"),
    artifactsPath: join(work, "artifacts"),
    project: "legacy-archive",
    org: "local",
    skipFilesystemCheck: true,
    identity: {
      principal_id: "local:producer",
      participant_id: "node-session",
      environment: { client_name: "node", client_version: "fixture" },
    },
  };
  const local = await createTilaLocal(options);
  await local.project.create({
    id: "legacy-task",
    type: "task",
    data: { name: "Legacy task", status: "open" },
    created_by: "fixture",
  });
  const facade = buildLocalResources(local.project, local.artifacts);
  await facade.records.create("config", {
    key: "main",
    value: { region: "eu" },
  });
  const uploaded = await facade.artifacts.writeText("Legacy evidence", {
    kind: "report",
    mimeType: "text/plain",
  });
  await facade.artifacts.review(uploaded.key, {
    decision: "trusted",
    expected_review_revision: 0,
    reason: "Checked source",
    idempotencyKey: "legacy-review",
  });
  local.close();
  const output = join(work, "legacy.tila-backup");
  manifest = await exportProjectBackup({
    source: {
      backend: "local",
      projectId: options.project,
      dbPath: options.dbPath,
      artifactsPath: options.artifactsPath,
    },
    output,
  });
  await inspectProjectBackup(output);
  archive = readFileSync(output);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 3. Write the module (bytes only; the oracles are pinned in the tests).
const sha256 = createHash("sha256").update(archive).digest("hex");
const encoded = archive.toString("base64");
const chunks = encoded.match(/.{1,100}/g) ?? [];
const target = join(
  repo,
  "packages/sdk/src/__tests__/fixtures/legacy-backup/v0.7.0-archive.ts",
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `// Generated by scripts/generate-legacy-backup-fixtures.mjs. Do not edit.
// A project backup exported by the tila-sdk v0.7.0 local backend (tag commit
// ${values.commit}): one task, one record and one reviewed artifact, migration
// level ${manifest.source.do_migration_version}. Pin its bytes and digest in the tests that use it.
const BASE64 = [
${chunks.map((chunk) => `  "${chunk}",`).join("\n")}
].join("");

export function legacyV070Archive(): Uint8Array {
  return Uint8Array.from(atob(BASE64), (char) => char.charCodeAt(0));
}
`,
);

console.log(
  JSON.stringify(
    {
      archive_sha256: sha256,
      archive_bytes: archive.length,
      manifest: {
        product_version: manifest.source.product_version,
        do_migration_version: manifest.source.do_migration_version,
        semantic_digest: manifest.semantic_digest,
      },
      fixed_rows_digest_level_40: rowsDigest,
    },
    null,
    2,
  ),
);
