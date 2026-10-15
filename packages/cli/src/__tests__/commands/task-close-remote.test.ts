/**
 * `task close` against a remote-shaped backend.
 *
 * The remote `SchemaBackend` returns the applied definition as TOML text, or
 * (older Workers) as the JSON-encoded parsed document. These tests drive the
 * command with a mocked `CommandContext` so each shape, and every refusal, is
 * checked against exactly what `entity.update` receives.
 */

import type { CommandDef, SubCommandsDef } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDefaultSchemaToml } from "../../lib/provisioning";

vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockGetCurrentSchema = vi.fn();
const mockResolveContext = vi.fn();

vi.mock("../../context", () => ({
  requireClient: (ctx: { client: unknown }) => ctx.client,
  resolveContext: () => mockResolveContext(),
}));

async function closeCommand(): Promise<CommandDef> {
  const { default: task } = await import("../../commands/task");
  const subs = task.subCommands as SubCommandsDef;
  return (await subs.close) as CommandDef;
}

async function runClose(args: Record<string, unknown>): Promise<void> {
  const cmd = await closeCommand();
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => Promise<void>;
  await (cmd.run as unknown as RunFn)({
    rawArgs: [],
    args: { ...args, _: [] },
    cmd,
  });
}

const task = (type = "task") => ({
  id: "T-1",
  type,
  schema_version: 1,
  data: { title: "A task", status: "open" },
  archived: 0,
  created_at: 1,
  updated_at: 1,
  created_by: "cli",
  tags: [],
});

function schemaRecord(definition: string | null) {
  return { version: 3, revision: 3, definition, applied_at: 1700000000000 };
}

describe("tila task close (remote-shaped backend)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    for (const mock of [mockGet, mockUpdate, mockGetCurrentSchema]) {
      mock.mockReset();
    }
    mockGet.mockResolvedValue(task());
    mockUpdate.mockImplementation(async (id: string) => ({ ...task(), id }));
    mockResolveContext.mockReset();
    mockResolveContext.mockReturnValue({
      client: { get: vi.fn() },
      config: { project_id: "proj-test" },
      entity: { get: mockGet, update: mockUpdate },
      schema: { getCurrentSchema: mockGetCurrentSchema },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const lastError = () => JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0]));

  it("writes only the declared status state from a TOML definition", async () => {
    mockGetCurrentSchema.mockResolvedValue(
      schemaRecord(generateDefaultSchemaToml()),
    );
    await runClose({ id: "T-1", outcome: "completed", json: true });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith("T-1", { status: "done" });
    expect(JSON.parse(String(logSpy.mock.calls[0][0])).result).toMatchObject({
      id: "T-1",
      outcome: "completed",
      lifecycle_outcome: "success",
      field: "status",
      state: "done",
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("reads a JSON-encoded definition from an older Worker", async () => {
    mockGetCurrentSchema.mockResolvedValue(
      schemaRecord(
        JSON.stringify({
          schema_version: 1,
          work_units: {
            task: {
              fields: {
                title: { type: "string", required: true },
                status: {
                  type: "enum",
                  required: true,
                  values: ["open", "done", "cancelled"],
                },
              },
              parents: [],
              lifecycle: {
                field: "status",
                dispatchable: ["open"],
                terminal: ["done", "cancelled"],
                dependency_satisfied: ["done"],
                outcomes: { success: "done", cancelled: "cancelled" },
              },
            },
          },
        }),
      ),
    );
    await runClose({ id: "T-1", outcome: "cancelled", json: true });
    expect(mockUpdate).toHaveBeenCalledWith("T-1", { status: "cancelled" });
  });

  it("uses the entity's own type and lifecycle field", async () => {
    mockGet.mockResolvedValue(task("ticket"));
    mockGetCurrentSchema.mockResolvedValue(
      schemaRecord(`schema_version = 1

[work_units.ticket]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "phase", required = true, type = "enum", values = ["todo", "shipped", "dropped"] },
]
parents = []

[work_units.ticket.lifecycle]
field = "phase"
dispatchable = ["todo"]
terminal = ["shipped", "dropped"]
dependency_satisfied = ["shipped"]

[work_units.ticket.lifecycle.outcomes]
success = "shipped"
abandoned = "dropped"
`),
    );
    await runClose({ id: "T-1", outcome: "deferred", json: true });
    expect(mockUpdate).toHaveBeenCalledWith("T-1", { phase: "dropped" });
  });

  it.each([
    ["no schema applied", null, /No schema is applied/],
    ["an unparseable definition", "{{ not toml or json", /could not be read/],
    [
      "a definition that fails validation",
      `schema_version = 1
[work_units.task]
fields = [{ name = "title", required = true, type = "string" }]
parents = []
[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
`,
      /not valid/,
    ],
  ])("fails closed with %s", async (_name, definition, message) => {
    mockGetCurrentSchema.mockResolvedValue(schemaRecord(definition));
    await runClose({ id: "T-1", outcome: "completed", json: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = lastError();
    expect(envelope).toMatchObject({
      ok: false,
      error: { kind: "constraint-violation" },
    });
    expect(envelope.error.message).toMatch(message);
  });

  it("does not echo stored schema text when it cannot be read", async () => {
    mockGetCurrentSchema.mockResolvedValue(
      schemaRecord('password = "hunter2"\n[broken'),
    );
    await runClose({ id: "T-1", outcome: "completed", json: true });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("hunter2");
  });

  it("refuses a missing outcome mapping in text mode with one stderr line", async () => {
    mockGetCurrentSchema.mockResolvedValue(
      schemaRecord(
        `schema_version = 1
[work_units.task]
fields = [
  { name = "title", required = true, type = "string" },
  { name = "status", required = true, type = "enum", values = ["open", "done"] },
]
parents = []
[work_units.task.lifecycle]
field = "status"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
[work_units.task.lifecycle.outcomes]
success = "done"
`,
      ),
    );
    await runClose({ id: "T-1", outcome: "failure" });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe(
      'work_units.task.lifecycle.outcomes does not map outcome "failure" to a state',
    );
  });

  it("rejects an unknown task without reading the schema", async () => {
    mockGet.mockResolvedValue(null);
    await runClose({ id: "T-1", outcome: "completed", json: true });
    expect(mockGetCurrentSchema).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(lastError()).toMatchObject({
      ok: false,
      error: { kind: "not-found" },
    });
  });

  it("rejects an invalid outcome before resolving the backend", async () => {
    await runClose({ id: "T-1", outcome: "closed", json: true });
    expect(mockResolveContext).not.toHaveBeenCalled();
    expect(lastError()).toMatchObject({
      ok: false,
      error: { kind: "validation-error" },
    });
  });
});
