import {
  TokenIssueResponseSchema,
  type TokenListResponse,
  TokenListResponseSchema,
  TokenRevokeResponseSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { TilaApiError } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { credentialPolicyArgs, policyFromArgs } from "../lib/credential-policy";
import {
  boundedItems,
  diagnostic,
  exit,
  jsonArg,
  outputText,
  printJson,
  printJsonError,
  tsToIso,
} from "../lib/output";

export default defineCommand({
  meta: { name: "token", description: "Manage project API tokens" },
  subCommands: {
    issue: defineCommand({
      meta: { name: "issue", description: "Issue a new API token" },
      args: {
        ...credentialPolicyArgs,
        principal: {
          type: "string",
          description: "Service principal ID",
          required: true,
        },
        expires: {
          type: "string",
          description:
            "ISO expiry, Unix seconds, or never; defaults to 90 days",
        },
        jkt: { type: "string", description: "Optional DPoP key thumbprint" },
        name: {
          type: "string",
          description: "Token name (slug format: a-z, 0-9, hyphens)",
        },
        note: {
          type: "string",
          description: "Optional note describing token purpose",
        },
        ...jsonArg,
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
            diagnostic(
              "Error: this command requires a remote connection (tila init)",
            );
          }
          exit(1);
          return;
        }
        const client = requireClient(ctx);
        const name =
          (args.name as string | undefined) ||
          `token-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;

        try {
          const result = await client.post(
            "/api/tokens",
            {
              name,
              note: args.note || undefined,
              principal_id: args.principal,
              policy: policyFromArgs(args),
              jkt: args.jkt || undefined,
              expires_at:
                args.expires === "never"
                  ? null
                  : args.expires
                    ? /^\d+$/.test(String(args.expires))
                      ? Number(args.expires)
                      : Math.floor(Date.parse(String(args.expires)) / 1000)
                    : undefined,
            },
            { schema: TokenIssueResponseSchema, validate: true },
          );

          if (args.json) {
            printJson(result);
            return;
          }

          outputText(`Token issued: ${result.name}\n`);
          outputText(result.token);
          outputText("\nSave this token -- it will not be shown again.");
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 409) {
            if (args.json) {
              printJsonError(
                "A token with this name already exists",
                "CONFLICT",
              );
            }
            diagnostic(
              `Error: A token named "${name}" already exists. Use a different name or revoke the existing token first.`,
            );
            exit(1);
          }
          if (err instanceof TilaApiError && err.status === 403) {
            if (args.json) {
              printJsonError(
                "Insufficient permissions to issue tokens",
                "FORBIDDEN",
              );
            }
            diagnostic(
              "Error: This token does not have permission to issue tokens. Use an owner credential with the required token capability.",
            );
            exit(1);
          }
          throw err;
        }
      },
    }),
    rotate: defineCommand({
      meta: {
        name: "rotate",
        description:
          "Rotate a scoped credential without changing its principal",
      },
      args: {
        name: { type: "positional", required: true },
        "expected-token-id": { type: "string", required: true },
        "overlap-seconds": { type: "string", default: "0" },
        ...jsonArg,
      },
      async run({ args }) {
        const ctx = await resolveContext();
        const client = requireClient(ctx);
        const result = await client.post(
          `/api/tokens/${encodeURIComponent(args.name)}/rotate`,
          {
            expected_token_id: args["expected-token-id"],
            overlap_seconds: Number(args["overlap-seconds"]),
          },
          { schema: TokenIssueResponseSchema, validate: true },
        );
        if (args.json) printJson(result);
        else {
          outputText(
            `Token rotated: ${result.name}\n${result.token}\nSave this token -- it will not be shown again.`,
          );
        }
      },
    }),
    inspect: defineCommand({
      meta: {
        name: "inspect",
        description:
          "Show effective identity, role, capabilities, and restrictions",
      },
      args: { ...jsonArg },
      async run() {
        const ctx = await resolveContext();
        printJson(await requireClient(ctx).get("/api/whoami"));
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
        ...jsonArg,
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
            diagnostic(
              "Error: this command requires a remote connection (tila init)",
            );
          }
          exit(1);
          return;
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
          outputText(
            `Token '${name}' revoked. New requests and derived sessions are rejected immediately.`,
          );
        } catch (err) {
          if (err instanceof TilaApiError && err.status === 404) {
            if (args.json) {
              printJsonError(
                `No active token named "${name}" found`,
                "NOT_FOUND",
              );
            }
            diagnostic(
              `Error: No active token named "${name}" found. Use 'tila token list' to see available tokens.`,
            );
            exit(1);
          }
          if (err instanceof TilaApiError && err.status === 403) {
            if (args.json) {
              printJsonError(
                "Insufficient permissions to revoke tokens",
                "FORBIDDEN",
              );
            }
            diagnostic(
              "Error: This token does not have permission to revoke tokens. Use an owner credential with the required token capability.",
            );
            exit(1);
          }
          throw err;
        }
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List all project tokens" },
      args: {
        ...jsonArg,
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
            diagnostic(
              "Error: this command requires a remote connection (tila init)",
            );
          }
          exit(1);
          return;
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
            diagnostic(
              "Error: This token does not have permission to list tokens. Use an owner credential with the required token capability.",
            );
            exit(1);
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
          outputText("No tokens found.");
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
        outputText(
          [
            "NAME".padEnd(cols.name),
            "SCOPES".padEnd(cols.scopes),
            "CREATED".padEnd(cols.created),
            "LAST USED".padEnd(cols.lastUsed),
            "STATUS".padEnd(cols.status),
          ].join("  "),
        );

        for (const t of boundedItems(result.tokens)) {
          const created = formatTimestamp(t.created_at);
          const lastUsed = t.last_used_at
            ? formatTimestamp(t.last_used_at)
            : "never";
          const status = t.revoked_at ? "revoked" : "active";

          outputText(
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
