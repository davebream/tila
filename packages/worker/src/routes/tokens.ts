import { D1SessionStore, D1TokenStore } from "@tila/backend-d1";
import { TokenIssueRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { generateToken, hashToken } from "../lib/hash";
import { zodValidationError } from "../lib/validation";
import { invalidate } from "../middleware/auth";
import { requireProjectAdminHttp } from "../middleware/require-project-admin";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const tokens = new Hono<AppEnv>();

// POST /api/tokens -- Issue a new token
tokens.post("/", async (c) => {
  const authz = await requireProjectAdminHttp(c);
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  const body = await c.req.json();
  const parsed = TokenIssueRequestSchema.safeParse(body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "validation-error");

  const { name, note } = parsed.data;
  const plaintext = generateToken();
  // SEC-1: pepper at mint so it matches every peppered lookup (auth.ts:614,
  // auth-github app-config, auth-session exchange). Bare here would break
  // validation the moment an operator sets HASH_PEPPER.
  const tokenHash = await hashToken(plaintext, c.env.HASH_PEPPER);
  const createdAt = Math.floor(Date.now() / 1000);

  const store = new D1TokenStore(c.env.DB);
  let tokenId: string;
  try {
    const result = await store.issue({
      tokenHash,
      projectId,
      name,
      note,
      createdBy: tokenResult.name,
      createdAt,
    });
    tokenId = result.tokenId;
  } catch (err) {
    // D1 UNIQUE constraint violation on (project_id, name) WHERE revoked_at IS NULL
    if (
      err instanceof Error &&
      err.message.includes("UNIQUE constraint failed")
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: "token-name-conflict",
            message: "A token with this name already exists",
            retryable: false,
          },
        },
        409,
      );
    }
    throw err;
  }

  return c.json(
    {
      ok: true,
      token: plaintext,
      name,
      created_at: createdAt,
      token_id: tokenId,
    },
    201,
  );
});

// DELETE /api/tokens/:name -- Revoke a token
tokens.delete("/:name", async (c) => {
  const authz = await requireProjectAdminHttp(c);
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;
  const name = c.req.param("name");

  const store = new D1TokenStore(c.env.DB);
  const { revoked, tokenHash } = await store.revoke(
    projectId,
    name,
    tokenResult.name, // revokedBy -- T3 parameter
  );

  if (!revoked) {
    return c.json(
      {
        ok: false,
        error: {
          code: "token-not-found",
          message: "No active token with that name",
          retryable: false,
        },
      },
      404,
    );
  }

  // Synchronous cache invalidation -- clears before response (contracts.md Invariant 4)
  if (tokenHash !== null) {
    invalidate(tokenHash);
    // Cascade: delete all sessions minted from this token
    const sessionStore = new D1SessionStore(c.env.DB);
    await sessionStore.deleteByTokenHash(tokenHash);
  }

  return c.json({
    ok: true,
    name,
    revoked_at: Math.floor(Date.now() / 1000),
  });
});

// GET /api/tokens -- List all tokens for the project
tokens.get("/", async (c) => {
  const authz = await requireProjectAdminHttp(c);
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  const store = new D1TokenStore(c.env.DB);
  const rows = await store.list(projectId);

  return c.json({
    ok: true,
    tokens: rows,
  });
});
