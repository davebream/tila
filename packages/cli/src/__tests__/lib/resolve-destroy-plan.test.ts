import type { TilaInfraConfig, TilaProjectConfig } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { resolveDestroyPlan } from "../../lib/resolve-destroy-plan";

const localConfig: TilaProjectConfig = {
  project_id: "local-proj",
  backend: "cloudflare",
  worker_url: "https://worker.example.com",
  schema_version: 1,
  tila_version: "0.2.7",
  created_at: "2026-01-01T00:00:00Z",
  cloudflare: { account_id: "acct-1" },
} as TilaProjectConfig;

const infraConfig: TilaInfraConfig = {
  account_id: "acct-infra",
  account_name: "Infra Account",
  d1_database_id: "db-infra",
  worker_url: "https://worker.example.com",
} as TilaInfraConfig;

describe("resolveDestroyPlan", () => {
  it("returns an infra plan from infra config when a slug is given", () => {
    const plan = resolveDestroyPlan({
      slugArg: "remote-proj",
      localConfig: null,
      infraConfig,
    });

    expect(plan).toEqual({
      mode: "infra",
      slug: "remote-proj",
      workerUrl: "https://worker.example.com",
      accountId: "acct-infra",
      databaseId: "db-infra",
    });
  });

  it("errors when a slug is given but no infra config exists", () => {
    const plan = resolveDestroyPlan({
      slugArg: "remote-proj",
      localConfig: null,
      infraConfig: null,
    });

    expect(plan.mode).toBe("error");
  });

  it("errors when a slug is given but infra config has no worker_url", () => {
    const plan = resolveDestroyPlan({
      slugArg: "remote-proj",
      localConfig: null,
      infraConfig: { ...infraConfig, worker_url: undefined },
    });

    expect(plan.mode).toBe("error");
  });

  it("returns a local plan when no slug is given but local config exists", () => {
    const plan = resolveDestroyPlan({
      slugArg: undefined,
      localConfig,
      infraConfig,
    });

    expect(plan).toEqual({ mode: "local", config: localConfig });
  });

  it("returns needs-picker when no slug and no local config", () => {
    const plan = resolveDestroyPlan({
      slugArg: undefined,
      localConfig: null,
      infraConfig,
    });

    expect(plan.mode).toBe("needs-picker");
  });

  it("prefers the explicit slug over local config (infra mode)", () => {
    const plan = resolveDestroyPlan({
      slugArg: "remote-proj",
      localConfig,
      infraConfig,
    });

    expect(plan.mode).toBe("infra");
    if (plan.mode === "infra") expect(plan.slug).toBe("remote-proj");
  });
});
