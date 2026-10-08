import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureLifecycle } from "./lifecycle-install";
const context = vi.hoisted(() => ({ root: "" }));
vi.mock("../config", () => ({
  findTilaDir: () => join(context.root, ".tila"),
  findConfig: () => ({
    project_id: "test",
    worker_url: "https://tila.example",
  }),
}));
vi.mock("./lifecycle-runtime", () => ({
  lifecycleNamespace: () => "test",
  cliInvocation: () => ["/test/tila"],
  shellQuote: (s: string) => `'${s}'`,
}));
beforeEach(() => {
  context.root = mkdtempSync(join(tmpdir(), "tila-install-"));
  mkdirSync(join(context.root, ".tila"));
  vi.stubEnv("TILA_HOME", join(context.root, "private-state"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(context.root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each(["codex", "claude-code"] as const)(
  "preserves other %s hooks and MCP entries across install/reinstall/remove",
  (client) => {
    const codex = client === "codex";
    const dir = join(context.root, codex ? ".codex" : ".claude");
    mkdirSync(dir);
    const hooksFile = join(dir, codex ? "hooks.json" : "settings.local.json");
    const unrelated = {
      hooks: [{ type: "command", command: "existing-hook" }],
    };
    writeFileSync(
      hooksFile,
      JSON.stringify({ hooks: { SessionStart: [unrelated] }, custom: true }),
    );
    const mcpFile = codex
      ? join(dir, "config.toml")
      : join(context.root, ".mcp.json");
    const old = {
      command: "custom-tila",
      args: ["--existing"],
      env: { KEEP: "yes" },
    };
    writeFileSync(
      mcpFile,
      codex
        ? '[mcp_servers.tila]\ncommand="custom-tila"\nargs=["--existing"]\n[mcp_servers.tila.env]\nKEEP="yes"\n'
        : JSON.stringify({ mcpServers: { tila: old } }),
    );
    const original = readFileSync(mcpFile, "utf8");
    configureLifecycle(client, "install", true);
    expect(readFileSync(mcpFile, "utf8")).toBe(original);
    expect(
      existsSync(
        join(
          context.root,
          "private-state",
          "client-lifecycle",
          "installations",
        ),
      ),
    ).toBe(false);
    configureLifecycle(client, "install");
    configureLifecycle(client, "install");
    const installed = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(installed.hooks.SessionStart).toHaveLength(2);
    installed.hooks.Stop.push(unrelated);
    writeFileSync(hooksFile, JSON.stringify(installed));
    configureLifecycle(client, "remove");
    expect(JSON.parse(readFileSync(hooksFile, "utf8"))).toEqual({
      custom: true,
      hooks: { SessionStart: [unrelated], Stop: [unrelated] },
    });
    const restored = codex
      ? parse(readFileSync(mcpFile, "utf8"))
      : JSON.parse(readFileSync(mcpFile, "utf8"));
    expect(restored[codex ? "mcp_servers" : "mcpServers"].tila).toEqual(old);
  },
);
it("refuses to overwrite an MCP entry edited after installation", () => {
  configureLifecycle("claude-code", "install");
  const file = join(context.root, ".mcp.json");
  const changed = JSON.stringify({
    mcpServers: { tila: { command: "new-user-command" } },
  });
  writeFileSync(file, changed);
  expect(() => configureLifecycle("claude-code", "remove")).toThrow(
    "changed after installation",
  );
  expect(readFileSync(file, "utf8")).toBe(changed);
});

it("repairs an interrupted installation without duplicating hook commands", () => {
  configureLifecycle("claude-code", "install");
  // Ownership and hooks reached disk, but the MCP write did not.
  writeFileSync(join(context.root, ".mcp.json"), "{}");
  configureLifecycle("claude-code", "install");
  const hooks = JSON.parse(
    readFileSync(join(context.root, ".claude/settings.local.json"), "utf8"),
  );
  expect(hooks.hooks.SessionStart).toHaveLength(1);
  configureLifecycle("claude-code", "remove");
  expect(
    JSON.parse(readFileSync(join(context.root, ".mcp.json"), "utf8")).mcpServers
      .tila,
  ).toBeUndefined();
});
