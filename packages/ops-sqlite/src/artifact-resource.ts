import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ArtifactVersionError } from "./artifact-version-error";
import { resolveEntityReference } from "./fence-ops";
import type * as schema from "./schema";

type Db = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

export class ArtifactResourceError extends ArtifactVersionError {
  constructor() {
    super(
      400,
      "validation-error",
      "Artifact resource must name an existing task using its bare ID or matching <type>:<id> alias",
    );
  }
}

/** Artifact foreign keys store entity IDs; claims use canonical typed resources. */
export function resolveArtifactResource(
  db: Db,
  resource: string | null,
): string | null {
  if (resource === null) return null;
  const entity = resolveEntityReference(db, resource);
  if (!entity) throw new ArtifactResourceError();
  return entity.id;
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
