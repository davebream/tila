import type { RecordPageParams } from "@/hooks/use-api";
import type { RecordListSort } from "@/lib/api";

export const RECORD_PAGE_SIZE = 100;

export type RecordSortKey = "key" | "updated" | "revision";
export type RecordSort = { key: RecordSortKey; dir: "asc" | "desc" };

export const DEFAULT_RECORD_SORT: RecordSort = { key: "key", dir: "asc" };

export const RECORD_SORT_FIELDS: Record<RecordSortKey, RecordListSort> = {
  key: "key",
  updated: "updated_at",
  revision: "revision",
};

export function parseRecordSort(raw: string | null): RecordSort {
  if (!raw) return DEFAULT_RECORD_SORT;
  const [k, d] = raw.split(":");
  if (
    (k === "key" || k === "updated" || k === "revision") &&
    (d === "asc" || d === "desc")
  ) {
    return { key: k, dir: d };
  }
  return DEFAULT_RECORD_SORT;
}

/**
 * The list page described by the records URL (`q`, `sort`, `archived`,
 * `after`). The records page and the record drawer read the same page, so
 * sibling navigation in the drawer follows the rows on screen.
 */
export function recordPageParams(search: URLSearchParams): RecordPageParams {
  const sort = parseRecordSort(search.get("sort"));
  return {
    archived: search.get("archived") === "1",
    sort: RECORD_SORT_FIELDS[sort.key],
    order: sort.dir,
    keyContains: (search.get("q") ?? "").trim(),
    limit: RECORD_PAGE_SIZE,
    cursor: search.get("after") ?? undefined,
  };
}
