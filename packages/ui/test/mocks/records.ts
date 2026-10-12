import type { RecordCatalogEntry } from "@tila/schemas";
import { http, HttpResponse } from "msw";

export type RecordItemFixture = {
  type: string;
  key: string;
  revision: number;
  updated_at: number;
  updated_by: string;
  archived: number;
  tags: string[];
  title?: string | null;
};

export function makeRecordItem(
  type: string,
  key: string,
  overrides: Partial<RecordItemFixture> = {},
): RecordItemFixture {
  return {
    type,
    key,
    revision: 1,
    updated_at: Date.now() - 10_000,
    updated_by: "test-user",
    archived: 0,
    tags: [],
    ...overrides,
  };
}

/** `key-001` … `key-NNN` of one type, in key order. */
export function manyRecords(type: string, count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeRecordItem(type, `key-${String(i + 1).padStart(3, "0")}`, {
      revision: i + 1,
    }),
  );
}

export function recordEntry(
  type: string,
  count: number,
  overrides: Partial<RecordCatalogEntry> = {},
): RecordCatalogEntry {
  return {
    type,
    declaration: "declared",
    count,
    archived_count: 0,
    definition: { fields: [], format: "json", history: "revision" },
    ...overrides,
  };
}

export function recordTypesHandler(
  entries: RecordCatalogEntry[],
  scope: { restricted: boolean } = { restricted: false },
) {
  return http.get("*/projects/*/records/_types", () =>
    HttpResponse.json({
      ok: true,
      types: entries.map((e) => e.type),
      declared_types: entries
        .filter((e) => e.declaration === "declared")
        .map((e) => e.type),
      in_use_types: entries.filter((e) => e.count > 0).map((e) => e.type),
      entries,
      scope,
    }),
  );
}

/**
 * `GET /records/:type` honouring `include-archived`, `key_contains`, `sort`,
 * `order`, `limit` and opaque cursors bound to the filter and sort they were
 * issued for. A mismatched cursor is a 400 `invalid-cursor`, like the server.
 */
export function pagedRecordsHandler(
  items: RecordItemFixture[],
  opts: {
    restricted?: boolean;
    onRequest?: (type: string, params: URLSearchParams) => void;
  } = {},
) {
  return http.get("*/projects/*/records/:type", ({ request, params }) => {
    const type = params.type as string;
    // Leave the types listing to its own handler.
    if (type === "_types") return;
    const query = new URL(request.url).searchParams;
    opts.onRequest?.(type, query);
    const includeArchived = query.get("include-archived") === "true";
    const keyContains = query.get("key_contains") ?? "";
    const sort = query.get("sort") ?? "key";
    const order = query.get("order") ?? "asc";
    const binding = `${type}|${includeArchived}|${sort}:${order}|${keyContains}`;
    const filtered = items
      .filter(
        (r) =>
          r.type === type &&
          (includeArchived || r.archived === 0) &&
          r.key.toLowerCase().includes(keyContains.toLowerCase()),
      )
      .sort((a, b) => {
        const dir = order === "desc" ? -1 : 1;
        if (sort === "revision") return (a.revision - b.revision) * dir;
        if (sort === "updated_at") return (a.updated_at - b.updated_at) * dir;
        return a.key.localeCompare(b.key) * dir;
      });
    const limit = Number(query.get("limit") ?? "100");
    let offset = 0;
    const cursor = query.get("cursor");
    if (cursor) {
      let decoded = "";
      try {
        decoded = atob(cursor);
      } catch {
        decoded = "";
      }
      const match = /^r(\d+)\|(.*)$/.exec(decoded);
      if (!match || match[2] !== binding) {
        return HttpResponse.json(
          {
            ok: false,
            error: { code: "invalid-cursor", message: "Invalid cursor" },
          },
          { status: 400 },
        );
      }
      offset = Number(match[1]);
    }
    const page = filtered.slice(offset, offset + limit);
    const end = offset + page.length;
    return HttpResponse.json({
      ok: true,
      items: page,
      meta: {
        total: filtered.length,
        limit,
        next_cursor: end < filtered.length ? btoa(`r${end}|${binding}`) : null,
        scope: {
          restricted: opts.restricted ?? false,
          archived: includeArchived ? "included" : "excluded",
        },
      },
    });
  });
}
