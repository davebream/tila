import type { RequestOrigin } from "@tila/ops-sqlite";
import type { EnvironmentMetadata } from "@tila/schemas";

export function originFromBody(body: Record<string, unknown>): RequestOrigin {
  const principalId = body.principal_id;
  const participantId = body.participant_id;
  if (typeof principalId !== "string" || typeof participantId !== "string") {
    throw new Error("Canonical request identity is required");
  }
  const environment =
    body.environment && typeof body.environment === "object"
      ? (body.environment as EnvironmentMetadata)
      : {};
  return {
    principalId,
    participantId,
    environment,
    actor: principalId,
    tokenId:
      typeof body.actor_token_id === "string" ? body.actor_token_id : null,
    source: environment.client_name ?? null,
    sourceVersion: environment.client_version ?? null,
  };
}

export function systemOrigin(name: string): RequestOrigin {
  const id = `system:${name}`;
  return {
    principalId: id,
    participantId: id,
    environment: {},
    actor: id,
    tokenId: null,
    source: null,
    sourceVersion: null,
  };
}
