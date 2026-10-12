// Opaque pagination cursors (#300).
//
// A cursor is base64url JSON `{ v: 1, f: <fingerprint>, ...position }`. The
// fingerprint binds it to the filter and sort it was issued for, so reusing a
// cursor with different parameters fails loudly instead of silently skipping
// or repeating rows. Binding is for correctness, not security: a cursor never
// grants access, and every request re-applies the caller's restrictions.

import { canonicalJson } from "@tila/schemas";

export class InvalidCursorError extends Error {
  readonly code = "invalid-cursor";
  constructor(
    message = "Cursor is malformed or was issued for a different filter or sort",
  ) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

/** FNV-1a 64-bit hash of the canonical JSON form, as hex. */
export function fingerprint(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}

export function encodeCursor(
  fingerprintValue: string,
  position: Record<string, unknown>,
): string {
  return toBase64Url(
    JSON.stringify({ v: 1, f: fingerprintValue, ...position }),
  );
}

/**
 * Decode a cursor and check it was issued for `expectedFingerprint`. Returns
 * the position fields. Throws `InvalidCursorError` for anything else.
 */
export function decodeCursor(
  raw: string,
  expectedFingerprint: string,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(raw));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    (payload as { v?: unknown }).v !== 1 ||
    (payload as { f?: unknown }).f !== expectedFingerprint
  )
    throw new InvalidCursorError();
  const { v: _v, f: _f, ...position } = payload as Record<string, unknown>;
  return position;
}
