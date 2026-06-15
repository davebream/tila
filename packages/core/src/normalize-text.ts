import type { NormalizedArtifactText } from "@tila/schemas";

/** Artifacts larger than this threshold are not eligible for FTS indexing. */
export const MAX_BYTES_FOR_NORMALIZATION = 512 * 1024; // 512 KB

/**
 * Extract searchable plain text from artifact bytes.
 *
 * Returns `NormalizedArtifactText` for supported MIME types (`text/markdown`,
 * `text/plain`), or `null` for unsupported types and oversized artifacts.
 *
 * Uses only Web-standard APIs (TextDecoder, regex) -- safe for Cloudflare
 * Workers V8 isolate AND embedded SQLite hosts (Bun, Node). Never throws.
 *
 * Accepts either an `ArrayBuffer` (Worker upload path) or a `Uint8Array`
 * (embedded backend, which buffers bodies to a `Uint8Array`).
 */
export function normalizeArtifactText(
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
): NormalizedArtifactText | null {
  if (bytes.byteLength > MAX_BYTES_FOR_NORMALIZATION) {
    return null;
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  switch (mimeType) {
    case "text/markdown":
      return normalizeMarkdown(text);
    case "text/plain":
      return normalizePlainText(text);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeMarkdown(text: string): NormalizedArtifactText {
  const frontmatterTitle = extractFrontmatterTitle(text);
  const headingTitle = extractFirstHeading(text);
  const title = frontmatterTitle ?? headingTitle ?? null;

  let body = text;

  // Strip fenced code blocks (``` ... ```)
  body = body.replace(/^```[\s\S]*?^```/gm, "");

  // Strip inline code
  body = body.replace(/`[^`]+`/g, "");

  // Strip image syntax before links (images use ![alt](url))
  body = body.replace(/!\[[^\]]*\]\([^)]+\)/g, "");

  // Convert link text: [text](url) -> text
  body = body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Strip bold/italic markers
  body = body.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  body = body.replace(/_([^_]+)_/g, "$1");

  // Strip heading markers
  body = body.replace(/^#{1,6}\s+/gm, "");

  // Strip blockquote markers
  body = body.replace(/^>\s*/gm, "");

  // Strip horizontal rules
  body = body.replace(/^[-*_]{3,}\s*$/gm, "");

  // Normalize multiple blank lines to a single blank line
  body = body.replace(/\n{3,}/g, "\n\n");

  body = body.trim();

  return { title, body_text: body };
}

function normalizePlainText(text: string): NormalizedArtifactText {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  const title = firstNonEmpty ? firstNonEmpty.trim() : null;

  return { title, body_text: trimmed };
}

/**
 * Extract the `title` value from YAML frontmatter.
 *
 * Only reads the `title:` key. Malformed YAML is ignored (falls through to
 * heading extraction). Intentionally narrow -- no library required.
 */
function extractFrontmatterTitle(text: string): string | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return null;
  }

  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    // Closing fence
    if (line === "---") {
      break;
    }

    const match = line.match(/^title:\s*(.+)/i);
    if (match) {
      let value = match[1].trim();
      // Strip surrounding quotes (single or double)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }

  return null;
}

/** Extract text from the first `# Heading` line. */
function extractFirstHeading(text: string): string | null {
  const match = text.match(/^#{1,6}\s+(.+)/m);
  return match ? match[1].trim() : null;
}
