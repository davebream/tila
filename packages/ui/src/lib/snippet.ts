import DOMPurify from "dompurify";

/**
 * Search snippets are server HTML with match highlighting. Keep only the
 * highlight tags; everything else (attributes, scripts, links) is stripped.
 */
export function sanitizeSnippet(snippet: string): string {
  return DOMPurify.sanitize(snippet, {
    ALLOWED_TAGS: ["b", "strong", "mark"],
    ALLOWED_ATTR: [],
  });
}
