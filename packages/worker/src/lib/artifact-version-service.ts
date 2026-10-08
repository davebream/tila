import {
  ArtifactCommitRecordSchema,
  ArtifactLineageIdSchema,
  type ArtifactMetaResponse,
  ArtifactRestoreRequestSchema,
  type ArtifactRevision,
  ArtifactVersionFieldsSchema,
  TagsSchema,
  canonicalJsonSha256,
} from "@tila/schemas";
import type { Context } from "hono";
import { identityPayload } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";
import { forwardToDO } from "./do-forward";
import { normalizeArtifactText } from "./normalize-text";

type Ctx = Context<{ Bindings: Env; Variables: HonoVariables }>;
type VersionWrite = {
  lineage_id?: string;
  lineage_fence?: number;
  kind: string;
  resource?: string | null;
  fence?: number | null;
  mime_type: string;
  tags?: string[];
};

async function writeRevision(
  c: Ctx,
  input: VersionWrite,
  bytes: ArrayBuffer | null,
  source?: ArtifactRevision,
) {
  const fields = ArtifactVersionFieldsSchema.parse(input);
  if (!fields.lineage_id || !fields.lineage_fence)
    return c.json(
      {
        ok: false,
        error: {
          code: "missing-fence",
          message: "lineage_id and lineage_fence are required together",
          retryable: false,
        },
      },
      400,
    );
  const lineage = ArtifactLineageIdSchema.parse(fields.lineage_id);
  const tags = TagsSchema.parse(input.tags ?? source?.tags ?? []);
  const projectId = c.get("projectId");
  const identity = identityPayload(c);
  const operationId =
    c.get("idempotencyKey") ??
    `${projectId}:${identity.principal_id}:${c.req.path}:${c.req.header("Idempotency-Key") ?? crypto.randomUUID()}`;
  const sha256 =
    source?.sha256 ??
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes as ArrayBuffer),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const requestHash =
    c.get("idempotencyHash") ??
    (await canonicalJsonSha256({
      ...input,
      sha256,
      source: source?.r2_key ?? null,
    }));
  const stub = c.get("doStub");
  const reserve = await forwardToDO(stub, "/artifact/version/reserve", "POST", {
    project_id: projectId,
    operation_id: operationId,
    request_hash: requestHash,
    lineage_id: lineage,
    lineage_fence: fields.lineage_fence,
    kind: input.kind,
    resource: input.resource ?? null,
    fence: input.fence ?? null,
    mime_type: input.mime_type,
    sha256,
    bytes: source?.bytes ?? bytes?.byteLength ?? 0,
    tags,
    restored_from: source?.r2_key,
    adopt: source ? source.lineage_id === null : false,
    search_text: bytes ? normalizeArtifactText(bytes, input.mime_type) : null,
    actor: c.get("tokenResult").name,
    ...identity,
  });
  if (!reserve.ok) return reserve;
  const result = (await reserve.json()) as {
    duplicate?: ArtifactRevision;
    operation?: { id: string; state: string; record: string };
  };
  if (result.duplicate)
    return c.json({
      ok: true,
      key: result.duplicate.r2_key,
      bytes: result.duplicate.bytes,
      deduplicated: true,
      pointer: result.duplicate,
      restored_from: result.duplicate.restored_from,
    });
  if (!result.operation) throw new Error("Missing artifact reservation");
  if (result.operation.state === "reserved") {
    const record = ArtifactCommitRecordSchema.parse(
      JSON.parse(result.operation.record),
    );
    try {
      let body: ArrayBuffer | ReadableStream = bytes as ArrayBuffer;
      if (source) {
        const blob = await c.env.ARTIFACTS.get(source.r2_key);
        if (!blob) {
          await forwardToDO(stub, "/artifact/version/abort", "POST", {
            operation_id: operationId,
          });
          return c.json(
            {
              ok: false,
              error: {
                code: "artifact-unavailable",
                message: "Source blob is unavailable",
                retryable: false,
              },
            },
            410,
          );
        }
        body = blob.body;
      }
      await c.env.ARTIFACTS.put(record.pointer.r2_key, body, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: record.pointer.sha256,
        httpMetadata: { contentType: record.pointer.mime_type },
        customMetadata: {
          "tila-project": projectId,
          "tila-kind": record.pointer.kind,
          "tila-sha256": record.pointer.sha256,
          "tila-lineage": lineage,
          "tila-revision": String(record.pointer.revision),
          "tila-mime": record.pointer.mime_type,
          "tila-operation": operationId,
          "tila-restored-from": source?.r2_key ?? "",
        },
      });
    } catch {
      // Preserve the reservation on uncertain storage outcomes. A same-key
      // retry can finish it; a newer lease can supersede an unaccepted intent.
      return c.json(
        {
          ok: false,
          error: {
            code: "artifact-storage-unavailable",
            message: "Blob write failed; retry with the same idempotency key",
            retryable: true,
          },
        },
        503,
      );
    }
  }
  return forwardToDO(stub, "/artifact/version/commit", "POST", {
    operation_id: operationId,
  });
}

export function writeVersionedArtifact(
  c: Ctx,
  input: VersionWrite,
  bytes: ArrayBuffer,
) {
  return writeRevision(c, input, bytes);
}

export async function restoreArtifact(c: Ctx, key: string, raw: unknown) {
  const input = ArtifactRestoreRequestSchema.parse(raw);
  const response = await forwardToDO(
    c.get("doStub"),
    "/artifact/meta",
    "GET",
    undefined,
    { key },
  );
  if (!response.ok) return response;
  const { pointer } = (await response.json()) as ArtifactMetaResponse;
  if (
    pointer.lineage_id &&
    input.lineage_id &&
    pointer.lineage_id !== input.lineage_id
  )
    return c.json(
      {
        ok: false,
        error: {
          code: "lineage-conflict",
          message: "Restore must remain in its source lineage",
          retryable: false,
        },
      },
      409,
    );
  return writeRevision(
    c,
    {
      kind: pointer.kind,
      resource: pointer.resource,
      mime_type: pointer.mime_type,
      lineage_id: pointer.lineage_id ?? input.lineage_id,
      lineage_fence: input.fence,
      tags: input.tags,
    },
    null,
    pointer,
  );
}
