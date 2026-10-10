import { conversationOps } from "@tila/ops-sqlite";
import { z } from "zod";

const Payload = z
  .object({
    v: z.literal(1),
    kid: z.literal("conversation-1"),
    scope: z.string(),
    generation: z.string().uuid(),
    issued: z.number().int(),
    position: z.unknown(),
  })
  .strict();
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signConversationCursor(
  secret: string,
  scope: string,
  generation: string,
  position: unknown,
  now = Date.now(),
) {
  const body = encode(
    new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        kid: "conversation-1",
        scope,
        generation,
        issued: now,
        position,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    new TextEncoder().encode(body),
  );
  return `${body}.${encode(new Uint8Array(signature))}`;
}
export async function readConversationCursor(
  secret: string,
  cursor: string,
  scope: string,
  generation: string,
  now = Date.now(),
): Promise<unknown> {
  try {
    if (cursor.length > 4096) throw new Error();
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error();
    const [body, signature] = parts;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode(signature),
        new TextEncoder().encode(body),
      ))
    )
      throw new Error();
    const payload = Payload.parse(
      JSON.parse(new TextDecoder().decode(decode(body))),
    );
    if (payload.scope !== scope || payload.issued > now + 60000)
      throw new Error();
    if (payload.generation !== generation || payload.issued + 259200000 <= now)
      throw new conversationOps.ConversationError(
        "cursor-expired",
        "Restart history pagination; pending deliveries remain available",
        410,
      );
    return payload.position;
  } catch (error) {
    if (error instanceof conversationOps.ConversationError) throw error;
    throw new conversationOps.ConversationError(
      "invalid-cursor",
      "Cursor is malformed or belongs to another reader",
      400,
    );
  }
}
