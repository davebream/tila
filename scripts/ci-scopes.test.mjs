import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { selectScopes } from "./ci-scopes.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "tila-scopes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (path, content = "export const value = 1;\n") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.base.json",
  ])
    copyFileSync(file, join(cwd, file));
  for (const dir of readdirSync("packages")) {
    const manifest = join("packages", dir, "package.json");
    put(manifest, readFileSync(manifest));
    put(`packages/${dir}/src/input.ts`);
  }
  put("scripts/generate-version.mjs", "// fixture\n");
  git("init", "-q", "-b", "main");
  commit();
  const runTurbo = (env) =>
    spawnSync(
      resolve("node_modules/.bin/turbo"),
      ["run", "typecheck", "test", "--affected", "--dry=json"],
      { cwd, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
  const select = (base, head, overrides = {}) =>
    selectScopes({
      cwd,
      base,
      head,
      expectedHead: head,
      runTurbo,
      ...overrides,
    });
  return { cwd, put, git, commit, select };
}

test("scopes follow tila's real transitive package graph, including migrations", (t) => {
  const f = fixture(t);
  for (const [file, expected] of [
    [
      "packages/ui/src/input.ts",
      ["@tila/ui", "@tila/worker", "@tila/integration-tests", "@tila/bench"],
    ],
    [
      "packages/ops-sqlite/src/input.ts",
      [
        "@tila/backend-do",
        "@tila/backend-embedded",
        "@tila/backend-local",
        "tila-sdk",
        "tila-cli",
        "tila-mcp-server",
        "@tila/worker",
        "@tila/integration-tests",
      ],
    ],
    [
      "packages/worker/migrations/global/fixture.sql",
      ["@tila/worker", "@tila/integration-tests", "@tila/bench"],
    ],
    [
      "packages/schemas/src/input.ts",
      [
        "@tila/core",
        "@tila/ui",
        "tila-sdk",
        "tila-cli",
        "tila-mcp-server",
        "@tila/worker",
        "@tila/integration-tests",
      ],
    ],
  ]) {
    const base = f.git("rev-parse", "HEAD");
    f.put(file, "// changed\n");
    const result = f.select(base, f.commit());
    assert.equal(result.all_scopes, false, JSON.stringify(result));
    for (const name of expected)
      assert.ok(result.scopes.includes(name), `${file} must affect ${name}`);
    if (file.includes("/ui/"))
      assert.ok(
        !result.scopes.includes("tila-sdk"),
        "UI changes should not select an unrelated SDK package",
      );
  }
});

test("renames cover old and new packages, and deleted files keep their package scope", (t) => {
  const f = fixture(t);
  let base = f.git("rev-parse", "HEAD");
  renameSync(
    join(f.cwd, "packages/ui/src/input.ts"),
    join(f.cwd, "packages/sdk/src/moved.ts"),
  );
  let result = f.select(base, f.commit());
  assert.equal(result.all_scopes, false, JSON.stringify(result));
  for (const name of [
    "@tila/ui",
    "@tila/worker",
    "tila-sdk",
    "tila-mcp-server",
  ])
    assert.ok(result.scopes.includes(name), `rename must affect ${name}`);
  base = f.git("rev-parse", "HEAD");
  rmSync(join(f.cwd, "packages/sdk/src/moved.ts"));
  result = f.select(base, f.commit());
  assert.equal(result.all_scopes, false);
  assert.ok(result.scopes.includes("tila-sdk"));
});

test("shared files and unknown or changed package boundaries are barriers", (t) => {
  const f = fixture(t);
  for (const file of [
    "turbo.json",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    ".github/workflows/test.yml",
    "scripts/install.sh",
    "docs/example.md",
    "unknown.txt",
    "packages/new/src/input.ts",
    "packages/sdk/package.json",
  ]) {
    const base = f.git("rev-parse", "HEAD");
    const original = [
      "turbo.json",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
      "packages/sdk/package.json",
    ].includes(file)
      ? readFileSync(join(f.cwd, file), "utf8")
      : "";
    f.put(file, `${original}\n`);
    const result = f.select(base, f.commit());
    assert.equal(result.all_scopes, true, `${file} must be a barrier`);
  }
  const base = f.git("rev-parse", "HEAD");
  rmSync(join(f.cwd, "packages/ui"), { recursive: true });
  assert.equal(
    f.select(base, f.commit()).all_scopes,
    true,
    "deleted package must be a barrier",
  );
});

test("uncertain selection never becomes an empty or incomplete narrow scope", (t) => {
  const f = fixture(t);
  const base = f.git("rev-parse", "HEAD");
  f.put("packages/ui/src/input.ts", "// changed\n");
  const head = f.commit();
  for (const result of [
    { status: 1, stdout: "" },
    { status: 0, stdout: "not JSON" },
    { status: 0, stdout: JSON.stringify({ packages: [], tasks: [] }) },
    { status: 0, stdout: JSON.stringify({ packages: ["unknown"], tasks: [] }) },
    {
      status: 0,
      stdout: JSON.stringify({ packages: ["tila-sdk"], tasks: [] }),
    },
  ])
    assert.equal(
      f.select(base, head, { runTurbo: () => result }).all_scopes,
      true,
    );
  assert.equal(
    f.select(base, head, {
      runTurbo: () => {
        throw new Error("unavailable");
      },
    }).all_scopes,
    true,
  );
  assert.equal(f.select(undefined, head).all_scopes, true);
  assert.equal(f.select("a".repeat(40), head).all_scopes, true);
  assert.equal(f.select(base, head, { expectedHead: base }).all_scopes, true);
  assert.equal(f.select(head, head).all_scopes, true);
});
