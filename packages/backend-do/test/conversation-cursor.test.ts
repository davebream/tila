import { expect, it } from "vitest";
import {
  readConversationCursor,
  signConversationCursor,
} from "../src/routes/conversation-cursor";
it("authenticates cursor scope, expiry and restore generation", async () => {
  const generation = crypto.randomUUID();
  const secret = "test-only-secret";
  const scope = '["project","reader","room"]';
  const cursor = await signConversationCursor(
    secret,
    scope,
    generation,
    42,
    1000,
  );
  expect(
    await readConversationCursor(secret, cursor, scope, generation, 1001),
  ).toBe(42);
  await expect(
    readConversationCursor(secret, cursor, `${scope}other`, generation, 1001),
  ).rejects.toMatchObject({ code: "invalid-cursor" });
  await expect(
    readConversationCursor("other-key", cursor, scope, generation, 1001),
  ).rejects.toMatchObject({ code: "invalid-cursor" });
  await expect(
    readConversationCursor(secret, cursor, scope, crypto.randomUUID(), 1001),
  ).rejects.toMatchObject({ code: "cursor-expired" });
  await expect(
    readConversationCursor(secret, cursor, scope, generation, 259201000),
  ).rejects.toMatchObject({ code: "cursor-expired" });
  await expect(
    readConversationCursor(
      secret,
      cursor.slice(0, -10),
      scope,
      generation,
      1001,
    ),
  ).rejects.toMatchObject({ code: "invalid-cursor" });
});
