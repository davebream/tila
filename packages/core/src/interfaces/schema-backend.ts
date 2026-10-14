// packages/core/src/interfaces/schema-backend.ts

import type { SchemaApplyWarning, SchemaPreviewChange } from "@tila/schemas";

export interface SchemaRecord {
  version: number | null;
  revision?: number;
  definition: string | null;
  /** Epoch milliseconds the current revision was applied, when known. */
  applied_at?: number | null;
}

export interface ApplySchemaInput {
  definition: string;
  strategy?: string;
  /** Zero means no configuration has been applied yet. */
  expected_revision?: number;
  /** Definition returned by preview; destructive writes bind to this review. */
  reviewed_definition?: string;
  idempotency_key?: string;
}

export interface ApplySchemaOutput {
  ok: boolean;
  version: number | null;
  revision?: number;
  changes: string[];
  noChange?: boolean;
  reason?: string;
  hint?: string;
  warnings?: SchemaApplyWarning[];
}

/** Server preview of a definition against the data and revision applied now. */
export interface SchemaPreviewResult {
  /** Revision the preview evaluated; send it as `expected_revision`. */
  revision: number;
  reviewed_definition: string;
  changes: SchemaPreviewChange[];
  autoApplicable: boolean;
}

export interface SchemaBackend {
  getCurrentSchema(): Promise<SchemaRecord>;
  previewSchema(definition: string): Promise<SchemaPreviewResult>;
  applySchema(input: ApplySchemaInput): Promise<ApplySchemaOutput>;
}
