// Local browser evidence only; this is partial S1 coverage, not scenario acceptance.
// pnpm exec playwright install chromium
// pnpm test:browser:s1
// Required: BROWSER_S1_EVIDENCE_DIR (existing mode0700 private parent).
// Optional: BROWSER_S1_EXECUTABLE (preinstalled compatible Chromium).
// External requests are blocked; only the known optional font stylesheet is nonfatal.
// A failed run is evidence of the reported stop point, never S1 acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import {
  findForbiddenDefinitionContent,
  parseSchemaToml,
  serializeDefinitionDocument,
} from "@tila/core";
import { readDefinitionFile } from "@tila/core/definition-yaml";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const workerDir = resolve(root, "packages/worker");
process.umask(0o077);
// Evidence must survive deletion of the fresh credential/state fixture.
const evidenceParent = process.env.BROWSER_S1_EVIDENCE_DIR;
assert.ok(
  evidenceParent,
  "BROWSER_S1_EVIDENCE_DIR must name a private parent directory",
);
assert.equal((await lstat(evidenceParent)).isDirectory(), true);
assert.equal((await lstat(evidenceParent)).mode & 0o777, 0o700);
const evidence = await mkdtemp(resolve(evidenceParent, "browser-s1-"));
await mkdir(resolve(workerDir, ".wrangler"), { recursive: true });
const fixture = await mkdtemp(resolve(workerDir, ".wrangler/browser-s1-"));
const started = Date.now();
const observations = [];
let step = "prepare fixture";
let browser;
let browserServer;
let scenario;
let page;
let finished = false;
let releaseHeld;
const children = [];
const ports = [];
const secrets = [];
const cleanup = { errors: [], fixture_removed: false };
function redact(value) {
  let text = String(value).split("Call log:")[0];
  for (const secret of secrets) text = text.replaceAll(secret, "<redacted>");
  return text
    .replace(/https?:\/\/[^\s]+#[^\s]+/g, "<invitation-redacted>")
    .replace(
      /[^\n]*(?:AUTH_SECRET|INFRA_ADMIN_TOKEN|Authorization|Cookie|\.fill\()[^\n]*/gi,
      "<credential-line-redacted>",
    )
    .replaceAll(root, "<checkout>")
    .slice(0, 2000);
}
// Use an empty HOME/config directory even for Chromium; never load operator auth.
const env = Object.fromEntries(
  ["PATH", "TMPDIR", "SystemRoot"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  HOME: resolve(fixture, "home"),
  CI: "1",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_HIDE_BANNER: "true",
  XDG_CONFIG_HOME: resolve(fixture, "config"),
  TILA_HOME: resolve(fixture, "auth"),
});
const executablePath =
  process.env.BROWSER_S1_EXECUTABLE || chromium.executablePath();
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function portOpen(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      done(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(true));
  });
}
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
    flags: "wx",
  });
  const child = spawn("pnpm", args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const entry = { child, log, bytes: 0 };
  children.push(entry);
  // Decode complete lines before redaction, including secrets split across chunks.
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let dropping = false;
    const consume = (text) => {
      pending += text;
      let end = pending.indexOf("\n");
      while (end >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (!dropping && entry.bytes < 1_000_000) {
          const safe = `${redact(line)}\n`;
          entry.bytes += Buffer.byteLength(safe);
          log.write(safe);
        }
        dropping = false;
        end = pending.indexOf("\n");
      }
      if (pending.length > 16_384) {
        pending = "";
        dropping = true;
      }
    };
    stream.on("data", (chunk) => consume(decoder.write(chunk)));
    stream.on("end", () => {
      consume(decoder.end());
      consume("\n");
    });
  }
  entry.closed = new Promise((done) => child.once("close", done));
  entry.error = null;
  child.on("error", (error) => {
    entry.error = error;
  });
  return child;
}
async function command(name, args) {
  const child = launch(name, args);
  const entry = children.at(-1);
  const code = await bounded(entry.closed, 60_000, name);
  assert.equal(entry.error, null, `${name} spawn failed`);
  assert.equal(code, 0, `${name} failed; see its private redacted log`);
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
const authSecret = randomBytes(32).toString("hex");
secrets.push(token, admin, password, authSecret);
const external = [];
const blockedOptionalFonts = [];
const errors = [];
let failRun;
const runFailure = new Promise((_, reject) => {
  failRun = reject;
});
// Mark it handled before fixture setup finishes; race still observes rejection.
void runFailure.catch(() => {});
const onSignal = () => failRun(new Error("Interrupted; no retry permitted"));
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
try {
  const source = await readFile(resolve(root, "scripts/browser-s1.mjs"));
  await writeFile(resolve(evidence, "executed-browser-s1.mjs"), source, {
    mode: 0o600,
    flag: "wx",
  });
  record("executed source frozen", {
    sha256: createHash("sha256").update(source).digest("hex"),
  });
  await Promise.all(
    [env.HOME, env.XDG_CONFIG_HOME, env.TILA_HOME].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  // Vite and Wrangler must not discover unplanned per-checkout credential files.
  for (const dir of [
    root,
    workerDir,
    resolve(root, "packages/ui"),
    resolve(root, "packages/ui/src"),
  ]) {
    const files = await readdir(dir);
    assert.deepEqual(
      files.filter(
        (name) =>
          /^(?:\.env(?:\.|$)|\.dev\.vars)/.test(name) &&
          !name.endsWith(".example"),
      ),
      [],
    );
  }
  const workerPort = await freePort();
  let uiPort = await freePort();
  while (uiPort === workerPort) uiPort = await freePort();
  ports.push(workerPort, uiPort);
  const api = `http://127.0.0.1:${workerPort}`;
  const ui = `http://127.0.0.1:${uiPort}`;
  const config = resolve(fixture, "wrangler.toml");
  let toml = await readFile(resolve(workerDir, "wrangler.toml"), "utf8");
  for (const needle of [
    'main = "src/index.ts"',
    'database_id = ""',
    '\nCORS_ALLOWED_ORIGINS = ""\n',
  ]) {
    assert.equal(
      toml.split(needle).length - 1,
      1,
      "fixture config replacement must be unique",
    );
  }
  assert.equal((toml.match(/^\[assets\]$/gm) || []).length, 1);
  assert.equal(
    /remote\s*=\s*true|account_id\s*=|HASH_PEPPER\s*=/.test(toml),
    false,
  );
  toml = toml
    .replace(
      'main = "src/index.ts"',
      `main = ${JSON.stringify(resolve(workerDir, "src/index.ts"))}`,
    )
    .replace('database_id = ""', 'database_id = "browser-local"')
    .replace(/\[assets\][\s\S]*?run_worker_first = [^\n]*\n/, "")
    .replace(
      '\nCORS_ALLOWED_ORIGINS = ""\n',
      `\nCORS_ALLOWED_ORIGINS = "${ui}"\nUI_ORIGIN = "${ui}"\nAUTH_SECRET = "${authSecret}"\nINFRA_ADMIN_TOKEN = "${admin}"\n`,
    );
  assert.equal(toml.includes("[assets]"), false);
  assert.equal(toml.includes('database_id = "browser-local"'), true);
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
  // Generate version.ts during preflight, before freezing source identity.
  assert.ok(
    (await readFile(resolve(workerDir, "src/version.ts"), "utf8")).includes(
      "DO_CODE_VERSION",
    ),
  );
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
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    assert.equal(
      response.ok,
      true,
      `fixture API ${path}: HTTP ${response.status}`,
    );
    assert.equal(data.ok, true, "fixture API success envelope");
    return data;
  }
  const schemaPath = `/projects/${project}/schema`;
  const current = () => request(schemaPath);
  const historyVersions = async () =>
    (await request(`${schemaPath}/history`)).entries.map(
      (entry) => entry.version,
    );
  const initial = await current();
  assert.equal(initial.ok, true);
  assert.equal(initial.schema, null);
  assert.equal(initial.version, null);
  assert.equal(initial.revision, 0);
  assert.deepEqual(await historyVersions(), []);
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
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(
    setupResponse.ok,
    true,
    `account setup: HTTP ${setupResponse.status}`,
  );
  const invitation = new URL((await setupResponse.json()).url);
  assert.equal(invitation.origin, ui);
  assert.equal(invitation.pathname, "/invite");
  assert.ok(invitation.hash.length > 20);
  secrets.push(invitation.hash.slice(1));
  browserServer = await chromium.launchServer({
    executablePath,
    env,
    timeout: 15_000,
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  browser = await chromium.connect(browserServer.wsEndpoint(), {
    timeout: 10_000,
  });
  record("single Chromium launched", {
    version: browser.version(),
    pid: browserServer.process().pid,
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    acceptDownloads: true,
  });
  let stopExternal;
  const externalFailure = new Promise((_, reject) => {
    stopExternal = reject;
  });
  await context.routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    if (
      url.hostname === "127.0.0.1" &&
      [String(uiPort), String(workerPort)].includes(url.port)
    )
      socket.connectToServer();
    else {
      external.push(`${url.protocol}//${url.hostname}`);
      stopExternal(new Error("Unknown external WebSocket blocked"));
      socket.close();
    }
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
    if (
      route.request().resourceType() === "stylesheet" &&
      url.href ===
        "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&display=swap"
    ) {
      blockedOptionalFonts.push(url.origin);
      return route.abort();
    }
    external.push(`${url.protocol}//${url.hostname}`);
    stopExternal(new Error(`External browser request blocked: ${url.origin}`));
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(redact(error.message)));
  let schemaPosts = 0;
  page.on("request", (request) => {
    if (request.url() === `${api}${schemaPath}` && request.method() === "POST")
      schemaPosts++;
  });
  const caseTimer = setTimeout(
    () => failRun(new Error("Browser case exceeded 120 seconds")),
    120_000,
  );
  const at = async (suffix = "") => {
    await page.waitForURL(`${base}${suffix}`);
    assert.equal(page.url(), `${base}${suffix}`);
  };
  try {
    scenario = (async () => {
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
      const identityResponse = await context.request.get(`${api}/api/whoami`, {
        timeout: 10_000,
      });
      assert.equal(identityResponse.ok(), true);
      const identity = await identityResponse.json();
      assert.equal(identity.ok, true);
      assert.equal(identity.auth_kind, "cookie-session");
      assert.equal(identity.project_id, project);
      assert.equal(identity.role, "owner");
      assert.equal(identity.explicit_role, "owner");
      assert.ok(identity.principal_id);
      assert.notEqual(identity.permission, "read");
      if (identity.policy)
        for (const cap of ["schema:preview", "schema:write"])
          assert.ok(identity.policy.capabilities.includes(cap));
      record(step, {
        role: identity.role,
        selected_project: project,
        principal_present: true,
      });
      step = "browser first definition without a file";
      await page.goto(base);
      await at();
      await page
        .getByRole("button", { name: "Start definitions", exact: true })
        .click();
      const task =
        'schema_version = 1\n\n[work_units.task]\nfields = [{ name = "title", type = "string", required = true }]\n';
      await at("/source");
      await page.getByLabel("Draft (TOML)", { exact: true }).fill(task);
      await page
        .getByRole("link", { name: "Review changes", exact: true })
        .click();
      await at("/review");
      await page
        .getByRole("button", { name: "Apply as revision 1", exact: true })
        .click();
      await page.getByText("Applied as revision 1.", { exact: true }).waitFor();
      const revision1 = await current();
      assert.equal(revision1.revision, 1);
      assert.deepEqual(parsed(revision1.schema.definition), parsed(task));
      await at();
      record(step);
      step = "browser structured definition evolution and history";
      await page
        .getByRole("button", { name: "Add work type", exact: true })
        .click();
      const drawer = page.getByRole("dialog", {
        name: "New work type",
        exact: true,
      });
      await drawer.waitFor();
      assert.equal(await drawer.count(), 1);
      assert.equal(await page.getByRole("dialog").count(), 1);
      const name = drawer.getByLabel(/^Name\b/);
      assert.equal(await name.count(), 1);
      assert.equal(await name.getAttribute("aria-required"), "true");
      assert.equal(
        await drawer.getByRole("textbox", { name: /^Name\b/ }).count(),
        1,
      );
      const nameFacts = await name.evaluate((input) => ({
        tag: input.tagName,
        type: input.type,
        id: input.id,
        labels: [...input.labels].map((label) => label.textContent),
      }));
      assert.equal(nameFacts.tag, "INPUT");
      assert.equal(nameFacts.type, "text");
      assert.ok(nameFacts.id);
      assert.equal(nameFacts.labels.length, 1);
      record("required declaration Name DOM contract", nameFacts);
      await name.fill("bug");
      await drawer
        .getByRole("button", { name: "Save to draft", exact: true })
        .click();
      await page
        .getByRole("link", { name: "Review & apply", exact: true })
        .click();
      await at("/review");
      await page
        .getByRole("button", { name: "Apply as revision 2", exact: true })
        .click();
      await page.getByText("Applied as revision 2.", { exact: true }).waitFor();
      const revision2 = await current();
      assert.equal(revision2.revision, 2);
      const expected2 = parsed(`${task}\n[work_units.bug]\nfields = []\n`);
      assert.deepEqual(parsed(revision2.schema.definition), expected2);
      assert.deepEqual(
        parsed(revision2.schema.definition).work_units.task,
        parsed(task).work_units.task,
      );
      assert.deepEqual(await historyVersions(), [2, 1]);
      await page.getByRole("link", { name: "Revision 1", exact: true }).click();
      await page
        .getByRole("heading", { name: "Revision 1", exact: true })
        .waitFor();
      await page.getByText("Revision 1 source (TOML)", { exact: true }).click();
      await at("/history/1");
      const historical = page.locator("details").filter({
        has: page.locator("summary", {
          hasText: /^Revision 1 source \(TOML\)$/,
        }),
      });
      assert.equal(await historical.count(), 1);
      assert.deepEqual(
        parsed(await historical.locator("pre").textContent()),
        parsed(task),
      );
      await page.goto(base);
      await at();
      record(step);
      step = "browser semantic TOML and YAML export/import";
      for (const format of ["TOML", "YAML"]) {
        const downloadEvent = page.waitForEvent("download");
        await page
          .getByRole("button", { name: `Download ${format}`, exact: true })
          .click();
        const download = await downloadEvent;
        const stream = await download.createReadStream();
        assert.ok(stream, "browser download must provide a stream");
        const chunks = [];
        let bytes = 0;
        for await (const chunk of stream) {
          bytes += chunk.length;
          assert.ok(bytes <= 1_000_000, "bounded definition download");
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks).toString("utf8");
        assert.equal(
          download.suggestedFilename(),
          `${project}-definitions-r2.${format.toLowerCase()}`,
        );
        const read = readDefinitionFile(content, {
          format: format.toLowerCase(),
        });
        assert.equal(read.ok, true);
        assert.equal(read.metadata.format, "tila-definitions");
        assert.equal(read.metadata.format_version, 1);
        assert.equal(read.metadata.project_id, project);
        assert.equal(read.metadata.revision, 2);
        assert.equal(read.metadata.exported_with, "dashboard");
        assert.ok(Number.isFinite(Date.parse(read.metadata.exported_at)));
        assert.deepEqual(findForbiddenDefinitionContent(read.doc), []);
        for (const secret of secrets)
          assert.equal(content.includes(secret), false);
        const postsBefore = schemaPosts;
        const historyBefore = await historyVersions();
        assert.deepEqual(
          parsed(serializeDefinitionDocument(read.doc)),
          parsed(revision2.schema.definition),
        );
        await page
          .getByRole("link", { name: "Import a file", exact: true })
          .click();
        await at("/import");
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
        const noOp = await current();
        assert.equal(noOp.revision, 2);
        assert.deepEqual(parsed(noOp.schema.definition), expected2);
        assert.deepEqual(await historyVersions(), historyBefore);
        assert.equal(
          schemaPosts,
          postsBefore,
          "no-op import must not issue a schema POST",
        );
        await page.goto(base);
        await at();
        record(`${format} browser download and semantic no-op import`);
      }
      step = "stale browser apply after competing API revision";
      await page
        .getByRole("link", { name: "Edit source", exact: true })
        .click();
      const mine = `${revision2.schema.definition}\n[records.browser_note]\n`;
      await at("/source");
      await page.getByLabel("Draft (TOML)", { exact: true }).fill(mine);
      await page
        .getByRole("link", { name: "Review changes", exact: true })
        .click();
      await at("/review");
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
      let heldResolve;
      let heldReject;
      const held = new Promise((done, reject) => {
        heldResolve = done;
        heldReject = reject;
      });
      void held.catch(() => {});
      const release = new Promise((done) => {
        releaseHeld = done;
      });
      let heldCount = 0;
      const holdStale = async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        try {
          assert.equal(++heldCount, 1, "exactly one held stale POST");
          const payload = route.request().postDataJSON();
          assert.equal(payload.expected_revision, 2);
          assert.equal(payload.definition, mine);
          assert.deepEqual(parsed(payload.definition), parsed(mine));
          record("frozen browser POST held before competitor", {
            expected_revision: payload.expected_revision,
            definition_sha256: createHash("sha256")
              .update(payload.definition)
              .digest("hex"),
          });
          heldResolve();
          await release;
          if (finished) return route.abort();
          await route.continue();
        } catch (error) {
          heldReject(error);
          failRun(error);
          await route.abort().catch(() => {});
        }
      };
      await page.route(`${api}${schemaPath}`, holdStale);
      const rejectedEvent = page.waitForResponse(
        (response) =>
          response.url() === `${api}${schemaPath}` &&
          response.request().method() === "POST",
      );
      void rejectedEvent.catch(() => {});
      await apply3.click();
      await bounded(held, 10_000, "hold browser POST");
      const theirs = `${revision2.schema.definition}\n[artifacts.api_plan]\nmime_types = ["text/markdown"]\nretention_days = 30\n`;
      await request(schemaPath, { definition: theirs, expected_revision: 2 });
      const competitor = await current();
      assert.equal(competitor.revision, 3);
      assert.deepEqual(parsed(competitor.schema.definition), parsed(theirs));
      record("competitor committed while browser POST held", { revision: 3 });
      releaseHeld();
      const rejected = await rejectedEvent;
      assert.equal(rejected.status(), 412);
      const rejection = await rejected.json();
      assert.equal(rejection.error.code, "schema-revision-conflict");
      assert.equal(rejection.error.revision, 3);
      assert.equal(rejected.request().postDataJSON().expected_revision, 2);
      assert.equal(heldCount, 1);
      await page.unroute(`${api}${schemaPath}`, holdStale);
      await page
        .getByRole("region", {
          name: "Revision 3 was applied after your draft started",
          exact: true,
        })
        .waitFor();
      const afterConflict = await current();
      assert.equal(afterConflict.revision, 3);
      assert.deepEqual(parsed(afterConflict.schema.definition), parsed(theirs));
      assert.deepEqual(await historyVersions(), [3, 2, 1]);
      record(step, {
        http_status: 412,
        persisted_revision: 3,
        history: [3, 2, 1],
      });
      step = "browser explicit rebase and apply preserves both changes";
      await page
        .getByRole("button", {
          name: "Move my draft onto revision 3",
          exact: true,
        })
        .click();
      const apply4 = page.getByRole("button", {
        name: "Apply as revision 4",
        exact: true,
      });
      await apply4.waitFor();
      assert.equal(await apply4.count(), 1);
      await apply4.click();
      await page.getByText("Applied as revision 4.", { exact: true }).waitFor();
      const final = await current();
      assert.equal(final.revision, 4);
      assert.deepEqual(
        parsed(final.schema.definition),
        parsed(`${theirs}\n[records.browser_note]\n`),
      );
      await at();
      await page
        .getByRole("heading", { name: "Definitions", exact: true })
        .waitFor();
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
    })();
    await Promise.race([externalFailure, runFailure, scenario]);
  } finally {
    clearTimeout(caseTimer);
  }
} catch (error) {
  // No traces, cookies, request bodies or invitation URLs are retained.
  const message = redact(error.message || error);
  observations.push({
    step,
    outcome: "failed",
    error: message,
    elapsed_ms: Date.now() - started,
  });
  console.error(`FAIL ${step}\n${message}`);
  process.exitCode = 1;
} finally {
  finished = true;
  releaseHeld?.();
  try {
    await bounded(browser?.close() ?? Promise.resolve(), 5000, "browser close");
  } catch {
    cleanup.errors.push("browser close failed or timed out");
  }
  if (browserServer) {
    try {
      await bounded(browserServer.close(), 3000, "browser server close");
    } catch {
      try {
        await bounded(browserServer.kill(), 3000, "browser server kill");
      } catch {
        cleanup.errors.push("browser server kill failed");
      }
    }
    const child = browserServer.process();
    cleanup.browser_pid = child.pid;
    if (child.exitCode === null && child.signalCode === null)
      cleanup.errors.push("browser process still live");
  }
  if (scenario) {
    try {
      await bounded(
        scenario.catch(() => {}),
        12_000,
        "scenario cancellation",
      );
    } catch {
      cleanup.errors.push("scenario did not stop");
    }
  }
  // Each group is checked even when its pnpm leader has already exited.
  for (const { child } of children) {
    if (child.pid && groupAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  const termDeadline = Date.now() + 4000;
  while (
    Date.now() < termDeadline &&
    children.some(({ child }) => child.pid && groupAlive(child.pid))
  )
    await delay(100);
  for (const { child } of children) {
    if (child.pid && groupAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  for (const entry of children) {
    try {
      await bounded(entry.closed, 3000, "child reap");
      await bounded(
        new Promise((done, reject) => {
          entry.log.once("error", reject);
          entry.log.end(done);
        }),
        2000,
        "log flush",
      );
    } catch {
      cleanup.errors.push("child reap or log flush failed");
    }
  }
  cleanup.live_groups = children
    .filter(({ child }) => child.pid && groupAlive(child.pid))
    .map(({ child }) => child.pid);
  cleanup.browser_stopped =
    !browserServer ||
    browserServer.process().exitCode !== null ||
    browserServer.process().signalCode !== null;
  cleanup.open_ports = [];
  for (const port of ports)
    if (await portOpen(port)) cleanup.open_ports.push(port);
  if (
    cleanup.live_groups.length ||
    cleanup.open_ports.length ||
    !cleanup.browser_stopped
  )
    cleanup.errors.push("fixture still live; retained for diagnosis");
  else {
    try {
      await rm(fixture, { recursive: true });
      await assert.rejects(lstat(fixture), { code: "ENOENT" });
      cleanup.fixture_removed = true;
    } catch {
      cleanup.errors.push("fresh fixture deletion failed");
    }
  }
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  if (cleanup.errors.length) process.exitCode = 1;
  await writeFile(
    resolve(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "partial local browser S1; no live/native/S2/S3 acceptance",
        observations,
        external,
        blocked_optional_fonts: blockedOptionalFonts,
        page_errors: errors,
        cleanup,
        duration_ms: Date.now() - started,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const name of await readdir(evidence))
    await chmod(resolve(evidence, name), 0o600);
}
