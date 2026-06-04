import {
  TokenIssueResponseSchema,
  type TokenListResponse,
  TokenListResponseSchema,
  TokenRevokeResponseSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { printJson, printJsonError, tsToIso } from "../lib/output";

export default defineCommand({
  meta: { name: "token", description: "Manage project API tokens" },
  subCommands: {
    issue: defineCommand({
      meta: { name: "issue", description: "Issue a new API token" },
      args: {
        name: {
          type: "string",
          description: "Token name (slug format: a-z, 0-9, hyphens)",
        },
        note: {
          type: "string",
          description: "Optional note describing token purpose",
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
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
        }
        const client = requireClient(ctx);
        const name =
          (args.name as string | undefined) ||
          `token-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

        try {
          const result = await client.post(
            "/api/tokens",
            { name, note: args.note || undefined },
            { schema: TokenIssueResponseSchema, validate: true },
          );

          if (args.json) {
            printJson({ ok: true, name: result.name, token: result.token });
            return;
          }

          console.log(`Token issued: ${result.name}\n`);
          console.log(result.token);
          console.log("\nSave this token -- it will not be shown again.");
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 409) {
            if (args.json) {
              printJsonError(
                "A token with this name already exists",
                "CONFLICT",
              );
            }
            console.error(
              `Error: A token named "${name}" already exists. Use a different name or revoke the existing token first.`,
            );
            process.exit(1);
          }
          if (err instanceof TilaApiError && err.status === 403) {
            if (args.json) {
              printJsonError(
                "Insufficient permissions to issue tokens",
                "FORBIDDEN",
              );
            }
            console.error(
              "Error: This token does not have permission to issue tokens. Use a token with full scope.",
            );
            process.exit(1);
          }
          throw err;
        }
      },
    }),
    revoke: defineCommand({
      meta: { name: "revoke", description: "Revoke an API token" },
      args: {
        name: {
          type: "positional",
          description: "Token name to revoke",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
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
        }
        const client = requireClient(ctx);
        const name = args.name as string;

        try {
          await client.delete(`/api/tokens/${encodeURIComponent(name)}`, {
            schema: TokenRevokeResponseSchema,
            validate: true,
          });
          if (args.json) {
            printJson({ ok: true, name });
            return;
          }
          console.log(
            `Token '${name}' revoked. Note: revocation may take up to 60 seconds to propagate across all active sessions.`,
          );
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 404) {
            if (args.json) {
              printJsonError(
                `No active token named "${name}" found`,
                "NOT_FOUND",
              );
            }
            console.error(
              `Error: No active token named "${name}" found. Use 'tila token list' to see available tokens.`,
            );
            process.exit(1);
          }
          if (err instanceof TilaApiError && err.status === 403) {
            if (args.json) {
              printJsonError(
                "Insufficient permissions to revoke tokens",
                "FORBIDDEN",
              );
            }
            console.error(
              "Error: This token does not have permission to revoke tokens. Use a token with full scope.",
            );
            process.exit(1);
          }
          throw err;
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List all project tokens" },
      args: {
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      async run({ args }) {
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
        }
        const client = requireClient(ctx);
        let result: TokenListResponse;
        try {
          result = await client.get("/api/tokens", {
            schema: TokenListResponseSchema,
            validate: true,
          });
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 403) {
            if (args.json) {
              printJsonError(
                "Insufficient permissions to list tokens",
                "FORBIDDEN",
              );
            }
            console.error(
              "Error: This token does not have permission to list tokens. Use a token with full scope.",
            );
            process.exit(1);
          }
          throw err;
        }

        if (args.json) {
          printJson({
            tokens: result.tokens.map((t) => ({
              ...t,
              created_at: tsToIso(t.created_at * 1000),
              last_used_at: t.last_used_at
                ? tsToIso(t.last_used_at * 1000)
                : null,
              revoked_at: t.revoked_at ? tsToIso(t.revoked_at * 1000) : null,
            })),
          });
          return;
        }

        if (result.tokens.length === 0) {
          console.log("No tokens found.");
          return;
        }

        // Header
        const cols = {
          name: 16,
          scopes: 8,
          created: 20,
          lastUsed: 20,
          status: 10,
        };
        console.log(
          [
            "NAME".padEnd(cols.name),
            "SCOPES".padEnd(cols.scopes),
            "CREATED".padEnd(cols.created),
            "LAST USED".padEnd(cols.lastUsed),
            "STATUS".padEnd(cols.status),
          ].join("  "),
        );

        for (const t of result.tokens) {
          const created = formatTimestamp(t.created_at);
          const lastUsed = t.last_used_at
            ? formatTimestamp(t.last_used_at)
            : "never";
          const status = t.revoked_at ? "revoked" : "active";

          console.log(
            [
              t.name.padEnd(cols.name),
              t.scopes.padEnd(cols.scopes),
              created.padEnd(cols.created),
              lastUsed.padEnd(cols.lastUsed),
              status.padEnd(cols.status),
            ].join("  "),
          );
        }
      },
    }),
  },
});

function formatTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
