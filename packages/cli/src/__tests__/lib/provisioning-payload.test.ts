import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmbeddedPayloadRoot = vi.fn<() => string | null>();
const mockStageEmbeddedPayload = vi.fn();
vi.mock("../../lib/deploy-payload", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/deploy-payload")>();
  return {
    ...actual,
    embeddedPayloadRoot: () => mockEmbeddedPayloadRoot(),
    stageEmbeddedPayload: (...args: unknown[]) =>
      mockStageEmbeddedPayload(...args),
  };
});

const { DeployPayloadError } = await import("../../lib/deploy-payload");
const {
  isMonorepoLayout,
  resolveMigrationsDir,
  resolveUiDistDir,
  resolveWorkerMainPath,
} = await import("../../lib/provisioning");

const STAGED = {
  root: "/cache/1.2.3-abc",
  version: "1.2.3",
  workerMain: "/cache/1.2.3-abc/worker/index.js",
  uiDist: "/cache/1.2.3-abc/ui/dist",
  migrationsDir: "/cache/1.2.3-abc/migrations/global",
};

beforeEach(() => {
  vi.stubEnv("TILA_WORKER_DIST", "");
  vi.stubEnv("TILA_UI_DIST", "");
  vi.stubEnv("TILA_MIGRATIONS_DIR", "");
  vi.stubEnv("TILA_HOME", "/home/test/.tila");
  mockEmbeddedPayloadRoot.mockReset();
  mockStageEmbeddedPayload.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deploy payload resolution in a compiled binary", () => {
  beforeEach(() => {
    mockEmbeddedPayloadRoot.mockReturnValue("/$bunfs/root/deploy-payload");
    mockStageEmbeddedPayload.mockReturnValue(STAGED);
  });

  it("resolves the Worker, UI and migrations from the staged payload", () => {
    expect(resolveWorkerMainPath()).toBe(STAGED.workerMain);
    expect(resolveUiDistDir()).toBe(STAGED.uiDist);
    expect(resolveMigrationsDir()).toBe(STAGED.migrationsDir);
    expect(mockStageEmbeddedPayload).toHaveBeenCalledWith(
      join("/home/test/.tila", "cache", "deploy-payload"),
      expect.any(String),
    );
  });

  it("is not a monorepo layout, so deploy never runs the UI build", () => {
    expect(isMonorepoLayout()).toBe(false);
  });

  it("fails closed instead of returning monorepo paths", () => {
    mockStageEmbeddedPayload.mockImplementation(() => {
      throw new DeployPayloadError("manifest.json is missing.");
    });

    for (const resolve of [
      resolveWorkerMainPath,
      resolveUiDistDir,
      resolveMigrationsDir,
    ]) {
      expect(resolve).toThrow(/no usable deploy payload/);
    }
  });

  it("lets env overrides win over the payload", () => {
    vi.stubEnv("TILA_WORKER_DIST", "/custom/worker.js");
    vi.stubEnv("TILA_UI_DIST", "/custom/ui");
    vi.stubEnv("TILA_MIGRATIONS_DIR", "/custom/migrations");

    expect(resolveWorkerMainPath()).toBe("/custom/worker.js");
    expect(resolveUiDistDir()).toBe("/custom/ui");
    expect(resolveMigrationsDir()).toBe("/custom/migrations");
    expect(mockStageEmbeddedPayload).not.toHaveBeenCalled();
  });
});

describe("deploy payload resolution from source", () => {
  beforeEach(() => {
    mockEmbeddedPayloadRoot.mockReturnValue(null);
    mockStageEmbeddedPayload.mockReturnValue(null);
  });

  it("uses the monorepo Worker, UI and migrations", () => {
    expect(resolveWorkerMainPath()).toMatch(
      /packages[\\/]worker[\\/]src[\\/]index\.ts$/,
    );
    expect(resolveUiDistDir()).toMatch(/packages[\\/]ui[\\/]dist$/);
    expect(resolveMigrationsDir()).toMatch(
      /packages[\\/]worker[\\/]migrations[\\/]global$/,
    );
    expect(isMonorepoLayout()).toBe(true);
  });
});
