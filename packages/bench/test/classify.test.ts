import { TilaApiError } from "tila-sdk";
import { describe, expect, it } from "vitest";
import { classifyError } from "../src/classify";

describe("classifyError", () => {
  it("maps 409 already-held to conflict", () => {
    const c = classifyError(
      new TilaApiError(409, "already-held", "held", false),
    );
    expect(c.cls).toBe("conflict");
    expect(c.status).toBe(409);
  });

  it("maps 409 stale-fence and renew-failed to stale_fence", () => {
    expect(
      classifyError(new TilaApiError(409, "stale-fence", "stale", false)).cls,
    ).toBe("stale_fence");
    expect(
      classifyError(new TilaApiError(409, "renew-failed", "lost", false)).cls,
    ).toBe("stale_fence");
  });

  it("maps 403 release-ownership-denied to stale_fence", () => {
    expect(
      classifyError(
        new TilaApiError(403, "release-ownership-denied", "not yours", false),
      ).cls,
    ).toBe("stale_fence");
  });

  it("falls back to message text when the SDK folded the code into UNKNOWN", () => {
    expect(
      classifyError(
        new TilaApiError(409, "UNKNOWN", "Resource already held by x", false),
      ).cls,
    ).toBe("conflict");
    expect(
      classifyError(new TilaApiError(409, "UNKNOWN", "stale fence", false)).cls,
    ).toBe("stale_fence");
  });

  it("recognises core fence errors from the embedded tier by class name", () => {
    class FenceError extends Error {
      constructor() {
        super("fence mismatch");
        this.name = "FenceError";
      }
    }
    expect(classifyError(new FenceError()).cls).toBe("stale_fence");
  });

  it("treats everything else as an error", () => {
    expect(
      classifyError(new TilaApiError(500, "internal", "boom", true)).cls,
    ).toBe("error");
    expect(
      classifyError(
        new TilaApiError(409, "no-active-recipients", "none", false),
      ).cls,
    ).toBe("error");
    expect(classifyError(new Error("Network error")).cls).toBe("error");
    expect(classifyError("string").cls).toBe("error");
  });
});
