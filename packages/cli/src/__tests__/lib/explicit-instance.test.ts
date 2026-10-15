import type { InstanceKey, InstanceRecord } from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";
import {
  ExplicitInstanceTargetError,
  assertExplicitInstanceTarget,
} from "../../lib/explicit-instance";

const A_URL = "https://a.example.com";
const B_URL = "https://b.example.com";

const baseConfig = {
  project_id: "proj-a",
  worker_url: A_URL,
  schema_version: 1,
  tila_version: "0.1.0",
  created_at: "2026-01-01T00:00:00Z",
};

function record(
  key: string,
  workerUrl: string,
  trusted = true,
): InstanceRecord {
  return {
    instance_key: key as InstanceKey,
    instance_id_source: "server",
    worker_url: workerUrl,
    trust: { trusted, trusted_at: trusted ? 1 : null },
    created_at: 1,
  };
}

function registry(...records: InstanceRecord[]) {
  return {
    getInstance: vi.fn(
      async (key: InstanceKey) =>
        records.find((r) => r.instance_key === key) ?? null,
    ),
  };
}

async function refusal(promise: Promise<void>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExplicitInstanceTargetError);
  return error as ExplicitInstanceTargetError;
}

describe("assertExplicitInstanceTarget", () => {
  it("is a no-op without --instance and never reads the registry", async () => {
    const store = registry();
    await assertExplicitInstanceTarget(baseConfig, {}, store);
    await assertExplicitInstanceTarget(
      baseConfig,
      { project: "proj-a" },
      store,
    );
    expect(store.getInstance).not.toHaveBeenCalled();
  });

  it("accepts a trusted instance whose Worker is the project's worker_url", async () => {
    const store = registry(record("a-key", A_URL));
    await expect(
      assertExplicitInstanceTarget(baseConfig, { instance: "a-key" }, store),
    ).resolves.toBeUndefined();
  });

  it("compares Worker URLs canonically", async () => {
    const store = registry(record("a-key", "https://A.example.com/"));
    await expect(
      assertExplicitInstanceTarget(baseConfig, { instance: "a-key" }, store),
    ).resolves.toBeUndefined();
  });

  it("accepts a project pointer and --project that name this project", async () => {
    const store = registry(record("a-key", A_URL));
    await expect(
      assertExplicitInstanceTarget(
        { ...baseConfig, instance: { instance_key: "a-key" } },
        { instance: "a-key", project: "proj-a" },
        store,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses another registered instance than the directory's project", async () => {
    const store = registry(record("a-key", A_URL), record("b-key", B_URL));
    const error = await refusal(
      assertExplicitInstanceTarget(baseConfig, { instance: "b-key" }, store),
    );
    expect(error.code).toBe("invalid-argument");
    expect(error.message).toContain("different deployment");
    expect(error.message).toContain('"b-key"');
  });

  it("refuses an unknown instance, even when the directory's project is pinned to that key", async () => {
    const store = registry();
    const error = await refusal(
      assertExplicitInstanceTarget(
        { ...baseConfig, instance: { instance_key: "ghost" } },
        { instance: "ghost" },
        store,
      ),
    );
    expect(error.message).toContain("Unknown instance");
  });

  it("refuses a registered instance that is not trusted", async () => {
    const store = registry(record("a-key", A_URL, false));
    const error = await refusal(
      assertExplicitInstanceTarget(baseConfig, { instance: "a-key" }, store),
    );
    expect(error.message).toContain("not trusted");
  });

  it("refuses when the project pins a different instance key for the same Worker", async () => {
    const store = registry(record("a-key", A_URL), record("other", A_URL));
    const error = await refusal(
      assertExplicitInstanceTarget(
        { ...baseConfig, instance: { instance_key: "other" } },
        { instance: "a-key" },
        store,
      ),
    );
    expect(error.message).toContain("pinned to instance");
  });

  it("refuses --project that is not the directory's project", async () => {
    const store = registry(record("a-key", A_URL));
    const error = await refusal(
      assertExplicitInstanceTarget(
        baseConfig,
        { instance: "a-key", project: "proj-b" },
        store,
      ),
    );
    expect(error.message).toContain('--project "proj-b"');
  });

  it("refuses a local project without consulting the registry", async () => {
    const store = registry(record("a-key", A_URL));
    const error = await refusal(
      assertExplicitInstanceTarget(
        {
          ...baseConfig,
          backend: "local",
          worker_url: undefined,
          local: { db_path: "/x/db", artifacts_path: "/x/a" },
        },
        { instance: "a-key" },
        store,
      ),
    );
    expect(error.message).toContain("local project");
    expect(store.getInstance).not.toHaveBeenCalled();
  });

  it("refuses a project with no worker_url", async () => {
    const store = registry(record("a-key", A_URL));
    await refusal(
      assertExplicitInstanceTarget(
        { ...baseConfig, worker_url: undefined },
        { instance: "a-key" },
        store,
      ),
    );
    expect(store.getInstance).not.toHaveBeenCalled();
  });

  it("treats an empty --instance as explicit and refuses it", async () => {
    const store = registry(record("a-key", A_URL));
    await refusal(
      assertExplicitInstanceTarget(baseConfig, { instance: "" }, store),
    );
  });

  it("fails closed when the registry cannot be read", async () => {
    const store = {
      getInstance: vi.fn(async () => {
        throw new Error("registry unreadable");
      }),
    };
    await expect(
      assertExplicitInstanceTarget(baseConfig, { instance: "a-key" }, store),
    ).rejects.toThrow("registry unreadable");
  });
});
