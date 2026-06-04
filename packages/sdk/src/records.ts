import type {
  RecordArchiveRequest,
  RecordCreateRequest,
  RecordGetResponse,
  RecordHistoryResponse,
  RecordListResponse,
  RecordMutateResponse,
  RecordPatchRequest,
  RecordSetRequest,
  RecordTypesResponse,
  RecordUnarchiveRequest,
} from "@tila/schemas";
import type { TilaClient } from "./client";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createRecordMethods(client: TilaClient, projectId: string) {
  const base = `/projects/${projectId}/records`;

  return {
    async create(
      type: string,
      req: RecordCreateRequest,
    ): Promise<RecordMutateResponse> {
      return client.post<RecordMutateResponse>(`${base}/${type}`, req);
    },

    async set(
      type: string,
      key: string,
      req: RecordSetRequest,
    ): Promise<RecordMutateResponse> {
      return client.put<RecordMutateResponse>(
        `${base}/${type}/${encodeKey(key)}`,
        req,
      );
    },

    async get(type: string, key: string): Promise<RecordGetResponse> {
      return client.get<RecordGetResponse>(`${base}/${type}/${encodeKey(key)}`);
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
      opts?: { limit?: number; values?: boolean },
    ): Promise<RecordHistoryResponse> {
      const query: Record<string, string | undefined> = {};
      if (opts?.limit !== undefined) query.limit = String(opts.limit);
      if (opts?.values !== undefined) query.values = String(opts.values);
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
      },
    ): Promise<RecordListResponse> {
      return client.get<RecordListResponse>(`${base}/${type}`, { query });
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
