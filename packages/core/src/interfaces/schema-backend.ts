// packages/core/src/interfaces/schema-backend.ts

export interface SchemaRecord {
  version: number | null;
  definition: string | null;
}

export interface ApplySchemaInput {
  definition: string;
  strategy?: string;
}

export interface ApplySchemaOutput {
  ok: boolean;
  version: number | null;
  changes: string[];
  noChange?: boolean;
  reason?: string;
  hint?: string;
}

export interface SchemaBackend {
  getCurrentSchema(): Promise<SchemaRecord>;
  applySchema(input: ApplySchemaInput): Promise<ApplySchemaOutput>;
}
