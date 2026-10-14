import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type DeployTarget,
  DeployTargetSchema,
  type PerSlugInfraMeta,
  PerSlugInfraMetaSchema,
} from "@tila/schemas";
import type { AuthStore } from "../auth-store";
import { canonicalizeWorkerUrl } from "../auth-store";
import { findConfig } from "../config";
import type { Cloudflare } from "./cloudflare-client";
import { getInfraSlug, loadInfraConfig } from "./infra-config";
import {
  type InstanceSelection,
  InstanceSelectionError,
  resolveInstanceSelection,
} from "./instance-selection";
import { R2_BUCKET_NAME } from "./resource-names";

type TargetErrorCode =
  | "DEPLOY_TARGET_REQUIRED"
  | "DEPLOY_TARGET_NOT_FOUND"
  | "DEPLOY_TARGET_AMBIGUOUS"
  | "DEPLOY_TARGET_MISMATCH"
  | "DEPLOY_TARGET_UNVERIFIED";

export class DeployTargetError extends Error {
  constructor(
    readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type MetadataStore = Pick<
  AuthStore,
  "listInfra" | "getInfraMeta" | "getInstance" | "getCurrentContext"
>;
interface Candidate {
  slug: string;
  meta: PerSlugInfraMeta;
  scriptName: string;
}

async function readCandidates(
  store: MetadataStore,
  home: string,
  explicit?: string,
): Promise<Candidate[]> {
  const candidates = new Map<string, Candidate>();
  const slugs = explicit !== undefined ? [explicit] : await store.listInfra();
  for (const slug of slugs.sort()) {
    const meta = await store.getInfraMeta(slug);
    if (meta)
      candidates.set(slug, { slug, meta, scriptName: meta.infra_slug ?? slug });
  }
  // An explicitly selected per-installation record needs no legacy file.
  if (explicit !== undefined && candidates.has(explicit))
    return [...candidates.values()];
  if (existsSync(join(home, "infra.toml"))) {
    const legacy = loadInfraConfig(home);
    const slug = getInfraSlug(legacy);
    if ((explicit === undefined || explicit === slug) && !candidates.has(slug))
      candidates.set(slug, {
        slug,
        meta: PerSlugInfraMetaSchema.parse(legacy),
        scriptName: slug,
      });
  }
  return [...candidates.values()];
}

/** All network calls here are Cloudflare control-plane reads. */
export async function resolveDeployTarget(opts: {
  cf: Cloudflare;
  store: MetadataStore;
  home: string;
  infra?: string;
  instance?: string;
  project?: string;
  /** Presence only: the token itself never enters deployment selection. */
  inlineToken?: boolean;
}): Promise<DeployTarget> {
  try {
    return await verifyTarget(opts);
  } catch (error) {
    if (error instanceof DeployTargetError) throw error;
    if (error instanceof InstanceSelectionError)
      throw new DeployTargetError("DEPLOY_TARGET_NOT_FOUND", error.message);
    // SDK/TOML errors can contain request bodies or secret-bearing source lines.
    throw new DeployTargetError(
      "DEPLOY_TARGET_UNVERIFIED",
      "Could not verify deployment metadata or Cloudflare resources. Check the selected configuration and Cloudflare token permissions, or narrow selection with --infra <slug>; no deployment was started.",
    );
  }
}

async function verifyTarget(
  opts: Parameters<typeof resolveDeployTarget>[0],
): Promise<DeployTarget> {
  if (opts.project !== undefined) {
    const config = findConfig();
    if (config?.worker_url && config.project_id !== opts.project)
      throw new DeployTargetError(
        "DEPLOY_TARGET_MISMATCH",
        `No project ${JSON.stringify(opts.project)} in this config (project_id is ${JSON.stringify(config.project_id)}). Use --instance to select an instance.`,
      );
  }
  // The credential resolver targets the repository URL for inline tokens.
  // --token outranks --instance; an explicit --instance outranks env tokens.
  // An explicit --infra selects infrastructure independently of ambient auth.
  let inlineWorkerUrl: string | undefined;
  if (
    opts.infra === undefined &&
    (opts.inlineToken ||
      (opts.instance === undefined &&
        (process.env.TILA_TOKEN ?? process.env.TILA_API_TOKEN)))
  ) {
    inlineWorkerUrl = findConfig()?.worker_url;
    if (!inlineWorkerUrl)
      throw new DeployTargetError(
        "DEPLOY_TARGET_UNVERIFIED",
        "An inline Tila token has no repository Worker URL. Select infrastructure explicitly with --infra <slug> or correct the instance context.",
      );
  }
  let selection: InstanceSelection | null = null;
  if (opts.infra === undefined || opts.instance !== undefined)
    selection = await resolveInstanceSelection(opts.store, opts.instance);
  if (!selection && opts.infra === undefined)
    throw new DeployTargetError(
      "DEPLOY_TARGET_REQUIRED",
      "No instance selected. Use tila deploy --infra <slug> or --instance <key>.",
    );
  const candidates = await readCandidates(opts.store, opts.home, opts.infra);
  if (!candidates.length)
    throw new DeployTargetError(
      "DEPLOY_TARGET_NOT_FOUND",
      "No saved infrastructure matches this selection. Check --infra <slug> and the metadata in TILA_HOME/infra/ or infra.toml.",
    );

  const identities = new Map<string, Promise<string | null>>();
  function scriptForUrl(
    raw: string,
    accountId: string,
  ): Promise<string | null> {
    const normalized = canonicalizeWorkerUrl(raw);
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.port ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new DeployTargetError(
        "DEPLOY_TARGET_UNVERIFIED",
        "Deployment requires a direct HTTPS Worker hostname without a path or custom port.",
      );
    const key = JSON.stringify([accountId, normalized]);
    let result = identities.get(key);
    if (!result) {
      result = (async () => {
        if (url.hostname.endsWith(".workers.dev")) {
          const { subdomain } = await opts.cf.workers.subdomains.get({
            account_id: accountId,
          });
          const suffix = `.${subdomain}.workers.dev`;
          if (!url.hostname.endsWith(suffix)) return null;
          const script = url.hostname.slice(0, -suffix.length);
          return /^[a-z0-9][a-z0-9_-]*$/.test(script) ? script : null;
        }
        const matches = [];
        for await (const domain of opts.cf.workers.domains.list({
          account_id: accountId,
          hostname: url.hostname,
        })) {
          if (domain.hostname.toLowerCase() === url.hostname)
            matches.push(domain);
        }
        if (matches.length !== 1) return null;
        // This deploy path targets the production script, never a service environment.
        if (matches[0].environment && matches[0].environment !== "production")
          return null;
        return matches[0].service;
      })();
      identities.set(key, result);
    }
    return result;
  }

  const matches: Candidate[] = [];
  for (const candidate of candidates) {
    if (
      !selection ||
      (await scriptForUrl(selection.workerUrl, candidate.meta.account_id)) ===
        candidate.scriptName
    )
      matches.push(candidate);
  }
  if (!matches.length)
    throw new DeployTargetError(
      "DEPLOY_TARGET_MISMATCH",
      "The selected instance does not match the saved infrastructure. To deploy another installation, explicitly use --infra <slug> or --instance <key>.",
    );
  if (matches.length !== 1)
    throw new DeployTargetError(
      "DEPLOY_TARGET_AMBIGUOUS",
      `Multiple saved installations match: ${matches.map((c) => c.slug).join(", ")}. Select one with --infra <slug> (and --instance <key> to assert its instance).`,
    );
  const candidate = matches[0];
  const { meta, scriptName } = candidate;
  for (const url of [
    meta.worker_url,
    selection?.registeredUrl,
    inlineWorkerUrl,
  ]) {
    if (url && (await scriptForUrl(url, meta.account_id)) !== scriptName)
      throw new DeployTargetError(
        "DEPLOY_TARGET_MISMATCH",
        "The infrastructure, registered instance or inline-token context identifies a different Worker. Correct the selected context, or explicitly choose infrastructure with --infra <slug>.",
      );
  }

  const settings = await opts.cf.workers.scripts.scriptAndVersionSettings.get(
    scriptName,
    { account_id: meta.account_id },
  );
  const databases = settings.bindings?.filter((b) => b.name === "DB") ?? [];
  const buckets =
    settings.bindings?.filter((b) => b.name === "ARTIFACTS") ?? [];
  const database = databases[0];
  const bucket = buckets[0];
  const r2BucketName = meta.r2_bucket_name ?? R2_BUCKET_NAME;
  if (
    databases.length !== 1 ||
    database?.type !== "d1" ||
    (database.database_id ?? database.id) !== meta.d1_database_id ||
    buckets.length !== 1 ||
    bucket?.type !== "r2_bucket" ||
    bucket.bucket_name !== r2BucketName ||
    bucket.jurisdiction
  )
    throw new DeployTargetError(
      "DEPLOY_TARGET_MISMATCH",
      `Worker ${scriptName} in account ${meta.account_id} does not have the configured DB (${meta.d1_database_id}) and ARTIFACTS (${r2BucketName}) bindings. Refusing to migrate or change resources.`,
    );

  const workerUrl = selection?.workerUrl ?? meta.worker_url;
  return DeployTargetSchema.parse({
    source: opts.infra !== undefined ? "infra-flag" : selection?.source,
    infraSlug: candidate.slug,
    instanceKey: selection?.instanceKey ?? null,
    workerUrl: workerUrl ? canonicalizeWorkerUrl(workerUrl) : null,
    accountId: meta.account_id,
    accountName: meta.account_name,
    scriptName,
    d1DatabaseId: meta.d1_database_id,
    r2BucketName,
  });
}
