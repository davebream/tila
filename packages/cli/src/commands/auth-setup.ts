import { defineCommand } from "citty";
import { findConfig } from "../config";
import {
  assertHumanCommand,
  humanRequest,
  loginWorkerUrl,
} from "../lib/human-login";
import { loadInfraConfig } from "../lib/infra-config";
import { outputText } from "../lib/output";
import { tilaHome } from "../lib/provisioning";
import { resolveInfraAdminToken } from "../lib/resolve-destroy-plan";

export const setup = defineCommand({
  meta: {
    name: "setup",
    description:
      "Create the first administrator invitation using the infrastructure owner credential",
  },
  args: {
    email: {
      type: "string",
      required: true,
      description: "Administrator email",
    },
    url: { type: "string", description: "Tila server URL" },
    project: {
      type: "string",
      description: "Existing project to grant ownership of",
    },
  },
  async run({ args }) {
    assertHumanCommand();
    let infra: ReturnType<typeof loadInfraConfig> | null = null;
    try {
      infra = loadInfraConfig(tilaHome());
    } catch {
      /* Environment-only setup is supported. */
    }
    const token = resolveInfraAdminToken(
      infra,
      process.env.TILA_INFRA_ADMIN_TOKEN,
    );
    if (!token)
      throw new Error(
        "Infrastructure owner credential required: configure TILA_INFRA_ADMIN_TOKEN or use the machine that provisioned this instance",
      );
    const result = await humanRequest<{ url: string }>(
      loginWorkerUrl(args.url),
      "/setup",
      {
        email: args.email,
        projectId: args.project ?? findConfig()?.project_id,
      },
      token,
    );
    outputText(
      `Open this private invitation to create the first administrator account:\n${result.url}`,
    );
  },
});

export default setup;
