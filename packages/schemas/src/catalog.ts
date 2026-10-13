import { z } from "zod";
import {
  RecordPresentationSchema,
  WorkLifecycleSchema,
  WorkPresentationSchema,
} from "./config";

// --- Type catalogs (#300) ---
//
// A catalog describes the types a caller may read, independently of any page
// of result rows. Each entry says whether the current schema declares the
// type, and how many stored rows the caller can see.

/**
 * `declared`: the current schema declares the type (it may have no rows).
 * `undeclared`: rows exist but the current schema does not declare the type
 * (never declared, renamed, or retired). The rows stay readable.
 * `unknown`: the schema could not be read, so declaration status is unknown.
 */
export const TypeDeclarationSchema = z.enum([
  "declared",
  "undeclared",
  "unknown",
]);
export type TypeDeclaration = z.infer<typeof TypeDeclarationSchema>;

/** States what a count or result set covers. */
export const ResultScopeSchema = z.object({
  /** Namespace restrictions on the credential narrowed the types and counts. */
  restricted: z.boolean(),
  archived: z.enum(["excluded", "included"]).optional(),
});
export type ResultScope = z.infer<typeof ResultScopeSchema>;

/** Scope of a task list page. */
export const TaskListScopeSchema = ResultScopeSchema.extend({
  /**
   * With an `outcome` filter: the visible types whose lifecycle declares one
   * of the requested outcomes. Empty means no type can match, which is not
   * the same as no task being in that outcome.
   */
  outcome_types: z.array(z.string()).optional(),
});
export type TaskListScope = z.infer<typeof TaskListScopeSchema>;

export const CatalogIncompleteSchema = z.object({
  /** `unavailable`: the schema could not be fetched. `invalid`: it was fetched but does not parse or validate. */
  declared_types: z.enum(["unavailable", "invalid"]).optional(),
  /** The in-use types could not be listed. */
  in_use_types: z.literal("unavailable").optional(),
});
export type CatalogIncomplete = z.infer<typeof CatalogIncompleteSchema>;

export const CatalogFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  values: z.array(z.string()).optional(),
  /** Declared `default`; clients prefill new rows with it. Never applied to stored data. */
  default: z.unknown().optional(),
});
export type CatalogField = z.infer<typeof CatalogFieldSchema>;

const CatalogCountsShape = {
  type: z.string(),
  declaration: TypeDeclarationSchema,
  /** Non-archived rows visible to the caller. */
  count: z.number().int().nonnegative(),
  /** Archived rows visible to the caller. */
  archived_count: z.number().int().nonnegative(),
};

export const WorkCatalogDefinitionSchema = z.object({
  /** Declared fields, in declaration order. */
  fields: z.array(CatalogFieldSchema),
  lifecycle: WorkLifecycleSchema.optional(),
  presentation: WorkPresentationSchema.optional(),
});
export type WorkCatalogDefinition = z.infer<typeof WorkCatalogDefinitionSchema>;

export const WorkCatalogEntrySchema = z.object({
  ...CatalogCountsShape,
  /** Present only when `declaration` is `declared`. */
  definition: WorkCatalogDefinitionSchema.optional(),
});
export type WorkCatalogEntry = z.infer<typeof WorkCatalogEntrySchema>;

export const WorkCatalogResponseSchema = z.object({
  ok: z.literal(true),
  /** Sorted by type name. */
  types: z.array(WorkCatalogEntrySchema),
  scope: ResultScopeSchema,
  /** Omitted when complete. Never sent to namespace-restricted credentials. */
  incomplete: CatalogIncompleteSchema.optional(),
});
export type WorkCatalogResponse = z.infer<typeof WorkCatalogResponseSchema>;

export const RecordCatalogDefinitionSchema = z.object({
  fields: z.array(CatalogFieldSchema),
  presentation: RecordPresentationSchema.optional(),
  format: z.enum(["json", "yaml"]),
  history: z.enum(["revision", "snapshot"]),
  key_description: z.string().optional(),
  writers: z.array(z.enum(["human", "agent"])).optional(),
});
export type RecordCatalogDefinition = z.infer<
  typeof RecordCatalogDefinitionSchema
>;

export const RecordCatalogEntrySchema = z.object({
  ...CatalogCountsShape,
  definition: RecordCatalogDefinitionSchema.optional(),
});
export type RecordCatalogEntry = z.infer<typeof RecordCatalogEntrySchema>;

export const TypeCountSchema = z.object({
  type: z.string(),
  count: z.number().int().nonnegative(),
  archived_count: z.number().int().nonnegative(),
});
export type TypeCount = z.infer<typeof TypeCountSchema>;
