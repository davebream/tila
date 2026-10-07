import {
  CredentialConflict,
  CredentialDenied,
  CredentialStore,
} from "@tila/backend-d1";
import { D1SessionStore, D1TokenStore } from "@tila/backend-d1";
import { TokenRotateRequestSchema, policyContains } from "@tila/schemas";
import { TokenIssueRequestSchema } from "@tila/schemas";
import { Hono } from "hono";
import { generateToken, hashToken } from "../lib/hash";
import { nowSeconds } from "../lib/time";
import { zodValidationError } from "../lib/validation";
import { invalidate } from "../middleware/auth";
import {
  credentialManagementGuard,
  denied,
  scopedPolicy,
} from "../middleware/capability";
import { principalIdFor } from "../middleware/request-identity";
import { requireD1TokenHttp } from "../middleware/require-project-admin";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const tokens = new Hono<AppEnv>();

// POST /api/tokens -- Issue a new token
tokens.post("/", async (c) => {
  const authz = await credentialManagementGuard(c, "tokens:issue");
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  const body = await c.req.json();
  const parsed = TokenIssueRequestSchema.safeParse(body);
  if (!parsed.success)
    return zodValidationError(c, parsed.error, "validation-error");

  const { name, note, jkt, principal_id, policy, expires_at } = parsed.data;
  const parentPolicy = scopedPolicy(c);
  const parentJkt =
    tokenResult.kind === "d1-token" || tokenResult.kind === "cookie-session"
      ? tokenResult.cnfJkt
      : undefined;
  if (parentJkt && jkt && parentJkt !== jkt) return denied(c);
  const binding = parentJkt ?? jkt;
  if (principal_id || policy || expires_at !== undefined) {
    if (!principal_id || !policy)
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: "Scoped issuance requires principal_id and policy",
            retryable: false,
          },
        },
        400,
      );
    if (parentPolicy && !policyContains(parentPolicy, policy)) return denied(c);
    const plaintext = await generateToken();
    const tokenHash = await hashToken(plaintext, c.env.HASH_PEPPER);
    const issued = await new CredentialStore(c.env.DB).issue(
      {
        projectId,
        principalId: principal_id,
        name,
        note,
        policy,
        expiresAt: expires_at,
        cnfJkt: binding,
        tokenHash,
      },
      {
        principalId: principalIdFor(tokenResult),
        tokenId: tokenResult.tokenId,
      },
    );
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, token: plaintext, ...issued }, 201);
  }
  // Only the existing full-token compatibility path can mint another full token.
  if (tokenResult.kind !== "d1-token" || tokenResult.scopes !== "full")
    return denied(c);
  const plaintext = await generateToken();
  // SEC-1: pepper at mint so it matches every peppered lookup (auth.ts:614,
  // auth-github app-config, auth-session exchange). Bare here would break
  // validation the moment an operator sets HASH_PEPPER.
  const tokenHash = await hashToken(plaintext, c.env.HASH_PEPPER);
  const createdAt = nowSeconds();

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
      cnfJkt: binding,
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

  c.header("Cache-Control", "no-store");
  return c.json(
    {
      ok: true,
      token: plaintext,
      name,
      created_at: createdAt,
      token_id: tokenId,
      legacy: true,
    },
    201,
  );
});

// DELETE /api/tokens/:name -- Revoke a token
tokens.delete("/:name", async (c) => {
  const authz = await credentialManagementGuard(c, "tokens:revoke");
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;
  const name = c.req.param("name");

  const scopedStore = new CredentialStore(c.env.DB);
  const scoped = await scopedStore.find(projectId, name);
  if (scoped) {
    const parent = scopedPolicy(c);
    if (parent && !policyContains(parent, JSON.parse(scoped.policy_json)))
      return denied(c);
    await scopedStore.revoke(projectId, name, {
      principalId: principalIdFor(tokenResult),
      tokenId: tokenResult.tokenId,
    });
    return c.json({ ok: true, name, revoked_at: nowSeconds() });
  }
  if (scopedPolicy(c)) return denied(c);
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
    revoked_at: nowSeconds(),
  });
});

// GET /api/tokens -- List all tokens for the project
tokens.get("/", async (c) => {
  const authz = await credentialManagementGuard(c, "tokens:read");
  if (authz) return authz;
  const tokenResult = c.get("tokenResult");
  const projectId = tokenResult.projectId;

  const store = new D1TokenStore(c.env.DB);
  const rows = await store.list(projectId);

  return c.json({
    ok: true,
    tokens: [
      ...rows
        .filter((row) => row.scopes !== "scoped-v1")
        .map((row) => ({ ...row, legacy: true })),
      ...(await new CredentialStore(c.env.DB).list(projectId)),
    ],
  });
});

// Rotation is deliberately outside response-idempotency storage: no plaintext
// credential is retained for replay. expected_token_id is the compare-and-swap.
tokens.post("/:name/rotate", async (c) => {
  const authz = await credentialManagementGuard(c, "tokens:rotate");
  if (authz) return authz;
  const parsed = TokenRotateRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return zodValidationError(c, parsed.error);
  const token = c.get("tokenResult");
  const store = new CredentialStore(c.env.DB);
  const row = await store.find(token.projectId, c.req.param("name"));
  if (!row)
    return c.json(
      {
        ok: false,
        error: {
          code: "token-not-found",
          message: "No active scoped credential",
          retryable: false,
        },
      },
      404,
    );
  const policy = scopedPolicy(c);
  if (policy && !policyContains(policy, JSON.parse(row.policy_json)))
    return denied(c);
  const plaintext = await generateToken();
  const hash = await hashToken(plaintext, c.env.HASH_PEPPER);
  const result = await store.rotate(
    token.projectId,
    row.name,
    parsed.data.expected_token_id,
    hash,
    parsed.data.overlap_seconds,
    { principalId: principalIdFor(token), tokenId: token.tokenId },
  );
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, token: plaintext, ...result }, 201);
});

tokens.onError((error, c) => {
  if (
    error instanceof CredentialConflict ||
    error.message.includes("UNIQUE constraint failed")
  )
    return c.json(
      {
        ok: false,
        error: {
          code: "credential-conflict",
          message: "Credential name or version conflicts with current state",
          retryable: false,
        },
      },
      409,
    );
  if (error instanceof CredentialDenied) return denied(c);
  if (error instanceof SyntaxError)
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Malformed JSON body",
          retryable: false,
        },
      },
      400,
    );
  // Drizzle errors may contain bound hash parameters. Never log or echo them.
  return c.json(
    {
      ok: false,
      error: {
        code: "credential-unavailable",
        message: "Credential storage temporarily unavailable",
        retryable: true,
      },
    },
    503,
  );
});
