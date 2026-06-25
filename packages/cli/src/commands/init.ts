import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { findConfig, findTilaDir } from "../config";

export default defineCommand({
  meta: {
    name: "init",
    description: "Join an existing tila project",
  },
  args: {
    token: {
      type: "string",
      description: "API token (tila-token mode)",
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();

    // Step 1: Find config
    const config = findConfig(cwd);
    if (!config) {
      p.log.error(
        "No project found. Run `tila project create` to create one, " +
          "or ask your admin to commit `.tila/config.toml`.",
      );
      process.exit(1);
    }

    p.log.info(`Project: ${config.project_id}`);

    const tilaDir = findTilaDir(cwd) ?? join(cwd, ".tila");

    // Step 2: Read auth mode
    const authMode = config.auth?.mode ?? "tila-token";

    if (authMode === "github-repo") {
      // Step 3a: github-repo flow
      if (!config.worker_url) {
        p.log.error(
          "config.toml has no worker_url. Cannot join via GitHub auth.",
        );
        process.exit(1);
      }

      // Validate [github] section
      if (!config.github?.owner || !config.github?.repo) {
        p.log.error(
          'Auth mode is "github-repo" but [github] section is missing from .tila/config.toml. Add [github] with owner and repo fields.',
        );
        process.exit(1);
      }

      // Warn if --token flag was provided (ignored in github-repo mode)
      if (args.token) {
        p.log.warn(
          "Warning: --token flag is ignored in github-repo auth mode. Authentication uses GitHub device flow.",
        );
      }

      // Verify Worker health
      try {
        const resp = await fetch(
          `${config.worker_url.replace(/\/+$/, "")}/health`,
          {
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        p.log.info("Worker is reachable.");
      } catch (err) {
        p.log.error(
          `Worker unreachable at ${config.worker_url}/health: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }

      // Resolve GitHub token and exchange for session
      const { resolveGithubRepoToken } = await import("../lib/github-exchange");
      const githubConfig = {
        ...config,
        worker_url: config.worker_url as string,
      };
      try {
        await resolveGithubRepoToken(githubConfig, tilaDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("GitHub App not configured")) {
          p.log.error(
            "GitHub App not configured for this project. Ask the project admin to set up the GitHub App first.",
          );
        } else {
          p.log.error(msg);
        }
        process.exit(1);
      }

      p.log.success("Authenticated via GitHub.");
    } else {
      // Step 3b: tila-token flow
      const { writeTokenFile } = await import("../auth");
      let token = args.token;
      if (!token) {
        const result = await p.password({ message: "API token:" });
        if (p.isCancel(result)) process.exit(1);
        token = result;
      }
      if (!token || token.trim().length === 0) {
        p.log.error("No token provided. Aborting.");
        process.exit(1);
      }
      token = token.trim();

      writeTokenFile(token, tilaDir);
      p.log.info("Token written to .tila/.env (mode 0o600).");

      // Verify Worker health
      if (config.worker_url) {
        try {
          const resp = await fetch(
            `${config.worker_url.replace(/\/+$/, "")}/health`,
            {
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          p.log.success("Worker reachable.");
        } catch (err) {
          p.log.warn(
            `Worker unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Step 4: Update .gitignore
    const { ensureGitignored } = await import("../lib/provisioning");
    ensureGitignored(
      [".tila/.env", ".tila/.session", ".tila/github-token-cache.json"],
      cwd,
    );

    // Step 5: MCP setup
    const { runMcpInitPrompt } = await import("../lib/mcp-targets");
    await runMcpInitPrompt(cwd);

    p.log.success("Project initialized. Ready to use tila.");
    p.log.info(
      "Tip: run `tila link <worker_url>` to store credentials in the OS keychain for multi-instance auth.",
    );
  },
});
