// Paged, scoped unified search (#300).
//
// Each kind (tasks, records, artifacts) is ranked by FTS5 bm25 with a stable
// id tie-break. bm25 scores depend on the whole corpus, so they are not
// comparable across tables and shift whenever a document is written. A keyset
// on the score would therefore look stable without being stable. The cursor
// instead stores one offset per kind, bound to the query it was issued for:
// deterministic for an unchanged corpus, and pages may drift under concurrent
// writes (documented). Multi-kind pages interleave kinds round-robin.

import type {
  NamespaceRestrictions,
  SearchKind,
  SearchScope,
} from "@tila/schemas";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  SearchQueryError,
  searchArtifacts,
  validateFtsQuery,
} from "./artifact-ops";
import { type UnifiedSearchResult, searchEntities } from "./entity-ops";
import {
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
  fingerprint,
} from "./list-cursor";
import { searchRecords } from "./record-ops";
import type * as schema from "./schema";

type DB = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

// Interleave order matches the historical unified search: tasks, artifacts, records.
export const SEARCH_KINDS: readonly SearchKind[] = [
  "task",
  "artifact",
  "record",
];

/** Deepest offset a cursor may reach per kind. */
export const MAX_SEARCH_DEPTH = 1000;

/**
 * Turn plain typed words into a safe FTS5 query: each word becomes a quoted
 * phrase (so operators and punctuation are literal) and the last word is
 * prefix-matched when it has at least three characters.
 */
export function literalFtsQuery(q: string): string {
  const words = q
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ""))
    .filter((word) => /[\p{L}\p{N}]/u.test(word));
  if (words.length === 0)
    throw new SearchQueryError("Search query has no searchable words");
  return words
    .map((word, i) =>
      i === words.length - 1 && [...word].length >= 3
        ? `"${word}"*`
        : `"${word}"`,
    )
    .join(" ");
}

export interface SearchPageQuery {
  q: string;
  syntax?: "fts" | "literal";
  /** Kinds to search; already narrowed to what the caller may read. */
  kinds: SearchKind[];
  /** Task or record types; only valid with a single task or record kind. */
  types?: string[];
  tagFilter?: string[];
  limit: number;
  cursor?: string;
  restrictions?: NamespaceRestrictions;
}

export interface SearchPage {
  results: UnifiedSearchResult[];
  next_cursor: string | null;
}

type Offsets = Record<SearchKind, number>;

function fetchKind(
  db: DB,
  kind: SearchKind,
  query: SearchPageQuery & { q: string },
  offset: number,
  limit: number,
): UnifiedSearchResult[] {
  const common = {
    q: query.q,
    limit,
    offset,
    tagFilter: query.tagFilter,
    _skipValidation: true,
  };
  switch (kind) {
    case "task":
      return searchEntities(db, {
        ...common,
        entity_types: query.types,
        restrictions: query.restrictions,
      }).map((row) => ({ type: "entity" as const, ...row }));
    case "record":
      return searchRecords(db, {
        ...common,
        types: query.types,
        restrictions: query.restrictions,
      }).map((row) => ({ type: "record" as const, ...row }));
    case "artifact":
      return searchArtifacts(db, common).map((row) => ({
        type: "artifact" as const,
        ...row,
      }));
  }
}

export function searchPage(db: DB, query: SearchPageQuery): SearchPage {
  const ftsQuery =
    query.syntax === "literal" ? literalFtsQuery(query.q) : query.q;
  validateFtsQuery(ftsQuery);

  const kinds = SEARCH_KINDS.filter((kind) => query.kinds.includes(kind));
  const binding = fingerprint({
    q: query.q,
    syntax: query.syntax ?? "fts",
    kinds,
    types: query.types?.slice().sort() ?? null,
    tagFilter: query.tagFilter?.map((t) => t.toLowerCase()).sort() ?? null,
  });

  const offsets: Offsets = { task: 0, record: 0, artifact: 0 };
  if (query.cursor) {
    const position = decodeCursor(query.cursor, binding);
    const stored = position.o as Record<string, unknown> | undefined;
    for (const kind of kinds) {
      const value = stored?.[kind] ?? 0;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_SEARCH_DEPTH
      )
        throw new InvalidCursorError();
      offsets[kind] = value;
    }
  }

  // Fetch one extra row per kind to learn whether that kind has more.
  const sources = kinds.map((kind) => ({
    kind,
    rows:
      offsets[kind] >= MAX_SEARCH_DEPTH
        ? []
        : fetchKind(
            db,
            kind,
            { ...query, q: ftsQuery },
            offsets[kind],
            Math.min(query.limit, MAX_SEARCH_DEPTH - offsets[kind]) + 1,
          ),
    used: 0,
  }));

  const results: UnifiedSearchResult[] = [];
  while (results.length < query.limit) {
    let added = false;
    for (const source of sources) {
      if (results.length >= query.limit) break;
      if (source.used < source.rows.length) {
        results.push(source.rows[source.used++]);
        added = true;
      }
    }
    if (!added) break;
  }

  const next: Offsets = { ...offsets };
  let more = false;
  for (const source of sources) {
    next[source.kind] = offsets[source.kind] + source.used;
    if (
      source.rows.length > source.used &&
      next[source.kind] < MAX_SEARCH_DEPTH
    )
      more = true;
  }
  return {
    results,
    next_cursor: more
      ? encodeCursor(binding, {
          o: Object.fromEntries(kinds.map((kind) => [kind, next[kind]])),
        })
      : null,
  };
}

/** Read capability each kind requires from a scoped credential. */
const KIND_CAPABILITY: Record<SearchKind, string> = {
  task: "tasks:read",
  record: "records:read",
  artifact: "artifacts:read",
};

export class SearchKindDenied extends Error {
  constructor(readonly kind: SearchKind) {
    super(`Credential does not permit searching ${kind} results`);
    this.name = "SearchKindDenied";
  }
}

/**
 * Decide which kinds a caller searches. Without a scoped policy every kind is
 * searchable. A scoped policy needs each kind's read capability, and
 * namespace-restricted credentials never search artifacts (artifacts have no
 * namespace). Kinds the caller asked for explicitly but may not read throw
 * `SearchKindDenied`; kinds left implicit are excluded and reported.
 */
export function searchableKinds(
  policy:
    | { capabilities: readonly string[]; restrictions?: NamespaceRestrictions }
    | undefined,
  requested: readonly SearchKind[] | undefined,
): Pick<SearchScope, "kinds" | "excluded_kinds" | "restricted"> {
  const restricted =
    policy?.restrictions?.task_types !== undefined ||
    policy?.restrictions?.records !== undefined;
  const wanted = SEARCH_KINDS.filter(
    (kind) => requested === undefined || requested.includes(kind),
  );
  const kinds: SearchKind[] = [];
  const excluded: NonNullable<SearchScope["excluded_kinds"]> = [];
  for (const kind of wanted) {
    const reason =
      policy === undefined
        ? undefined
        : restricted && kind === "artifact"
          ? ("restricted" as const)
          : !policy.capabilities.includes(KIND_CAPABILITY[kind])
            ? ("capability" as const)
            : undefined;
    if (reason === undefined) {
      kinds.push(kind);
      continue;
    }
    if (requested !== undefined) throw new SearchKindDenied(kind);
    excluded.push({ kind, reason });
  }
  return {
    restricted,
    kinds,
    ...(excluded.length > 0 ? { excluded_kinds: excluded } : {}),
  };
}
