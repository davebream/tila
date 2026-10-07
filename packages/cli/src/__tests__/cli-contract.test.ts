import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const home = mkdtempSync(join(tmpdir(), "tila-contract-"));
const entry = join(root, "packages/cli/src/index.ts");
const env = {
  ...process.env,
  HOME: home,
  TILA_HOME: home,
  CI: "1",
  CODEX_THREAD_ID: "",
  TILA_LIFECYCLE_KEY: "",
  TILA_TOKEN: "",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
function invoke(args: string[], input = "") {
  return spawnSync("bun", [entry, ...args], {
    env,
    cwd: home,
    input,
    encoding: "utf8",
    timeout: 15000,
  });
}
afterAll(() => rmSync(home, { recursive: true, force: true }));
const families = [
  "task",
  "record",
  "artifact",
  "schema",
  "signal",
  "lifecycle",
  "auth",
  "instances",
  "token",
  "service-account",
  "repos",
  "admin",
  "project",
  "infra",
  "deploy",
  "reset",
  "config",
  "doctor",
  "init",
  "link",
  "disconnect",
  "mcp",
  "open",
  "index",
  "state",
  "presence",
  "journal",
  "switch",
  "shell",
  "summary",
  "gate",
  "template",
  "search",
];
describe("CLI invocation contract", () => {
  it.each(families)(
    "%s help works offline with JSON before the command",
    (family) => {
      const result = invoke(["--json", family, "--help"]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        result: { commands: expect.any(Array) },
      });
      expect(result.stdout).not.toContain("\u001b");
    },
  );
  it("introspection includes new review/lifecycle commands and preserves project schema", () => {
    const result = invoke(["schema"]);
    const schema = JSON.parse(result.stdout).result;
    expect(schema.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "artifact review", mutating: true }),
        expect.objectContaining({ name: "artifact reviews", mutating: false }),
        expect.objectContaining({
          name: "lifecycle hook",
          output_kind: "protocol",
        }),
        expect.objectContaining({ name: "schema apply", mutating: true }),
      ]),
    );
    expect(invoke(["schema", "--command", "signal group"]).status).toBe(0);
  });
  it("keeps aliases functional but hidden and suggests typos", () => {
    const help = invoke(["--help"]);
    expect(help.stdout).not.toMatch(/\b(entity|work-unit)\b/);
    expect(invoke(["entity", "list", "--help"]).status).toBe(0);
    const error = invoke(["--json", "taks"]);
    expect(error.status).toBe(1);
    expect(error.stdout).toBe("");
    expect(JSON.parse(error.stderr)).toMatchObject({
      ok: false,
      error: {
        kind: "unknown-command",
        message: expect.stringContaining("task"),
        retryable: false,
      },
    });
  });
  it("rejects invalid bounds and missing required arguments before backend access", () => {
    for (const args of [
      ["task", "list", "--limit", "-1"],
      ["signal", "ack"],
      ["task", "list", "--offset", "-1"],
      ["artifact", "reviews", "file", "--before-revision", "0"],
      ["task", "list", "--unknown-option"],
    ]) {
      const result = invoke(["--json", ...args]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).ok).toBe(false);
    }
  });
  it("never mistakes flag values or post-delimiter tokens for global flags", () => {
    const value = invoke(["--project=--json", "--version"]);
    expect(value.status).toBe(0);
    expect(value.stdout.trim()).not.toContain("{");
    const delimiter = invoke(["signal", "ack", "--", "--json"]);
    expect(delimiter.stdout).toBe("");
    expect(delimiter.stderr.trim()).not.toMatch(/^\{"ok"/);
  });
  it("preserves advisory hook JSON on malformed stdin", () => {
    const result = invoke(
      ["lifecycle", "hook", "--client", "codex"],
      "invalid",
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: expect.stringContaining("degraded"),
    });
  });
  it("rejects JSON raw downloads and noninteractive shells before contacting services", () => {
    expect(
      JSON.parse(invoke(["artifact", "get", "file", "--json"]).stderr).error
        .kind,
    ).toBe("invalid-argument");
    expect(
      JSON.parse(invoke(["shell", "--json", "--instance", "test"]).stderr).error
        .kind,
    ).toBe("input-required");
  });
  it.each(["bash", "zsh", "fish", "powershell"])(
    "generates offline %s completion",
    (shell) => {
      const result = invoke(["--json", "complete", shell]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("tila");
      expect(result.stdout).not.toContain("work-unit");
    },
  );
});
