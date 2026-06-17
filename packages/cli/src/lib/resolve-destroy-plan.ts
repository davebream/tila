import type { TilaInfraConfig, TilaProjectConfig } from "@tila/schemas";

/**
 * Pure decision: given the optional positional slug, the local project config
 * (if cwd has a .tila/), and the infra-global config (~/.tila/infra.toml),
 * decide HOW a destroy should be targeted. No I/O — the command shell performs
 * the prompts and network calls based on this plan.
 *
 *   - slug given        → infra mode: wipe by slug using infra-global config +
 *                          the INFRA_DESTROY_TOKEN (no local .tila/ required).
 *   - no slug + local   → local mode: today's per-project path.
 *   - no slug + neither → needs-picker: shell lists projects and asks.
 */
export type DestroyPlan =
  | { mode: "local"; config: TilaProjectConfig }
  | {
      mode: "infra";
      slug: string;
      workerUrl: string;
      accountId: string;
      databaseId: string;
    }
  | { mode: "needs-picker" }
  | { mode: "error"; message: string };

export function resolveDestroyPlan(input: {
  slugArg?: string;
  localConfig: TilaProjectConfig | null;
  infraConfig: TilaInfraConfig | null;
}): DestroyPlan {
  const { slugArg, localConfig, infraConfig } = input;

  // An explicit slug always targets infra mode — even if a local .tila/ exists,
  // the operator named a specific project to destroy by ID.
  if (slugArg) {
    if (!infraConfig) {
      return {
        mode: "error",
        message:
          "No ~/.tila/infra.toml found. Run `tila infra provision`, or run `tila project destroy` from inside the project directory.",
      };
    }
    if (!infraConfig.worker_url) {
      return {
        mode: "error",
        message:
          "infra.toml has no worker_url — cannot reach the Worker to wipe remote state. Re-run provisioning.",
      };
    }
    return {
      mode: "infra",
      slug: slugArg,
      workerUrl: infraConfig.worker_url,
      accountId: infraConfig.account_id,
      databaseId: infraConfig.d1_database_id,
    };
  }

  if (localConfig) {
    return { mode: "local", config: localConfig };
  }

  return { mode: "needs-picker" };
}

/**
 * Resolve the infra destroy token, preferring the environment over infra.toml
 * (mirrors how the per-project token is read env-first). Returns null when
 * neither source provides one — the caller fails closed, never silently skips.
 */
export function resolveInfraDestroyToken(
  infraConfig: TilaInfraConfig | null,
  envToken: string | undefined,
): string | null {
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }
  const fileToken = infraConfig?.infra_destroy_token;
  if (fileToken && fileToken.trim().length > 0) {
    return fileToken.trim();
  }
  return null;
}
