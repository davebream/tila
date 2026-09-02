import { Hono } from "hono";
import type { Context } from "hono";
import { forwardToDO } from "../lib/do-forward";
import { generateToken } from "../lib/hash";
import { hashToken } from "../lib/hash-token";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";
import { requireD1Token } from "./admin";

type BackupEnv = { Bindings: Env; Variables: HonoVariables };

type TransferState = {
  session_id: string;
  mode: "export" | "import" | "rollback";
  owner: string;
};

export function createBackupRoutes(options: {
  projectTokenAuth: boolean;
}): Hono<BackupEnv> {
  const backup = new Hono<BackupEnv>();
  if (options.projectTokenAuth) {
    backup.use("/*", requirePermission("admin"));
    backup.use("/*", requireD1Token);
  }

  const callerOwner = (c: Context<BackupEnv>): string => {
    if (!options.projectTokenAuth) return "infra";
    return `token:${c.get("tokenResult").tokenId}`;
  };

  const requireOwnedTransfer = async (
    c: Context<BackupEnv>,
    sessionId: string | undefined,
    modes: TransferState["mode"][],
  ): Promise<Response | TransferState> => {
    if (!sessionId) {
      return c.json(
        {
          error: {
            code: "validation-error",
            message: "sessionId is required",
          },
        },
        400,
      );
    }
    const response = await forwardToDO(
      c.get("doStub"),
      "/admin/transfer/status",
      "GET",
    );
    if (!response.ok) return response;
    const { state } = (await response.json()) as {
      state: TransferState | null;
    };
    if (
      !state ||
      state.session_id !== sessionId ||
      state.owner !== callerOwner(c) ||
      !modes.includes(state.mode)
    ) {
      return c.json(
        {
          error: {
            code: "transfer-conflict",
            message: "Transfer session does not belong to this caller",
          },
        },
        409,
      );
    }
    if (
      state.mode !== "export" &&
      c.req.header("X-Confirm-Slug") !== c.get("projectId")
    ) {
      return c.json(
        {
          error: {
            code: "confirm-slug-mismatch",
            message: "X-Confirm-Slug must match the project ID",
          },
        },
        400,
      );
    }
    return state;
  };

  const D1_BACKUP_TABLES = [
    "_projects",
    "_project_repos",
    "_github_app_config",
    "_admin_grants",
    "_oidc_principals",
  ] as const;

  const D1_BACKUP_COLUMNS: Record<
    (typeof D1_BACKUP_TABLES)[number],
    ReadonlySet<string>
  > = {
    _projects: new Set([
      "project_id",
      "display_name",
      "created_at",
      "created_by",
      "cloudflare_account_id",
      "schema_version",
      "archived",
      "repo_admin_auto_admin",
      "oidc_issuer",
      "oidc_audience",
    ]),
    _project_repos: new Set([
      "project_id",
      "github_host",
      "github_owner",
      "github_repo",
      "github_repo_id",
      "min_read_permission",
      "min_write_permission",
      "enabled",
      "created_at",
      "created_by",
      "oidc_permission",
    ]),
    _github_app_config: new Set([
      "project_id",
      "installation_id",
      "created_at",
      "created_by",
    ]),
    _admin_grants: new Set([
      "project_id",
      "github_host",
      "github_user_id",
      "github_login_snapshot",
      "granted_by_user_id",
      "granted_at",
      "revoked_at",
      "revoked_by_user_id",
      "identity_host",
      "subject_id",
    ]),
    _oidc_principals: new Set([
      "project_id",
      "issuer",
      "subject",
      "permission",
      "enabled",
      "created_at",
      "created_by",
    ]),
  };
  const D1_BACKUP_ORDER: Record<(typeof D1_BACKUP_TABLES)[number], string[]> = {
    _projects: ["project_id"],
    _project_repos: ["project_id", "github_host", "github_repo_id"],
    _github_app_config: ["project_id"],
    _admin_grants: [
      "project_id",
      "identity_host",
      "subject_id",
      "granted_at",
      "revoked_at",
      "github_user_id",
    ],
    _oidc_principals: ["project_id", "issuer", "subject"],
  };

  backup.get("/transfer/status", async (c) => {
    const response = await forwardToDO(
      c.get("doStub"),
      "/admin/transfer/status",
      "GET",
    );
    if (!response.ok) return response;
    const body = (await response.json()) as { state: TransferState | null };
    if (body.state && body.state.owner !== callerOwner(c)) {
      return c.json(
        {
          error: {
            code: "transfer-conflict",
            message: "Project transfer is owned by another caller",
          },
        },
        409,
      );
    }
    return c.json(body);
  });

  backup.post("/transfer/:action", async (c) => {
    const action = c.req.param("action");
    if (
      !new Set([
        "begin",
        "renew",
        "promote",
        "retarget",
        "prepare",
        "finalize",
        "complete-export",
      ]).has(action)
    ) {
      return c.json(
        {
          error: {
            code: "not-found",
            message: "Unknown backup transfer action",
          },
        },
        404,
      );
    }
    const body = await c.req.json<{
      sessionId?: string;
      mode?: TransferState["mode"];
      owner?: string;
    }>();
    if (action === "begin") {
      body.owner = callerOwner(c);
      if (
        body.mode !== "export" &&
        c.req.header("X-Confirm-Slug") !== c.get("projectId")
      ) {
        return c.json(
          {
            error: {
              code: "confirm-slug-mismatch",
              message: "X-Confirm-Slug must match the project ID",
            },
          },
          400,
        );
      }
    } else {
      const transfer = await requireOwnedTransfer(c, body.sessionId, [
        "export",
        "import",
        "rollback",
      ]);
      if (transfer instanceof Response) return transfer;
    }
    return forwardToDO(
      c.get("doStub"),
      `/admin/transfer/${action}`,
      "POST",
      body,
    );
  });

  backup.get("/transfer/meta", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    return forwardToDO(c.get("doStub"), "/admin/transfer/meta", "GET");
  });

  backup.get("/transfer/snapshot/:table", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    return forwardToDO(
      c.get("doStub"),
      `/admin/transfer/snapshot/${c.req.param("table")}`,
      "GET",
      undefined,
      {
        offset: c.req.query("offset") ?? "0",
        limit: c.req.query("limit") ?? "250",
      },
    );
  });

  backup.post("/transfer/rows/:table", async (c) => {
    const body = await c.req.json<{ sessionId?: string }>();
    const transfer = await requireOwnedTransfer(c, body.sessionId, [
      "import",
      "rollback",
    ]);
    if (transfer instanceof Response) return transfer;
    return forwardToDO(
      c.get("doStub"),
      `/admin/transfer/rows/${c.req.param("table")}`,
      "POST",
      body,
    );
  });

  backup.get("/d1", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    const projectId = c.get("projectId");
    const sections: Record<string, Record<string, unknown>[]> = {};
    for (const table of D1_BACKUP_TABLES) {
      const columns = [...D1_BACKUP_COLUMNS[table]];
      const result = await c.env.DB.prepare(
        `SELECT ${columns.join(", ")} FROM ${table} WHERE project_id = ? ORDER BY ${D1_BACKUP_ORDER[table].join(", ")}`,
      )
        .bind(projectId)
        .all();
      sections[table] = result.results as Record<string, unknown>[];
    }
    return c.json({ sections });
  });

  backup.post("/d1/restore", async (c) => {
    const projectId = c.get("projectId");
    if (c.req.header("X-Confirm-Slug") !== projectId) {
      return c.json(
        {
          error: {
            code: "confirm-slug-mismatch",
            message: "X-Confirm-Slug must match the project ID",
          },
        },
        400,
      );
    }
    const body = await c.req.json<{
      sessionId?: string;
      sections: Record<string, Record<string, unknown>[]>;
      createBootstrapToken?: boolean;
    }>();
    const transfer = await requireOwnedTransfer(c, body.sessionId, [
      "import",
      "rollback",
    ]);
    if (transfer instanceof Response) return transfer;
    const current = await c.env.DB.prepare(
      "SELECT cloudflare_account_id FROM _projects WHERE project_id = ?",
    )
      .bind(projectId)
      .first<{ cloudflare_account_id: string }>();
    if (!current)
      return c.json(
        {
          error: {
            code: "not-found",
            message: "Destination project is missing",
          },
        },
        404,
      );
    const statements: D1PreparedStatement[] = [];
    for (const table of [...D1_BACKUP_TABLES].reverse()) {
      if (table !== "_projects" && table !== "_github_app_config") {
        statements.push(
          c.env.DB.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(
            projectId,
          ),
        );
      }
    }
    for (const table of D1_BACKUP_TABLES) {
      for (const original of body.sections[table] ?? []) {
        const row: Record<string, unknown> = {
          ...original,
          project_id: projectId,
        };
        if (table === "_projects") {
          const preserved = new Set([
            "created_at",
            "created_by",
            "cloudflare_account_id",
            "project_id",
          ]);
          const columns = Object.keys(row).filter(
            (column) =>
              D1_BACKUP_COLUMNS._projects.has(column) && !preserved.has(column),
          );
          if (columns.length > 0) {
            statements.push(
              c.env.DB.prepare(
                `UPDATE _projects SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE project_id = ?`,
              ).bind(...columns.map((column) => row[column]), projectId),
            );
          }
          continue;
        }
        if (table === "_github_app_config") continue;
        const columns = Object.keys(row).filter((column) =>
          D1_BACKUP_COLUMNS[table].has(column),
        );
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          ).bind(...columns.map((column) => row[column])),
        );
      }
    }
    if (statements.length > 0) await c.env.DB.batch(statements);
    let bootstrapToken: string | undefined;
    if (body.createBootstrapToken) {
      bootstrapToken = await generateToken();
      const tokenHash = await hashToken(bootstrapToken, c.env.HASH_PEPPER);
      await c.env.DB.prepare(
        `INSERT INTO _tokens
        (token_hash, token_id, project_id, name, note, scopes, created_at, created_by)
        VALUES (?, ?, ?, 'restore-bootstrap', 'Fresh token created by project restore', 'full', ?, 'infra-backup-restore')`,
      )
        .bind(tokenHash, crypto.randomUUID(), projectId, Date.now())
        .run();
    }
    return c.json({
      ok: true,
      warnings: [
        "GitHub installation metadata requires reconnection and was not restored",
      ],
      ...(bootstrapToken ? { bootstrapToken } : {}),
    });
  });

  backup.get("/object", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    const key = c.req.query("key");
    if (!key)
      return c.json(
        { error: { code: "validation-error", message: "key is required" } },
        400,
      );
    const object = await c.env.ARTIFACTS.get(key);
    if (!object)
      return c.json(
        { error: { code: "not-found", message: "Object is missing" } },
        404,
      );
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set(
      "X-Tila-Custom-Metadata",
      JSON.stringify(object.customMetadata ?? {}),
    );
    return new Response(object.body, { headers });
  });

  backup.get("/object-metadata", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    const key = c.req.query("key");
    if (!key)
      return c.json(
        { error: { code: "validation-error", message: "key is required" } },
        400,
      );
    const object = await c.env.ARTIFACTS.head(key);
    if (!object)
      return c.json(
        { error: { code: "not-found", message: "Object is missing" } },
        404,
      );
    return c.json({
      bytes: object.size,
      etag: object.etag,
      httpMetadata: object.httpMetadata ?? {},
      customMetadata: object.customMetadata ?? {},
    });
  });

  backup.put("/object", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "import",
      "rollback",
    ]);
    if (transfer instanceof Response) return transfer;
    const key = c.req.query("key");
    const sha256 = c.req.query("sha256");
    if (!key || !sha256 || !/^[a-f0-9]{64}$/.test(sha256) || !c.req.raw.body) {
      return c.json(
        {
          error: {
            code: "validation-error",
            message: "key, sha256, and body are required",
          },
        },
        400,
      );
    }
    const checksum = Uint8Array.from(sha256.match(/.{2}/g) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    );
    const rawHttpMetadata = JSON.parse(
      c.req.header("X-Tila-Http-Metadata") ?? "{}",
    ) as Record<string, unknown>;
    const httpMetadata: R2HTTPMetadata = {
      ...(typeof rawHttpMetadata.contentType === "string"
        ? { contentType: rawHttpMetadata.contentType }
        : {}),
      ...(typeof rawHttpMetadata.contentLanguage === "string"
        ? { contentLanguage: rawHttpMetadata.contentLanguage }
        : {}),
      ...(typeof rawHttpMetadata.contentDisposition === "string"
        ? { contentDisposition: rawHttpMetadata.contentDisposition }
        : {}),
      ...(typeof rawHttpMetadata.contentEncoding === "string"
        ? { contentEncoding: rawHttpMetadata.contentEncoding }
        : {}),
      ...(typeof rawHttpMetadata.cacheControl === "string"
        ? { cacheControl: rawHttpMetadata.cacheControl }
        : {}),
    };
    await c.env.ARTIFACTS.put(key, c.req.raw.body, {
      sha256: checksum.buffer,
      httpMetadata,
      customMetadata: JSON.parse(
        c.req.header("X-Tila-Custom-Metadata") ?? "{}",
      ) as Record<string, string>,
    });
    return c.json({ ok: true });
  });

  backup.get("/journal-archives", async (c) => {
    const transfer = await requireOwnedTransfer(c, c.req.query("sessionId"), [
      "export",
    ]);
    if (transfer instanceof Response) return transfer;
    const prefix = `journal-archive/${c.get("projectId")}/`;
    const objects: Array<{
      key: string;
      bytes: number;
      etag: string;
      customMetadata: Record<string, string>;
    }> = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.ARTIFACTS.list({ prefix, cursor });
      objects.push(
        ...page.objects.map((object) => ({
          key: object.key,
          bytes: object.size,
          etag: object.etag,
          customMetadata: object.customMetadata ?? {},
        })),
      );
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return c.json({ objects });
  });
  return backup;
}

export const backup = createBackupRoutes({ projectTokenAuth: true });
