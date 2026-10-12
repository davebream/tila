import { defineCommand } from "citty";
import {
  assertHumanCommand,
  humanRequest,
  loginWorkerUrl,
} from "../lib/human-login";
import { loadInfraConfig } from "../lib/infra-config";
import { outputText } from "../lib/output";
import { tilaHome } from "../lib/provisioning";
import { resolveInfraAdminToken } from "../lib/resolve-destroy-plan";

export default defineCommand({
  meta: {
    name: "recover-account",
    description:
      "Create an account recovery link using the infrastructure owner credential",
  },
  args: {
    email: {
      type: "string",
      required: true,
      description: "Existing account email",
    },
    url: { type: "string", description: "Tila server URL" },
  },
  async run({ args }) {
    assertHumanCommand();
    let infra: ReturnType<typeof loadInfraConfig> | null = null;
    try {
      infra = loadInfraConfig(tilaHome());
    } catch {
      /* Environment-only recovery is supported. */
    }
    const token = resolveInfraAdminToken(
      infra,
      process.env.TILA_INFRA_ADMIN_TOKEN,
    );
    if (!token) throw new Error("Infrastructure owner credential required");
    const result = await humanRequest<{ url: string }>(
      loginWorkerUrl(args.url),
      "/recovery/owner",
      { email: args.email },
      token,
    );
    outputText(
      `Share this recovery link privately. It expires in one hour:\n${result.url}`,
    );
  },
});
