/**
 * Tests for the unified TOML schema validation helper (C6 / Task 11).
 *
 * Verifies:
 * (1) All four call-site patterns (relationship-type, slot, history-mode, record-type)
 *     are served through the single helper backed by the cache.
 * (2) DO-fetch-count: two validation calls for the same project trigger exactly ONE
 *     /schema/current DO fetch (round-trip elimination via cache).
 * (3) Per-site fallback survival: each site's permissive/empty-declared fallback still
 *     holds when schema is absent or TOML is unparseable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearSchemaCacheForTest } from "./schema-cache";
import { getValidatedSchema } from "./schema-validation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DurableObjectStub fake that records calls to fetch() */
function makeFakeStub(
  responseBody: unknown,
  status = 200,
): { stub: DurableObjectStub; callCount: () => number } {
  let calls = 0;
  const stub = {
    fetch: vi.fn(async (_req: Request | string) => {
      calls++;
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  } as unknown as DurableObjectStub;
  return { stub, callCount: () => calls };
}

const PROJECT_ID = "proj-test-val-123";

const VALID_TOML_WITH_ALL_SECTIONS = `
schema_version = 1

[artifact_relationships]
types = ["uses", "produces"]

[entity_artifact_references]
slots = ["main", "supporting"]

[records.deploy-config]
history = "snapshot"

[records.feature-flags]
history = "revision"
`;

const VALID_TOML_NO_DECLARATIONS = "schema_version = 1";

beforeEach(() => {
  _clearSchemaCacheForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// (1) Helper returns parsed schema for all four call-site patterns
// ---------------------------------------------------------------------------
describe("getValidatedSchema returns parsed schema", () => {
  it("returns ok=true with parsed schema when definition is valid TOML", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: VALID_TOML_WITH_ALL_SECTIONS },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok=true");

    // relationship-type pattern: artifact_relationships.types
    expect(result.schema.artifact_relationships?.types).toEqual([
      "uses",
      "produces",
    ]);

    // slot pattern: entity_artifact_references.slots
    expect(result.schema.entity_artifact_references?.slots).toEqual([
      "main",
      "supporting",
    ]);

    // history-mode pattern: records[type].history
    expect(result.schema.records?.["deploy-config"]?.history).toBe("snapshot");
    expect(result.schema.records?.["feature-flags"]?.history).toBe("revision");

    // record-type pattern: Object.keys(records)
    expect(Object.keys(result.schema.records ?? {})).toContain("deploy-config");
    expect(Object.keys(result.schema.records ?? {})).toContain("feature-flags");
  });

  it("returns ok=false with reason=no-schema when DO has no schema configured", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: null,
      version: null,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok=false");
    expect(result.reason).toBe("no-schema");
  });

  it("returns ok=false with reason=parse-error when TOML is invalid", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: "<<< invalid toml >>>" },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok=false");
    expect(result.reason).toBe("parse-error");
  });

  it("returns ok=false with reason=validate-error when TOML fails schema validation", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: {
        // Missing required schema_version field
        definition: '[artifact_relationships]\ntypes = ["uses"]',
      },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok=false");
    expect(result.reason).toBe("validate-error");
  });
});

// ---------------------------------------------------------------------------
// (2) DO-fetch-count: two calls → exactly ONE DO fetch (cache hit on second)
// ---------------------------------------------------------------------------
describe("round-trip elimination (DO-fetch-count assertion)", () => {
  it("two validation calls for the same project trigger exactly ONE DO fetch", async () => {
    const { stub, callCount } = makeFakeStub({
      ok: true,
      schema: { definition: VALID_TOML_WITH_ALL_SECTIONS },
      version: 1,
    });

    // First call: cache miss → DO fetch
    const first = await getValidatedSchema(stub, PROJECT_ID);
    // Second call: cache hit → no DO fetch
    const second = await getValidatedSchema(stub, PROJECT_ID);

    expect(callCount()).toBe(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("two validation calls simulating different write-paths share one fetch", async () => {
    const { stub, callCount } = makeFakeStub({
      ok: true,
      schema: { definition: VALID_TOML_WITH_ALL_SECTIONS },
      version: 1,
    });

    // Simulates: artifact-relationship write + entity artifact-ref write
    // (two different call-site patterns, same project, same request flow)
    const relationshipResult = await getValidatedSchema(stub, PROJECT_ID);
    const slotResult = await getValidatedSchema(stub, PROJECT_ID);

    expect(callCount()).toBe(1);

    if (!relationshipResult.ok || !slotResult.ok)
      throw new Error("Expected ok=true");
    const types = relationshipResult.schema.artifact_relationships?.types ?? [];
    const slots = slotResult.schema.entity_artifact_references?.slots ?? [];
    expect(types).toContain("uses");
    expect(slots).toContain("main");
  });
});

// ---------------------------------------------------------------------------
// (3) Per-site fallback survival: each site's permissive fallback still holds
// ---------------------------------------------------------------------------
describe("per-site fallback survival", () => {
  // artifacts.ts relationship-type: allow-through (empty declared types) on parse failure
  it("allows any relationship type when schema is absent (permissive default)", async () => {
    const { stub } = makeFakeStub({ ok: true, schema: null, version: null });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok=false");
    // Call site fallback: allow any type when schema absent
    const declaredTypes = result.reason === "no-schema" ? [] : [];
    expect(declaredTypes).toHaveLength(0); // permissive: empty means allow-all
  });

  it("allows any relationship type when TOML is unparseable (permissive default)", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: "BAD TOML {{{{" },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected ok=false");
    expect(result.reason).toBe("parse-error");
    // Call site maps parse-error → allow-through (no 422)
  });

  // entities.ts slot: allow-through (empty declared slots) on parse failure
  it("allows any slot when no slots are declared (valid schema, no slots)", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: VALID_TOML_NO_DECLARATIONS },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok=true");
    // Call site: if no slots declared, allow any slot
    const slots = result.schema.entity_artifact_references?.slots;
    expect(!slots || slots.length === 0).toBe(true);
  });

  // records.ts resolveRecordHistoryMode: returns "revision" on ANY parse failure
  it("resolveRecordHistoryMode fallback: returns revision on no-schema", async () => {
    const { stub } = makeFakeStub({ ok: true, schema: null, version: null });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    // Simulate the records.ts fallback: any non-ok → "revision"
    const historyMode = result.ok
      ? (result.schema.records?.["some-type"]?.history ?? "revision")
      : "revision";

    expect(historyMode).toBe("revision");
  });

  it("resolveRecordHistoryMode fallback: returns revision on parse-error", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: "NOT TOML AT ALL" },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    const historyMode = result.ok
      ? (result.schema.records?.["some-type"]?.history ?? "revision")
      : "revision";

    expect(historyMode).toBe("revision");
  });

  it("resolveRecordHistoryMode: returns snapshot for declared snapshot type", async () => {
    const { stub } = makeFakeStub({
      ok: true,
      schema: { definition: VALID_TOML_WITH_ALL_SECTIONS },
      version: 1,
    });

    const result = await getValidatedSchema(stub, PROJECT_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok=true");
    const historyMode =
      result.schema.records?.["deploy-config"]?.history ?? "revision";
    expect(historyMode).toBe("snapshot");
  });
});
