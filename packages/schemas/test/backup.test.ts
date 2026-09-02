import { describe, expect, it } from "vitest";
import {
  PROJECT_BACKUP_FORMAT,
  ProjectBackupHeaderSchema,
  ProjectBackupManifestSchema,
  ProjectBackupObjectSchema,
} from "../src";

const sha = "a".repeat(64);

describe("project backup v1 contracts", () => {
  it("accepts a complete v1 manifest and normalizes older optional fields", () => {
    const parsed = ProjectBackupManifestSchema.parse({
      format: PROJECT_BACKUP_FORMAT,
      format_version: 1,
      complete: true,
      project_id: "demo",
      created_at: "2026-09-02T00:00:00.000Z",
      source: {
        backend: "local",
        product_version: "0.2.7",
        do_migration_version: 23,
        schema_version: 1,
      },
      entries: [],
      content_root: sha,
      semantic_digest: sha,
      journal_next_sequence: 1,
      journal_archive_watermark: 0,
      exclusions: [],
      stats: {
        rows: 0,
        objects: 0,
        blob_bytes: 0,
        archive_bytes: 0,
        elapsed_ms: 0,
      },
    });
    expect(parsed.required_features).toEqual([]);
    expect(parsed.optional_sections).toEqual([]);
  });

  it("rejects unsafe archive paths", () => {
    expect(() =>
      ProjectBackupObjectSchema.parse({
        key: "../secret",
        sha256: sha,
        bytes: 1,
        blob_path: `blobs/${sha}`,
      }),
    ).toThrow();
  });

  it("rejects incomplete headers and newer format versions", () => {
    expect(() =>
      ProjectBackupHeaderSchema.parse({
        format: PROJECT_BACKUP_FORMAT,
        format_version: 2,
        created_at: "2026-09-02T00:00:00.000Z",
        project_id: "demo",
      }),
    ).toThrow();
  });
});
