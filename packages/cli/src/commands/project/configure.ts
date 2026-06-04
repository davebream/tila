import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { findConfig, writeConfigFile } from "../../config";
import {
  createCustomDomain,
  resolveZoneId,
} from "../../lib/cloudflare-resources";
import { getInfraSlug, loadInfraConfig } from "../../lib/infra-config";
import { resolveCfApiToken, tilaHome } from "../../lib/provisioning";

export default defineCommand({
  meta: {
    name: "configure",
    description: "Configure a custom domain for the tila Worker",
  },
  args: {
    domain: {
      type: "string",
      description: "Custom domain hostname (e.g. tila.acme.com)",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const tilaDir = join(cwd, ".tila");
    const homeDir = tilaHome();

    // Step 1: Load project config — fail if not found
    const config = findConfig(cwd);
    if (!config) {
      p.cancel("No tila project found. Run `tila project create` first.");
      process.exit(1);
    }

    // Step 2: Validate project is Cloudflare-backed
    if (config.backend === "local") {
      p.cancel("Custom domains require a Cloudflare-backed project.");
      process.exit(1);
    }

    // Step 3: Resolve CF API token
    const apiToken = resolveCfApiToken();
    if (!apiToken) {
      p.cancel(
        "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env.\n\n" +
          "Set the token via `export CLOUDFLARE_API_TOKEN=...` or in ~/.tila/.env before running this command.",
      );
      process.exit(1);
    }

    // Step 4: Load infra config — need account_id
    let infraConfig: ReturnType<typeof loadInfraConfig>;
    try {
      infraConfig = loadInfraConfig(homeDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.cancel(
        `No infrastructure found. Run \`tila infra provision\` first.\n\n${msg}`,
      );
      process.exit(1);
    }

    const accountId = infraConfig.account_id;
    let hostname = args.domain;
    if (!hostname) {
      const result = await p.text({
        message: "Custom domain hostname:",
        placeholder: "tila.acme.com",
        validate: (v) =>
          !v?.includes(".") ? "Must be a valid hostname" : undefined,
      });
      if (p.isCancel(result)) {
        p.cancel("Cancelled.");
        process.exit(1);
      }
      hostname = result;
    }

    // Step 5: Resolve zone ID
    const s = p.spinner();
    s.start("Verifying zone...");
    let zoneId: string;
    try {
      zoneId = await resolveZoneId(apiToken, accountId, hostname);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      s.stop("Zone verification failed.");
      p.cancel(
        `No zone found for '${hostname}' on this Cloudflare account.\n\n${msg}`,
      );
      process.exit(1);
    }
    s.stop("Zone verified.");

    // Step 6: Attach custom domain
    const s2 = p.spinner();
    s2.start("Attaching custom domain...");
    try {
      await createCustomDomain({
        apiToken,
        accountId,
        zoneId,
        hostname,
        service: getInfraSlug(infraConfig),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      s2.stop("Domain attachment failed.");
      p.cancel(`Failed to create custom domain: ${msg}`);
      process.exit(1);
    }
    s2.stop("Custom domain attached.");

    // Step 7: Update config
    const updatedConfig = {
      ...config,
      custom_domain: hostname,
      worker_url: `https://${hostname}`,
    };

    // Step 8: Write config
    writeConfigFile(updatedConfig, tilaDir);

    // Step 9: Summary
    p.note(
      `Worker URL:     https://${hostname}\nCustom domain:  ${hostname}\nProject:        ${config.project_id}`,
      "Custom domain configured",
    );
  },
});
