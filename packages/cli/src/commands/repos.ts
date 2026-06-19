import { RepoRegisterResponseSchema } from "@tila/schemas";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { jsonArg, printJson, printJsonError } from "../lib/output";

export default defineCommand({
  meta: { name: "repos", description: "Manage the GitHub repo allowlist" },
  subCommands: {
    register: defineCommand({
      meta: {
        name: "register",
        description:
          "Register the configured GitHub repo in the project allowlist",
      },
      args: {
        owner: {
          type: "string",
          description: "GitHub repo owner (defaults to [github] config)",
        },
        repo: {
          type: "string",
          description: "GitHub repo name (defaults to [github] config)",
        },
        host: {
          type: "string",
          description: "GitHub host",
          default: "github.com",
        },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // REMOTE_ONLY guard: registration calls a remote admin endpoint.
        if (ctx.config.backend === "local") {
          if (args.json) {
            printJsonError(
              "This command requires a remote connection (tila init)",
              "REMOTE_ONLY",
            );
          } else {
            console.error(
              "Error: this command requires a remote connection (tila init)",
            );
          }
          process.exit(1);
          return;
        }

        // Resolve owner/repo/host: flags win, else fall back to [github] config.
        const owner =
          (args.owner as string | undefined) ?? ctx.config.github?.owner;
        const repo =
          (args.repo as string | undefined) ?? ctx.config.github?.repo;
        const host =
          (args.host as string | undefined) ??
          ctx.config.github?.host ??
          "github.com";

        if (!owner || !repo) {
          const msg =
            "No repo configured. Pass --owner and --repo, or run from a project with a [github] section in .tila/config.toml.";
          if (args.json) {
            printJsonError(msg, "NO_REPO");
          } else {
            console.error(`Error: ${msg}`);
          }
          process.exit(1);
          return;
        }

        const client = requireClient(ctx);

        try {
          const result = await client.post(
            "/api/repos",
            { owner, repo, github_host: host },
            { schema: RepoRegisterResponseSchema, validate: true },
          );

          if (args.json) {
            printJson({
              ok: true,
              owner,
              repo,
              github_repo_id: result.github_repo_id,
              full_name: result.full_name,
              registered_at: result.registered_at,
            });
            return;
          }

          console.log(`Repo ${result.full_name} registered.`);
          console.log("Re-running this command is safe (idempotent).");
        } catch (err) {
          // ERROR BRANCHING — branch on status + message + retryable, NOT
          // err.code. The SDK's toTilaErrorCode() collapses every repos-route
          // wire code (token-authz-denied, repo-access-denied, repo-not-found,
          // github-api-timeout, github-api-error) to "UNKNOWN" because none are
          // in TILA_ERRORS, so err.code carries no disambiguating signal here.
          //
          // The only signal separating the two 403s is the Worker's curated
          // message. These substring checks are pinned to the message text in
          // packages/worker/src/routes/repos.ts — if a server message changes,
          // this branching must change with it.
          if (err instanceof TilaApiError) {
            if (err.status === 403 && err.message.includes("full scope")) {
              const msg =
                "Registering a repo requires a full-scope token. Use the full-scope bootstrap token issued at `tila project create`.";
              if (args.json) {
                printJsonError(msg, "FORBIDDEN");
              } else {
                console.error(`Error: ${msg}`);
              }
              process.exit(1);
              return;
            }
            if (err.status === 403) {
              // repo-access-denied: the Worker's GitHub token cannot see the
              // repo — NOT a token-scope problem, so do not misdirect the user.
              const msg = `The tila Worker's GitHub token cannot access ${owner}/${repo}. Check the GitHub App installation / repo visibility.`;
              if (args.json) {
                printJsonError(msg, "REPO_ACCESS_DENIED");
              } else {
                console.error(`Error: ${msg}`);
              }
              process.exit(1);
              return;
            }
            if (err.status === 404) {
              const msg = `GitHub repo ${owner}/${repo} not found (renamed or deleted?). Verify owner/repo.`;
              if (args.json) {
                printJsonError(msg, "REPO_NOT_FOUND");
              } else {
                console.error(`Error: ${msg}`);
              }
              process.exit(1);
              return;
            }
            if (err.retryable) {
              // 502/504 — github-api-error / github-api-timeout.
              const msg = `${err.message} (transient — safe to re-run \`tila repos register\`).`;
              if (args.json) {
                printJsonError(msg, "RETRYABLE");
              } else {
                console.error(`Error: ${msg}`);
              }
              process.exit(1);
              return;
            }
            // Any other TilaApiError — surface status + curated message only,
            // never a raw response body/headers.
            const msg = `Registration failed (HTTP ${err.status}): ${err.message}`;
            if (args.json) {
              printJsonError(msg, "UNKNOWN");
            } else {
              console.error(`Error: ${msg}`);
            }
            process.exit(1);
            return;
          }

          // Worker-unreachable / network-class failure. The SDK's
          // TilaClient.request emits a "Network error connecting to ..."
          // message on fetch failure (verified packages/sdk/src/client.ts).
          // This is the command's headline recovery scenario: it is run right
          // after a first deploy when the Worker may still be cold.
          if (err instanceof Error && err.message.includes("Network error")) {
            const msg =
              "tila Worker not reachable yet. Wait a few seconds after deploy and re-run `tila repos register`.";
            if (args.json) {
              printJsonError(msg, "WORKER_UNREACHABLE");
            } else {
              console.error(`Error: ${msg}`);
            }
            process.exit(1);
            return;
          }

          throw err;
        }
      },
    }),
  },
});
