import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import { RepoRegisterResponseSchema } from "@tila/schemas";
import type { TilaProjectConfig } from "@tila/schemas";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { writeTokenFile } from "../../auth";
import { findConfig, writeConfigFile } from "../../config";
import { createCliClient } from "../../lib/client-factory";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import {
  insertGithubAppConfig,
  insertTokenAndProject,
} from "../../lib/cloudflare-resources";
import {
  type AppCredentials,
  loadGithubAppCredentials,
} from "../../lib/github-app-setup";
import { loadInfraConfig } from "../../lib/infra-config";
import { runMcpInitPrompt } from "../../lib/mcp-targets";
import { printJson, printJsonError } from "../../lib/output";
import {
  deriveOrg,
  deriveRepo,
  ensureGitignored,
  generateDefaultSchemaToml,
  generateRawToken,
  hashToken,
  resolveCfApiToken,
  resolveProjectName,
  tilaHome,
} from "../../lib/provisioning";

export default defineCommand({
  meta: {
    name: "create",
    description: "Create a new tila project",
  },
  args: {
    local: {
      type: "boolean",
      description: "Use local SQLite backend (no Cloudflare required)",
      default: false,
    },
    name: {
      type: "string",
      description:
        "Project name (lowercase, hyphens, no spaces). Prompted if not provided.",
      required: false,
    },
    "skip-github": {
      type: "boolean",
      description: "Skip GitHub App repo registration",
      default: false,
    },
    json: {
      type: "boolean",
      description:
        "Output result as JSON (suppresses interactive prompts, suitable for CI)",
      default: false,
    },
  },
  async run({ args }) {
    if (args.local) {
      await runLocalProvisioning(args.name, args.json);
    } else {
      await runCloudflareProvisioning(
        args["skip-github"],
        args.name,
        args.json,
      );
    }
  },
});

async function runCloudflareProvisioning(
  skipGithub = false,
  nameFlag?: string,
  json = false,
): Promise<void> {
  const cwd = process.cwd();
  const tilaDir = join(cwd, ".tila");
  const homeDir = tilaHome();

  // Step 1: Load infra.toml — fail if missing
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
  const d1DatabaseId = infraConfig.d1_database_id;

  // Step 2: Validate worker_url exists in infra config
  const workerUrl = infraConfig.worker_url;
  if (!workerUrl) {
    p.cancel(
      "No worker_url in infra.toml. Run `tila infra provision` to deploy the shared Worker first.",
    );
    process.exit(1);
  }

  // Step 3: Validate github-app.json exists if github_app configured in infra.toml
  let githubCredentials: AppCredentials | null = null;
  if (infraConfig.github_app && !skipGithub) {
    githubCredentials = loadGithubAppCredentials(homeDir);
    if (!githubCredentials) {
      p.cancel(
        "GitHub App is configured in infra.toml but ~/.tila/github-app.json is missing or invalid.\n\n" +
          "Re-run `tila infra provision --force-github-app` to recreate it, or use --skip-github.",
      );
      process.exit(1);
    }
  }

  // Step 4: Detect git remote
  const repoInfo = deriveRepo(cwd);

  // Step 5: Generate project slug
  let slug: string;
  const existingConfig = existsSync(join(tilaDir, "config.toml"))
    ? findConfig(cwd)
    : null;
  if (existingConfig) {
    slug = existingConfig.project_id;
    if (!json)
      p.log.info(
        `Existing project detected: ${slug} (re-running provisioning)`,
      );
  } else {
    slug = await resolveProjectName(cwd, nameFlag);
    if (!json) p.log.info(`Project: ${slug}`);
  }

  // Step 6: Resolve CF token — env var -> ~/.tila/.env (non-interactive, needed for D1 insert)
  const cfToken = resolveCfApiToken();
  if (!cfToken) {
    if (json) {
      printJsonError(
        "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env",
        "MISSING_TOKEN",
      );
    }
    p.cancel(
      "No CLOUDFLARE_API_TOKEN found in environment or ~/.tila/.env.\n\n" +
        "Set the token via `export CLOUDFLARE_API_TOKEN=...` or in ~/.tila/.env before running project create.",
    );
    process.exit(1);
  }

  // Step 7: Create CF client (needed for D1 insert)
  const cf = createCloudflareClient(cfToken);

  // Step 8: Generate API token, insert in D1
  const s = json ? null : p.spinner();
  if (s) s.start("Generating API token...");
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  await insertTokenAndProject({
    client: cf,
    accountId,
    databaseId: d1DatabaseId,
    tokenHash,
    slug,
  });
  if (s) s.stop("API token generated.");

  // Step 8b: Register GitHub App installation in D1 (so the Worker can mint tokens)
  if (infraConfig.github_app && !skipGithub) {
    await insertGithubAppConfig({
      client: cf,
      accountId,
      databaseId: d1DatabaseId,
      projectId: slug,
      installationId: infraConfig.github_app.installation_id,
    });
  }

  // Step 9: Register repo
  let githubEnabled = false;
  if (githubCredentials && repoInfo && !skipGithub) {
    try {
      if (s) s.start(`Registering repo ${repoInfo.owner}/${repoInfo.repo}...`);
      const client = createCliClient(workerUrl, rawToken);
      await client.post(
        "/api/repos",
        {
          owner: repoInfo.owner,
          repo: repoInfo.repo,
        },
        { schema: RepoRegisterResponseSchema, validate: true },
      );
      if (s) s.stop(`Repo ${repoInfo.owner}/${repoInfo.repo} registered.`);
      githubEnabled = true;
    } catch (err) {
      if (err instanceof TilaApiError) {
        if (s) s.stop(`Repo registration failed: ${err.message}`);
      } else if (
        err instanceof Error &&
        err.message.includes("Network error")
      ) {
        if (s)
          s.stop(
            "Repo registration skipped (Worker not reachable yet — this is normal for first deploy).",
          );
      } else {
        if (s)
          s.stop(
            `Repo registration failed: ${err instanceof Error ? err.message : String(err)}`,
          );
      }
    }
  } else if (githubCredentials && !repoInfo && !skipGithub) {
    if (!json)
      p.log.warn(
        "  No git remote found -- [github] section will need manual owner/repo configuration.",
      );
    githubEnabled = true;
  } else if (githubCredentials && !skipGithub) {
    githubEnabled = true;
  }

  // Step 10: Write config.toml, .tila/.env, .gitignore, schema.toml
  const config: TilaProjectConfig = {
    project_id: slug,
    worker_url: workerUrl,
    schema_version: 1,
    tila_version: "0.1.0",
    created_at: new Date().toISOString(),
    cloudflare: { account_id: accountId },
    backends: {
      entity: "do-sqlite",
      coordination: "do-sqlite",
      artifact: "r2",
      auth: "d1",
    },
    ...(githubEnabled ? { auth: { mode: "github-repo" as const } } : undefined),
    ...(githubEnabled && repoInfo
      ? {
          github: {
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            host: "github.com",
          },
        }
      : undefined),
  };
  writeConfigFile(config, tilaDir);

  const gitignoreEntries = [".tila/.env", ".tila/.session"];
  if (githubEnabled) {
    gitignoreEntries.push(".tila/github-app.json");
  }
  ensureGitignored(gitignoreEntries, cwd);

  writeTokenFile(rawToken, tilaDir);

  const schemaTomlPath = join(cwd, "tila.schema.toml");
  if (!existsSync(schemaTomlPath)) {
    writeFileSync(schemaTomlPath, generateDefaultSchemaToml(), "utf-8");
  }

  // Step 11: Success summary
  if (json) {
    printJson({ project_id: slug, worker_url: workerUrl, token: rawToken });
    return;
  }
  let summaryLines = `Worker:   ${workerUrl}\nProject:  ${slug}\nToken:    written to .tila/.env`;
  if (githubEnabled && githubCredentials) {
    summaryLines += `\nApp ID:   ${githubCredentials.app_id}`;
    summaryLines += "\nAuth:     github-repo";
  }
  const nextSteps = githubEnabled
    ? 'Next steps:\n  1. Commit .tila/config.toml to the repo\n  2. Teammates join with: tila init\n  3. Run: tila doctor  to verify the setup\n  4. Start working: tila task new --title "First task"'
    : 'Next steps:\n  1. Commit .tila/config.toml to the repo\n  2. Teammates join with: tila init  (authenticates via GitHub)\n  3. Start working: tila task new --title "First task"';
  p.note(`${summaryLines}\n\n${nextSteps}`, "tila project created");

  // Step 12: Offer MCP setup
  await runMcpInitPrompt(cwd);
}

async function runLocalProvisioning(
  nameFlag?: string,
  json = false,
): Promise<void> {
  const cwd = process.cwd();
  const tilaDir = join(cwd, ".tila");

  // Step 1: Preflight -- check no existing config
  if (existsSync(join(tilaDir, "config.toml"))) {
    p.cancel(
      "This project is already initialized (.tila/config.toml exists).\n\n" +
        "To re-initialize, remove .tila/config.toml first.",
    );
    process.exit(1);
  }

  // Step 2: Project name (prompt or flag)
  const projectId = await resolveProjectName(cwd, nameFlag);
  if (!json) p.log.info(`  Project: ${projectId}`);

  // Step 3: Org derivation
  const org = deriveOrg(cwd);
  if (!json) p.log.info(`  Org: ${org}`);

  // Step 4: Path resolution
  const dbPath = join(tilaHome(), "projects", projectId, "state.db");
  const artifactsPath = join(tilaHome(), "artifacts", org, projectId);

  // Step 5: DB initialization (eager migration)
  if (!json) p.log.info("Initializing local database...");
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const { LocalProject } = await import("@tila/backend-local");
    const lp = LocalProject.open(dbPath, org, projectId);
    lp.close();
    if (!json) p.log.info(`  Database: ${dbPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      printJsonError(message, "DB_INIT_FAILED");
    }
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as Error).name === "LocalFilesystemError"
    ) {
      p.cancel(`Local backend requires a local filesystem.\n${message}`);
    } else {
      p.cancel(`Failed to initialize local database at ${dbPath}:\n${message}`);
    }
    process.exit(1);
  }

  // Step 6: Artifact directory creation
  try {
    mkdirSync(artifactsPath, { recursive: true });
    if (!json) p.log.info(`  Artifacts: ${artifactsPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      printJsonError(message, "ARTIFACTS_DIR_FAILED");
    }
    p.cancel(
      `Failed to create artifact directory at ${artifactsPath}:\n${message}`,
    );
    process.exit(1);
  }

  // Step 7: Config write
  if (!json) p.log.info("Writing config files...");
  const config = {
    project_id: projectId,
    backend: "local" as const,
    schema_version: 1,
    tila_version: "0.1.0",
    created_at: new Date().toISOString(),
    local: {
      db_path: dbPath,
      artifacts_path: artifactsPath,
      org,
    },
  };
  writeConfigFile(config, tilaDir);

  // Step 8: Gitignore
  ensureGitignored([".tila/.env", ".tila/.session"], cwd);

  // Step 9: Schema toml
  const schemaTomlPath = join(cwd, "tila.schema.toml");
  if (!existsSync(schemaTomlPath)) {
    writeFileSync(schemaTomlPath, generateDefaultSchemaToml(), "utf-8");
  }

  // Step 10: Success summary
  if (json) {
    printJson({
      project_id: projectId,
      db_path: dbPath,
      artifacts_path: artifactsPath,
      backend: "local",
    });
    return;
  }
  p.note(
    `Project:    ${projectId}\nOrg:        ${org}\nDatabase:   ${dbPath}\nArtifacts:  ${artifactsPath}\nBackend:    local (SQLite + filesystem)\n\nNext steps:\n  1. Start working: tila task new --title "First task"`,
    "tila project provisioned (local mode)",
  );
  await runMcpInitPrompt(cwd);
}
