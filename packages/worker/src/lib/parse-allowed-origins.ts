/**
 * Parse a comma-separated list of allowed origins from an env var string.
 * Trims whitespace, filters empty strings, and rejects wildcard "*" entries
 * to prevent accidental CORS misconfigurations.
 */
export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .filter((o) => o !== "*");
}
