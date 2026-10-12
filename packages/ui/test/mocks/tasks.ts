import type { WorkCatalogEntry } from "@tila/schemas";
import { http, HttpResponse } from "msw";

export type TaskFixture = {
  id: string;
  type: string;
  schema_version: number;
  data: Record<string, unknown>;
  archived: number;
  created_at: number;
  updated_at: number;
  created_by: string;
  tags: string[];
};

export function makeTask(
  id: string,
  overrides: Partial<TaskFixture> = {},
): TaskFixture {
  return {
    id,
    type: "task",
    schema_version: 1,
    data: {},
    archived: 0,
    created_at: Date.now() - 20_000,
    updated_at: Date.now() - 10_000,
    created_by: "test-user",
    tags: [],
    ...overrides,
  };
}

/** `task-001` … `task-NNN`, in list order. */
export function manyTasks(count: number): TaskFixture[] {
  return Array.from({ length: count }, (_, i) =>
    makeTask(`task-${String(i + 1).padStart(3, "0")}`, {
      data: { title: `Task number ${i + 1}` },
    }),
  );
}

export type ListScope = { restricted: boolean };

/**
 * `GET /tasks` honouring `type`, `archived=0`, `limit` and opaque keyset
 * cursors bound to the filter they were issued for, like the server. A cursor
 * reused with a different filter or sort is a 400 `invalid-cursor`.
 */
export function pagedTasksHandler(
  tasks: TaskFixture[],
  opts: {
    scope?: ListScope;
    onRequest?: (params: URLSearchParams) => void;
  } = {},
) {
  return http.get("*/projects/*/tasks", ({ request }) => {
    const params = new URL(request.url).searchParams;
    opts.onRequest?.(params);
    const types = params.get("type")?.split(",").filter(Boolean) ?? [];
    const excludeArchived = params.get("archived") === "0";
    const binding = `${types.join(",")}|${params.get("archived") ?? ""}|${params.get("sort") ?? ""}:${params.get("order") ?? ""}`;
    const filtered = tasks.filter(
      (t) =>
        (types.length === 0 || types.includes(t.type)) &&
        (!excludeArchived || t.archived === 0),
    );
    const limit = Number(params.get("limit") ?? "100");
    let offset = 0;
    const cursor = params.get("cursor");
    if (cursor) {
      let decoded = "";
      try {
        decoded = atob(cursor);
      } catch {
        decoded = "";
      }
      const match = /^c(\d+)\|(.*)$/.exec(decoded);
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
    const hasMore = end < filtered.length;
    return HttpResponse.json({
      ok: true,
      entities: page,
      total: filtered.length,
      limit,
      offset: 0,
      has_more: hasMore,
      next_cursor: hasMore ? btoa(`c${end}|${binding}`) : null,
      scope: {
        restricted: opts.scope?.restricted ?? false,
        archived: excludeArchived ? "excluded" : "included",
      },
    });
  });
}

/** Cursor the paged handler accepts for `offset` under the given binding. */
export function cursorFor(offset: number, binding: string): string {
  return btoa(`c${offset}|${binding}`);
}

export function declaredEntry(
  type: string,
  count: number,
  definition: WorkCatalogEntry["definition"] = { fields: [] },
  archived_count = 0,
): WorkCatalogEntry {
  return { type, declaration: "declared", count, archived_count, definition };
}

export function catalogHandler(
  types: WorkCatalogEntry[],
  scope: { restricted: boolean } = { restricted: false },
) {
  return http.get("*/projects/*/tasks/~/types", () =>
    HttpResponse.json({ ok: true, types, scope }),
  );
}

export type SearchHit = {
  entity_id: string;
  entity_type: string;
  name: string | null;
  snippet: string | null;
};

export function searchHandler(
  hits: SearchHit[],
  opts: {
    restricted?: boolean;
    next_cursor?: string | null;
    onRequest?: (params: URLSearchParams) => void;
  } = {},
) {
  return http.get("*/projects/*/search", ({ request }) => {
    opts.onRequest?.(new URL(request.url).searchParams);
    return HttpResponse.json({
      ok: true,
      results: hits.map((h) => ({ type: "entity", indexed_at: 1, ...h })),
      total: hits.length,
      next_cursor: opts.next_cursor ?? null,
      scope: {
        restricted: opts.restricted ?? false,
        kinds: ["task"],
        archived: "excluded",
      },
    });
  });
}
