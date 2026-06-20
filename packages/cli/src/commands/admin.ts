import { defineCommand } from "citty";
import { TilaApiError, type TilaClient } from "tila-sdk";
import { findConfig } from "../config";
import { requireClient, resolveContext } from "../context";
import type { AdminListRow } from "../lib/admin-user-arg";
import { parseGrantArg, resolveRevokeArg } from "../lib/admin-user-arg";
import { createCliClient } from "../lib/client-factory";
import { jsonArg, printJson, printJsonError } from "../lib/output";

/**
 * Token arg shared across all admin subcommands.
 *
 * Precedence: --token > TILA_TOKEN env > resolveContext() token.
 *
 * When the override is present, the client is resolved directly (config
 * worker_url + token via createCliClient) WITHOUT triggering Cloudflare auth
 * steps (verifyCloudflareAuth / checkAccountMatch) and without requiring
 * CLOUDFLARE_API_TOKEN. This is the CI bootstrap escape hatch (C5).
 *
 * Security: prefer TILA_TOKEN (env) over --token — the --token value is
 * visible in `ps aux` to other local users. TILA_TOKEN is a full-scope secret:
 * mask it in CI logs and do NOT set it in persistent shell rc files
 * (.bashrc/.zshrc). The admin commands never persist the token.
 *
 * CI bootstrap: pass the full-scope D1 init token via TILA_TOKEN (preferred)
 * or --token. Example: TILA_TOKEN=<init-token> tila admin grant <user>
 */
const tokenArg = {
  token: {
    type: "string" as const,
    description:
      "Full-scope D1 token override (prefer TILA_TOKEN env var — --token value is visible in ps aux)",
    required: false,
  },
};

interface AdminClient {
  projectId: string;
  client: TilaClient;
}

/**
 * Resolve the admin client and project id.
 *
 * Token precedence: --token > TILA_TOKEN > resolveContext() token.
 * When the override is present, bypasses CF auth steps entirely.
 */
async function resolveAdminClient(args: {
  token?: string | undefined;
  json?: boolean | undefined;
}): Promise<AdminClient | null> {
  const rawToken = (args.token as string | undefined) ?? process.env.TILA_TOKEN;

  if (rawToken) {
    // C5: direct client — no CF auth, no CLOUDFLARE_API_TOKEN required.
    // Warn on interactive --token use (value visible in `ps aux`).
    if (args.token && process.stdout.isTTY) {
      console.warn(
        "Warning: --token value is visible in the process table (ps aux). " +
          "Prefer TILA_TOKEN env var for interactive use.",
      );
    }

    const config = findConfig();
    if (!config) {
      if (args.json) {
        printJsonError(
          "No tila project found. Run tila project create or tila init.",
          "NO_CONFIG",
        );
      } else {
        console.error(
          "Error: no tila project found. Run `tila project create` or `tila init`.",
        );
      }
      return null;
    }
    if (!config.worker_url) {
      if (args.json) {
        printJsonError(
          "No worker_url in config. Run tila project create.",
          "NO_WORKER_URL",
        );
      } else {
        console.error(
          "Error: no worker_url in config. Run `tila project create`.",
        );
      }
      return null;
    }

    return {
      projectId: config.project_id,
      client: createCliClient(config.worker_url, rawToken),
    };
  }

  // No token override — use the standard resolveContext() path (includes CF auth checks).
  const ctx = await resolveContext();
  const client = requireClient(ctx);
  return { projectId: ctx.config.project_id, client };
}

export default defineCommand({
  meta: { name: "admin", description: "Manage project admin roster" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List active project admins" },
      args: {
        ...tokenArg,
        ...jsonArg,
      },
      async run({ args }) {
        // REMOTE_ONLY guard: admin roster routes require a remote connection.
        // Check config backend before resolving the client (cheap check first).
        const rawToken =
          (args.token as string | undefined) ?? process.env.TILA_TOKEN;
        if (!rawToken) {
          const ctx = await resolveContext();
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
          const client = requireClient(ctx);
          const projectId = ctx.config.project_id;
          await runAdminList(client, projectId, args);
          return;
        }

        const resolved = await resolveAdminClient(args);
        if (!resolved) {
          process.exit(1);
          return;
        }
        await runAdminList(resolved.client, resolved.projectId, args);
      },
    }),

    grant: defineCommand({
      meta: {
        name: "grant",
        description: "Grant admin access to a GitHub user",
      },
      args: {
        user: {
          type: "positional",
          description:
            "GitHub user id (numeric) or login to grant admin access",
          required: true,
        },
        ...tokenArg,
        ...jsonArg,
      },
      async run({ args }) {
        const rawToken =
          (args.token as string | undefined) ?? process.env.TILA_TOKEN;
        if (!rawToken) {
          const ctx = await resolveContext();
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
          const client = requireClient(ctx);
          const projectId = ctx.config.project_id;
          await runAdminGrant(client, projectId, args.user as string, args);
          return;
        }

        const resolved = await resolveAdminClient(args);
        if (!resolved) {
          process.exit(1);
          return;
        }
        await runAdminGrant(
          resolved.client,
          resolved.projectId,
          args.user as string,
          args,
        );
      },
    }),

    revoke: defineCommand({
      meta: {
        name: "revoke",
        description: "Revoke admin access from a GitHub user",
      },
      args: {
        user: {
          type: "positional",
          description:
            "GitHub user id (numeric) or login to revoke admin access",
          required: true,
        },
        ...tokenArg,
        ...jsonArg,
      },
      async run({ args }) {
        const rawToken =
          (args.token as string | undefined) ?? process.env.TILA_TOKEN;
        if (!rawToken) {
          const ctx = await resolveContext();
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
          const client = requireClient(ctx);
          const projectId = ctx.config.project_id;
          await runAdminRevoke(client, projectId, args.user as string, args);
          return;
        }

        const resolved = await resolveAdminClient(args);
        if (!resolved) {
          process.exit(1);
          return;
        }
        await runAdminRevoke(
          resolved.client,
          resolved.projectId,
          args.user as string,
          args,
        );
      },
    }),
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared operation helpers (used by both the standard and token-override paths)
// ─────────────────────────────────────────────────────────────────────────────

async function runAdminList(
  client: TilaClient,
  projectId: string,
  args: Record<string, unknown>,
): Promise<void> {
  try {
    const result = (await client.get(`/projects/${projectId}/admins`)) as {
      ok: boolean;
      admins: AdminListRow[];
    };

    if (args.json) {
      printJson(result);
      return;
    }

    const admins = result.admins;
    if (admins.length === 0) {
      console.log("No active admins.");
      return;
    }

    for (const admin of admins) {
      const login = admin.login ? ` (@${admin.login})` : "";
      const grantedBy = admin.granted_by ? ` by ${admin.granted_by}` : "";
      console.log(
        `  ${admin.github_user_id}${login} — granted${grantedBy} at ${new Date(admin.granted_at * 1000).toISOString()}`,
      );
    }
  } catch (err) {
    if (err instanceof TilaApiError) {
      const msg = `List failed (HTTP ${err.status}): ${err.message}`;
      if (args.json) {
        printJsonError(msg, "API_ERROR");
      } else {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
      return;
    }
    throw err;
  }
}

async function runAdminGrant(
  client: TilaClient,
  projectId: string,
  user: string,
  args: Record<string, unknown>,
): Promise<void> {
  const body = parseGrantArg(user);

  try {
    const result = (await client.post(
      `/projects/${projectId}/admins`,
      body,
    )) as { ok: boolean; github_user_id: number; granted: boolean };

    if (args.json) {
      printJson(result);
      return;
    }

    const label =
      "login" in body
        ? `@${body.login} (id: ${result.github_user_id})`
        : `${result.github_user_id}`;
    if (result.granted) {
      console.log(`Granted admin access to ${label}.`);
    } else {
      console.log(
        `${label} is already an active admin (idempotent — no change).`,
      );
    }
  } catch (err) {
    if (err instanceof TilaApiError) {
      const msg = `Grant failed (HTTP ${err.status}): ${err.message}`;
      if (args.json) {
        printJsonError(msg, "API_ERROR");
      } else {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
      return;
    }
    throw err;
  }
}

async function runAdminRevoke(
  client: TilaClient,
  projectId: string,
  user: string,
  args: Record<string, unknown>,
): Promise<void> {
  let githubUserId: number;

  if (/^\d+$/.test(user)) {
    githubUserId = Number(user);
  } else {
    // Login input — fetch the current roster for id resolution.
    // TOCTOU note: this is a client-side best-effort snapshot — there is a
    // window between the list call and the DELETE. The server's idempotent
    // soft-delete is the safety net if the admin was concurrently removed.
    let snapshot: AdminListRow[] | null = null;
    try {
      const listResult = (await client.get(
        `/projects/${projectId}/admins`,
      )) as { ok: boolean; admins: AdminListRow[] };
      snapshot = listResult.admins;
    } catch {
      // Snapshot fetch failed — resolveRevokeArg will return an error
    }

    const resolved = resolveRevokeArg(user, snapshot);
    if ("error" in resolved) {
      if (args.json) {
        printJsonError(resolved.error, "RESOLVE_ERROR");
      } else {
        console.error(`Error: ${resolved.error}`);
      }
      process.exit(1);
      return;
    }
    githubUserId = resolved.id;
  }

  try {
    const result = (await client.delete(
      `/projects/${projectId}/admins/${githubUserId}`,
    )) as { ok: boolean; github_user_id: number; revoked: boolean };

    if (args.json) {
      printJson(result);
      return;
    }

    if (result.revoked) {
      console.log(`Revoked admin access from ${githubUserId}.`);
    } else {
      console.log(`${githubUserId} was not an active admin (no change).`);
    }
  } catch (err) {
    if (err instanceof TilaApiError) {
      // Surface last-admin (409) verbatim — actionable message from server
      const msg = `Revoke failed (HTTP ${err.status}): ${err.message}`;
      if (args.json) {
        printJsonError(msg, err.status === 409 ? "LAST_ADMIN" : "API_ERROR");
      } else {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
      return;
    }
    throw err;
  }
}
