import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CloudBackupEndpoint } from "tila-sdk/backup";
import { checkpointInstance } from "tila-sdk/backup";
import { findConfig } from "../config";
import { assertExplicitInstanceTarget } from "./explicit-instance";
import { resolveParticipantId } from "./global-flags";
import { loadInfraConfig } from "./infra-config";
import { tilaHome } from "./provisioning";
import { resolveInfraAdminToken } from "./resolve-destroy-plan";

export async function checkpointSource(): Promise<CloudBackupEndpoint> {
  const config = findConfig();
  if (!config || config.backend === "local" || !config.worker_url)
    throw new Error("Checkpoint commands require a configured cloud project");
  await assertExplicitInstanceTarget(config);
  const infra = existsSync(join(tilaHome(), "infra.toml"))
    ? loadInfraConfig(tilaHome())
    : null;
  const token = resolveInfraAdminToken(infra, process.env.INFRA_ADMIN_TOKEN);
  if (!token)
    throw new Error(
      "Set INFRA_ADMIN_TOKEN or configure the infrastructure-owner credential",
    );
  if (
    !process.env.INFRA_ADMIN_TOKEN &&
    infra?.worker_url &&
    checkpointInstance(infra.worker_url) !==
      checkpointInstance(config.worker_url)
  )
    throw new Error("Infrastructure credential belongs to a different Worker");
  return {
    backend: "cloud",
    projectId: config.project_id,
    baseUrl: config.worker_url,
    infraToken: token,
    participantId: resolveParticipantId().id,
    cloudflareAccountId: config.cloudflare?.account_id,
  };
}
