import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "/projects/dev-project";
const fences = {
  "task.auth-middleware": 17,
  "task.integration-tests": 29,
};

// Model curl's HTTP error handling as well as its request arguments. Without
// --fail/-f the stub returns an error body successfully, just like real curl.
const curlStub = String.raw`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const headers = [];
let url, method = "GET", data;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-H") headers.push(args[++i]);
  else if (args[i] === "-X") method = args[++i];
  else if (args[i] === "-d") data = args[++i];
  else if (args[i].startsWith("http")) url = args[i];
}
const body = data === undefined ? null : JSON.parse(data === "@-" ? fs.readFileSync(0, "utf8") : data);
const request = { path: new URL(url).pathname, method, headers, body };
fs.appendFileSync(process.env.TILA_SEED_REQUEST_LOG, JSON.stringify(request) + "\n");
const failure = JSON.parse(process.env.TILA_SEED_FAILURE);
if (failure && request.path === failure.path &&
    Object.entries(failure.body ?? {}).every(([key, value]) => body?.[key] === value)) {
  const fails = args.some(arg => arg === "--fail" || arg === "--fail-with-body" || /^-[^-]*f/.test(arg));
  if (fails) {
    process.stderr.write("curl: (22) The requested URL returned error: 500\n");
    process.exit(22);
  }
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "seed-test-error" } }));
} else if (body?.mode === "exclusive") {
  const invalid = process.env.TILA_SEED_INVALID_FENCE;
  process.stdout.write(invalid || JSON.stringify({ ok: true, fence: ${JSON.stringify(fences)}[body.resource] }));
} else {
  process.stdout.write(JSON.stringify({ ok: true }));
}
`;

async function runSeed({ failure = null, invalidFence = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tila-dev-seed-"));
  try {
    const log = join(root, "requests.jsonl");
    await writeFile(join(root, "curl"), curlStub, { mode: 0o755 });
    const result = spawnSync("bash", [join(repoRoot, "scripts/dev-seed.sh")], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        PARTICIPANT_ID: "",
        TILA_SEED_REQUEST_LOG: log,
        TILA_SEED_FAILURE: JSON.stringify(failure),
        TILA_SEED_INVALID_FENCE: invalidFence,
      },
    });
    assert.ifError(result.error);
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { ...result, requests };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("dev seed writes the complete dataset with request identity and acquired fences", async () => {
  const result = await runSeed();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /=== Seed complete ===/);
  assert.match(result.stdout, /11 tasks \(1 epic, 2 milestones, 8 tasks\)/);
  assert.equal(result.requests.length, 41);
  const at = (path) => result.requests.filter((r) => r.path === prefix + path);
  assert.equal(at("/schema").length, 1);
  const definition = at("/schema")[0].body.definition;
  assert.equal(
    definition,
    (
      await readFile(join(repoRoot, "packages/cli/tila.schema.toml"), "utf8")
    ).trimEnd(),
  );
  assert.match(definition.split("[project]")[0], /^schema_version = 1$/m);
  const parsed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { readFileSync } from "node:fs";
       import { parseSchemaToml } from "./packages/core/src/schema-parser.ts";
       const result = parseSchemaToml(readFileSync(0, "utf8"));
       console.log(JSON.stringify(result));
       if (!result.ok) process.exitCode = 1;`,
    ],
    { cwd: repoRoot, input: definition, encoding: "utf8", timeout: 30_000 },
  );
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  const schema = JSON.parse(parsed.stdout).schema;
  for (const request of at("/tasks")) {
    assert.ok(
      request.body.type in schema.work_units,
      `schema must declare ${request.body.type}`,
    );
  }
  assert.equal(at("/tasks").length, 11);
  assert.equal(at("/tasks/relationships").length, 16);
  assert.equal(at("/records/deploy_config").length, 1);
  assert.equal(at("/records/db_schema").length, 2);
  assert.equal(at("/claims").length, 0);
  assert.equal(
    at("/claims/acquire").filter((r) => r.body.mode === "exclusive").length,
    2,
  );
  const presence = at("/claims/acquire").filter(
    (r) => r.body.mode === "presence",
  );
  assert.equal(presence.length, 3);
  assert.equal(new Set(presence.map((r) => r.body.resource)).size, 3);

  for (const request of result.requests) {
    assert.equal(request.method, "POST");
    assert.ok(
      request.headers.includes(
        "Authorization: Bearer tila_dev_token_localonly",
      ),
    );
    assert.deepEqual(
      request.headers.filter((header) =>
        header.startsWith("X-Tila-Participant-Id:"),
      ),
      [
        `X-Tila-Participant-Id: ${request.body.mode === "presence" ? request.body.resource : "dev-seed"}`,
      ],
    );
  }

  const artifacts = at("/artifacts/text");
  assert.equal(artifacts.length, 5);
  assert.deepEqual(
    artifacts.map((r) => r.body.resource),
    [
      "task.auth-middleware",
      "task.auth-middleware",
      "task.integration-tests",
      "task.integration-tests",
      undefined,
    ],
  );
  for (const { body } of artifacts) {
    assert.equal(body.fence, fences[body.resource]);
    assert.ok(body.content.length > 0);
  }
  for (const [index, file] of [
    [1, "auth-middleware-design.md"],
    [2, "project-status-report.md"],
  ]) {
    assert.equal(
      artifacts[index].body.content,
      await readFile(join(repoRoot, "scripts/seed-data", file), "utf8"),
    );
  }
});

// The seed must not reproduce #398: with no lifecycle, only status "closed"
// is finished, so seeded `done` tasks were counted as waiting on prerequisites.
// The seeded tasks and edges go through the real shared readiness rules.
const READINESS = String.raw`
import { readFileSync } from "node:fs";
import { parseSchemaToml } from "./packages/core/src/schema-parser.ts";
import {
  blockedTaskIds,
  evaluateReadiness,
} from "./packages/ops-sqlite/src/ready-ops.ts";

const { definition, tasks, relationships } = JSON.parse(readFileSync(0, "utf8"));
const parsed = parseSchemaToml(definition);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));

const snapshotFor = (schema) => {
  const predecessors = new Map();
  for (const edge of relationships) {
    if (edge.type !== "blocks" && edge.type !== "soft-blocks") continue;
    predecessors.set(edge.to_id, [...(predecessors.get(edge.to_id) ?? []), edge.from_id]);
  }
  return {
    definition: schema,
    entities: new Map(
      tasks.map((t) => [t.id, { id: t.id, type: t.type, data: t.data, archived: 0, tags: [] }]),
    ),
    predecessors,
    gates: new Map(),
  };
};
const report = (schema) => {
  const snapshot = snapshotFor(schema);
  return {
    blocked: [...blockedTaskIds(snapshot)].sort(),
    // Containers (epic, milestone) stay legacy by design; judge the tasks.
    ready: tasks
      .filter((t) => t.type === "task")
      .filter((t) => evaluateReadiness(snapshot, t.id).ready)
      .map((t) => t.id)
      .sort(),
  };
};

// The same seed with the task lifecycle removed is the legacy fallback.
const { lifecycle, ...task } = parsed.schema.work_units.task;
const legacy = {
  ...parsed.schema,
  work_units: { ...parsed.schema.work_units, task },
};
console.log(JSON.stringify({
  declared: parsed.schema.work_units.task.lifecycle ?? null,
  seeded: report(parsed.schema),
  legacy: report(legacy),
}));
`;

test("dev seed declares the task lifecycle, so finished tasks do not count as blocked", async () => {
  const result = await runSeed();
  assert.equal(result.status, 0, result.stderr);
  const at = (path) => result.requests.filter((r) => r.path === prefix + path);
  const done = at("/tasks")
    .filter((r) => r.body.data.status === "done")
    .map((r) => r.body.id)
    .sort();
  assert.deepEqual(done, [
    "task.api-routes",
    "task.ci-pipeline",
    "task.db-migrations",
  ]);

  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", READINESS],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      input: JSON.stringify({
        definition: at("/schema")[0].body.definition,
        tasks: at("/tasks").map((r) => r.body),
        relationships: at("/tasks/relationships").map((r) => r.body),
      }),
    },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const { declared, seeded, legacy } = JSON.parse(run.stdout);

  // The seed maps `done` as the finished and successful state. Nothing else is
  // declared: no cancelled/failed meaning is guessed for this fixture.
  assert.deepEqual(declared, {
    field: "status",
    dispatchable: ["queued"],
    terminal: ["done"],
    dependency_satisfied: ["done"],
    on_start: "in-progress",
    outcomes: { success: "done" },
  });

  // Only integration-tests really waits: auth-middleware is still in progress.
  assert.deepEqual(seeded.blocked, ["task.integration-tests"]);
  for (const id of done) assert.ok(!seeded.blocked.includes(id), id);
  assert.deepEqual(seeded.ready, [
    "task.docs-api",
    "task.error-handling",
    "task.rate-limiting",
  ]);

  // Without the lifecycle the seeded `done` tasks are reported as waiting.
  assert.ok(legacy.blocked.includes("task.api-routes"));
  assert.ok(legacy.blocked.includes("task.ci-pipeline"));
});

for (const [stage, path, body] of [
  ["schema", "/schema"],
  ["task", "/tasks"],
  ["relationship", "/tasks/relationships"],
  ["record", "/records/deploy_config"],
  ["claim", "/claims/acquire", { mode: "exclusive" }],
  ["presence", "/claims/acquire", { mode: "presence" }],
  ["inline artifact", "/artifacts/text", { kind: "source" }],
  ["file artifact", "/artifacts/text", { kind: "document" }],
]) {
  test(`dev seed stops immediately on a failed ${stage} write`, async () => {
    const result = await runSeed({ failure: { path: prefix + path, body } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /curl: \(22\)/);
    assert.doesNotMatch(result.stdout, /=== Seed complete ===/);
    const failed = result.requests.findIndex(
      (r) =>
        r.path === prefix + path &&
        Object.entries(body ?? {}).every(
          ([key, value]) => r.body[key] === value,
        ),
    );
    assert.ok(failed >= 0);
    assert.equal(
      result.requests.length,
      failed + 1,
      "no writes follow the failed request",
    );
  });
}

for (const invalidFence of [
  "not json",
  JSON.stringify({ ok: true }),
  ...[null, 0, -1, 1.5, "17", true].map((fence) =>
    JSON.stringify({ ok: true, fence }),
  ),
]) {
  test(`dev seed rejects invalid exclusive-claim response: ${invalidFence}`, async () => {
    const result = await runSeed({ invalidFence });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /=== Seed complete ===/);
    assert.equal(result.requests.at(-1).path, `${prefix}/claims/acquire`);
    assert.equal(
      result.requests.filter((r) => r.path === `${prefix}/claims/acquire`)
        .length,
      1,
    );
    assert.equal(
      result.requests.filter((r) => r.path === `${prefix}/artifacts/text`)
        .length,
      0,
    );
  });
}
