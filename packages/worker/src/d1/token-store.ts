import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { tokens } from "./schema";

export interface TokenResult {
  projectId: string;
  name: string;
  scopes: string;
  tokenId: string;
  /** RFC 7638 SHA-256 JWK thumbprint for DPoP sender-constraint. Null = unbound. */
  cnfJkt: string | null;
}

export interface TokenRow {
  token_id: string;
  name: string;
  note: string | null;
  scopes: string;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export class D1TokenStore {
  private drizzle;

  constructor(private db: D1Database) {
    this.drizzle = drizzle(this.db);
  }

  async validate(tokenHash: string): Promise<TokenResult | null> {
    const rows = await this.drizzle
      .select({
        projectId: tokens.project_id,
        name: tokens.name,
        scopes: tokens.scopes,
        tokenId: tokens.token_id,
        cnfJkt: tokens.cnf_jkt,
      })
      .from(tokens)
      .where(and(eq(tokens.token_hash, tokenHash), isNull(tokens.revoked_at)))
      .limit(1);

    return rows[0] ?? null;
  }

  async updateLastUsedAt(tokenHash: string): Promise<void> {
    await this.drizzle
      .update(tokens)
      .set({ last_used_at: Math.floor(Date.now() / 1000) })
      .where(eq(tokens.token_hash, tokenHash));
  }

  async issue(params: {
    tokenHash: string;
    projectId: string;
    name: string;
    note?: string;
    createdBy: string;
    createdAt: number;
    /** Optional DPoP JWK thumbprint. Omit or pass undefined to issue an unbound token. */
    cnfJkt?: string;
  }): Promise<{ tokenId: string }> {
    const tokenId = crypto.randomUUID();
    await this.drizzle.insert(tokens).values({
      token_hash: params.tokenHash,
      project_id: params.projectId,
      name: params.name,
      note: params.note ?? null,
      scopes: "full",
      created_at: params.createdAt,
      created_by: params.createdBy,
      token_id: tokenId,
      cnf_jkt: params.cnfJkt ?? null,
    });
    return { tokenId };
  }

  async revoke(
    projectId: string,
    name: string,
    revokedBy: string,
  ): Promise<{ revoked: boolean; tokenHash: string | null }> {
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.drizzle
      .update(tokens)
      .set({ revoked_at: now, revoked_by: revokedBy })
      .where(
        and(
          eq(tokens.project_id, projectId),
          eq(tokens.name, name),
          isNull(tokens.revoked_at),
        ),
      )
      .returning({ tokenHash: tokens.token_hash });

    if (rows.length === 0) {
      return { revoked: false, tokenHash: null };
    }
    return { revoked: true, tokenHash: rows[0].tokenHash };
  }

  async list(projectId: string): Promise<TokenRow[]> {
    const rows = await this.drizzle
      .select({
        token_id: tokens.token_id,
        name: tokens.name,
        note: tokens.note,
        scopes: tokens.scopes,
        created_at: tokens.created_at,
        created_by: tokens.created_by,
        last_used_at: tokens.last_used_at,
        revoked_at: tokens.revoked_at,
        revoked_by: tokens.revoked_by,
      })
      .from(tokens)
      .where(eq(tokens.project_id, projectId))
      .orderBy(desc(tokens.created_at));

    return rows;
  }
}
