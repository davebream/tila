/**
 * Artifact text normalization for full-text search indexing.
 *
 * The implementation now lives in `@tila/core` so both the Worker (Cloudflare
 * upload path) and the embedded SQLite backends (Bun/Node local mode) share one
 * normalizer and never drift. This module re-exports it to preserve the
 * existing `../lib/normalize-text` import sites within the Worker package.
 */
export {
  normalizeArtifactText,
  MAX_BYTES_FOR_NORMALIZATION,
} from "@tila/core";
