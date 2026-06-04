import type { R2ArtifactBackend } from "@tila/backend-r2";
import { normalizeArtifactText } from "./normalize-text";

export type ScanRow = {
  artifact_key: string;
  kind: string;
  resource: string | null;
  sha256: string;
  mime_type: string;
  produced_at: number;
  pointer_tombstoned: number;
  existing_sha256: string | null;
  doc_tombstoned: number | null;
};

export type RebuildCandidate = {
  artifact_key: string;
  kind: string;
  resource: string | null;
  sha256: string;
  mime_type: string;
  produced_at: number;
  pointer_tombstoned: number;
  title: string | null;
  body_text: string | null;
  source_sha256: string | null;
};

const SEARCHABLE_MIME_TYPES = new Set(["text/markdown", "text/plain"]);

/**
 * Determine which scan rows need R2 reads and enrich them with blob content.
 *
 * For tombstoned pointers or already-current docs: no R2 read needed.
 * For missing/stale docs with searchable MIME types: fetch R2 blob and normalize.
 */
export async function buildRebuildCandidates(
  r2: R2ArtifactBackend,
  pointers: ScanRow[],
): Promise<RebuildCandidate[]> {
  const candidates: RebuildCandidate[] = [];

  for (const p of pointers) {
    const base: RebuildCandidate = {
      artifact_key: p.artifact_key,
      kind: p.kind,
      resource: p.resource,
      sha256: p.sha256,
      mime_type: p.mime_type,
      produced_at: p.produced_at,
      pointer_tombstoned: p.pointer_tombstoned,
      title: null,
      body_text: null,
      source_sha256: null,
    };

    // Tombstoned pointer: no R2 read needed, but still include for tombstone-leak fix
    if (p.pointer_tombstoned === 1) {
      candidates.push(base);
      continue;
    }

    // Already current: matching sha256 and not tombstoned
    if (
      p.existing_sha256 !== null &&
      p.existing_sha256 === p.sha256 &&
      p.doc_tombstoned === 0
    ) {
      base.source_sha256 = p.sha256;
      candidates.push(base);
      continue;
    }

    // Non-searchable MIME type -- unrecoverable at DO level
    if (!SEARCHABLE_MIME_TYPES.has(p.mime_type)) {
      candidates.push(base);
      continue;
    }

    // Needs R2 read: missing doc or stale sha256
    try {
      const blob = await r2.get(p.artifact_key);
      if (!blob) {
        // R2 blob not found
        candidates.push(base);
        continue;
      }

      const arrayBuf = await new Response(blob.body).arrayBuffer();
      const normalized = normalizeArtifactText(arrayBuf, p.mime_type);
      if (normalized) {
        base.title = normalized.title;
        base.body_text = normalized.body_text;
        base.source_sha256 = p.sha256;
      }
    } catch {
      // R2 read or stream failure -- leave as unrecoverable
    }

    candidates.push(base);
  }

  return candidates;
}
