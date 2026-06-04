import { describe, expect, it } from "vitest";

// config.ts reads import.meta.env.VITE_API_URL at module load time.
// Vitest exposes import.meta.env from the test environment; VITE_API_URL is not
// set in the test environment by default, so API_BASE_URL should be "".

describe("API_BASE_URL config", () => {
  it("defaults to empty string when VITE_API_URL is not set", async () => {
    // Dynamic import ensures the module is fresh for each test run
    const { API_BASE_URL } = await import("@/lib/config");
    expect(API_BASE_URL).toBe("");
  });

  it("is a string (falsy empty string means same-origin fallback)", async () => {
    const { API_BASE_URL } = await import("@/lib/config");
    expect(typeof API_BASE_URL).toBe("string");
    // When empty, the fallback `API_BASE_URL || window.location.origin` will use origin
    expect(API_BASE_URL || "fallback").toBe("fallback");
  });
});
