// Local browser evidence only; this is partial S1 coverage, not scenario acceptance.
// pnpm exec playwright install chromium
// pnpm test:browser:s1
// Optional: BROWSER_S1_EXECUTABLE, BROWSER_S1_EVIDENCE_DIR (private local output).
// External requests fail closed, including the current Google Fonts stylesheet.
// A failed run is evidence of the reported stop point, never S1 acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseSchemaToml, serializeDefinitionDocument } from "@tila/core";
import { readDefinitionFile } from "@tila/core/definition-yaml";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const workerDir = resolve(root, "packages/worker");
await mkdir(resolve(workerDir, ".wrangler"), { recursive: true });
const fixture = await mkdtemp(resolve(workerDir, ".wrangler/browser-s1-"));
const evidence =
  process.env.BROWSER_S1_EVIDENCE_DIR || resolve(fixture, "evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const started = Date.now();
const observations = [];
let step = "prepare fixture";
let browser;
let page;
const children = [];
// Do not inherit Cloudflare credentials, project auth, or the operator's config.
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  // The banner performs an npm update check even for --local commands.
  WRANGLER_HIDE_BANNER: "true",
  XDG_CONFIG_HOME: resolve(fixture, "config"),
  TILA_HOME: resolve(fixture, "auth"),
});
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function launch(name, args, extraEnv = {}) {
  const log = createWriteStream(resolve(evidence, `${name}.log`), {
    mode: 0o600,
  });
  const child = spawn("pnpm", args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}
async function command(name, args) {
  const child = launch(name, args);
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(code, 0, `${name} failed; see its private log`);
}
async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`Local server did not start during ${step}`);
}
function record(name, details = {}) {
  observations.push({
    step: name,
    elapsed_ms: Date.now() - started,
    ...details,
  });
  console.log(`PASS ${name}`);
}
function parsed(source) {
  const result = parseSchemaToml(source);
  assert.equal(result.ok, true, "definition must parse");
  return result.schema;
}
const project = "browser-s1";
const token = randomBytes(32).toString("hex");
const admin = randomBytes(32).toString("hex");
const password = randomBytes(24).toString("base64url");
const external = [];
const errors = [];
try {
  const workerPort = await freePort();
  let uiPort = await freePort();
  while (uiPort === workerPort) uiPort = await freePort();
  const api = `http://127.0.0.1:${workerPort}`;
  const ui = `http://127.0.0.1:${uiPort}`;
  const config = resolve(fixture, "wrangler.toml");
  let toml = await readFile(resolve(workerDir, "wrangler.toml"), "utf8");
  toml = toml
    .replace(
      'main = "src/index.ts"',
      `main = ${JSON.stringify(resolve(workerDir, "src/index.ts"))}`,
    )
    .replace('database_id = ""', 'database_id = "browser-local"')
    .replace(/\[assets\][\s\S]*?run_worker_first = [^\n]*\n/, "")
    .replace(
      'CORS_ALLOWED_ORIGINS = ""',
      `CORS_ALLOWED_ORIGINS = "${ui}"\nUI_ORIGIN = "${ui}"\nAUTH_SECRET = "${randomBytes(32).toString("hex")}"\nINFRA_ADMIN_TOKEN = "${admin}"`,
    );
  await writeFile(config, toml, { mode: 0o600 });
  const migrationsDir = resolve(workerDir, "migrations/global");
  const migrations = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const migrationFile = resolve(fixture, "migrations.sql");
  await writeFile(
    migrationFile,
    (
      await Promise.all(
        migrations.map((name) =>
          readFile(resolve(migrationsDir, name), "utf8"),
        ),
      )
    ).join("\n"),
  );
  const wrangler = ["--filter", "@tila/worker", "exec", "wrangler"];
  const storage = [
    "--config",
    config,
    "--persist-to",
    resolve(fixture, "state"),
  ];
  await command("migrate", [
    ...wrangler,
    "d1",
    "execute",
    "tila-global",
    "--local",
    "--yes",
    ...storage,
    "--file",
    migrationFile,
  ]);
  const seed = resolve(fixture, "seed.sql");
  await writeFile(
    seed,
    `INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES ('${project}', 'Browser S1', strftime('%s','now'), 'browser-fixture', 'local');
INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES ('${createHash("sha256").update(token).digest("hex")}', '${project}', 'browser-competitor', 'full', strftime('%s','now'), 'browser-fixture');`,
    { mode: 0o600 },
  );
  await command("seed", [
    ...wrangler,
    "d1",
    "execute",
    "tila-global",
    "--local",
    "--yes",
    ...storage,
    "--file",
    seed,
  ]);
  step = "start isolated Worker and UI";
  await command("version", ["--filter", "@tila/worker", "run", "gen:version"]);
  const worker = launch("worker", [
    ...wrangler,
    "dev",
    "--local",
    ...storage,
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--inspector-port",
    "0",
    "--tsconfig",
    resolve(root, "tsconfig.json"),
  ]);
  const vite = launch(
    "ui",
    [
      "--filter",
      "@tila/ui",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
      "--strictPort",
    ],
    { VITE_API_URL: api },
  );
  await Promise.all([
    ready(`${api}/api/runtime/info`, worker),
    ready(ui, vite),
  ]);
  record("isolated local fixture", { migrations: migrations.length });
  async function request(path, body) {
    const response = await fetch(`${api}${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "browser-competitor",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(
      response.ok,
      true,
      `fixture API ${path}: HTTP ${response.status}`,
    );
    return data;
  }
  const schemaPath = `/projects/${project}/schema`;
  const current = () => request(schemaPath);
  const base = `${ui}/p/${project}/settings/definitions`;
  step = "browser account setup";
  // The invitation is infrastructure setup; account acceptance and login occur in Chromium.
  const setupResponse = await fetch(`${api}/api/account/setup`, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "browser@example.test", projectId: project }),
  });
  assert.equal(
    setupResponse.ok,
    true,
    `account setup: HTTP ${setupResponse.status}`,
  );
  const invitation = new URL((await setupResponse.json()).url);
  assert.equal(invitation.origin, ui);
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_S1_EXECUTABLE || undefined,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  let stopExternal;
  const externalFailure = new Promise((_, reject) => {
    stopExternal = reject;
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === api ||
      url.origin === ui ||
      url.protocol === "blob:" ||
      url.protocol === "data:"
    )
      return route.continue();
    external.push(`${url.protocol}//${url.hostname}`);
    stopExternal(new Error(`External browser request blocked: ${url.origin}`));
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await Promise.race([
    externalFailure,
    (async () => {
      await page.goto(invitation.href);
      await page.getByText("browser@example.test", { exact: true }).waitFor();
      await page.getByLabel("Name", { exact: true }).fill("Synthetic Browser");
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await page.waitForURL(`${ui}/`);
      // A new account has a workspace session until it selects a project.
      await page
        .getByRole("button", { name: "Browser S1", exact: true })
        .click();
      await page.waitForURL(`${ui}/p/${project}/**`);
      record(step);
      step = "browser first definition without a file";
      await page.goto(base);
      await page
        .getByRole("button", { name: "Start definitions", exact: true })
        .click();
      const task =
        'schema_version = 1\n\n[work_units.task]\nfields = [{ name = "title", type = "string", required = true }]\n';
      await page.getByLabel("Draft (TOML)").fill(task);
      await page
        .getByRole("link", { name: "Review changes", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Apply as revision 1", exact: true })
        .click();
      await page.getByText("Applied as revision 1.", { exact: true }).waitFor();
      assert.equal((await current()).revision, 1);
      record(step);
      step = "browser structured definition evolution and history";
      await page
        .getByRole("button", { name: "Add work type", exact: true })
        .click();
      const drawer = page.getByRole("dialog");
      await drawer.getByLabel("Name", { exact: true }).fill("bug");
      await drawer
        .getByRole("button", { name: "Save to draft", exact: true })
        .click();
      await page
        .getByRole("link", { name: "Review changes", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Apply as revision 2", exact: true })
        .click();
      await page.getByText("Applied as revision 2.", { exact: true }).waitFor();
      const revision2 = await current();
      assert.equal(revision2.revision, 2);
      await page.getByRole("link", { name: "Revision 1", exact: true }).click();
      await page
        .getByRole("heading", { name: "Revision 1", exact: true })
        .waitFor();
      await page.getByText("Revision 1 source (TOML)", { exact: true }).click();
      assert.ok(
        (await page.locator("pre").first().textContent()).includes(
          "work_units.task",
        ),
      );
      await page.goto(base);
      record(step);
      step = "browser semantic TOML and YAML export/import";
      for (const format of ["TOML", "YAML"]) {
        const downloadEvent = page.waitForEvent("download");
        await page
          .getByRole("button", { name: `Download ${format}`, exact: true })
          .click();
        const download = await downloadEvent;
        const content = await readFile(await download.path(), "utf8");
        const read = readDefinitionFile(content, {
          format: format.toLowerCase(),
        });
        assert.equal(read.ok, true);
        assert.deepEqual(
          parsed(serializeDefinitionDocument(read.doc)),
          parsed(revision2.schema.definition),
        );
        await page
          .getByRole("link", { name: "Import a file", exact: true })
          .click();
        await page
          .getByLabel("File (.toml, .yaml or .yml)", { exact: true })
          .setInputFiles({
            name: download.suggestedFilename(),
            mimeType: "text/plain",
            buffer: Buffer.from(content),
          });
        await page
          .getByRole("button", {
            name: "Load into draft and review",
            exact: true,
          })
          .click();
        await page
          .getByText(
            "The file matches revision 2; there is nothing to import.",
            {
              exact: true,
            },
          )
          .waitFor();
        assert.equal((await current()).revision, 2);
        await page.goto(base);
        record(`${format} browser download and semantic no-op import`);
      }
      step = "stale browser apply after competing API revision";
      await page
        .getByRole("link", { name: "Edit source", exact: true })
        .click();
      const mine = `${revision2.schema.definition}\n[records.browser_note]\n`;
      await page.getByLabel("Draft (TOML)").fill(mine);
      await page
        .getByRole("link", { name: "Review changes", exact: true })
        .click();
      const apply3 = page.getByRole("button", {
        name: "Apply as revision 3",
        exact: true,
      });
      await apply3.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "Apply as revision 3" && !b.disabled,
        ),
      );
      const theirs = `${revision2.schema.definition}\n[artifacts.api_plan]\nmime_types = ["text/markdown"]\nretention_days = 30\n`;
      await request(schemaPath, { definition: theirs, expected_revision: 2 });
      assert.equal((await current()).revision, 3);
      const rejectedEvent = page.waitForResponse(
        (response) =>
          response.url() === `${api}${schemaPath}` &&
          response.request().method() === "POST",
      );
      await apply3.click();
      const rejected = await rejectedEvent;
      assert.equal(rejected.status(), 412);
      assert.equal(
        (await rejected.json()).error.code,
        "schema-revision-conflict",
      );
      await page
        .getByRole("region", {
          name: "Revision 3 was applied after your draft started",
          exact: true,
        })
        .waitFor();
      const afterConflict = await current();
      assert.equal(afterConflict.revision, 3);
      assert.deepEqual(parsed(afterConflict.schema.definition), parsed(theirs));
      record(step, { http_status: 412, persisted_revision: 3 });
      step = "browser explicit rebase and apply preserves both changes";
      await page
        .getByRole("button", {
          name: "Move my draft onto revision 3",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "Apply as revision 4", exact: true })
        .click();
      await page.getByText("Applied as revision 4.", { exact: true }).waitFor();
      const final = await current();
      assert.equal(final.revision, 4);
      assert.ok(final.schema.definition.includes("browser_note"));
      assert.ok(final.schema.definition.includes("api_plan"));
      const history = await request(`${schemaPath}/history`);
      assert.deepEqual(
        history.entries.map((entry) => entry.version),
        [4, 3, 2, 1],
      );
      await page.screenshot({
        path: resolve(evidence, "definitions-final.png"),
        fullPage: true,
      });
      assert.deepEqual(external, [], "browser attempted external access");
      assert.deepEqual(errors, [], "browser page errors");
      record(step, { persisted_revision: 4, history: [4, 3, 2, 1] });
    })(),
  ]);
} catch (error) {
  // No traces, cookies, request bodies or invitation URLs are retained.
  const message = String(error.stack || error)
    .replaceAll(root, "<checkout>")
    .replace(/https?:\/\/[^\s]+#[^\s]+/g, "<invitation-redacted>");
  observations.push({
    step,
    outcome: "failed",
    error: message,
    elapsed_ms: Date.now() - started,
  });
  console.error(`FAIL ${step}\n${message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  await writeFile(
    resolve(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "partial local browser S1; no live/native/S2/S3 acceptance",
        observations,
        external,
        page_errors: errors,
        duration_ms: Date.now() - started,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
