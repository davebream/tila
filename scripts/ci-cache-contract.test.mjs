import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("Turbo hashes shared configuration, revision, toolchain and transitive package inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tila-cache-contract-"));
  const put = (name, content) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const env = {
    ...process.env,
    TILA_BUILD_REVISION: "revision-a",
    TILA_TOOLCHAIN: "fixture-toolchain",
  };
  const dry = (extra = [], overrides = {}) =>
    JSON.parse(
      execFileSync(
        resolve("node_modules/.bin/turbo"),
        ["run", "build", "typecheck", "test", "--dry=json", ...extra],
        {
          cwd: dir,
          env: { ...env, ...overrides },
          encoding: "utf8",
          maxBuffer: 20 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  const hashes = (result) =>
    Object.fromEntries(result.tasks.map((task) => [task.taskId, task.hash]));
  try {
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "turbo.json",
      "tsconfig.base.json",
    ])
      copyFileSync(file, join(dir, file));
    put("scripts/generate-version.mjs", "// generator fixture\n");
    for (const name of readdirSync("packages")) {
      const manifest = join("packages", name, "package.json");
      try {
        put(manifest, readFileSync(manifest));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      put(`packages/${name}/src/input.ts`, "export const value = 1;\n");
    }
    git("init", "-q", "-b", "main");
    commit();
    const before = hashes(dry());
    const revision = hashes(dry([], { TILA_BUILD_REVISION: "revision-b" }));
    assert.notEqual(
      before["@tila/backend-do#build"],
      revision["@tila/backend-do#build"],
    );
    assert.notEqual(
      before["@tila/worker#build"],
      revision["@tila/worker#build"],
    );
    assert.equal(before["tila-sdk#build"], revision["tila-sdk#build"]);
    const runtime = hashes(dry([], { TILA_TOOLCHAIN: "other-platform" }));
    assert.notEqual(before["tila-sdk#test"], runtime["tila-sdk#test"]);
    for (const [file, expected] of [
      ["packages/schemas/src/input.ts", ["tila-sdk#test", "@tila/worker#test"]],
      [
        "packages/ops-sqlite/src/input.ts",
        ["@tila/backend-do#test", "tila-sdk#test"],
      ],
      [
        "packages/worker/migrations/global/fixture.sql",
        ["@tila/integration-tests#test"],
      ],
      ["packages/sdk/src/input.ts", ["@tila/integration-tests#test"]],
      ["packages/ui/src/input.ts", ["@tila/ui#test"]],
      ["scripts/install.sh", ["tila-cli#test"]],
      ["tsconfig.base.json", ["tila-sdk#typecheck"]],
      ["pnpm-lock.yaml", ["tila-sdk#test"]],
    ]) {
      const base = git("rev-parse", "HEAD");
      const previous = hashes(dry());
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      const text = readFileSync(join(dir, file), {
        encoding: "utf8",
        flag: "a+",
      });
      // Keep JSON/YAML valid while changing a real input.
      put(
        file,
        file === "pnpm-lock.yaml"
          ? text
              .replaceAll("version: 5.9.3", "version: 5.9.4")
              .replaceAll("typescript@5.9.3", "typescript@5.9.4")
              .replaceAll("typescript@5.9.3:", "typescript@5.9.4:")
          : `${text}\n`,
      );
      const head = commit();
      const after = hashes(dry());
      const selected = new Set(
        dry(["--affected"], {
          TURBO_SCM_BASE: base,
          TURBO_SCM_HEAD: head,
        }).tasks.map((task) => task.taskId),
      );
      for (const task of expected) {
        assert.notEqual(
          previous[task],
          after[task],
          `${file} must invalidate ${task}`,
        );
        assert.ok(selected.has(task), `${file} must select ${task}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
