import {
  RecordKeySchema,
  RecordTypeSchema,
  parseRecordResource,
} from "@tila/schemas";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ArtifactVersionError } from "./artifact-version-error";
import { resolveCurrentSchema } from "./constraint-ops";
import { resolveEntityReference } from "./fence-ops";
import * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

export class ArtifactResourceError extends ArtifactVersionError {
  constructor() {
    super(
      400,
      "validation-error",
      "Artifact resource must name an existing task using its bare ID or matching <type>:<id> alias, or a valid record snapshot resource",
    );
  }
}

/** Task pointers store bare IDs; snapshot pointers store record:<type>/<key>. */
export function resolveArtifactResource(
  db: Db,
  resource: string | null,
  kind?: string,
): string | null {
  if (resource === null) {
    if (isRecordSnapshotKind(kind)) throw new ArtifactResourceError();
    return null;
  }
  if (isRecordSnapshotKind(kind)) {
    const record = parseRecordResource(resource);
    if (record) {
      if (
        !RecordTypeSchema.safeParse(record.type).success ||
        !RecordKeySchema.safeParse(record.key).success
      )
        throw new ArtifactResourceError();
      if (kind === "record-snapshot-source") {
        // The CLI uploads the original source before creating the record.
        if (
          resolveCurrentSchema(db)?.records?.[record.type]?.history !==
          "snapshot"
        )
          throw new ArtifactResourceError();
      } else if (
        !db
          .select({ key: schema.records.key })
          .from(schema.records)
          .where(
            and(
              eq(schema.records.type, record.type),
              eq(schema.records.key, record.key),
            ),
          )
          .get()
      ) {
        throw new ArtifactResourceError();
      }
      return resource;
    }
    throw new ArtifactResourceError();
  }
  const entity = resolveEntityReference(db, resource);
  if (!entity) throw new ArtifactResourceError();
  return entity.id;
}

function isRecordSnapshotKind(kind: string | undefined): boolean {
  return (
    kind === "record-snapshot-canonical" || kind === "record-snapshot-source"
  );
}

/** Unknown filters continue to match no rows instead of becoming write errors. */
export function resolveArtifactResourceFilter(
  db: Db,
  resource: string,
): string {
  return resolveEntityReference(db, resource)?.id ?? resource;
}

/** Limit database-error translation to artifact writes, including Drizzle causes. */
export function withArtifactResourceErrors<T>(write: () => T): T {
  try {
    return write();
  } catch (error) {
    const seen = new Set<unknown>();
    let cause: unknown = error;
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause);
      if (
        (cause as Error & { code?: string }).code ===
          "SQLITE_CONSTRAINT_FOREIGNKEY" ||
        /\bFOREIGN KEY constraint failed\b|\bSQLITE_CONSTRAINT_FOREIGNKEY\b/i.test(
          cause.message,
        )
      )
        throw new ArtifactResourceError();
      cause = cause.cause;
    }
    throw error;
  }
}
