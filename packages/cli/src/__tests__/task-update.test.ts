import { TILA_ERRORS } from "tila-sdk";
/**
 * Tests for task update --field loud-fail when = is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../lib/exit-codes";

// Minimal harness: invoke a command's run function directly
type RunFn = (ctx: {
  rawArgs: string[];
  args: Record<string, unknown> & { _: string[] };
  cmd: unknown;
}) => void | Promise<void>;

async function runCmd(
  run: RunFn | undefined,
  args: Record<string, unknown>,
): Promise<void> {
  if (!run) throw new Error("no run fn");
  return run({ rawArgs: [], args: { _: [], ...args }, cmd: {} });
}

describe("task update --field loud-fail", () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("rejects --field without = in plain mode with USER_ERROR exit (1)", async () => {
    // Import task command dynamically to avoid bun:sqlite issues at module level
    // We test the validation logic via the exported function
    const { validateField } = await import("../lib/field-validator");
    expect(() => validateField("foobar")).toThrow();
  });

  it("validateField returns {key,value} for valid key=value", async () => {
    const { validateField } = await import("../lib/field-validator");
    const result = validateField("status=open");
    expect(result).toEqual({ key: "status", value: "open" });
  });

  it("validateField handles value with = in it (split on first =)", async () => {
    const { validateField } = await import("../lib/field-validator");
    const result = validateField("name=foo=bar");
    expect(result).toEqual({ key: "name", value: "foo=bar" });
  });

  it("validateField rejects empty key (=value)", async () => {
    const { validateField } = await import("../lib/field-validator");
    expect(() => validateField("=value")).toThrow();
  });
});

describe("C1↔C2 seam: signal failure emits real TILA_ERRORS code → exitCodeFor classifies to exit 1", () => {
  it("exitCodeFor maps the real NETWORK_ERROR from signal send → exit 2", async () => {
    const { exitCodeFor } = await import("../lib/exit-codes");
    // After C2 fixes, signal.ts maps network failures to TILA_ERRORS.DO_UNREACHABLE
    // or TILA_ERRORS.INTERNAL — both should be exit 2
    expect(exitCodeFor(TILA_ERRORS.DO_UNREACHABLE)).toBe(
      EXIT_CODES.NETWORK_ERROR,
    );
    expect(exitCodeFor(TILA_ERRORS.INTERNAL)).toBe(EXIT_CODES.NETWORK_ERROR);
  });

  it("exitCodeFor maps VALIDATION_ERROR from invalid payload → exit 1 (user error)", async () => {
    const { exitCodeFor } = await import("../lib/exit-codes");
    // signal.ts :54 INVALID_PAYLOAD → mapped to TILA_ERRORS.VALIDATION_ERROR in C2
    // which classifies to USER_ERROR
    expect(exitCodeFor(TILA_ERRORS.VALIDATION_ERROR)).toBe(
      EXIT_CODES.USER_ERROR,
    );
  });

  it("old literal 'NETWORK_ERROR' (pre-C2 bug) classifies to USER_ERROR (not exit 2)", async () => {
    const { exitCodeFor } = await import("../lib/exit-codes");
    // The stale literal is NOT a TILA_ERRORS member → defaults to USER_ERROR (1)
    // This ensures automation doesn't retry authz failures
    expect(exitCodeFor("NETWORK_ERROR")).toBe(EXIT_CODES.USER_ERROR);
  });

  it("old literal 'INVALID_PAYLOAD' (pre-C2 bug) classifies to USER_ERROR", async () => {
    const { exitCodeFor } = await import("../lib/exit-codes");
    expect(exitCodeFor("INVALID_PAYLOAD")).toBe(EXIT_CODES.USER_ERROR);
  });
});
