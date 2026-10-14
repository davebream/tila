import type { InstanceKey } from "@tila/schemas";
import type { AuthStore } from "../auth-store";
import { findConfig, loadConfigFile } from "../config";

export interface InstanceSelection {
  source: "flag" | "env" | "repo-pointer" | "current-context";
  instanceKey: string | null;
  workerUrl: string;
  registeredUrl?: string;
}

export class InstanceSelectionError extends Error {}

/** Select metadata for infrastructure operations; never acquire a Tila credential. */
export async function resolveInstanceSelection(
  store: Pick<AuthStore, "getInstance" | "getCurrentContext">,
  instance?: string,
): Promise<InstanceSelection | null> {
  async function fromKey(
    key: string,
    source: InstanceSelection["source"],
    presentedUrl?: string,
  ): Promise<InstanceSelection> {
    const record = await store.getInstance(key as InstanceKey);
    if (!record)
      throw new InstanceSelectionError(
        `Unknown instance ${JSON.stringify(key)}. Select a registered --instance <key> or saved --infra <slug>.`,
      );
    return {
      source,
      instanceKey: key,
      workerUrl: presentedUrl ?? record.worker_url,
      registeredUrl: record.worker_url,
    };
  }

  if (instance !== undefined) return fromKey(instance, "flag");
  if (process.env.TILA_INSTANCE !== undefined)
    return fromKey(process.env.TILA_INSTANCE, "env");

  const envConfig = process.env.TILA_CONFIG;
  const config =
    envConfig !== undefined ? loadConfigFile(envConfig) : findConfig();
  const source = envConfig !== undefined ? "env" : "repo-pointer";
  if (config) {
    if (config.backend === "local" || !config.worker_url)
      throw new InstanceSelectionError(
        "Selected project has no remote deployment. Use --infra <slug> or --instance <key>.",
      );
    if (config.instance?.instance_key !== undefined)
      return fromKey(config.instance.instance_key, source, config.worker_url);
    return { source, instanceKey: null, workerUrl: config.worker_url };
  }

  const key = await store.getCurrentContext();
  return key ? fromKey(key, "current-context") : null;
}
