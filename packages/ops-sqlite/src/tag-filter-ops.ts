import { type SQL, sql } from "drizzle-orm";

/**
 * Builds one correlated EXISTS predicate per tag in `tags`, for multi-tag AND
 * filtering against a tag join table.
 *
 * @param joinTable - The name of the tag table, e.g. `"entity_tags"`.
 * @param correlation - An arbitrary SQL predicate that correlates the join-table
 *   alias `jt` with the outer query row.  This must be a Drizzle `sql` fragment;
 *   it is inserted verbatim into the EXISTS sub-select.
 *   Examples:
 *     - entities:  `sql\`jt.entity_id = entities.id\``
 *     - artifacts: `sql\`jt.artifact_key = artifact_pointers.r2_key\``
 *     - records:   `sql\`jt.type = records.type AND jt.key = records.key\``
 * @param tags - Pre-normalized (lowercase) tag values to match.
 * @returns An array of SQL fragments, one per tag, each an EXISTS clause.
 */
export function tagExistsConditions(
  joinTable: string,
  correlation: SQL,
  tags: string[],
): SQL[] {
  return tags.map(
    (tag) =>
      sql`EXISTS (SELECT 1 FROM ${sql.raw(joinTable)} jt WHERE ${correlation} AND jt.tag = ${tag})`,
  );
}
