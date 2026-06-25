import { createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { openInBrowser } from "../../lib/browser";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import {
  applyD1Migrations,
  applyR2Lifecycle,
  deleteWorkerSecret,
  ensureD1Database,
  ensureR2Bucket,
  queryD1,
  setWorkerSecrets,
} from "../../lib/cloudflare-resources";
import { deployWorkerWithAssets, describeUiOutcome } from "../../lib/deploy";
import { ensureInfraAdminToken } from "../../lib/ensure-infra-admin-token";
import {
  discoverInstallation,
  loadGithubAppCredentials,
  mintAppJwt,
  startManifestFlow,
} from "../../lib/github-app-setup";
import {
  INFRA_CONFIG_FILE,
  getInfraSlug,
  loadInfraConfig,
  writeInfraConfig,
} from "../../lib/infra-config";
import { resolveInfraConfig } from "../../lib/infra-fallback";
import { buildAuthStore } from "../../lib/instance-context";
import { printJsonError } from "../../lib/output";
import {
  generateHmacKey,
  resolveCfApiToken,
  resolveMigrationsDir,
  tilaHome,
} from "../../lib/provisioning";
import { R2_BUCKET_NAME } from "../../lib/resource-names";
import { verifyCloudflareAuth } from "../../lib/wrangler";

const CF_TOKEN_KEY = "CLOUDFLARE_API_TOKEN";

function validateSlug(value: string | undefined): string | undefined {
  if (!value || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    return "Must be lowercase alphanumeric with hyphens, 1-63 chars, no leading/trailing hyphens";
  }
}

function ensurePkcs8(pem: string): string {
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  const key = createPrivateKey({ key: pem, format: "pem" });
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

function appendToEnvFile(filePath: string, key: string, value: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  if (existing.includes(`${key}=`)) return;
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(filePath, `${existing}${separator}${key}=${value}\n`, {
    mode: 0o600,
  });
}

async function promptForCfToken(): Promise<string> {
  p.log.info(
    `No ${CF_TOKEN_KEY} found in environment or ~/.tila/.env.\n\nCreate an Account API Token at https://dash.cloudflare.com/?to=/:account/api-tokens\nwith these permissions:\n  - Workers Scripts: Edit\n  - Account Settings: Read\n  - D1: Edit\n  - R2 Storage: Edit`,
  );
  const tokenResult = await p.password({
    message: `Paste your ${CF_TOKEN_KEY}:`,
  });
  if (p.isCancel(tokenResult)) {
    p.cancel("Operation cancelled.");
    process.exit(1);
  }
  const token = String(tokenResult ?? "");
  if (!token.trim()) {
    p.cancel("No token provided. Aborting.");
    process.exit(1);
  }
  return token.trim();
}

async function runForceRedeploy(
  tilaDir: string,
  rotateHmac: boolean,
  rotateAdminToken: boolean,
  headless = false,
): Promise<void> {
  // Load existing infra config — prefer per-slug store, fall back to flat file
  let infraConfig: Awaited<ReturnType<typeof resolveInfraConfig>>;
  try {
    infraConfig = await resolveInfraConfig(tilaDir, buildAuthStore());
  } catch {
    p.cancel("No infra.toml found. Run full `tila infra provision` first.");
    process.exit(1);
  }

  const scriptName = getInfraSlug(infraConfig);

  // Resolve HMAC key
  let hmacKey = infraConfig.hmac_key;
  if (rotateHmac) {
    if (!headless) {
      const confirm = await p.confirm({
        message:
          "This will invalidate all active sessions across all projects. Continue?",
      });
      if (p.isCancel(confirm) || !confirm) {
        p.log.info("Aborted.");
        process.exit(0);
      }
    }
    hmacKey = generateHmacKey();
  }

  if (!hmacKey) {
    p.cancel(
      "HMAC key not in infra.toml. Run full `tila infra provision` first.",
    );
    process.exit(1);
  }

  // Resolve CF token
  let cfToken = resolveCfApiToken();
  if (!cfToken) {
    cfToken = await promptForCfToken();
  }

  const cf = createCloudflareClient(cfToken);
  const s = p.spinner();

  const r2BucketName = infraConfig.r2_bucket_name ?? R2_BUCKET_NAME;

  s.start("Deploying Worker and UI...");
  const result = await deployWorkerWithAssets({
    cf,
    accountId: infraConfig.account_id,
    scriptName,
    d1DatabaseId: infraConfig.d1_database_id,
    r2BucketName,
    apiToken: cfToken,
    skipUi: false,
  });
  const uiDesc = describeUiOutcome(result.ui);
  s.stop(uiDesc.spinnerMessage);
  const workerUrl = result.workerUrl;

  // Best-effort: delete the stale UI_ORIGIN secret if it exists (migrated env).
  // UI_ORIGIN is a secret, not a var — wrangler never deletes it on deploy.
  // A stale *.pages.dev value would break OAuth redirects after migrating to Option A.
  // 404/not-found is treated as a no-op by deleteWorkerSecret.
  try {
    await deleteWorkerSecret(
      cf,
      infraConfig.account_id,
      scriptName,
      "UI_ORIGIN",
    );
  } catch {
    // Non-fatal — log nothing to avoid leaking internals
  }

  // Infra admin token — generate-if-absent / preserve / rotate-with-flag.
  // The token value is NEVER logged; it flows only into the secrets map + infra.toml.
  const { token: infraAdminToken } = ensureInfraAdminToken(infraConfig, {
    rotate: rotateAdminToken,
  });

  // Worker secrets
  const secrets: Record<string, string> = {
    GITHUB_SESSION_HMAC_KEY: hmacKey,
    INFRA_ADMIN_TOKEN: infraAdminToken,
  };

  // Re-set GitHub App secrets if available
  const creds = loadGithubAppCredentials(tilaDir);
  if (creds) {
    secrets.GITHUB_APP_ID = String(creds.app_id);
    secrets.GITHUB_APP_PRIVATE_KEY = ensurePkcs8(creds.pem);
    secrets.GITHUB_APP_CLIENT_ID = creds.client_id;
    secrets.GITHUB_APP_CLIENT_SECRET = creds.client_secret;
  }

  s.start("Setting Worker secrets...");
  await setWorkerSecrets(cf, infraConfig.account_id, scriptName, secrets);
  s.stop("Worker secrets set.");

  // Update infra.toml
  writeInfraConfig(
    {
      ...infraConfig,
      worker_url: workerUrl,
      hmac_key: hmacKey,
      infra_admin_token: infraAdminToken,
    },
    tilaDir,
  );

  if (rotateAdminToken) {
    p.log.warn(
      "INFRA_ADMIN_TOKEN rotated — takes effect within seconds as it propagates to all edge locations; an immediate admin call may 403 until propagation completes, retry.",
    );
  }

  p.note(
    `Worker: ${workerUrl}\n${rotateHmac ? "HMAC key rotated — existing sessions invalidated." : "HMAC key preserved."}`,
    "Re-deployed",
  );
}

export default defineCommand({
  meta: {
    name: "provision",
    description:
      "Provision account-level infrastructure (D1, R2, Worker, GitHub App)",
  },
  args: {
    "force-github-app": {
      type: "boolean",
      description: "Re-run GitHub App manifest flow even if already configured",
      default: false,
    },
    "force-redeploy": {
      type: "boolean",
      description:
        "Re-deploy Worker and UI without re-provisioning D1 or GitHub App",
      default: false,
    },
    "rotate-hmac": {
      type: "boolean",
      description: "Generate new HMAC key (invalidates all active sessions)",
      default: false,
    },
    "rotate-admin-token": {
      type: "boolean",
      description:
        "Generate a new INFRA_ADMIN_TOKEN (invalidates the previous admin token)",
      default: false,
    },
    headless: {
      type: "boolean",
      description:
        "Non-interactive mode for CI/automation — skips all prompts (requires CLOUDFLARE_API_TOKEN and --slug)",
      default: false,
    },
    slug: {
      type: "string",
      description:
        "Infrastructure slug (required in --headless mode, e.g. 'tila')",
      required: false,
    },
  },
  async run({ args }) {
    const tilaDir = tilaHome();
    const envPath = join(tilaDir, ".env");

    if (args.headless) {
      if (!resolveCfApiToken()) {
        printJsonError(
          "CLOUDFLARE_API_TOKEN required in headless mode",
          "MISSING_TOKEN",
        );
      }
      if (!args.slug) {
        printJsonError(
          "--slug flag is required in headless mode",
          "MISSING_SLUG",
        );
      }
    }

    if (args["force-redeploy"]) {
      await runForceRedeploy(
        tilaDir,
        args["rotate-hmac"],
        args["rotate-admin-token"],
        args.headless,
      );
      return;
    }

    // Step 1: Pre-flight — create ~/.tila/ with mode 0o700
    mkdirSync(tilaDir, { recursive: true, mode: 0o700 });

    // Step 1b: Check for existing infra.toml — confirm overwrite before provisioning
    const infraTomlPath = join(tilaDir, INFRA_CONFIG_FILE);
    if (existsSync(infraTomlPath) && !args.headless) {
      const overwrite = await p.confirm({
        message:
          "~/.tila/infra.toml already exists. Overwrite with new provision?",
      });
      if (p.isCancel(overwrite)) {
        p.cancel("Operation cancelled.");
        process.exit(1);
      }
      if (!overwrite) {
        p.log.info("Aborted — keeping existing infra.toml.");
        process.exit(0);
      }
    }

    // Step 2: Resolve CF token — env var → ~/.tila/.env → prompt
    let cfToken = resolveCfApiToken();
    if (!cfToken) {
      if (args.headless) {
        // Already validated above; this path is unreachable in headless mode
        printJsonError(
          "CLOUDFLARE_API_TOKEN required in headless mode",
          "MISSING_TOKEN",
        );
      }
      cfToken = await promptForCfToken();
    }

    // Step 3: Verify auth — extract account_id, account_name
    const s = p.spinner();
    s.start("Verifying Cloudflare credentials...");
    const whoami = await verifyCloudflareAuth(cfToken);
    s.stop(`Cloudflare account: ${whoami.account_name} (${whoami.account_id})`);

    const cf = createCloudflareClient(cfToken);

    // Load existing infra config once — prefer per-slug store, fall back to flat file.
    // Used for GitHub App detection and infra admin token continuity.
    let existingInfra: Awaited<ReturnType<typeof resolveInfraConfig>> | null =
      null;
    try {
      existingInfra = await resolveInfraConfig(tilaDir, buildAuthStore());
    } catch (err) {
      console.warn(
        `[tila] Failed to load existing infra.toml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 3b: Prompt for infrastructure slug (or use --slug in headless mode)
    let infraSlug: string;
    if (args.headless) {
      infraSlug = args.slug as string;
    } else {
      const slugResult = await p.text({
        message: "Infrastructure slug (used for Worker name):",
        defaultValue: "tila",
        validate: validateSlug,
      });
      if (p.isCancel(slugResult)) {
        p.cancel("Operation cancelled.");
        process.exit(1);
      }
      infraSlug = slugResult as string;
    }

    // Step 4: Create D1 database
    s.start("Setting up D1 database...");
    const d1Id = await ensureD1Database(cf, whoami.account_id, cfToken);
    s.stop(`D1 database ID: ${d1Id}`);

    // Step 5: Apply D1 migrations
    const migrationsDir = resolveMigrationsDir();
    await applyD1Migrations(cf, whoami.account_id, d1Id, migrationsDir);

    // Step 5b: Seed the stable deployment instance id into _deployment_meta.
    // ON CONFLICT DO NOTHING ensures a re-provision never changes (and therefore
    // never invalidates) an already-issued instance_id.
    const instanceId = crypto.randomUUID();
    await queryD1(
      cf,
      whoami.account_id,
      d1Id,
      "INSERT INTO _deployment_meta (id, instance_id, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
      [instanceId, String(Date.now())],
    );
    p.log.info(`Deployment instance id: ${instanceId}`);

    // Step 6: R2 artifact bucket
    s.start("Setting up R2 artifact bucket...");
    await ensureR2Bucket(cf, whoami.account_id, R2_BUCKET_NAME);
    await applyR2Lifecycle(cf, whoami.account_id, R2_BUCKET_NAME);
    s.stop("R2 artifact bucket ready.");

    // Step 7: Deploy Worker + UI (Option A: same-origin, wrangler deploy)
    s.start("Deploying Worker and UI...");
    const deployResult = await deployWorkerWithAssets({
      cf,
      accountId: whoami.account_id,
      scriptName: infraSlug,
      d1DatabaseId: d1Id,
      r2BucketName: R2_BUCKET_NAME,
      apiToken: cfToken,
      skipUi: false,
    });
    const workerUrl = deployResult.workerUrl;
    const deployUiDesc = describeUiOutcome(deployResult.ui);
    s.stop(deployUiDesc.spinnerMessage);

    // Best-effort: delete the stale UI_ORIGIN secret from pre-Option-A environments.
    // Fresh provisions never set this secret, so 404 is the expected no-op path.
    try {
      await deleteWorkerSecret(cf, whoami.account_id, infraSlug, "UI_ORIGIN");
    } catch {
      // Non-fatal
    }

    // Step 8: HMAC key + infra admin token + initial secrets
    const hmacKey = generateHmacKey();
    // Infra admin token — generate-if-absent / preserve / rotate-with-flag.
    // The token value is NEVER logged; it flows only into the secrets map + infra.toml.
    const { token: infraAdminToken } = ensureInfraAdminToken(existingInfra, {
      rotate: args["rotate-admin-token"],
    });
    const secrets: Record<string, string> = {
      GITHUB_SESSION_HMAC_KEY: hmacKey,
      INFRA_ADMIN_TOKEN: infraAdminToken,
    };
    s.start("Setting Worker secrets...");
    await setWorkerSecrets(cf, whoami.account_id, infraSlug, secrets);
    s.stop("Worker secrets set.");

    if (args["rotate-admin-token"]) {
      p.log.warn(
        "INFRA_ADMIN_TOKEN rotated — takes effect within seconds as it propagates to all edge locations; an immediate admin call may 403 until propagation completes, retry.",
      );
    }

    // Step 9: Orphan detection — warn if github-app.json exists but infra.toml doesn't
    const githubAppJsonPath = join(tilaDir, "github-app.json");
    if (!existsSync(infraTomlPath) && existsSync(githubAppJsonPath)) {
      p.log.warn(
        "Found ~/.tila/github-app.json without infra.toml. This may be leftover from a previous setup.",
      );
    }

    // Step 10: GitHub App — skip if already configured (unless --force-github-app)
    let githubApp: { app_id: number; installation_id: number } | undefined;
    let credentials: Awaited<ReturnType<typeof startManifestFlow>> | undefined;

    const hasExistingGithubApp = existingInfra?.github_app != null;

    if (args.headless) {
      p.log.info("Headless mode — skipping GitHub App setup.");
      githubApp = existingInfra?.github_app;
    } else if (hasExistingGithubApp && !args["force-github-app"]) {
      p.log.info(
        "GitHub App already configured in infra.toml — skipping. Use --force-github-app to re-run.",
      );
      githubApp = existingInfra?.github_app;
    } else {
      try {
        s.start("Starting GitHub App manifest flow...");
        credentials = await startManifestFlow({
          tilaDir,
          workerUrl,
          onReady: (port) => {
            s.stop("Local server ready");
            p.note(
              `Create the GitHub App in your browser.\n\nIf your browser didn't open, visit: http://127.0.0.1:${port}/\n\nThis will timeout in 5 minutes. Press Ctrl+C to cancel.`,
              "GitHub App Setup",
            );
          },
        });
        s.stop(`GitHub App created (app_id: ${credentials.app_id})`);

        const installUrl = `https://github.com/apps/${credentials.slug}/installations/new`;
        p.note(
          `Install the GitHub App on your account/org.\n\nIf your browser didn't open, visit:\n${installUrl}`,
          "Install GitHub App",
        );
        openInBrowser(installUrl);

        s.start("Waiting for App installation...");
        const appJwt = await mintAppJwt(credentials.app_id, credentials.pem);
        const installation = await discoverInstallation(appJwt);
        s.stop(`Installation: ${installation.account} (${installation.id})`);

        githubApp = {
          app_id: credentials.app_id,
          installation_id: installation.id,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.error(`\nGitHub App setup failed: ${msg}`);
        p.log.info(
          "Cloudflare resources are provisioned. Retry GitHub App setup later with: tila infra provision --force-github-app",
        );
      }
    }

    // Step 11: Set GitHub App secrets on Worker
    if (githubApp) {
      // Use credentials from this invocation, or fall back to stored github-app.json
      const appCreds = credentials ?? loadGithubAppCredentials(tilaDir);
      if (appCreds) {
        s.start("Setting GitHub App secrets...");
        await setWorkerSecrets(cf, whoami.account_id, infraSlug, {
          GITHUB_APP_ID: String(appCreds.app_id),
          GITHUB_APP_PRIVATE_KEY: ensurePkcs8(appCreds.pem),
          GITHUB_APP_CLIENT_ID: appCreds.client_id,
          GITHUB_APP_CLIENT_SECRET: appCreds.client_secret,
        });
        s.stop("GitHub App secrets set.");
      }
    }

    // Step 12: Write infra.toml — atomic, only after all steps succeed
    // NOTE: pages_project_name is deliberately NOT written here (Option A no longer
    // creates a Pages project). Existing values in infra.toml are left readable
    // for teardown's deletePagesProject to clean up pre-Option-A environments.
    writeInfraConfig(
      {
        account_id: whoami.account_id,
        account_name: whoami.account_name,
        d1_database_id: d1Id,
        worker_url: workerUrl,
        r2_bucket_name: R2_BUCKET_NAME,
        hmac_key: hmacKey,
        infra_admin_token: infraAdminToken,
        infra_slug: infraSlug,
        ...(githubApp ? { github_app: githubApp } : {}),
      },
      tilaDir,
    );

    // Step 13: Write CF token to ~/.tila/.env
    appendToEnvFile(envPath, CF_TOKEN_KEY, cfToken);

    // Success summary
    const summaryLines = [
      `Account:  ${whoami.account_name} (${whoami.account_id})`,
      `D1:       ${d1Id}`,
      `Worker:   ${workerUrl}`,
      `R2:       ${R2_BUCKET_NAME}`,
      ...(githubApp
        ? [
            `GitHub:   app_id=${githubApp.app_id}, installation_id=${githubApp.installation_id}`,
          ]
        : []),
      "Config:   ~/.tila/infra.toml",
    ].join("\n");
    p.note(summaryLines, "Account infrastructure provisioned");
  },
});
