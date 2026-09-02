import { type ProjectBackupTable, projectTransferOps } from "@tila/ops-sqlite";
import { type Context, Hono } from "hono";
import type { ProjectSubRouter, RouterDeps } from "./types";

const jsonError = (
  c: Context,
  code: string,
  message: string,
  status: 400 | 409 | 423 | 500,
) => c.json({ error: { code, message } }, status);

export function createTransferRoutes(deps: RouterDeps): ProjectSubRouter {
  const app = new Hono();
  const sql = deps.ctx.storage.sql;

  app.get("/admin/transfer/status", (c) =>
    c.json({ state: projectTransferOps.getTransferState(sql) }),
  );

  app.post("/admin/transfer/begin", async (c) => {
    try {
      const body = await c.req.json<{
        sessionId: string;
        mode: "export" | "import" | "rollback";
        owner: string;
        archiveDigest?: string;
        safetyArchive?: string;
        ttlMs?: number;
      }>();
      const state = projectTransferOps.beginTransfer(sql, body);
      return c.json({ state });
    } catch (error) {
      if (error instanceof projectTransferOps.TransferConflictError) {
        return jsonError(c, error.code, error.message, 409);
      }
      throw error;
    }
  });

  app.post("/admin/transfer/renew", async (c) => {
    const body = await c.req.json<{ sessionId: string; ttlMs?: number }>();
    projectTransferOps.renewExport(sql, body.sessionId, body.ttlMs);
    return c.json({ ok: true });
  });

  app.post("/admin/transfer/promote", async (c) => {
    const body = await c.req.json<{
      sessionId: string;
      mode: "import" | "rollback";
      archiveDigest: string;
      safetyArchive?: string;
    }>();
    projectTransferOps.promoteTransfer(
      sql,
      body.sessionId,
      body.mode,
      body.archiveDigest,
      body.safetyArchive ?? null,
    );
    return c.json({ ok: true });
  });

  app.post("/admin/transfer/retarget", async (c) => {
    const body = await c.req.json<{
      sessionId: string;
      archiveDigest: string;
    }>();
    projectTransferOps.retargetTransfer(
      sql,
      body.sessionId,
      body.archiveDigest,
    );
    return c.json({ ok: true });
  });

  app.get("/admin/transfer/snapshot/:table", (c) => {
    const table = c.req.param("table") as ProjectBackupTable;
    const offset = Number.parseInt(c.req.query("offset") ?? "0", 10);
    const limit = Number.parseInt(c.req.query("limit") ?? "250", 10);
    const page = projectTransferOps.readSnapshotPage(sql, table, {
      offset,
      limit,
    });
    return c.json(page);
  });

  app.get("/admin/transfer/meta", async (c) => {
    const [digest, journal] = await Promise.all([
      projectTransferOps.semanticDigest(sql),
      Promise.resolve(projectTransferOps.journalState(sql)),
    ]);
    return c.json({
      digest,
      journal,
      migrationVersion: 24,
      tables: projectTransferOps.PROJECT_BACKUP_TABLES,
    });
  });

  app.post("/admin/transfer/prepare", async (c) => {
    const body = await c.req.json<{ sessionId: string }>();
    const state = projectTransferOps.getTransferState(sql);
    if (
      !state ||
      state.session_id !== body.sessionId ||
      state.mode === "export"
    ) {
      return jsonError(
        c,
        "transfer-conflict",
        "Import session does not match the active lock",
        409,
      );
    }
    const result = deps.ctx.storage.transactionSync(() =>
      projectTransferOps.prepareSnapshotRestore(sql, body.sessionId),
    );
    return c.json({ ok: true, replayed: result === "replayed" });
  });

  app.post("/admin/transfer/rows/:table", async (c) => {
    const table = c.req.param("table") as ProjectBackupTable;
    const body = await c.req.json<{
      sessionId: string;
      chunkIndex: number;
      sha256: string;
      rows: Record<string, unknown>[];
    }>();
    const encoded = new TextEncoder().encode(
      body.rows.map((row) => projectTransferOps.canonicalJson(row)).join("\n") +
        (body.rows.length > 0 ? "\n" : ""),
    );
    const actual = await projectTransferOps.sha256Hex(encoded);
    if (actual !== body.sha256) {
      return jsonError(
        c,
        "checksum-mismatch",
        "Chunk checksum does not match its contents",
        400,
      );
    }
    const result = deps.ctx.storage.transactionSync(() => {
      const accepted = projectTransferOps.acceptChunk(sql, {
        sessionId: body.sessionId,
        section: `do/${table}.jsonl`,
        chunkIndex: body.chunkIndex,
        sha256: body.sha256,
        bytes: encoded.byteLength,
      });
      if (accepted === "accepted") {
        projectTransferOps.insertSnapshotRows(sql, table, body.rows);
      }
      return accepted;
    });
    return c.json({ ok: true, replayed: result === "replayed" });
  });

  app.post("/admin/transfer/finalize", async (c) => {
    const body = await c.req.json<{
      sessionId: string;
      journalNextSequence: number;
      semanticDigest: string;
    }>();
    const state = projectTransferOps.getTransferState(sql);
    if (
      !state ||
      state.session_id !== body.sessionId ||
      state.mode === "export"
    ) {
      return jsonError(
        c,
        "transfer-conflict",
        "Import session does not match the active lock",
        409,
      );
    }
    projectTransferOps.finalizeSnapshotRestore(sql, body.journalNextSequence);
    const actual = await projectTransferOps.semanticDigest(sql);
    if (actual !== body.semanticDigest) {
      return jsonError(
        c,
        "semantic-digest-mismatch",
        "Restored project does not match the backup",
        409,
      );
    }
    projectTransferOps.finishTransfer(sql, body.sessionId);
    return c.json({ ok: true, semanticDigest: actual });
  });

  app.post("/admin/transfer/complete-export", async (c) => {
    const body = await c.req.json<{ sessionId: string }>();
    const state = projectTransferOps.getTransferState(sql);
    if (
      !state ||
      state.session_id !== body.sessionId ||
      state.mode !== "export"
    ) {
      return jsonError(
        c,
        "transfer-conflict",
        "Export session does not match the active lock",
        409,
      );
    }
    projectTransferOps.finishTransfer(sql, body.sessionId);
    return c.json({ ok: true });
  });

  return app;
}
