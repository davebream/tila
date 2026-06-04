import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMonorepoLayout, tilaHome } from "../../lib/provisioning";

describe("tilaHome()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns TILA_HOME when set", () => {
    vi.stubEnv("TILA_HOME", "/custom/tila/home");
    expect(tilaHome()).toBe("/custom/tila/home");
  });

  it("falls back to join(homedir(), '.tila') when TILA_HOME is unset", () => {
    vi.stubEnv("TILA_HOME", undefined as unknown as string);
    expect(tilaHome()).toBe(join(homedir(), ".tila"));
  });

  it("treats empty string TILA_HOME as unset", () => {
    vi.stubEnv("TILA_HOME", "");
    expect(tilaHome()).toBe(join(homedir(), ".tila"));
  });
});

describe("isMonorepoLayout()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns false when TILA_WORKER_DIST env var is set (env override strategy)", () => {
    vi.stubEnv("TILA_WORKER_DIST", "/custom/path/to/worker/index.js");
    // env override is not monorepo layout
    expect(isMonorepoLayout()).toBe(false);
  });

  it("returns true when neither env var is set and sidecar does not exist (monorepo fallback)", () => {
    // In test environment: no TILA_WORKER_DIST, no sidecar next to process.execPath
    // The monorepo fallback fires, indicating dev/monorepo layout
    vi.stubEnv("TILA_WORKER_DIST", "");
    vi.stubEnv("TILA_UI_DIST", "");
    // When we are running tests, process.execPath is the test runner, not the tila binary,
    // so the sidecar path won't exist, falling back to monorepo strategy
    const result = isMonorepoLayout();
    // In monorepo (test environment), should return true
    expect(typeof result).toBe("boolean");
    // The test suite runs inside the monorepo, so this should be true
    expect(result).toBe(true);
  });

  it("returns false when TILA_UI_DIST env var is set (env override strategy)", () => {
    vi.stubEnv("TILA_UI_DIST", "/custom/path/to/ui/dist");
    expect(isMonorepoLayout()).toBe(false);
  });
});
