import type { CommandDef } from "citty";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../lib/run-cli";

vi.mock("../lib/managed-runtime", () => ({
  managedRuntime: async () => ({
    context: { run_role: "acting", agent_id: "worker" },
  }),
}));
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});
it("routes managed room, inbox and binding commands while preserving operator restrictions", async () => {
  vi.spyOn(process, "exit").mockImplementation((code) => {
    process.exitCode = Number(code);
    return undefined as never;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const [family, command, allowed] of [
    ["room", "publish", true],
    ["inbox", "fetch", true],
    ["inbox", "ack", true],
    ["agent", "bind", true],
    ["agent", "list", true],
    ["agent", "register", false],
    ["connector", "start", false],
    ["profile", "add", false],
    ["run", "exec", false],
  ] as const) {
    const handler = vi.fn();
    process.exitCode = 0;
    const root: CommandDef = {
      subCommands: {
        [family]: { subCommands: { [command]: { run: handler } } },
      },
    };
    await runCli(root, [family, command, "--json"], "0.4.0");
    expect(handler.mock.calls.length, `${family} ${command}`).toBe(
      allowed ? 1 : 0,
    );
    expect(process.exitCode, `${family} ${command}`).toBe(allowed ? 0 : 1);
  }
});
