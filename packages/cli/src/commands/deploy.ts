import { createPrivateKey } from "node:crypto";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { createCloudflareClient } from "../lib/cloudflare-client";
import { setWorkerSecrets } from "../lib/cloudflare-resources";
import {
  type DeployResult,
  deployWorkerWithAssets,
  describeUiOutcome,
} from "../lib/deploy";
import { loadGithubAppCredentials } from "../lib/github-app-setup";
import { getInfraSlug, loadInfraConfig } from "../lib/infra-config";
import { printJson, printJsonError } from "../lib/output";
import { resolveCfApiToken, tilaHome } from "../lib/provisioning";
import { R2_BUCKET_NAME } from "../lib/resource-names";

export default defineCommand({
  meta: {
    name: "deploy",
    description:
      "Deploy Worker and UI to Cloudflare via wrangler. Exit codes: 0 success, 1 deploy failed.",
  },
  args: {
    "skip-ui": {
      type: "boolean",
      description:
        "Skip UI deployment (deploy Worker code only, no [assets] block)",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON to stdout (suppresses prompts)",
      default: false,
    },
  },
  async run({ args }) {
    const json = args.json === true;
    const tilaDir = tilaHome();

    function fatal(message: string, code: string): never {
      if (json) printJsonError(message, code);
      p.cancel(message);
      process.exit(1);
    }

    let infraConfig: ReturnType<typeof loadInfraConfig>;
    try {
      infraConfig = loadInfraConfig(tilaDir);
    } catch {
      fatal(
        "No infra.toml found. Run `tila infra provision` first.",
        "NO_INFRA_CONFIG",
      );
    }

    const cfToken = resolveCfApiToken();
    if (!cfToken) {
      fatal(
        "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env.\n\n" +
          "Set the token via `export CLOUDFLARE_API_TOKEN=...` or in ~/.tila/.env.",
        "NO_CF_TOKEN",
      );
    }

    const cf = createCloudflareClient(cfToken);
    const scriptName = getInfraSlug(infraConfig);
    const r2BucketName = infraConfig.r2_bucket_name ?? R2_BUCKET_NAME;

    const s = json ? null : p.spinner();
    s?.start("Deploying...");

    let result: DeployResult;
    try {
      result = await deployWorkerWithAssets({
        cf,
        accountId: infraConfig.account_id,
        scriptName,
        d1DatabaseId: infraConfig.d1_database_id,
        r2BucketName,
        apiToken: cfToken,
        skipUi: args["skip-ui"],
      });

      const secrets: Record<string, string> = {};
      if (infraConfig.hmac_key) {
        secrets.GITHUB_SESSION_HMAC_KEY = infraConfig.hmac_key;
      }
      const creds = loadGithubAppCredentials(tilaDir);
      if (creds) {
        secrets.GITHUB_APP_ID = String(creds.app_id);
        const key = createPrivateKey({ key: creds.pem, format: "pem" });
        secrets.GITHUB_APP_PRIVATE_KEY = key.export({
          type: "pkcs8",
          format: "pem",
        }) as string;
        secrets.GITHUB_APP_CLIENT_ID = creds.client_id;
        secrets.GITHUB_APP_CLIENT_SECRET = creds.client_secret;
      }
      if (Object.keys(secrets).length > 0) {
        await setWorkerSecrets(cf, infraConfig.account_id, scriptName, secrets);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) printJsonError(`Deploy failed: ${msg}`, "DEPLOY_FAILED");
      s?.stop("Deploy failed.");
      p.cancel(`Deploy failed: ${msg}`);
      process.exit(1);
    }

    if (json) {
      printJson({ workerUrl: result.workerUrl, ui: result.ui });
      return;
    }

    const { spinnerMessage, uiLine } = describeUiOutcome(result.ui);
    s?.stop(spinnerMessage);
    p.note(`Worker:  ${result.workerUrl}\n${uiLine}`, "Deploy complete");
  },
});
