import { describe, expect, it } from "vitest";

/**
 * Entity-artifact references and artifact relationship integration tests.
 *
 * DO-level tests validate the ops functions via better-sqlite3.
 * Worker-level tests are documented as stubs awaiting @cloudflare/vitest-pool-workers setup.
 */

describe("entity-artifact references (DO ops)", () => {
  it.todo(
    "insertEntityArtifactReference creates a row with correct entity_id, artifact_key, slot",
  );

  it.todo(
    "insertEntityArtifactReference emits entity.artifact.referenced journal event",
  );

  it.todo(
    "insertEntityArtifactReference is idempotent (INSERT OR IGNORE on PK)",
  );

  it.todo(
    "insertEntityArtifactReference with non-existent entity_id throws FK violation",
  );

  it.todo(
    "insertEntityArtifactReference with non-existent artifact_key throws FK violation",
  );

  it.todo(
    "listEntityArtifactReferences returns all refs for a given entity_id",
  );

  it.todo(
    "listEntityArtifactReferences returns empty array for unknown entity_id",
  );
});

describe("artifact relationships (DO ops)", () => {
  it.todo("addArtifactRelationship creates a row with from_key, to_key, type");

  it.todo(
    "addArtifactRelationship supports to_uri (external URI) when to_key is null",
  );

  it.todo(
    "addArtifactRelationship emits artifact.relationship.added journal event",
  );

  it.todo("addArtifactRelationship is idempotent (INSERT OR IGNORE)");

  it.todo("listArtifactRelationships returns all relationships for a from_key");
});

describe("Worker slot validation", () => {
  it.todo(
    "POST entity artifact-ref with valid slot (declared in schema TOML) returns 201",
  );

  it.todo(
    "POST entity artifact-ref with invalid slot returns 422 with error code invalid-slot",
  );

  it.todo(
    "POST entity artifact-ref with no schema applied allows any slot (permissive default)",
  );

  it.todo(
    "POST entity artifact-ref with schema that has no slots declared allows any slot",
  );
});

describe("Worker relationship type validation", () => {
  it.todo(
    "POST artifact relationship with valid type (declared in schema TOML) returns 201",
  );

  it.todo(
    "POST artifact relationship with invalid type returns 422 with error code invalid-relationship-type",
  );

  it.todo(
    "POST artifact relationship with no schema applied allows any type (permissive default)",
  );
});

describe("FK error surfacing", () => {
  it.todo(
    "POST entity artifact-ref with non-existent artifact_key returns 404 (not 500)",
  );

  it.todo(
    "POST artifact relationship with non-existent from_key returns 404 (not 500)",
  );
});

describe("End-to-end flow (stubs -- awaiting pool-workers)", () => {
  it.todo(
    "create entity -> upload artifact -> add artifact-ref with valid slot -> list refs -> ref appears",
  );

  it.todo(
    "upload two artifacts -> add relationship -> list relationships -> relationship appears",
  );
});
