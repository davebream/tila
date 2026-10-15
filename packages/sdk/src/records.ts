import type {
  RecordArchiveRequest,
  RecordCreateRequest,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
  RecordMetaResponse,
  RecordMutateResponse,
  RecordPatchRequest,
  RecordPutRequest,
  RecordSetRequest,
  RecordTypesResponse,
  RecordUnarchiveRequest,
  RecordWriteResponse,
} from "@tila/schemas";
import type { TilaClient } from "./client";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createRecordMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/records`;

  return {
    /**
     * Creates a record. A credential that may write but not read the key
     * receives a `RecordWriteReceiptResponse` (type, key and fence only)
     * instead of the full record; narrow with `isRecordWriteReceipt`.
     */
    async create(
      type: string,
      req: RecordCreateRequest,
    ): Promise<RecordWriteResponse> {
      return client.post<RecordWriteResponse>(`${base}/${type}`, req);
    },

    /** Replaces a record; the response is a receipt under the rule of `create`. */
    async set(
      type: string,
      key: string,
      req: RecordSetRequest,
    ): Promise<RecordWriteResponse> {
      return client.put<RecordWriteResponse>(
        `${base}/${type}/${encodeKey(key)}`,
        req,
      );
    },

    /** Create-or-replace; the response is a receipt under the rule of `create`. */
    async put(
      type: string,
      key: string,
      req: RecordPutRequest,
    ): Promise<RecordWriteResponse> {
      return client.post<RecordWriteResponse>(
        `${base}/${type}/~/put/${encodeKey(key)}`,
        req,
      );
    },

    async get(type: string, key: string): Promise<RecordGetResponse> {
      return client.get<RecordGetResponse>(`${base}/${type}/${encodeKey(key)}`);
    },

    /**
     * Reads a record's revision, current fence, `value_sha256`, `updated_at`
     * and `archived` state without its value (`GET ...?meta=1`). All fields come
     * from one snapshot, so the fence belongs to the revision beside it. Needs
     * the same read access to the key as `get`, and a missing record is the
     * same 404. Use it to check whether a cached copy is current or to learn the
     * fence before a fenced write without transferring the value.
     */
    async meta(type: string, key: string): Promise<RecordMetaResponse> {
      return client.get<RecordMetaResponse>(
        `${base}/${type}/${encodeKey(key)}`,
        { query: { meta: "1" } },
      );
    },

    async patch(
      type: string,
      key: string,
      req: RecordPatchRequest,
    ): Promise<RecordMutateResponse> {
      return client.patch<RecordMutateResponse>(
        `${base}/${type}/${encodeKey(key)}`,
        req,
      );
    },

    async archive(
      type: string,
      key: string,
      req: RecordArchiveRequest,
    ): Promise<RecordMutateResponse> {
      return client.post<RecordMutateResponse>(
        `${base}/${type}/~/archive/${encodeKey(key)}`,
        req,
      );
    },

    async unarchive(
      type: string,
      key: string,
      req: RecordUnarchiveRequest,
    ): Promise<RecordMutateResponse> {
      return client.post<RecordMutateResponse>(
        `${base}/${type}/~/unarchive/${encodeKey(key)}`,
        req,
      );
    },

    async history(
      type: string,
      key: string,
      opts?: { limit?: number; values?: boolean; cursor?: string },
    ): Promise<RecordHistoryResponse> {
      const query: Record<string, string | undefined> = {};
      if (opts?.limit !== undefined) query.limit = String(opts.limit);
      if (opts?.values !== undefined) query.values = String(opts.values);
      if (opts?.cursor) query.cursor = opts.cursor;
      return client.get<RecordHistoryResponse>(
        `${base}/${type}/~/history/${encodeKey(key)}`,
        { query },
      );
    },

    async list(
      type: string,
      query?: {
        tag?: string;
        filter?: string;
        "include-archived"?: string;
        limit?: string;
        tagFilter?: string[];
        /** `next_cursor` from a previous page. */
        cursor?: string;
        sort?: "key" | "updated_at" | "revision";
        order?: "asc" | "desc";
        keyContains?: string;
      },
    ): Promise<RecordListResponse> {
      const { tagFilter, keyContains, ...rest } = query ?? {};
      const q: Record<string, string | undefined> = { ...rest };
      if (tagFilter?.length) q.tag_filter = tagFilter.join(",");
      if (keyContains) q.key_contains = keyContains;
      return client.get<RecordListResponse>(`${base}/${type}`, { query: q });
    },

    async types(): Promise<RecordTypesResponse> {
      return client.get<RecordTypesResponse>(`${base}/_types`);
    },

    async typesInUse(): Promise<RecordTypesResponse> {
      const raw = await client.get<{
        ok: true;
        types: string[];
        in_use_types?: string[];
      }>(`${base}/_types`);
      return { ok: true, types: raw.in_use_types ?? [] };
    },
  };
}
