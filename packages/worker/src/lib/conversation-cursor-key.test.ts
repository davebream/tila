import { describe, expect, it } from "vitest";
import { resolveConversationCursorKey } from "./conversation-cursor-key";

const dedicated = "d".repeat(32);

async function legacyKey(pepper: string, projectId: string) {
  // The derivation conversation routes used before the dedicated key existed.
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([pepper, "conversation-1", projectId]),
    ),
  );
  return Array.from(new Uint8Array(material), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}

describe("resolveConversationCursorKey", () => {
  it("keeps the original HASH_PEPPER derivation byte-identical", async () => {
    const result = await resolveConversationCursorKey(
      { HASH_PEPPER: "pepper" },
      "p1",
    );
    expect(result).toEqual({
      ok: true,
      key: await legacyKey("pepper", "p1"),
      source: "hash-pepper",
    });
  });

  it("prefers the dedicated key over HASH_PEPPER", async () => {
    const result = await resolveConversationCursorKey(
      { CONVERSATION_CURSOR_KEY: dedicated, HASH_PEPPER: "pepper" },
      "p1",
    );
    expect(result.ok && result.source).toBe("conversation-cursor-key");
    expect(result.ok && result.key).toMatch(/^[0-9a-f]{64}$/);
    expect(result.ok && result.key).not.toBe(await legacyKey("pepper", "p1"));
    expect(result.ok && result.key).not.toContain(dedicated);
  });

  it("fails closed on a short dedicated key instead of falling back", async () => {
    for (const key of ["short", " ".repeat(40)])
      await expect(
        resolveConversationCursorKey(
          { CONVERSATION_CURSOR_KEY: key, HASH_PEPPER: "pepper" },
          "p1",
        ),
      ).resolves.toEqual({ ok: false, reason: "cursor-key-too-short" });
  });

  it("treats an empty dedicated key as unset", async () => {
    const result = await resolveConversationCursorKey(
      { CONVERSATION_CURSOR_KEY: "", HASH_PEPPER: "pepper" },
      "p1",
    );
    expect(result.ok && result.source).toBe("hash-pepper");
  });

  it("derives a different key per project", async () => {
    const env = { CONVERSATION_CURSOR_KEY: dedicated };
    const a = await resolveConversationCursorKey(env, "p1");
    const b = await resolveConversationCursorKey(env, "p2");
    expect(a.ok && b.ok && a.key !== b.key).toBe(true);
  });

  it("reports missing when no source is configured", async () => {
    await expect(resolveConversationCursorKey({}, "p1")).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });
});
