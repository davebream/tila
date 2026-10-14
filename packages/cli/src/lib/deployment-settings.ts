import {
  type DeploymentSettings,
  DeploymentSettingsSchema,
} from "@tila/schemas";
import Cloudflare from "cloudflare";
import { z } from "zod";
import { canonicalizeWorkerUrl } from "../auth-store";

export class DeploymentSettingsError extends Error {
  readonly code = "DEPLOY_SETTINGS_UNVERIFIED";
}

const INSPECTION_ERROR =
  "Could not verify Worker exposure and analytics settings. Check Cloudflare Workers Scripts read access and the selected account and Worker; no deployment was started.";

/** Only a script-specific not-found response permits fresh provisioning. */
export async function readWorkerSettings(
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
  allowMissing = false,
) {
  try {
    const settings = await cf.workers.scripts.scriptAndVersionSettings.get(
      scriptName,
      {
        account_id: accountId,
      },
    );
    if (!settings || !Array.isArray(settings.bindings))
      throw new Error("Missing Worker settings");
    return settings;
  } catch (error) {
    if (
      allowMissing &&
      error instanceof Cloudflare.NotFoundError &&
      error.errors?.some((entry) => entry.code === 10007)
    )
      return null;
    throw new DeploymentSettingsError(INSPECTION_ERROR);
  }
}

type WorkerSettings = NonNullable<
  Awaited<ReturnType<typeof readWorkerSettings>>
>;

/** Never returns defaults for an existing Worker or copies secret-bearing settings. */
export async function resolveDeploymentSettings(opts: {
  cf: Cloudflare;
  accountId: string;
  scriptName: string;
  worker: WorkerSettings | null;
  preferredUrl?: string | null;
}): Promise<{ settings: DeploymentSettings; workerUrl: string }> {
  try {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(opts.scriptName))
      throw new Error("Invalid Worker name");
    let settings: DeploymentSettings;
    if (opts.worker === null) {
      settings = {
        workersDev: true,
        analyticsEngineDatasets: [
          { binding: "ANALYTICS", dataset: "tila-analytics" },
        ],
      };
    } else {
      const exposure = z
        .object({ enabled: z.boolean(), previews_enabled: z.boolean() })
        .parse(
          await opts.cf.workers.scripts.subdomain.get(opts.scriptName, {
            account_id: opts.accountId,
          }),
        );
      const bindings = opts.worker.bindings;
      if (
        !Array.isArray(bindings) ||
        bindings.filter((b) => b.name === "ANALYTICS").length !== 1 ||
        bindings.find((b) => b.name === "ANALYTICS")?.type !==
          "analytics_engine"
      ) {
        throw new DeploymentSettingsError(
          "Worker must have exactly one valid ANALYTICS binding. Review its Cloudflare bindings before retrying; no deployment was started.",
        );
      }
      settings = DeploymentSettingsSchema.parse({
        workersDev: exposure.enabled,
        previewUrls: exposure.previews_enabled,
        analyticsEngineDatasets: bindings
          .filter((b) => b.type === "analytics_engine")
          .map((b) => ({ binding: b.name, dataset: b.dataset })),
      });
    }

    const preferred = opts.preferredUrl
      ? canonicalizeWorkerUrl(opts.preferredUrl)
      : null;
    // Prefer an asserted custom domain over workers.dev. Domain lookup is also
    // necessary when workers.dev is disabled, even if the saved URL is stale.
    if (
      opts.worker !== null &&
      (!settings.workersDev ||
        (preferred && !new URL(preferred).hostname.endsWith(".workers.dev")))
    ) {
      const urls = new Set<string>();
      for await (const domain of opts.cf.workers.domains.list({
        account_id: opts.accountId,
      })) {
        if (
          domain.service === opts.scriptName &&
          (!domain.environment || domain.environment === "production")
        ) {
          const hostname = z.string().min(1).parse(domain.hostname);
          const url = new URL(`https://${hostname}`);
          if (
            url.hostname !== hostname.toLowerCase() ||
            url.pathname !== "/" ||
            url.port ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error("Invalid domain");
          urls.add(canonicalizeWorkerUrl(url.href));
        }
      }
      if (preferred && urls.has(preferred))
        return { settings, workerUrl: preferred };
      if (!settings.workersDev) {
        if (urls.size === 1) return { settings, workerUrl: [...urls][0] };
        throw new DeploymentSettingsError(
          "Worker has no unambiguous supported public endpoint. Select an instance with a verified production custom-domain URL, or review its Cloudflare routing; no deployment was started.",
        );
      }
    }

    const { subdomain } = await opts.cf.workers.subdomains.get({
      account_id: opts.accountId,
    });
    if (
      typeof subdomain !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain)
    )
      throw new Error("Invalid account subdomain");
    return {
      settings,
      workerUrl: `https://${opts.scriptName}.${subdomain}.workers.dev`,
    };
  } catch (error) {
    if (error instanceof DeploymentSettingsError) throw error;
    throw new DeploymentSettingsError(INSPECTION_ERROR);
  }
}

export function describeDeploymentSettings(
  settings: DeploymentSettings,
): string {
  return `workers.dev: ${settings.workersDev}; previews: ${settings.previewUrls ?? "initial default"}\nAnalytics: ${settings.analyticsEngineDatasets.map((entry) => `${entry.binding}=${entry.dataset}`).join(", ")}`;
}
