import { RepoRegisterResponseSchema } from "@tila/schemas";
import {
  RepoAccessPolicyRequestSchema,
  RepoOidcPolicySchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { TILA_ERRORS, TilaApiError, createRepoMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { integerFlag } from "../lib/expected-revision";
import { globalFlagArgs } from "../lib/global-flags";
import {
  diagnostic,
  exit,
  jsonArg,
  outputText,
  printJson,
  printJsonError,
} from "../lib/output";

async function repoApi() {
  return createRepoMethods(requireClient(await resolveContext()));
}
const repoArg = {
  ...globalFlagArgs,
  repo: {
    type: "positional" as const,
    required: true as const,
    description: "Numeric GitHub repository ID (from repos list)",
  },
  host: {
    type: "string" as const,
    description: "GitHub host (default github.com)",
  },
};
const revisionArg = {
  "expected-revision": {
    type: "string" as const,
    description: "Policy revision you reviewed; stale values fail",
  },
};
function repoId(value: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1)
    throw new Error("Repository ID must be a positive integer");
  return id;
}

/** Owner policy commands; all writes accept the reviewed revision. */
function repoPolicyCommands() {
  return {
    list: defineCommand({
      meta: { description: "List linked repositories with both policies" },
      args: { ...globalFlagArgs, host: { type: "string" } },
      async run({ args }) {
        printJson(await (await repoApi()).list({ host: args.host }));
      },
    }),
    policy: defineCommand({
      meta: {
        description:
          "Show the human access policy, or replace it with --set '<json>'",
      },
      args: { ...repoArg, ...revisionArg, set: { type: "string" } },
      async run({ args }) {
        const api = await repoApi();
        const id = repoId(args.repo);
        printJson(
          args.set
            ? await api.setAccessPolicy(
                id,
                RepoAccessPolicyRequestSchema.parse(JSON.parse(args.set)),
                {
                  host: args.host,
                  expectedRevision: integerFlag(
                    "expected-revision",
                    args["expected-revision"],
                  ),
                },
              )
            : await api.accessPolicy(id, { host: args.host }),
        );
      },
    }),
    oidc: defineCommand({
      meta: {
        description:
          "Show the Actions OIDC policy, or replace it with --set '<json>'",
      },
      args: { ...repoArg, ...revisionArg, set: { type: "string" } },
      async run({ args }) {
        const api = await repoApi();
        const id = repoId(args.repo);
        printJson(
          args.set
            ? await api.setOidcPolicy(
                id,
                RepoOidcPolicySchema.parse(JSON.parse(args.set)),
                {
                  host: args.host,
                  expectedRevision: integerFlag(
                    "expected-revision",
                    args["expected-revision"],
                  ),
                },
              )
            : await api.oidcPolicy(id, { host: args.host }),
        );
      },
    }),
    remove: defineCommand({
      meta: {
        description:
          "Remove a repository link; explicit memberships are not removed",
      },
      args: { ...repoArg, ...revisionArg },
      async run({ args }) {
        printJson(
          await (await repoApi()).remove(repoId(args.repo), {
            host: args.host,
            expectedRevision: integerFlag(
              "expected-revision",
              args["expected-revision"],
            ),
          }),
        );
      },
    }),
  };
}

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
            diagnostic(
              "Error: this command requires a remote connection (tila init)",
            );
          }
          exit(1);
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
            diagnostic(`Error: ${msg}`);
          }
          exit(1);
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

          outputText(`Repo ${result.full_name} registered.`);
          outputText("Re-running this command is safe (idempotent).");
        } catch (err) {
          if (err instanceof TilaApiError) {
            switch (err.code) {
              case TILA_ERRORS.REPO_TOKEN_AUTHZ_DENIED: {
                const msg =
                  "Registering a repo requires a full-scope token. Use the full-scope bootstrap token issued at `tila project create`.";
                if (args.json) {
                  printJsonError(msg, "FORBIDDEN");
                } else {
                  diagnostic(`Error: ${msg}`);
                }
                exit(1);
                return;
              }
              case TILA_ERRORS.REPO_ACCESS_DENIED: {
                // The Worker's GitHub token cannot see the repo —
                // NOT a token-scope problem, so do not misdirect the user.
                const msg = `The tila Worker's GitHub token cannot access ${owner}/${repo}. Check the GitHub App installation / repo visibility.`;
                if (args.json) {
                  printJsonError(msg, "REPO_ACCESS_DENIED");
                } else {
                  diagnostic(`Error: ${msg}`);
                }
                exit(1);
                return;
              }
              case TILA_ERRORS.REPO_NOT_FOUND: {
                const msg = `GitHub repo ${owner}/${repo} not found (renamed or deleted?). Verify owner/repo.`;
                if (args.json) {
                  printJsonError(msg, "REPO_NOT_FOUND");
                } else {
                  diagnostic(`Error: ${msg}`);
                }
                exit(1);
                return;
              }
            }
            if (err.retryable) {
              // github-api-timeout / github-api-error and any future retryable code.
              const msg = `${err.message} (transient — safe to re-run \`tila repos register\`).`;
              if (args.json) {
                printJsonError(msg, "RETRYABLE");
              } else {
                diagnostic(`Error: ${msg}`);
              }
              exit(1);
              return;
            }
            // Any other TilaApiError (e.g. un-typed 403) — surface status +
            // curated message only, never a raw response body/headers.
            const msg = `Registration failed (HTTP ${err.status}): ${err.message}`;
            if (args.json) {
              printJsonError(msg, "UNKNOWN");
            } else {
              diagnostic(`Error: ${msg}`);
            }
            exit(1);
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
              diagnostic(`Error: ${msg}`);
            }
            exit(1);
            return;
          }

          throw err;
        }
      },
    }),
    ...repoPolicyCommands(),
  },
});
