import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const script = resolve(".agents/skills/tila-release/scripts/run-gate-bench.sh");

function fixture(t, failAt = 0) {
  const root = mkdtempSync(join(tmpdir(), "tila-gate-bench-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "packages/bench/results"), { recursive: true });
  writeFileSync(
    join(root, "fixture.json"),
    JSON.stringify({ failAt, calls: 0, urls: [] }),
  );
  writeFileSync(join(root, "project.json"), '{"result":{"token":"fixture"}}');
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[process.argv.indexOf("--dir") + 1];
const stateFile = path.join(root, "fixture.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
state.calls++;
state.urls.push(process.env.TILA_BASE_URL);
fs.writeFileSync(stateFile, JSON.stringify(state));
const name = process.argv[process.argv.indexOf("--scenario") + 1];
const op = name === "claims-uncontended" ? "acquire" : "update";
const result = { scenarios: [{ name, ops: { [op]: {
  timing: { metrics: { worker: { p95: 1 } } },
  latency_ms: { p50: 100, p95: 500 }
} } }] };
fs.writeFileSync(path.join(root, "packages/bench/results", "http-" + String(state.calls).padStart(3, "0") + ".json"), JSON.stringify(result));
console.log("[bench] " + name + ": 10 ops in 1s");
if (state.calls === state.failAt) process.exit(42);
`,
    { mode: 0o755 },
  );
  return {
    calls: () => JSON.parse(readFileSync(join(root, "fixture.json"))).calls,
    urls: () => JSON.parse(readFileSync(join(root, "fixture.json"))).urls,
    run: (mode) =>
      spawnSync(
        "bash",
        [
          script,
          mode,
          "https://a.invalid",
          "a",
          join(root, "project.json"),
          ...(mode === "ab"
            ? ["https://b.invalid", "b", join(root, "project.json")]
            : []),
          join(root, "out"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      ),
  };
}

for (const mode of ["full", "ab"]) {
  test(`${mode} benchmark gate preserves child failure and stops subsequent runs`, (t) => {
    const f = fixture(t, 1);
    const result = f.run(mode);
    assert.ifError(result.error);
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stdout, /EXIT 42/);
    assert.doesNotMatch(result.stdout, /AB EXIT 0/);
    assert.equal(f.calls(), 1);
  });
}

test("A/B report selects primary-operation percentiles rather than server timing", (t) => {
  const f = fixture(t);
  const result = f.run("ab");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls(), 8);
  assert.deepEqual(f.urls(), [
    "https://a.invalid",
    "https://b.invalid",
    "https://a.invalid",
    "https://b.invalid",
    "https://b.invalid",
    "https://a.invalid",
    "https://b.invalid",
    "https://a.invalid",
  ]);
  assert.equal(
    result.stdout.match(/^claims-uncontended\tacquire\t100\t500$/gm)?.length,
    4,
  );
  assert.equal(
    result.stdout.match(/^fenced-writes\tupdate\t100\t500$/gm)?.length,
    4,
  );
  assert.match(result.stdout, /AB EXIT 0/);
});
