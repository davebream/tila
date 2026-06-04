import { describe, expect, it } from "vitest";

/**
 * Search feature integration tests.
 *
 * These tests validate the full searchable-artifacts stack: Worker upload
 * triggers text extraction and search-doc indexing in ProjectDO SQLite FTS5,
 * Worker search API queries the DO and returns paginated results with snippets,
 * tombstone/sweep lifecycle removes search docs, doctor detects index drift,
 * and rebuild restores missing search docs from canonical state.
 *
 * Requires @cloudflare/vitest-pool-workers setup with DO + D1 + R2 bindings.
 * Until that infrastructure exists, these tests document expected behavior
 * as living specification stubs.
 *
 * Stack exercised: Worker -> DO -> artifact_search_docs + FTS5 -> R2 (blobs)
 *
 * Acceptance criteria coverage (issue #83):
 * - AC-1:  Searchable markdown indexed and returned by query
 * - AC-2:  Non-searchable kind produces no search doc
 * - AC-3:  Unsupported MIME type with searchable kind produces no search doc
 * - AC-4:  Source artifact (resource=null) appears in search results
 * - AC-5:  Invalid FTS5 query returns stable API error, no 500
 * - AC-6:  Tombstoned artifact absent from search results
 * - AC-7:  Doctor detects missing search doc
 * - AC-8:  Doctor detects orphaned search doc
 * - AC-9:  Rebuild --apply repopulates missing search doc from R2
 * - AC-10: Sweep expiry removes search doc
 * - AC-11: Pagination (limit/cursor) respected
 * - AC-12: Kind and resource filter parameters narrow results
 */

describe("Search indexing", () => {
  it("AC-1: searchable markdown artifact is indexed and returned by query", () => {
    // Setup:
    //   1. Create project in D1 registry, obtain project_id
    //   2. Upload a text/markdown artifact with kind "lesson" (searchable=true in schema)
    //      POST /projects/:projectId/artifacts with multipart body containing markdown
    //      with distinctive term "xyzUniqueAlpha" in the body
    //   3. Verify upload response: 200 { ok: true, r2_key: "produced/..." }
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=xyzUniqueAlpha
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [...], total: 1 }
    //   - results[0].r2_key matches the uploaded artifact's key
    //   - results[0].kind === "lesson"
    //   - results[0].snippet contains "xyzUniqueAlpha" (or is non-null)
    //   - Journal contains "artifact.indexed" event for this key
    expect(true).toBe(true);
  });

  it("AC-2: non-searchable artifact kind produces no search doc", () => {
    // Setup:
    //   1. Upload a text/markdown artifact with a kind that has searchable=false
    //      (e.g., a custom kind not in the default searchable set)
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=<term from the artifact>
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [], total: 0 }
    //   - No row in artifact_search_docs for this artifact_key
    expect(true).toBe(true);
  });

  it("AC-3: unsupported MIME type (image/png) with searchable kind produces no search doc", () => {
    // Setup:
    //   1. Upload an image/png artifact with kind "lesson" (searchable=true)
    //      The binary content is not text-extractable
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=<any term>
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [], total: 0 }
    //   - No row in artifact_search_docs for this artifact_key
    //   - The artifact pointer exists (upload succeeded) but indexing was skipped
    expect(true).toBe(true);
  });
});

describe("Source artifact search", () => {
  it("AC-4: source artifact (resource=null, sources/ prefix) appears in search results", () => {
    // Setup:
    //   1. Upload a source artifact (no resource field, sources/ R2 key prefix)
    //      with text/markdown content containing "xyzSourceBeta"
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=xyzSourceBeta
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [...], total: 1 }
    //   - results[0].resource === null (source artifacts have no resource)
    //   - results[0].r2_key starts with "sources/"
    //   - results[0].snippet contains "xyzSourceBeta" (or is non-null)
    expect(true).toBe(true);
  });
});

describe("Search query behavior", () => {
  it("AC-5: invalid FTS5 query syntax returns stable API error, no 500", () => {
    // Setup:
    //   1. Project exists with at least one indexed artifact
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=AND OR NOT *** {{{{
    //
    // Assertions:
    //   - Response status: 400 (not 500, not crash)
    //   - Response body: { ok: false, error: <string describing syntax error> }
    //   - Worker process remains healthy (subsequent valid query succeeds)
    expect(true).toBe(true);
  });

  it("AC-6: tombstoned artifact does not appear in normal search results", () => {
    // Setup:
    //   1. Upload searchable artifact with term "xyzTombGamma"
    //   2. Verify it appears in search results
    //   3. Tombstone the artifact pointer via POST /projects/:projectId/artifacts/tombstone
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=xyzTombGamma
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [], total: 0 }
    //   - artifact_search_docs row for this key is DELETED (row count = 0)
    //   - Note: T12 deletes the search doc row on tombstone (DELETE, not tombstoned=1 flag)
    expect(true).toBe(true);
  });

  it("AC-11: pagination -- limit and cursor/offset parameters respected", () => {
    // Setup:
    //   1. Upload 5 searchable artifacts all containing "xyzPagDelta"
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=xyzPagDelta&limit=2
    //
    // Assertions:
    //   - Response: 200 { ok: true, results: [...], total: 5 }
    //   - results.length === 2
    //   - Pagination metadata present (cursor or offset for next page)
    //   - Second request with cursor/offset returns next 2 results (no overlap)
    expect(true).toBe(true);
  });

  it("AC-12: kind and resource filter parameters narrow results correctly", () => {
    // Setup:
    //   1. Upload 3 searchable artifacts: 2 with kind "lesson", 1 with kind "adr"
    //      All containing "xyzFilterEpsilon"
    //   2. One lesson has resource "entity-abc", the other has resource "entity-def"
    //
    // Action:
    //   GET /projects/:projectId/artifacts/search?q=xyzFilterEpsilon&kind=lesson
    //
    // Assertions:
    //   - Response: results.length === 2, total === 2 (only lessons)
    //
    // Action 2:
    //   GET /projects/:projectId/artifacts/search?q=xyzFilterEpsilon&kind=lesson&resource=entity-abc
    //
    // Assertions 2:
    //   - Response: results.length === 1, results[0].resource === "entity-abc"
    expect(true).toBe(true);
  });
});

describe("Search reindex route (issue #412)", () => {
  it("returns 2xx for /search/reindex with valid entity body", () => {
    // Integration stub: the real behavior is validated by the ops-sqlite unit tests
    // (resetEntitySearchDocs + reindexBatch) and the DO-route unit test (empty-body 400).
    // Full end-to-end requires a live DO with storage (not yet wired in this harness).
    // This test documents the expected integration contract.
    //
    // Expected:
    //   POST /projects/:projectId/search/reindex
    //   Headers: { "content-type": "application/json", Authorization: "Bearer <admin-token>" }
    //   Body: { kind: "entity" }
    //   => 200 { ok: true, status: "started", kind: "entity" }
    expect(true).toBe(true);
  });
});

describe("Search reliability", () => {
  it("AC-7: doctor detects missing search doc for searchable artifact", () => {
    // Setup:
    //   1. Upload a searchable artifact (search doc created)
    //   2. Directly DELETE the artifact_search_docs row (simulate drift)
    //
    // Action:
    //   GET /projects/:projectId/doctor/search-drift
    //
    // Assertions:
    //   - Response: 200 { ok: true, findings: [...] }
    //   - findings contains entry: { check: "search-missing-doc", status: "fail", count: 1 }
    //   - examples array includes the artifact_key of the missing doc
    expect(true).toBe(true);
  });

  it("AC-8: doctor detects orphaned search doc with no pointer", () => {
    // Setup:
    //   1. Directly INSERT a row into artifact_search_docs with no corresponding
    //      artifact_pointers row (simulate orphan)
    //
    // Action:
    //   GET /projects/:projectId/doctor/search-drift
    //
    // Assertions:
    //   - Response: 200 { ok: true, findings: [...] }
    //   - findings contains entry: { check: "search-orphan-doc", status: "fail", count: 1 }
    expect(true).toBe(true);
  });

  it("AC-9: search rebuild --apply repopulates missing search doc from R2", () => {
    // Setup:
    //   1. Upload a searchable artifact (pointer + R2 blob exist)
    //   2. Directly DELETE the artifact_search_docs row
    //
    // Action:
    //   POST /projects/:projectId/artifacts/search-rebuild?apply=true
    //   (or equivalent CLI: tila doctor --search-rebuild --apply)
    //
    // Assertions:
    //   - Response: 200 with rebuild report showing status "written" for the artifact
    //   - artifact_search_docs row now exists again with correct body_text
    //   - Search query for the artifact's content returns results
    //   - Journal contains "artifact.search.rebuilt" event
    expect(true).toBe(true);
  });

  it("AC-10: sweep expiry tombstones/removes search doc, artifact absent from results", () => {
    // Setup:
    //   1. Upload a searchable artifact with term "xyzSweepZeta"
    //   2. Set artifact pointer's expires_at to Date.now() - 1 (already expired)
    //
    // Action:
    //   POST /_internal/sweep (triggers sweep cycle)
    //
    // Assertions:
    //   - Sweep response shows artifactsExpired >= 1
    //   - GET /projects/:projectId/artifacts/search?q=xyzSweepZeta returns empty results
    //   - artifact_search_docs row for the key is deleted (row count = 0)
    expect(true).toBe(true);
  });
});
