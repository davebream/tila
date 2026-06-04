import { eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sessions } from "./schema";

export interface SessionResult {
  projectId: string;
  tokenHash: string;
  name: string;
  scopes: string;
  expiresAt: number;
}

export class D1SessionStore {
  private db;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  async create(params: {
    sessionHash: string;
    projectId: string;
    tokenHash: string;
    actorName: string;
    scopes: string;
    expiresAt: number;
  }): Promise<void> {
    await this.db.insert(sessions).values({
      session_hash: params.sessionHash,
      project_id: params.projectId,
      token_hash: params.tokenHash,
      actor_name: params.actorName,
      scopes: params.scopes,
      created_at: Date.now(),
      expires_at: params.expiresAt,
    });
  }

  async validate(sessionHash: string): Promise<SessionResult | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.session_hash, sessionHash))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    if (row.expires_at < Date.now()) return null;

    return {
      projectId: row.project_id,
      tokenHash: row.token_hash,
      name: row.actor_name,
      scopes: row.scopes,
      expiresAt: row.expires_at,
    };
  }

  async revoke(sessionHash: string): Promise<void> {
    await this.db
      .delete(sessions)
      .where(eq(sessions.session_hash, sessionHash));
  }

  async deleteExpired(): Promise<{ deleted: number }> {
    const result = await this.db
      .delete(sessions)
      .where(lt(sessions.expires_at, Date.now()))
      .returning();
    return { deleted: result.length };
  }

  async deleteByTokenHash(tokenHash: string): Promise<{ deleted: number }> {
    const result = await this.db
      .delete(sessions)
      .where(eq(sessions.token_hash, tokenHash))
      .returning();
    return { deleted: result.length };
  }
}
