import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { assemblePayload } from "./build-deploy-payload.mjs";

let root;
const write = (path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const inputs = () => ({
  workerDir: join(root, "worker"),
  uiDir: join(root, "ui"),
  migrationsDir: join(root, "migrations"),
  output: join(root, "out"),
  version: "1.2.3",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tila-deploy-payload-"));
  write("worker/index.js", "export default {};\n");
  write("worker/index.js.map", "{}");
  write("worker/bundle-meta.json", "{}");
  write("worker/README.md", "wrangler output");
  write("ui/index.html", "<html>");
  write("ui/assets/app.js", 'fetch("/api/health")');
  write("migrations/0002_b.sql", "SELECT 2;");
  write("migrations/0001_a.sql", "SELECT 1;");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("assembles the layout and a deterministic manifest", () => {
  assemblePayload(inputs());
  const manifest = JSON.parse(
    readFileSync(join(root, "out/manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(Object.keys(manifest.files), [
    "migrations/global/0001_a.sql",
    "migrations/global/0002_b.sql",
    "ui/dist/assets/app.js",
    "ui/dist/index.html",
    "worker/index.js",
  ]);
  assert.equal(
    manifest.files["worker/index.js"],
    createHash("sha256").update("export default {};\n").digest("hex"),
  );
  assert.ok(!existsSync(join(root, "out/worker/index.js.map")));
  assert.ok(!existsSync(join(root, "out/worker/bundle-meta.json")));

  const first = readFileSync(join(root, "out/manifest.json"), "utf8");
  assemblePayload(inputs());
  assert.equal(readFileSync(join(root, "out/manifest.json"), "utf8"), first);
});

test("rejects a UI built against a local API", () => {
  write("ui/assets/app.js", 'const API="http://localhost:8787"');
  assert.throws(() => assemblePayload(inputs()), /points at a local API/);
});

test("requires index.html, index.js and at least one migration", () => {
  rmSync(join(root, "ui/index.html"));
  assert.throws(() => assemblePayload(inputs()), /no index\.html/);
  write("ui/index.html", "<html>");
  rmSync(join(root, "worker/index.js"));
  assert.throws(() => assemblePayload(inputs()), /no index\.js/);
  write("worker/index.js", "export default {};\n");
  rmSync(join(root, "migrations"), { recursive: true });
  mkdirSync(join(root, "migrations"));
  assert.throws(() => assemblePayload(inputs()), /No D1 migrations/);
});

test("fails on unexpected files in the Worker bundle", () => {
  write("worker/secrets.txt", "x");
  assert.throws(() => assemblePayload(inputs()), /Unexpected file/);
});
