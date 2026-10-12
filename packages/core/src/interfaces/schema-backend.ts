// packages/core/src/interfaces/schema-backend.ts

export interface SchemaRecord {
  version: number | null;
  revision?: number;
  definition: string | null;
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
}

export interface SchemaBackend {
  getCurrentSchema(): Promise<SchemaRecord>;
  applySchema(input: ApplySchemaInput): Promise<ApplySchemaOutput>;
}
