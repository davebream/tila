import type { CommandDef, SubCommandsDef } from "citty";
import { RemoteRecordBackend, TilaClient } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tila record set` end to end over the REAL remote backend and client, with
 * only `fetch` stubbed. The command-level unit tests in `record.test.ts` mock
 * the backend, so they cannot show that a write-only credential's committed
 * write is reported as a success rather than as a response-validation failure.
 */

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => JSON.stringify({ text: "mine" })),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("yocto-spinner", () => ({
  default: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    error: vi.fn().mockReturnThis(),
  })),
}));

interface Call {
  method: string;
  path: string;
}
const calls: Call[] = [];
let respond: () => Response = () => new Response(null, { status: 500 });

vi.mock("../../context", () => {
  const fetchStub = async (input: unknown, init?: RequestInit) => {
    calls.push({
      method: String(init?.method),
      path: new URL(String(input)).pathname,
    });
    return respond();
  };
  const client = new TilaClient({
    baseUrl: "https://worker.example",
    token: "credential",
    participantId: "fixture",
    fetch: fetchStub as unknown as typeof globalThis.fetch,
  });
  return {
    requireClient: (ctx: { client: unknown }) => ctx.client,
    resolveContext: () => ({
      client,
      config: { project_id: "proj" },
      machine: "test-machine",
      record: new RemoteRecordBackend(client, "proj"),
      schema: {
        getCurrentSchema: async () => ({ version: null, definition: null }),
      },
    }),
  };
});

async function setSubCommand(): Promise<CommandDef> {
  const mod = await import("../../commands/record");
  const subs = mod.default.subCommands as SubCommandsDef;
  return (await subs.set) as CommandDef;
}

async function run(args: Record<string, unknown>): Promise<void> {
  const cmd = await setSubCommand();
  type RunFn = (ctx: {
    rawArgs: string[];
    args: Record<string, unknown> & { _: string[] };
    cmd: CommandDef;
  }) => void | Promise<void>;
  await (cmd.run as RunFn)({
    rawArgs: [],
    args: { _: [], type: "question", key: "q1", file: "v.json", ...args },
    cmd,
  });
}

const receipt = {
  ok: true,
  receipt: true,
  type: "question",
  key: "q1",
  fence: 4,
};
const stored = {
  type: "question",
  key: "q1",
  schema_version: 1,
  value: { text: "mine" },
  value_sha256: "b".repeat(64),
  revision: 3,
  archived: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  updated_by: "cli",
  tags: [],
};

describe("tila record set against the remote backend", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    calls.length = 0;
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

  it("reports a committed write-only create as a success, with one request", async () => {
    respond = () => Response.json(receipt, { status: 201 });

    await run({ json: false });

    expect(calls).toEqual([
      { method: "POST", path: "/projects/proj/records/question" },
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("Set record question/q1");
    expect(line).toContain("fence 4");
    expect(line).not.toMatch(/\brev\b|undefined|NaN|Unexpected/);
  });

  it("reports a committed write-only set --fence as a success, with one request", async () => {
    respond = () => Response.json({ ...receipt, fence: 9 });

    await run({ json: false, fence: "8" });

    expect(calls).toEqual([
      { method: "PUT", path: "/projects/proj/records/question/q1" },
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("Set record question/q1");
    expect(line).toContain("fence 9");
    expect(line).not.toMatch(/\brev\b|undefined|NaN|Unexpected/);
  });

  it("--json prints the receipt for a write-only credential", async () => {
    respond = () => Response.json(receipt, { status: 201 });

    await run({ json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.result).toEqual({
      receipt: true,
      type: "question",
      key: "q1",
      fence: 4,
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps the revision output for a credential that can read what it writes", async () => {
    respond = () =>
      Response.json(
        { ok: true, record: stored, fence: 4, revision: 3 },
        {
          status: 201,
        },
      );

    await run({ json: false });

    expect(logSpy.mock.calls).toEqual([
      ["Set record question/q1 (rev 3, fence 4)"],
    ]);
    expect(calls).toHaveLength(1);
  });

  it("--json keeps the full row for a credential that can read", async () => {
    respond = () =>
      Response.json(
        { ok: true, record: stored, fence: 4, revision: 3 },
        {
          status: 201,
        },
      );

    await run({ json: true });

    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.result).toEqual({ ...stored, fence: 4 });
  });

  it("an error response stays an error and prints no success line", async () => {
    respond = () =>
      Response.json(
        {
          ok: false,
          error: {
            code: "stale-fence",
            message: "Fence is stale",
            retryable: false,
          },
        },
        { status: 409 },
      );

    await expect(run({ json: false, fence: "1" })).rejects.toMatchObject({
      status: 409,
      code: "stale-fence",
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
