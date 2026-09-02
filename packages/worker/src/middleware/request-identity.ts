import {
  type EnvironmentMetadata,
  EnvironmentMetadataSchema,
  ParticipantIdSchema,
} from "@tila/schemas";
import type { MiddlewareHandler } from "hono";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function canonicalIssuer(rawIssuer: string): string {
  const issuer = new URL(rawIssuer);
  issuer.protocol = issuer.protocol.toLowerCase();
  issuer.hostname = issuer.hostname.toLowerCase();
  issuer.search = "";
  issuer.hash = "";
  return issuer.toString().replace(/\/$/, "");
}

export function principalIdFor(token: UnifiedTokenResult): string {
  switch (token.kind) {
    case "d1-token":
      return `token:${token.tokenId}`;
    case "session": {
      if (token.githubUserId === undefined || !token.githubHost) {
        throw new Error(
          "Authenticated GitHub session has no immutable subject",
        );
      }
      return `github:${token.githubHost.trim().toLowerCase()}:${token.githubUserId}`;
    }
    case "oidc-session":
      return `oidc:${canonicalIssuer(token.oidcIssuer)}:${token.oidcSubject}`;
    case "cookie-session":
    case "workspace-session":
      if (!token.principalId) {
        throw new Error("Browser session has no immutable subject");
      }
      return token.principalId;
  }
}

function environmentFromHeaders(
  header: (name: string) => string | undefined,
  source: string | undefined,
  sourceVersion: string | null | undefined,
): EnvironmentMetadata {
  const candidate = {
    machine: header("X-Tila-Machine"),
    repository: header("X-Tila-Repository"),
    worktree: header("X-Tila-Worktree"),
    branch: header("X-Tila-Branch"),
    commit: header("X-Tila-Commit"),
    client_name: source,
    client_version: sourceVersion ?? undefined,
  };
  return EnvironmentMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(candidate).filter(([, value]) => value !== undefined),
    ),
  );
}

/** Resolve immutable auth identity and validate participant/environment headers. */
export function requestIdentityMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: HonoVariables;
}> {
  return async (c, next) => {
    let principalId: string;
    try {
      principalId = principalIdFor(c.get("tokenResult"));
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message:
              "Authenticated session has no canonical principal; sign in again.",
            retryable: false,
          },
        },
        401,
      );
    }

    const rawParticipant = c.req.header("X-Tila-Participant-Id");
    const parsedParticipant = ParticipantIdSchema.safeParse(rawParticipant);
    // Schema preview is read-only even though it uses POST.
    const isMutation =
      MUTATING_METHODS.has(c.req.method) &&
      !c.req.path.endsWith("/schema/preview");

    if (isMutation && !parsedParticipant.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "participant-required",
            message:
              "X-Tila-Participant-Id is required for project mutations. Upgrade your tila client or provide a stable participant ID.",
            retryable: false,
          },
        },
        400,
      );
    }

    let environment: EnvironmentMetadata;
    try {
      environment = environmentFromHeaders(
        (name) => c.req.header(name),
        c.get("source"),
        c.get("sourceVersion"),
      );
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "invalid-environment",
            message: "One or more X-Tila environment headers are invalid.",
            retryable: false,
          },
        },
        400,
      );
    }

    c.set("principalId", principalId);
    if (parsedParticipant.success) {
      c.set("participantId", parsedParticipant.data);
    }
    c.set("environment", environment);
    await next();
  };
}

export function identityPayload(c: {
  get(key: "principalId"): string | undefined;
  get(key: "participantId"): string | undefined;
  get(key: "environment"): EnvironmentMetadata | undefined;
  get(key: "tokenResult"): UnifiedTokenResult;
}) {
  const principalId = c.get("principalId");
  const participantId = c.get("participantId");
  if (!principalId || !participantId) {
    throw new Error("Canonical request identity is required");
  }
  return {
    principal_id: principalId,
    participant_id: participantId,
    environment: c.get("environment") ?? {},
    actor_token_id: c.get("tokenResult").tokenId || null,
  };
}
