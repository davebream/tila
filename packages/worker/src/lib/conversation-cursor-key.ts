import type { Env } from "../types";

/** Minimum length of an explicitly configured cursor key, in characters. */
export const CURSOR_KEY_MIN_LENGTH = 32;

/**
 * Where the conversation cursor signing key came from. Names only; the
 * secret material itself never leaves this module except as the derived key.
 */
export type ConversationCursorKeySource =
  | "conversation-cursor-key"
  | "hash-pepper";

export type ConversationCursorKey =
  | { ok: true; key: string; source: ConversationCursorKeySource }
  | { ok: false; reason: "missing" | "cursor-key-too-short" };

type CursorKeyEnv = Pick<Env, "CONVERSATION_CURSOR_KEY" | "HASH_PEPPER">;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");

async function purposeKey(secret: string, projectId: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(
        JSON.stringify(["tila:conversation-cursor:v1", projectId]),
      ),
    ),
  );
}

/**
 * Resolve the project-specific key that signs conversation cursors.
 *
 * Precedence:
 * 1. `CONVERSATION_CURSOR_KEY` — dedicated secret, so enabling conversations
 *    never requires setting or rotating the credential hash pepper.
 * 2. `HASH_PEPPER` — the original derivation, kept byte-identical so
 *    deployments that already set a pepper keep their outstanding cursors.
 *
 * Changing the winning source invalidates outstanding cursors only; readers
 * restart without a cursor. With no source, callers must fail closed: setting
 * a source is the explicit operator step that turns conversations on.
 */
export async function resolveConversationCursorKey(
  env: CursorKeyEnv,
  projectId: string,
): Promise<ConversationCursorKey> {
  const dedicated = env.CONVERSATION_CURSOR_KEY;
  if (dedicated !== undefined && dedicated !== "") {
    if (dedicated.trim().length < CURSOR_KEY_MIN_LENGTH)
      return { ok: false, reason: "cursor-key-too-short" };
    return {
      ok: true,
      key: await purposeKey(dedicated, projectId),
      source: "conversation-cursor-key",
    };
  }
  if (env.HASH_PEPPER) {
    const material = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([env.HASH_PEPPER, "conversation-1", projectId]),
      ),
    );
    return { ok: true, key: hex(material), source: "hash-pepper" };
  }
  return { ok: false, reason: "missing" };
}
