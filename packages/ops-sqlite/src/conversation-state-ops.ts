import { and, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as s from "./schema";
type DB = BaseSQLiteDatabase<"sync", unknown, typeof s>;
export const clearLease = {
  lease_token: null,
  lease_until: null,
  lease_gen: null,
  lease_binding_id: null,
  lease_epoch: null,
};
export function rearm(
  db: DB,
  agent: string,
  now = Date.now(),
  publication = true,
) {
  const row = db
    .select({ attachment: s.agentBindings.attachment_json })
    .from(s.agentBindings)
    .where(
      and(
        eq(s.agentBindings.agent_id, agent),
        eq(s.agentBindings.state, "active"),
      ),
    )
    .get();
  const b = row ? (JSON.parse(row.attachment) as { mechanism: string }) : null;
  db.insert(s.dispatchOutbox)
    .values({
      agent_id: agent,
      state: b?.mechanism === "poll" ? "quiet" : "pending",
      publish_gen: 1,
      next_attempt_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: s.dispatchOutbox.agent_id,
      set: {
        state: b?.mechanism === "poll" ? "quiet" : "pending",
        publish_gen: sql`${s.dispatchOutbox.publish_gen} + ${publication ? 1 : 0}`,
        next_attempt_at: now,
        updated_at: now,
        ...(publication ? {} : clearLease),
      },
    })
    .run();
}
export function invalidateRestoredConversations(db: DB, now = Date.now()) {
  db.update(s.dispatchOutbox)
    .set({
      ...clearLease,
      state: "pending",
      next_attempt_at: now,
      updated_at: now,
    })
    .run();
  db.delete(s.conversationContext).run();
  db.insert(s.conversationState)
    .values({ singleton: 1, generation: crypto.randomUUID() })
    .onConflictDoUpdate({
      target: s.conversationState.singleton,
      set: { generation: crypto.randomUUID() },
    })
    .run();
}
