import { z } from "zod";

export const PROJECT_BACKUP_FORMAT = "tila-backup" as const;
export const PROJECT_BACKUP_FORMAT_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeBackupPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "backup entry path must be relative and traversal-free",
  );

export const ProjectBackupHeaderSchema = z.object({
  format: z.literal(PROJECT_BACKUP_FORMAT),
  format_version: z.literal(PROJECT_BACKUP_FORMAT_VERSION),
  created_at: z.string().datetime(),
  project_id: z.string().min(1),
});

export const ProjectBackupEntrySchema = z.object({
  path: SafeBackupPathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative().optional(),
});

export const ProjectBackupObjectSchema = z.object({
  key: SafeBackupPathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  blob_path: SafeBackupPathSchema.nullable(),
  tombstoned: z.boolean().default(false),
  blob_deleted: z.boolean().default(false),
  http_metadata: z.record(z.unknown()).default({}),
  custom_metadata: z.record(z.string()).default({}),
});

export const ProjectBackupManifestSchema = z.object({
  format: z.literal(PROJECT_BACKUP_FORMAT),
  format_version: z.literal(PROJECT_BACKUP_FORMAT_VERSION),
  complete: z.literal(true),
  project_id: z.string().min(1),
  created_at: z.string().datetime(),
  source: z.object({
    backend: z.enum(["cloud", "local"]),
    product_version: z.string().min(1),
    do_migration_version: z.number().int().nonnegative(),
    schema_version: z.number().int().nonnegative(),
    cloudflare_account_id: z.string().optional(),
    github_installation_id: z.string().optional(),
  }),
  required_features: z.array(z.string()).default([]),
  optional_sections: z.array(SafeBackupPathSchema).default([]),
  entries: z.array(ProjectBackupEntrySchema),
  content_root: Sha256Schema,
  semantic_digest: Sha256Schema,
  journal_next_sequence: z.number().int().positive(),
  journal_archive_watermark: z.number().int().nonnegative(),
  exclusions: z.array(z.string()),
  stats: z.object({
    rows: z.number().int().nonnegative(),
    objects: z.number().int().nonnegative(),
    blob_bytes: z.number().int().nonnegative(),
    archive_bytes: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
  }),
});

export const ProjectTransferModeSchema = z.enum([
  "export",
  "import",
  "rollback",
]);

export const ProjectTransferStateSchema = z.object({
  session_id: z.string().min(1),
  mode: ProjectTransferModeSchema,
  owner: z.string().min(1),
  archive_digest: Sha256Schema.nullable(),
  safety_archive: z.string().nullable(),
  started_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive().nullable(),
});

export type ProjectBackupHeader = z.infer<typeof ProjectBackupHeaderSchema>;
export type ProjectBackupEntry = z.infer<typeof ProjectBackupEntrySchema>;
export type ProjectBackupObject = z.infer<typeof ProjectBackupObjectSchema>;
export type ProjectBackupManifest = z.infer<typeof ProjectBackupManifestSchema>;
export type ProjectTransferMode = z.infer<typeof ProjectTransferModeSchema>;
export type ProjectTransferState = z.infer<typeof ProjectTransferStateSchema>;
