/**
 * Parse a specific cookie value from a raw Cookie header string.
 * Handles %-encoded values via decodeURIComponent.
 */
export function parseCookieHeader(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  const pairs = header.split(";").map((s) => s.trim());
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    if (key === name) {
      return decodeURIComponent(pair.slice(eqIdx + 1).trim());
    }
  }
  return null;
}
