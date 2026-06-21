import { TILA_ERRORS } from "tila-sdk";
/**
 * Tests for CliSuccessEnvelope, CliErrorEnvelope types and jsonArg export.
 *
 * Also verifies that failWithCliError uses exitCodeFor so network errors
 * exit with code 2 rather than always 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../lib/exit-codes";
import type { CliErrorEnvelope, CliSuccessEnvelope } from "../lib/output";
import { failWithCliError, jsonArg, printJsonSuccess } from "../lib/output";

describe("jsonArg", () => {
  it("has a json key with type boolean", () => {
    expect(jsonArg).toHaveProperty("json");
    expect(jsonArg.json.type).toBe("boolean");
  });
});

describe("CliSuccessEnvelope", () => {
  it("has ok:true and result field at runtime (type-level test via shape)", () => {
    const envelope: CliSuccessEnvelope<{ id: string }> = {
      ok: true,
      result: { id: "abc" },
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.result.id).toBe("abc");
  });
});

describe("CliErrorEnvelope", () => {
  it("has ok:false with code and message fields", () => {
    const envelope: CliErrorEnvelope = {
      ok: false,
      code: "not-found",
      message: "Task not found",
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("not-found");
    expect(envelope.message).toBe("Task not found");
  });

  it("optionally has a hint field", () => {
    const envelope: CliErrorEnvelope = {
      ok: false,
      code: "do-unreachable",
      message: "Cannot reach service",
      hint: "Check network and retry",
    };
    expect(envelope.hint).toBe("Check network and retry");
  });
});

describe("printJsonSuccess", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a CliSuccessEnvelope JSON object wrapping the result", () => {
    printJsonSuccess({ id: "abc", name: "Test" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(output.ok).toBe(true);
    expect(output.result).toEqual({ id: "abc", name: "Test" });
  });
});

describe("failWithCliError exit code routing", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vitest spy
  let exitSpy: any;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("exits with NETWORK_ERROR (2) for do-unreachable errors in json mode", () => {
    const err = Object.assign(new Error("unreachable"), {
      name: "TilaApiError",
      code: TILA_ERRORS.DO_UNREACHABLE,
    });
    failWithCliError(err, true);
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.NETWORK_ERROR);
  });

  it("exits with USER_ERROR (1) for stale-fence errors in json mode", () => {
    const err = Object.assign(new Error("stale"), {
      name: "TilaApiError",
      code: TILA_ERRORS.STALE_FENCE,
    });
    failWithCliError(err, true);
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.USER_ERROR);
  });

  it("exits with NETWORK_ERROR (2) for internal in non-json mode", () => {
    const err = Object.assign(new Error("internal"), {
      name: "TilaApiError",
      code: TILA_ERRORS.INTERNAL,
    });
    failWithCliError(err, false);
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.NETWORK_ERROR);
  });

  it("emits a CliErrorEnvelope in json mode", () => {
    const err = Object.assign(new Error("not-found"), {
      name: "TilaApiError",
      code: TILA_ERRORS.NOT_FOUND,
    });
    failWithCliError(err, true);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBeDefined();
    expect(output.message).toBeDefined();
  });
});
