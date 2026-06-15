/**
 * withErrorBoundary wraps every command's run handler so an uncaught backend
 * error (e.g. a stale-fence FenceError) is rendered as a clean one-line CLI
 * error instead of leaking a bundled stack trace through citty's top-level
 * handler. This is the global backstop covering all fence-bearing commands
 * (record set/put/patch, gate resolve, artifact write, ...).
 */
import { defineCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withErrorBoundary } from "../lib/error-boundary";

type RunFn = (ctx: {
  rawArgs: string[];
  args: Record<string, unknown> & { _: string[] };
  cmd: unknown;
}) => void | Promise<void>;

async function run(cmd: { run?: unknown }, args: Record<string, unknown>) {
  await (cmd.run as RunFn)({ rawArgs: [], args: { _: [], ...args }, cmd });
}

describe("withErrorBoundary", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy types
  let exitSpy: any;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("renders a thrown FenceError from a leaf command as a clean one-line error", async () => {
    const cmd = defineCommand({
      meta: { name: "x" },
      run() {
        throw Object.assign(new Error("Fence mismatch: current=3, claimed=0"), {
          name: "FenceError",
          currentFence: 3,
          claimedFence: 0,
        });
      },
    });

    const wrapped = withErrorBoundary(cmd);
    await expect(run(wrapped, { json: false })).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = String(errorSpy.mock.calls[0][0]);
    expect(msg).toMatch(/fence/i);
    expect(msg).not.toContain("\n");
    expect(msg).not.toMatch(/\s+at\s+\S+:\d+/);
  });

  it("wraps nested subcommands recursively (--json yields structured error)", async () => {
    const parent = defineCommand({
      meta: { name: "parent" },
      subCommands: {
        child: defineCommand({
          meta: { name: "child" },
          run() {
            throw Object.assign(new Error("boom"), {
              name: "TilaApiError",
              code: "stale-fence",
            });
          },
        }),
      },
    });

    const wrapped = withErrorBoundary(parent);
    const child = (wrapped.subCommands as Record<string, { run?: unknown }>)
      .child;
    await expect(run(child, { json: true })).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const payload = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(payload.code).toBe("stale-fence");
  });

  it("passes through a successful run untouched", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const cmd = defineCommand({
      meta: { name: "ok" },
      run() {
        console.log("did the thing");
      },
    });

    await run(withErrorBoundary(cmd), { json: false });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("did the thing");
    logSpy.mockRestore();
  });
});
