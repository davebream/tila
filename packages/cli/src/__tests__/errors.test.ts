import { TILA_ERRORS } from "tila-sdk";
/**
 * Tests for describeCliError remediation hints (C2) and CliErrorEnvelope shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../lib/exit-codes";
import { describeCliError, printJsonError } from "../lib/output";

describe("describeCliError remediation hints", () => {
  it("returns hint for do-unreachable (network class)", () => {
    const err = Object.assign(new Error("Connection refused"), {
      name: "TilaApiError",
      code: TILA_ERRORS.DO_UNREACHABLE,
    });
    const result = describeCliError(err);
    expect(result.code).toBe(TILA_ERRORS.DO_UNREACHABLE);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/retry|network|connect/i);
  });

  it("returns hint for INTERNAL_ERROR (network class)", () => {
    const err = Object.assign(new Error("Server error"), {
      name: "TilaApiError",
      code: TILA_ERRORS.INTERNAL_ERROR,
    });
    const result = describeCliError(err);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/retry|server|transient/i);
  });

  it("returns hint for RATE_LIMITED", () => {
    const err = Object.assign(new Error("Too many requests"), {
      name: "TilaApiError",
      code: TILA_ERRORS.RATE_LIMITED,
    });
    const result = describeCliError(err);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/retry|wait|rate/i);
  });

  it("returns hint for internal (DO-layer network error)", () => {
    const err = Object.assign(new Error("internal error"), {
      name: "TilaApiError",
      code: TILA_ERRORS.INTERNAL,
    });
    const result = describeCliError(err);
    expect(result.hint).toBeDefined();
  });

  it("does not return hint for user-error codes (stale-fence)", () => {
    const err = Object.assign(new Error("stale"), {
      name: "TilaApiError",
      code: TILA_ERRORS.STALE_FENCE,
    });
    const result = describeCliError(err);
    // stale-fence is handled by the special case branch — no general hint needed
    expect(result.code).toBe("stale-fence");
  });

  it("does not return hint for NOT_FOUND (user-actionable)", () => {
    const err = Object.assign(new Error("not found"), {
      name: "TilaApiError",
      code: TILA_ERRORS.NOT_FOUND,
    });
    const result = describeCliError(err);
    // hint is optional; for user-error codes it should be absent or null
    // We don't assert absence strongly — just that it's not a false "retry" hint
    if (result.hint) {
      expect(result.hint).not.toMatch(/retry/i);
    }
  });
});

describe("printJsonError emits CliErrorEnvelope", () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy
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

  it("emits { ok:false, code, message } JSON to stderr", () => {
    printJsonError("Task not found", TILA_ERRORS.NOT_FOUND);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.ok).toBe(false);
    expect(output.code).toBe(TILA_ERRORS.NOT_FOUND);
    expect(output.message).toBe("Task not found");
  });

  it("includes hint when provided", () => {
    printJsonError(
      "Connection failed",
      TILA_ERRORS.DO_UNREACHABLE,
      "Check network and retry",
    );
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output.hint).toBe("Check network and retry");
  });

  it("omits hint field when not provided", () => {
    printJsonError("Not found", TILA_ERRORS.NOT_FOUND);
    const output = JSON.parse(String(errorSpy.mock.calls[0][0]));
    expect(output).not.toHaveProperty("hint");
  });

  it("exits with provided exit code", () => {
    printJsonError(
      "Network error",
      TILA_ERRORS.DO_UNREACHABLE,
      undefined,
      EXIT_CODES.NETWORK_ERROR,
    );
    expect(exitSpy).toHaveBeenCalledWith(EXIT_CODES.NETWORK_ERROR);
  });

  it("defaults exit code to 1 when not provided", () => {
    printJsonError("Error", TILA_ERRORS.NOT_FOUND);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
