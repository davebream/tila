import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import type { AdminListRow } from "../lib/admin-user-arg";
import { parseGrantArg, resolveRevokeArg } from "../lib/admin-user-arg";
import { jsonArg, printJson, printJsonError } from "../lib/output";

export default defineCommand({
  meta: { name: "admin", description: "Manage project admin roster" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List active project admins" },
      args: {
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // REMOTE_ONLY guard: admin roster routes require a remote connection.
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

        try {
          const result = (await client.get(
            `/projects/${projectId}/admins`,
          )) as { ok: boolean; admins: AdminListRow[] };

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
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // REMOTE_ONLY guard
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
        const user = args.user as string;
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
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();

        // REMOTE_ONLY guard
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
        const user = args.user as string;

        // Resolve the user arg to a numeric id.
        // For login inputs: fetch the current roster as a snapshot and find the id.
        // TOCTOU note: this is a client-side best-effort snapshot — there is a
        // window between the list call and the DELETE. The server's idempotent
        // soft-delete is the safety net if the admin was concurrently removed.
        let githubUserId: number;

        if (/^\d+$/.test(user)) {
          githubUserId = Number(user);
        } else {
          // Login input — fetch the current roster for id resolution
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
              printJsonError(
                msg,
                err.status === 409 ? "LAST_ADMIN" : "API_ERROR",
              );
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
