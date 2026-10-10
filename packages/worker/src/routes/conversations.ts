import { RuntimeDenied, RuntimeStore } from "@tila/backend-d1";
import { PROJECT_ROLE_RANK } from "@tila/schemas";
import { Hono } from "hono";
import { runtimeIdentity } from "../lib/agent-authority";
import { analyticsCtxFrom } from "../lib/analytics";
import { forwardToDO } from "../lib/do-forward";
import { principalIdFor } from "../middleware/request-identity";
import type { Env, HonoVariables } from "../types";
export const conversations = new Hono<{
  Bindings: Env;
  Variables: HonoVariables;
}>();
conversations.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});
conversations.all("*", async (c) => {
  const path = c.req.path.replace(/^\/projects\/[^/]+/, "").replace(/\/$/, "");
  if (!/^\/(?:rooms|inbox|dispatch)(?:\/|$)/.test(path)) return c.notFound();
  const protocol = c.req.header("X-Tila-Conversation-Protocol");
  if (protocol !== undefined && protocol !== "1")
    return c.json(
      {
        ok: false,
        error: {
          code: "unsupported-protocol",
          message: "Supported conversation protocols: 1",
          retryable: false,
          details: { reason: "UNSUPPORTED_PROTOCOL", supported: [1] },
        },
      },
      400,
    );
  if (
    c.req.method === "POST" &&
    /^\/rooms\/[^/]+\/messages$/.test(path) &&
    c.req.header("Idempotency-Key") !== undefined
  )
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message:
            "Use client_op_id instead of Idempotency-Key for publication",
          retryable: false,
        },
      },
      400,
    );
  const token = c.get("tokenResult");
  const policy = c.get("credentialPolicy");
  const role = c.get("effectiveRole");
  const runtime = runtimeIdentity(
    token.kind === "d1-token" ? token.runtime : undefined,
  );
  if (
    (path.startsWith("/dispatch/") ||
      /^\/inbox\/[^/]+(?:\/watch|\/deliveries\/[^/]+\/ack)?$/.test(path)) &&
    !runtime
  )
    return c.json(
      {
        ok: false,
        error: {
          code: "runtime-required",
          message: "This operation requires a current agent-pinned run",
          retryable: false,
        },
      },
      403,
    );
  if (runtime?.run_role === "relay" && !path.startsWith("/dispatch/"))
    return c.json(
      {
        ok: false,
        error: {
          code: "permission-denied",
          message: "Relay credentials have metadata-only dispatch access",
          retryable: false,
        },
      },
      403,
    );
  const authority = {
    principal_id: principalIdFor(token),
    participant_id:
      runtime?.participant_id ??
      c.get("participantId") ??
      principalIdFor(token),
    can_manage: policy
      ? policy.capabilities.includes("conversations:manage")
      : (token.kind === "d1-token" && token.scopes === "full") ||
        (role !== undefined &&
          PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK.maintainer),
    runtime,
  };
  if (path.startsWith("/dispatch/")) {
    const agent = path.split("/")[2];
    const current = await forwardToDO(
      c.get("doStub"),
      `/agents/${encodeURIComponent(agent)}/current-run`,
      "GET",
      undefined,
      undefined,
      undefined,
      {
        "X-Tila-Agent-Authority": JSON.stringify({
          principal_id: authority.principal_id,
          can_manage: false,
          runtime,
        }),
      },
    );
    if (!current.ok) return current;
    const { run_id } = (await current.json()) as { run_id: string | null };
    const store = new RuntimeStore(c.env.DB);
    const holder = run_id ? await store.run(run_id) : undefined;
    if (
      !holder ||
      holder.project_id !== c.get("projectId") ||
      holder.enrollment_id !== runtime?.enrollment_id
    )
      return c.json(
        {
          ok: false,
          error: {
            code: "no-active-binding",
            message: "No current acting run on this enrollment",
            retryable: false,
          },
        },
        409,
      );
    await store.context(holder.current_token_id);
  }
  if (!c.env.HASH_PEPPER)
    return c.json(
      {
        ok: false,
        error: {
          code: "config-unavailable",
          message: "Conversation cursors require HASH_PEPPER",
          retryable: false,
        },
      },
      503,
    );
  // The cursor signing secret is project-specific and never taken from headers.
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([c.env.HASH_PEPPER, "conversation-1", c.get("projectId")]),
    ),
  );
  const cursorKey = Array.from(new Uint8Array(material), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  let body: unknown;
  if (c.req.method !== "GET" && c.req.method !== "DELETE") {
    const text = await c.req.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation-error",
            message: "Invalid JSON",
            retryable: false,
          },
        },
        400,
      );
    }
  }
  const response = await forwardToDO(
    c.get("doStub"),
    path,
    c.req.method,
    body,
    c.req.query(),
    analyticsCtxFrom(c),
    {
      "X-Tila-Conversation-Authority": JSON.stringify(authority),
      "X-Tila-Conversation-Cursor-Key": cursorKey,
    },
  );
  // A long poll must not return mailbox metadata after run revocation.
  if (path.endsWith("/watch") && token.kind === "d1-token" && runtime)
    await new RuntimeStore(c.env.DB).context(token.tokenId);
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "private, no-store");
  return result;
});
conversations.onError((error, c) => {
  if (error instanceof RuntimeDenied)
    return c.json(
      {
        ok: false,
        error: { code: error.code, message: error.message, retryable: false },
      },
      403,
    );
  throw error;
});
