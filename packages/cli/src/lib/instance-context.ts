/**
 * Instance-context resolution seam for the tila CLI (WI-L).
 *
 * Every CLI command that needs to identify a tila instance resolves through this
 * module. It is the single point where:
 * - The AuthStore is constructed (TilaPaths + FakeSecretStore or KeyringSecretStore)
 * - The global flags (--instance/--token/--project) are mapped to ResolveInput
 * - resolveWithTrace() is called
 * - current_context is mutated via the single-writer wrapper writeCurrentContext()
 *
 * SINGLE-WRITER INVARIANT: writeCurrentContext() is the ONLY export that calls
 * authStore.setCurrentContext(). No command file may import setCurrentContext
 * directly. This is enforced by a unit test in instance-context.test.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStore,
  KeyringSecretStore,
  TilaPaths,
  processEnvProbe,
  resolveWithTrace,
} from "@tila/auth-store";
import type {
  LegacyLocations,
  RepoPointer,
  ResolveInput,
  ResolveOutcome,
  ResolvedInstance,
  ResolverEnv,
} from "@tila/auth-store";
import type { InstanceKey } from "@tila/schemas";
import { findConfig, findTilaDir } from "../config";
import { getGlobalFlags } from "./global-flags";
import { tilaHome } from "./provisioning";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Safe metadata projection of a ResolvedInstance — exposes only display fields,
 * never the raw credential/token.
 *
 * Use this everywhere a resolved instance is shown in output (auth status, doctor
 * resolve-trace, etc.). Never pass ResolvedInstance.credential to any output path.
 */
export interface InstanceMetadata {
  instance_key: InstanceKey | null;
  worker_url: string;
  credentialSource: ResolvedInstance["credentialSource"];
  trust: ResolvedInstance["trust"];
}

// ---------------------------------------------------------------------------
// buildAuthStore
// ---------------------------------------------------------------------------

/**
 * Construct an AuthStore backed by the OS keychain.
 * Honors TILA_HOME for the paths.
 */
export function buildAuthStore(): AuthStore {
  const paths = new TilaPaths();
  const secrets = new KeyringSecretStore();
  return new AuthStore({ paths, secrets, env: processEnvProbe });
}

// ---------------------------------------------------------------------------
// loadRepoPointer
// ---------------------------------------------------------------------------

/**
 * Derive a RepoPointer from the walked-up .tila/config.toml.
 * Returns null when outside a tila repo or when the config has no worker_url.
 *
 * Maps:
 * - config.worker_url → RepoPointer.worker_url
 * - config.instance?.instance_key → RepoPointer.instance_key
 */
export function loadRepoPointer(cwd?: string): RepoPointer | null {
  const config = findConfig(cwd);
  if (!config || !config.worker_url) return null;
  return {
    worker_url: config.worker_url,
    instance_key: (config.instance?.instance_key as InstanceKey) ?? null,
  };
}

// ---------------------------------------------------------------------------
// deriveWorkerUrl
// ---------------------------------------------------------------------------

/**
 * Derive the worker_url for a --project flag.
 *
 * Because the config is single-project (one worker_url per config.toml), --project
 * is a SAFETY ASSERTION that the active config matches, not a multi-project selector.
 *
 * Rules:
 * - If project is absent → return repoConfig?.worker_url ?? null
 * - If project equals repoConfig.project_id → return repoConfig.worker_url
 * - If project is given but doesn't match → throw a friendly error
 * - If no repoConfig → return null
 */
function deriveWorkerUrl(
  project: string | undefined,
  repoPointer: RepoPointer | null,
  repoProjectId: string | undefined,
): string | null {
  if (project === undefined) return repoPointer?.worker_url ?? null;
  if (!repoPointer) return null;
  if (project === repoProjectId) return repoPointer.worker_url;
  throw new Error(
    `No project '${project}' in this config (project_id is '${repoProjectId ?? "unknown"}'). Did you mean to use --instance instead?`,
  );
}

// ---------------------------------------------------------------------------
// resolveInstanceContext
// ---------------------------------------------------------------------------

export interface ResolveInstanceContextOpts {
  /** Override the AuthStore (for testing — production uses buildAuthStore()). */
  authStore?: AuthStore;
  /** Override the repo pointer (for testing). */
  repoPointer?: RepoPointer | null;
  /** Override the resolver env (for testing). */
  env?: ResolverEnv;
  /** Override flag-derived ResolveInput.flags (for testing inline token paths). */
  flags?: ResolveInput["flags"];
  /**
   * Override the legacy locations (for testing the legacy-fallback rung).
   * Production auto-builds from findTilaDir() + tilaHome()/infra.toml.
   */
  legacy?: LegacyLocations;
}

/**
 * Assemble ResolveInput from global flags, repo config, and the AuthStore, then
 * call resolveWithTrace(). Never throws — returns the ResolveOutcome directly.
 *
 * Flag → ResolveFlags mapping:
 *   --instance → flags.instance
 *   --token    → flags.token
 *   --project  → derives flags.workerUrl via deriveWorkerUrl()
 */
export async function resolveInstanceContext(
  opts: ResolveInstanceContextOpts = {},
): Promise<ResolveOutcome> {
  const globalFlags = getGlobalFlags();
  const authStore = opts.authStore ?? buildAuthStore();

  // Derive repo pointer and project id for deriveWorkerUrl
  let repoPointer: RepoPointer | null;
  let repoProjectId: string | undefined;
  if ("repoPointer" in opts) {
    repoPointer = opts.repoPointer ?? null;
    repoProjectId = undefined;
  } else {
    const config = findConfig();
    repoPointer = config?.worker_url
      ? {
          worker_url: config.worker_url,
          instance_key: (config.instance?.instance_key as InstanceKey) ?? null,
        }
      : null;
    repoProjectId = config?.project_id;
  }

  // Map global flags to ResolveFlags
  const workerUrl =
    opts.flags?.workerUrl !== undefined
      ? opts.flags.workerUrl
      : deriveWorkerUrl(globalFlags.project, repoPointer, repoProjectId);

  const resolveFlags = opts.flags ?? {
    instance: globalFlags.instance ?? undefined,
    token: globalFlags.token ?? undefined,
    workerUrl: workerUrl ?? undefined,
  };

  // Resolver env: derive from process if not provided
  const env: ResolverEnv = opts.env ?? {
    isCI: Boolean(process.env.CI),
    isTTY: Boolean(process.stdout.isTTY),
    tilaHomeOverridden: Boolean(process.env.TILA_HOME),
  };

  // Build legacy locations for the lowest-priority legacy-fallback rung (WI-M).
  // opts.legacy overrides for test injection; production auto-discovers from cwd walk-up.
  const homeInfraPath = join(tilaHome(), "infra.toml");
  const builtLegacy: LegacyLocations = {
    projectTilaDir: findTilaDir(),
    homeInfraToml: existsSync(homeInfraPath) ? homeInfraPath : null,
  };
  const legacy = opts.legacy ?? builtLegacy;

  const input: ResolveInput = {
    flags: resolveFlags,
    envReader: (name: string) => process.env[name],
    env,
    authStore,
    repoPointer: repoPointer ?? undefined,
    legacy,
  };

  return resolveWithTrace(input);
}

// ---------------------------------------------------------------------------
// writeCurrentContext — SINGLE WRITER
// ---------------------------------------------------------------------------

/**
 * The ONLY authorized call-site for authStore.setCurrentContext().
 *
 * - Pass a key to switch to a different instance (tila switch).
 * - Pass null to clear a dangling pin (tila instances remove).
 *
 * No command file may call authStore.setCurrentContext() directly.
 */
export async function writeCurrentContext(
  authStore: AuthStore,
  key: InstanceKey | null,
): Promise<void> {
  await authStore.setCurrentContext(key);
}

// ---------------------------------------------------------------------------
// toInstanceMetadata — security projection
// ---------------------------------------------------------------------------

/**
 * Project a ResolvedInstance to display-safe metadata.
 *
 * NEVER includes the credential (token) — security requirement from the plan.
 * Always use this function before printing resolution data to stdout or JSON.
 */
export function toInstanceMetadata(
  resolved: ResolvedInstance,
): InstanceMetadata {
  return {
    instance_key: resolved.instance_key,
    worker_url: resolved.worker_url,
    credentialSource: resolved.credentialSource,
    trust: resolved.trust,
  };
}
